import { BareResponse } from "@mercuryworkshop/proxy-transports";
import { ScramjetFetchHandler, ScramjetHeaders } from "@mercuryworkshop/scramjet";
import { context, FrameRedirect, transport } from "./context.ts";

type FetchEvent = Event & {
	request: Request;
	clientId: string;
	resultingClientId: string;
	respondWith(p: Promise<Response>): void;
};
const sw = globalThis as unknown as {
	clients: {
		claim(): Promise<void>;
		get(
			id: string,
		): Promise<
			{ url: string; postMessage(message: unknown, transfer: Transferable[]): void } | undefined
		>;
	};
	skipWaiting(): Promise<void>;
	oninstall: () => void;
	onactivate: (e: { waitUntil(p: Promise<void>): void }) => void;
	onfetch: (e: FetchEvent) => void;
};
sw.oninstall = () => void sw.skipWaiting();
sw.onactivate = (e) => e.waitUntil(sw.clients.claim());
const local = async (url: string) => BareResponse.fromNativeResponse(await fetch(url));
const handler = new ScramjetFetchHandler({
	context: context(),
	transport: transport(),
	crossOriginIsolated: true,
	sendSetCookie: async () => {},
	fetchBlobUrl: local,
	fetchDataUrl: local,
});
async function handle(e: FetchEvent) {
	const req = e.request,
		id = e.resultingClientId || e.clientId || "navigation";
	if (!handler.trackedClients.has(id)) handler.trackedClients.set(id, { clientId: id, history: [] });
	const c = e.clientId ? await sw.clients.get(e.clientId) : undefined;
	try {
		let initial = new Headers(req.headers);
		// Parser preloads can precede the document bridge. Intercept requests from a ready
		// document (fetch/XHR/resource loads) without making those early loads deadlock.
		if (
			c?.url.startsWith(`${location.origin}/view/`) &&
			req.mode !== "navigate" &&
			req.destination === ""
		) {
			const channel = new MessageChannel();
			const decision = await new Promise<{ block?: boolean; headers?: [string, string][] }>((ok) => {
				const t = setTimeout(() => {
					channel.port1.close();
					ok({});
				}, 800);
				channel.port1.onmessage = (e) => {
					clearTimeout(t);
					channel.port1.close();
					ok(e.data);
				};
				const path = new URL(req.url).pathname.slice("/view/".length);
				c.postMessage(
					{
						iyowa: "intercept",
						url: decodeURIComponent(path),
						method: req.method,
						headers: [...initial],
					},
					[channel.port2],
				);
			});
			if (decision.block)
				return new Response("Blocked by controlled-frame interceptor", { status: 403 });
			if (decision.headers) initial = new Headers(decision.headers);
		}
		const result = await handler.handleFetch({
			rawUrl: new URL(req.url),
			rawReferrer: req.referrer || null,
			rawDestination: req.destination,
			mode: req.mode,
			referrer: req.referrer,
			method: req.method,
			body: ["GET", "HEAD"].includes(req.method) ? null : await req.arrayBuffer(),
			cache: req.cache,
			initialHeaders: ScramjetHeaders.fromNativeHeaders(initial),
			clientId: id,
			rawClientUrl: c?.url.startsWith(`${location.origin}/view/`) ? new URL(c.url) : undefined,
		});
		const headers = new Headers(result.headers.toRawHeaders());
		headers.delete("content-length");
		headers.set("Cross-Origin-Embedder-Policy", "credentialless");
		headers.set("Cross-Origin-Resource-Policy", "cross-origin");
		headers.set(
			"Content-Security-Policy",
			`frame-ancestors ${globalThis.__iyowaFrame.parent} http://localhost:${location.port}`,
		);
		headers.set("Cache-Control", "no-store");
		return new Response([204, 205, 304].includes(result.status) ? null : result.body, {
			status: result.status,
			headers,
		});
	} catch (error) {
		if (req.mode === "navigate") {
			const escapeHtml = (s: string) =>
				s.replace(
					/[&<>"']/g,
					(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] || c,
				);
			const marker =
				error instanceof FrameRedirect
					? `<meta name="iyowa-redirect" content="${escapeHtml(error.destination)}">`
					: "";
			return new Response(
				`<!doctype html><title>Frame unavailable</title>${marker}<p>${escapeHtml(String(error))}</p><script src="/.iyowa/frame-config.js"></script><script src="/.iyowa/frame-error.js"></script>`,
				{
					headers: {
						"Content-Type": "text/html",
						"Cross-Origin-Embedder-Policy": "credentialless",
						"Cross-Origin-Resource-Policy": "cross-origin",
						"Content-Security-Policy": `default-src 'self';frame-ancestors ${globalThis.__iyowaFrame.parent} http://localhost:${location.port}`,
					},
				},
			);
		}
		return new Response(String(error), {
			status: 502,
			headers: { "Content-Type": "text/plain", "Cross-Origin-Embedder-Policy": "credentialless" },
		});
	}
}
sw.onfetch = (e) => {
	if (e.request.url.startsWith(`${location.origin}/view/`)) e.respondWith(handle(e));
};
