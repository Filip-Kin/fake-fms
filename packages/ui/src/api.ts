import { useEffect, useRef, useState } from "react";
import type { FmsState } from "shared";

/** POST a control mutation to the server. */
export async function control(path: string, body?: unknown): Promise<void> {
	await fetch(path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: body ? JSON.stringify(body) : "{}",
	});
}

/** Subscribe to the live FmsState pushed over the control websocket. */
export function useFmsState(): { state: FmsState | null; connected: boolean } {
	const [state, setState] = useState<FmsState | null>(null);
	const [connected, setConnected] = useState(false);
	const wsRef = useRef<WebSocket | null>(null);

	useEffect(() => {
		let stop = false;
		let retry: ReturnType<typeof setTimeout> | null = null;

		const connect = () => {
			if (stop) return;
			const proto = location.protocol === "https:" ? "wss" : "ws";
			const ws = new WebSocket(`${proto}://${location.host}/ws`);
			wsRef.current = ws;
			ws.onopen = () => setConnected(true);
			ws.onmessage = (ev) => {
				try {
					const msg = JSON.parse(ev.data as string) as { type: string; data: FmsState };
					if (msg.type === "state") setState(msg.data);
				} catch {
					// ignore malformed frames
				}
			};
			ws.onclose = () => {
				setConnected(false);
				if (!stop) retry = setTimeout(connect, 1000);
			};
			ws.onerror = () => ws.close();
		};

		connect();
		return () => {
			stop = true;
			if (retry) clearTimeout(retry);
			wsRef.current?.close();
		};
	}, []);

	return { state, connected };
}
