import { libcurl } from "libcurl.js";

/**
 * libcurl.js performs HTTP(S) and WebSocket handshakes locally (TLS terminates in the
 * browser); the partition's Wisp relay only carries TCP bytes. This module must run in an
 * unhooked global (service worker or dedicated network worker): libcurl uses the global
 * fetch and WebSocket, which Scramjet replaces inside proxied documents.
 */
let loading: Promise<void> | undefined;
let session: InstanceType<typeof libcurl.HTTPSession> | undefined;

export function loadCurl(): Promise<void> {
	loading ??= (async () => {
		libcurl.logger = (type: string, text: string) => {
			if (type === "error") console.error(`[libcurl] ${text}`);
		};
		libcurl.stderr = () => {};
		await libcurl.load_wasm(new URL("/.iyowa/libcurl.wasm", location.href).href);
		libcurl.set_websocket(
			`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/.iyowa/net/`,
		);
	})().catch((error: unknown) => {
		loading = undefined;
		throw error;
	});
	return loading;
}

/** Request headers libcurl or the browser must own; the rest pass through unchanged. */
const DROP = new Set([
	"host",
	"connection",
	"keep-alive",
	"content-length",
	"transfer-encoding",
	"te",
	"upgrade",
	"accept-encoding",
	"proxy-authorization",
	"proxy-connection",
	// libcurl.js can't represent a 304 without a body; responses are never cached here anyway.
	"if-none-match",
	"if-modified-since",
]);
/** Response headers describing an encoding libcurl already removed. */
const DECODED = new Set(["content-encoding", "content-length", "transfer-encoding"]);

export interface NetResponse {
	status: number;
	statusText: string;
	headers: [string, string][];
	body: ReadableStream<Uint8Array> | null;
}

export async function curlFetch(
	url: string,
	method: string,
	headers: Iterable<[string, string]>,
	body: BodyInit | null,
	signal?: AbortSignal,
): Promise<NetResponse> {
	await loadCurl();
	session ??= new libcurl.HTTPSession({ enable_cookies: false });
	const outgoing: Record<string, string> = {};
	for (const [k, v] of headers) if (!DROP.has(k.toLowerCase())) outgoing[k] = v;
	if (!Object.keys(outgoing).some((k) => k.toLowerCase() === "user-agent"))
		outgoing["User-Agent"] = navigator.userAgent;
	const response = await session.fetch(url, {
		method,
		headers: outgoing,
		body: ["GET", "HEAD"].includes(method) ? undefined : (body ?? undefined),
		redirect: "manual",
		credentials: "omit",
		signal,
		// Browsers never attempt cleartext HTTP/2 (an `Upgrade: h2c` request), and servers that also
		// accept WebSockets reject it. HTTPS still negotiates HTTP/2 through ALPN.
		...(url.startsWith("http:") ? { _libcurl_http_version: 1.1 } : {}),
	});
	const raw = (
		(response as { raw_headers?: [string, string][] }).raw_headers ?? [...response.headers]
	).filter(([k]) => !DECODED.has(k.toLowerCase()));
	return { status: response.status, statusText: response.statusText, headers: raw, body: response.body };
}

export async function curlWebSocket(url: string, protocols: string[], headers: Record<string, string>) {
	await loadCurl();
	return new libcurl.WebSocket(url, protocols, { headers }) as WebSocket;
}
