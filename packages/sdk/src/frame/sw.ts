import {
	BareResponse,
	type ProxyTransport,
	type TransferrableResponse,
} from "@mercuryworkshop/proxy-transports";
import { ScramjetFetchHandler, ScramjetHeaders } from "@mercuryworkshop/scramjet";
import { frameContext, PREFIX, RESERVED } from "./context.ts";
import { curlFetch } from "./net.ts";

// Partition service worker: Scramjet rewrites every document, script and stylesheet of the
// controlled frame; libcurl.js fetches them over the partition's Wisp relay.

interface Client {
	id: string;
	url: string;
	frameType: string;
	postMessage(message: unknown, transfer?: Transferable[]): void;
}
type FetchEvent = Event & {
	request: Request;
	clientId: string;
	resultingClientId: string;
	respondWith(response: Promise<Response>): void;
	waitUntil(promise: Promise<unknown>): void;
};
const sw = globalThis as unknown as {
	clients: { claim(): Promise<void>; get(id: string): Promise<Client | undefined> };
	skipWaiting(): Promise<void>;
	addEventListener(type: string, listener: (e: Event & Record<string, never>) => void): void;
	onfetch: (e: FetchEvent) => void;
	oninstall: () => void;
	onactivate: (e: { waitUntil(p: Promise<void>): void }) => void;
	onmessage: (e: MessageEvent & { source: Client | null }) => void;
};
sw.oninstall = () => void sw.skipWaiting();
sw.onactivate = (e) => e.waitUntil(sw.clients.claim());

const config = globalThis.__iyowaFrame;
const context = frameContext();
const COOKIES = new Request(`${location.origin}${RESERVED}cookies`);

// Cookies persist with the partition origin's Cache Storage (cleared by clearData).
const restored = (async () => {
	const saved = await (await caches.open("iyowa-frame")).match(COOKIES);
	if (saved) context.cookieJar.load(await saved.text());
})().catch(() => {});
let saving: Promise<void> = Promise.resolve();
function persistCookies() {
	saving = saving.then(async () => {
		await (await caches.open("iyowa-frame")).put(COOKIES, new Response(context.cookieJar.dump()));
	});
	return saving.catch(() => {});
}

const transport: ProxyTransport = {
	ready: true,
	init: async () => {},
	async request(url, method, body, headers, signal): Promise<TransferrableResponse> {
		if (url.origin === config.bundleOrigin) {
			const r = await fetch(`${location.origin}${RESERVED}resource${url.pathname}${url.search}`, {
				signal,
			});
			return {
				body: await r.arrayBuffer(),
				headers: [...r.headers],
				status: r.status,
				statusText: r.statusText,
			};
		}
		const r = await curlFetch(url.href, method, headers, body as BodyInit | null, signal);
		return { body: r.body ?? "", headers: r.headers, status: r.status, statusText: r.statusText };
	},
	connect() {
		throw new DOMException("Service workers do not open WebSockets", "NotSupportedError");
	},
};

const local = async (url: string) => BareResponse.fromNativeResponse(await fetch(url));
const handler = new ScramjetFetchHandler({
	context,
	transport,
	crossOriginIsolated: true,
	sendSetCookie: async () => {
		await persistCookies();
	},
	fetchBlobUrl: local,
	fetchDataUrl: local,
});

/** Clients that registered webRequest interceptors, with their URL patterns. */
const intercepting = new Map<string, boolean>();
const RESOURCE_TYPES: Record<string, string> = {
	"": "xmlhttprequest",
	document: "main_frame",
	iframe: "sub_frame",
	frame: "sub_frame",
	script: "script",
	worker: "script",
	sharedworker: "script",
	style: "stylesheet",
	image: "image",
	font: "font",
	audio: "media",
	video: "media",
	track: "media",
	object: "object",
	manifest: "other",
};

async function ask(
	client: Client,
	message: Record<string, unknown>,
): Promise<{ block?: boolean; headers?: [string, string][] }> {
	const channel = new MessageChannel();
	return new Promise((ok) => {
		const timer = setTimeout(() => {
			channel.port1.close();
			ok({});
		}, 2000);
		channel.port1.onmessage = (e) => {
			clearTimeout(timer);
			channel.port1.close();
			ok(e.data || {});
		};
		client.postMessage({ iyowa: "intercept", ...message }, [channel.port2]);
	});
}

function frameHeaders(headers: Headers) {
	headers.delete("content-length");
	headers.set("Cross-Origin-Embedder-Policy", "credentialless");
	headers.set("Cross-Origin-Resource-Policy", "cross-origin");
	headers.set("Content-Security-Policy", `frame-ancestors ${config.parent} ${config.shell}`);
	headers.set("Cache-Control", "no-store");
	return headers;
}

function errorPage(url: string, error: unknown) {
	const text = (s: string) =>
		s.replace(
			/[&<>"']/g,
			(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] || c,
		);
	const message = String((error as Error)?.message ?? error);
	return new Response(
		`<!doctype html><meta charset="utf-8"><title>Can't reach this page</title><style>body{font:14px system-ui;margin:2rem;color:#444}h1{font-size:18px}code{word-break:break-all}</style><h1>Can't reach this page</h1><p><code>${text(url)}</code></p><p>${text(message)}</p><script src="${RESERVED}frame-config.js"></script><script src="${RESERVED}frame-error.js"></script>`,
		{ status: 502, headers: frameHeaders(new Headers({ "Content-Type": "text/html; charset=utf-8" })) },
	);
}

async function handle(e: FetchEvent): Promise<Response> {
	await restored;
	const request = e.request;
	const clientId = e.resultingClientId || e.clientId || "navigation";
	const client = e.clientId ? await sw.clients.get(e.clientId) : undefined;
	const virtual = decodeURIComponent(new URL(request.url).pathname.slice(PREFIX.length));
	let headers = new Headers(request.headers);
	const type = RESOURCE_TYPES[request.destination] ?? "other";
	const watched = client && request.mode !== "navigate" && intercepting.get(client.id);
	try {
		if (watched) {
			const decision = await ask(client, {
				phase: "before",
				url: virtual,
				method: request.method,
				type,
				headers: [...headers],
			});
			if (decision.block)
				return new Response(null, { status: 403, statusText: "Blocked by the embedding app" });
			if (decision.headers) headers = new Headers(decision.headers);
		}
		const result = await handler.handleFetch({
			rawUrl: new URL(request.url),
			rawReferrer: request.referrer || null,
			rawDestination: request.destination,
			mode: request.mode,
			referrer: request.referrer,
			method: request.method,
			body: ["GET", "HEAD"].includes(request.method) ? null : await request.arrayBuffer(),
			cache: request.cache,
			initialHeaders: ScramjetHeaders.fromNativeHeaders(headers),
			clientId,
			rawClientUrl: client?.url.startsWith(`${location.origin}${PREFIX}`)
				? new URL(client.url)
				: undefined,
		});
		const responseHeaders = frameHeaders(new Headers(result.headers.toRawHeaders()));
		if (watched)
			client.postMessage({
				iyowa: "request-done",
				url: virtual,
				method: request.method,
				type,
				status: result.status,
				headers: [...responseHeaders],
			});
		const empty = request.method === "HEAD" || [101, 204, 205, 304].includes(result.status);
		return new Response(empty ? null : (result.body as BodyInit), {
			status: result.status,
			statusText: result.statusText,
			headers: responseHeaders,
		});
	} catch (error) {
		if (watched)
			client.postMessage({
				iyowa: "request-done",
				url: virtual,
				method: request.method,
				type,
				error: String(error),
			});
		if (request.mode === "navigate") return errorPage(virtual, error);
		return new Response(String((error as Error)?.message ?? error), {
			status: 502,
			headers: frameHeaders(new Headers({ "Content-Type": "text/plain" })),
		});
	}
}

sw.onfetch = (e) => {
	if (new URL(e.request.url).pathname.startsWith(PREFIX)) e.respondWith(handle(e));
};

sw.onmessage = (e) => {
	const m = e.data;
	if (!e.source) return;
	if (m?.iyowa === "intercepting") intercepting.set(e.source.id, !!m.active);
	else if (m?.iyowa === "cookies" && Array.isArray(m.cookies)) {
		for (const entry of m.cookies) context.cookieJar.setCookies(String(entry.cookie), new URL(entry.url));
		void persistCookies();
	} else if (m?.iyowa === "clear-cookies") {
		context.cookieJar.clear();
		void persistCookies();
	}
};
