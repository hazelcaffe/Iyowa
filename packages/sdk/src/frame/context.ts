import type { ProxyTransport, RawHeaders, TransferrableResponse } from "@mercuryworkshop/proxy-transports";
import { CookieJar, defaultConfig, type ScramjetContext } from "@mercuryworkshop/scramjet";
import type { FrameConfig } from "../shared/types.ts";

export interface FrameBoot {
	cookies: string;
	headers: RawHeaders;
	history: { url: string }[];
}

declare global {
	var __iyowaFrame: FrameConfig;
	var __iyowaFrameBoot: FrameBoot | undefined;
}

export const RESERVED = "/.iyowa/";
export const PREFIX = "/view/";

function base64(text: string): string {
	let binary = "";
	for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
	return btoa(binary);
}

/** One Scramjet context per partition realm (service worker, document or worker). */
export function frameContext(): ScramjetContext {
	const origin = location.origin;
	const asset = (name: string) => `${origin}${RESERVED}${name}`;
	const boot = (headers: RawHeaders, history: { url: string }[]) =>
		`data:text/javascript;base64,${base64(`globalThis.__iyowaFrameBoot=${JSON.stringify({ cookies: context.cookieJar.dump(), headers, history }).replaceAll("<", "\\u003c")};`)}`;
	const context: ScramjetContext = {
		config: {
			...defaultConfig,
			maskedfiles: [RESERVED],
			flags: {
				...defaultConfig.flags,
				captureErrors: false,
				cleanErrors: false,
				syncxhr: false,
				encapsulateWorkers: false,
			},
		},
		prefix: new URL(PREFIX, origin),
		cookieJar: new CookieJar(),
		interface: {
			codecEncode: encodeURIComponent,
			codecDecode: decodeURIComponent,
			getInjectScripts(_meta, _handler, html, script) {
				return [
					script(asset("frame-config.js")),
					script(asset("scramjet.js")),
					script(boot(html.headers || [], html.history || [])),
					script(asset("frame-client.js")),
				];
			},
			getWorkerInjectScripts(_meta, isModule, script) {
				const setup = isModule
					? script(boot([], []))
					: `globalThis.__iyowaFrameBoot=${JSON.stringify({ cookies: context.cookieJar.dump(), headers: [], history: [] })};\n`;
				return `${script(asset("frame-config.js"))}${script(asset("scramjet.js"))}${setup}${script(asset("frame-worker.js"))}`;
			},
		},
	};
	return context;
}

/** Platform functions captured before Scramjet hooks the realm. */
export interface Natives {
	Worker: typeof Worker;
	fetch: typeof fetch;
	listen: typeof EventTarget.prototype.addEventListener;
	post: typeof Worker.prototype.postMessage;
}

/**
 * Transport for proxied documents and workers. Their globals are hooked by Scramjet, so the
 * network runs in an unhooked dedicated worker (libcurl.js over the partition's Wisp relay).
 */
export function workerTransport(natives: Natives): ProxyTransport {
	let worker: Worker | undefined;
	let seq = 0;
	const replies = new Map<number, (m: Record<string, unknown>) => void>();
	const sockets = new Map<
		number,
		{
			open(protocol: string, extensions: string): void;
			message(data: string | ArrayBuffer): void;
			close(code: number, reason: string): void;
			error(message: string): void;
		}
	>();
	const send = (message: unknown, transfer: Transferable[] = []) =>
		natives.post.call(net(), message, { transfer });
	const net = (): Worker => {
		if (!worker) {
			worker = new natives.Worker(`${location.origin}${RESERVED}frame-net.js`, {
				name: "iyowa-frame-net",
			});
			natives.listen.call(worker, "message", (({ data: m }: MessageEvent) => {
				if (m.type === "response") {
					replies.get(m.id)?.(m);
					replies.delete(m.id);
					return;
				}
				const socket = sockets.get(m.id);
				if (!socket) return;
				if (m.type === "ws-open") socket.open(m.protocol || "", m.extensions || "");
				else if (m.type === "ws-message") socket.message(m.data);
				else if (m.type === "ws-error") socket.error(m.message || "WebSocket error");
				else if (m.type === "ws-close") {
					sockets.delete(m.id);
					socket.close(m.code ?? 1006, m.reason || "");
				}
			}) as EventListener);
		}
		return worker;
	};
	return {
		ready: true,
		init: async () => {},
		async request(url, method, body, headers, signal): Promise<TransferrableResponse> {
			if (url.origin === globalThis.__iyowaFrame.bundleOrigin) {
				const r = await natives.fetch(
					`${location.origin}${RESERVED}resource${url.pathname}${url.search}`,
					{ signal },
				);
				return {
					body: await r.arrayBuffer(),
					headers: [...r.headers],
					status: r.status,
					statusText: r.statusText,
				};
			}
			const id = ++seq;
			const payload = body == null ? null : await new Response(body as BodyInit).arrayBuffer();
			const reply = new Promise<Record<string, unknown>>((ok) => replies.set(id, ok));
			send(
				{ type: "fetch", id, url: url.href, method, headers, body: payload },
				payload ? [payload] : [],
			);
			const m = await reply;
			if (m.error) throw new TypeError(String(m.error));
			return {
				body: (m.body as ArrayBuffer | null) ?? "",
				headers: m.headers as RawHeaders,
				status: m.status as number,
				statusText: (m.statusText as string) || "",
			};
		},
		connect(url, protocols, headers, onopen, onmessage, onclose, onerror) {
			const id = ++seq;
			sockets.set(id, { open: onopen, message: onmessage, close: onclose, error: onerror });
			send({ type: "ws-open", id, url: url.href, protocols, headers });
			return [
				(data) => {
					if (data instanceof Blob)
						void data
							.arrayBuffer()
							.then((buffer) => send({ type: "ws-send", id, data: buffer }, [buffer]));
					else send({ type: "ws-send", id, data });
				},
				(code, reason) => send({ type: "ws-close", id, code, reason }),
			];
		},
	};
}
