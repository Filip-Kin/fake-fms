// Minimal implementation of the ASP.NET Core SignalR JSON protocol over WebSocket.
// Both consumers use the @microsoft/signalr client, which speaks exactly this protocol.
// Frames are JSON objects separated by the 0x1e record separator; the handshake is a
// single separate frame exchanged before any typed messages.

export const RS = "\x1e";

export const MessageType = {
	Invocation: 1,
	StreamItem: 2,
	Completion: 3,
	StreamInvocation: 4,
	CancelInvocation: 5,
	Ping: 6,
	Close: 7,
} as const;

export interface HandshakeRequest {
	protocol: string;
	version: number;
}

export interface InvocationMessage {
	type: 1;
	target: string;
	arguments: unknown[];
	invocationId?: string;
	headers?: Record<string, string>;
}

export interface CompletionMessage {
	type: 3;
	invocationId: string;
	result?: unknown;
	error?: string;
}

export interface PingMessage {
	type: 6;
}

export interface CloseMessage {
	type: 7;
	error?: string;
	allowReconnect?: boolean;
}

export type SignalRMessage =
	| InvocationMessage
	| CompletionMessage
	| PingMessage
	| CloseMessage
	| { type: number; [key: string]: unknown };

/** Append the record separator to a serialized message. */
export function encode(msg: SignalRMessage): string {
	return JSON.stringify(msg) + RS;
}

/** Split a raw WebSocket payload (which may concatenate several frames) into messages. */
export function decodeFrames(raw: string): SignalRMessage[] {
	const out: SignalRMessage[] = [];
	for (const piece of raw.split(RS)) {
		if (piece.length === 0) continue;
		try {
			out.push(JSON.parse(piece) as SignalRMessage);
		} catch (err) {
			// Skip the malformed frame rather than killing the connection, but say so.
			console.warn(`[signalr] dropping malformed frame: ${piece.slice(0, 200)}`, err);
		}
	}
	return out;
}

/** Detect the handshake frame (it has no numeric `type`, but has `protocol`). */
export function tryParseHandshake(raw: string): HandshakeRequest | null {
	const piece = raw.split(RS).find((p) => p.length > 0);
	if (!piece) return null;
	try {
		const obj = JSON.parse(piece) as Record<string, unknown>;
		if (typeof obj.protocol === "string" && typeof obj.version === "number") {
			return obj as unknown as HandshakeRequest;
		}
	} catch (err) {
		// Not a handshake frame; the caller logs the unexpected pre-handshake traffic once.
		console.warn(`[signalr] unparseable pre-handshake frame: ${piece.slice(0, 200)}`, err);
	}
	return null;
}

export function handshakeResponse(error?: string): string {
	return (error ? JSON.stringify({ error }) : "{}") + RS;
}

export function invocation(target: string, args: unknown[]): string {
	const msg: InvocationMessage = { type: 1, target, arguments: args };
	return encode(msg);
}

export function completion(invocationId: string, result: unknown, error?: string): string {
	const msg: CompletionMessage = { type: 3, invocationId, ...(error ? { error } : { result }) };
	return encode(msg);
}

export function ping(): string {
	return encode({ type: 6 });
}
