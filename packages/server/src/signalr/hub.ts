import type { ServerWebSocket } from "bun";
import {
	completion,
	decodeFrames,
	handshakeResponse,
	type InvocationMessage,
	invocation,
	MessageType,
	ping,
	RS,
	type SignalRMessage,
	tryParseHandshake,
} from "./protocol";

export interface ConnData {
	hubPath: string;
	connectionToken: string;
	connectionId: string;
	handshaken: boolean;
	/** Set after warning once about a pre-handshake non-handshake frame, so a bad client can't spam the log. */
	warnedNonHandshake?: boolean;
}

export type ServerSocket = ServerWebSocket<ConnData>;
type InvokeHandler = (conn: ServerSocket, args: unknown[]) => unknown | Promise<unknown>;

/**
 * One SignalR hub: tracks its connected sockets, broadcasts server->client invocations,
 * and dispatches client->server invocations to registered handlers (acking with a
 * completion when the client supplied an invocationId).
 */
export class Hub {
	readonly name: string;
	readonly path: string;
	private connections = new Set<ServerSocket>();
	private handlers = new Map<string, InvokeHandler>();

	constructor(name: string, path: string) {
		this.name = name;
		this.path = path;
	}

	get clientCount(): number {
		return this.connections.size;
	}

	/** Register a client->server method. Target match is case-insensitive. */
	onInvoke(target: string, handler: InvokeHandler): void {
		this.handlers.set(target.toLowerCase(), handler);
	}

	add(ws: ServerSocket): void {
		this.connections.add(ws);
	}

	remove(ws: ServerSocket): void {
		this.connections.delete(ws);
	}

	/** Broadcast a server->client invocation to every handshaken connection. */
	broadcast(target: string, ...args: unknown[]): void {
		const frame = invocation(target, args);
		for (const ws of this.connections) {
			if (ws.data.handshaken) ws.send(frame);
		}
	}

	/** Send a keepalive ping to every handshaken connection. */
	pingAll(): void {
		const frame = ping();
		for (const ws of this.connections) {
			if (ws.data.handshaken) ws.send(frame);
		}
	}

	async handleMessage(ws: ServerSocket, raw: string): Promise<void> {
		if (!ws.data.handshaken) {
			const hs = tryParseHandshake(raw);
			if (!hs) {
				if (!ws.data.warnedNonHandshake) {
					ws.data.warnedNonHandshake = true;
					console.warn(`[${this.name}] first frame from ${ws.data.connectionId} is not a handshake; ignoring until one arrives`);
				}
				return;
			}
			if (hs.protocol !== "json") {
				ws.send(handshakeResponse("Only the json protocol is supported"));
				ws.close();
				return;
			}
			ws.data.handshaken = true;
			ws.send(handshakeResponse());
			// The client may pack typed frames into the same payload right behind the handshake
			// (the @microsoft/signalr client does this under load); process them, don't drop them.
			const separator = raw.indexOf(RS);
			const trailing = separator >= 0 ? raw.slice(separator + 1) : "";
			for (const msg of decodeFrames(trailing)) {
				await this.handleParsed(ws, msg);
			}
			return;
		}
		for (const msg of decodeFrames(raw)) {
			await this.handleParsed(ws, msg);
		}
	}

	private async handleParsed(ws: ServerSocket, msg: SignalRMessage): Promise<void> {
		switch (msg.type) {
			case MessageType.Ping:
				ws.send(ping());
				return;
			case MessageType.Close:
				this.remove(ws);
				ws.close();
				return;
			case MessageType.Invocation: {
				const inv = msg as unknown as InvocationMessage;
				const handler = this.handlers.get(inv.target.toLowerCase());
				let result: unknown = null;
				let error: string | undefined;
				if (handler) {
					try {
						result = await handler(ws, inv.arguments ?? []);
					} catch (e) {
						error = e instanceof Error ? e.message : String(e);
						console.error(`[${this.name}] invoke ${inv.target} failed:`, e);
					}
				} else {
					console.warn(`[${this.name}] no handler for client invocation ${inv.target}`);
				}
				if (inv.invocationId) ws.send(completion(inv.invocationId, result ?? null, error));
				return;
			}
			default:
				return;
		}
	}
}
