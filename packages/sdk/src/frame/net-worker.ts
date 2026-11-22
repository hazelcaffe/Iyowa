import { curlFetch, curlWebSocket } from "./net.ts";

// One per proxied document or worker that needs page-initiated networking (mostly WebSockets).
const sockets = new Map<number, WebSocket>();
const reply = (message: Record<string, unknown>, transfer: Transferable[] = []) =>
	postMessage(message, { transfer });

addEventListener("message", async ({ data: m }: MessageEvent) => {
	if (m.type === "fetch") {
		try {
			const r = await curlFetch(m.url, m.method, m.headers, m.body);
			const body = r.body ? await new Response(r.body).arrayBuffer() : null;
			reply(
				{
					type: "response",
					id: m.id,
					status: r.status,
					statusText: r.statusText,
					headers: r.headers,
					body,
				},
				body ? [body] : [],
			);
		} catch (e) {
			reply({ type: "response", id: m.id, error: String((e as Error)?.message ?? e) });
		}
		return;
	}
	if (m.type === "ws-open") {
		try {
			const headers: Record<string, string> = {};
			for (const [k, v] of m.headers as [string, string][])
				if (!/^(host|connection|upgrade|sec-websocket-.*|content-length)$/i.test(k)) headers[k] = v;
			const ws = await curlWebSocket(m.url, m.protocols || [], headers);
			ws.binaryType = "arraybuffer";
			sockets.set(m.id, ws);
			ws.onopen = () =>
				reply({ type: "ws-open", id: m.id, protocol: ws.protocol, extensions: ws.extensions });
			ws.onmessage = (e) =>
				reply(
					{ type: "ws-message", id: m.id, data: e.data },
					e.data instanceof ArrayBuffer ? [e.data] : [],
				);
			ws.onerror = () => reply({ type: "ws-error", id: m.id, message: "WebSocket connection failed" });
			ws.onclose = (e) => {
				sockets.delete(m.id);
				reply({ type: "ws-close", id: m.id, code: e.code, reason: e.reason });
			};
		} catch (e) {
			reply({ type: "ws-error", id: m.id, message: String((e as Error)?.message ?? e) });
			reply({ type: "ws-close", id: m.id, code: 1006, reason: "" });
		}
		return;
	}
	if (m.type === "ws-send") sockets.get(m.id)?.send(m.data);
	else if (m.type === "ws-close") sockets.get(m.id)?.close(m.code, m.reason);
});
