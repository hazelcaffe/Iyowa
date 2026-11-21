import type { ProxyTransport } from "@mercuryworkshop/proxy-transports";
import { CookieJar, defaultConfig, type ScramjetContext } from "@mercuryworkshop/scramjet";

declare global {
	var __iyowaFrame: { virtual: string; parent: string; publicSource: boolean };
}
export class FrameRedirect extends Error {
	constructor(readonly destination: string) {
		super("Frame redirected");
	}
}
export function context(): ScramjetContext {
	return {
		config: {
			...defaultConfig,
			maskedfiles: ["/.iyowa/"],
			flags: { ...defaultConfig.flags, syncxhr: false, encapsulateWorkers: false },
		},
		prefix: new URL("/view/", location.origin),
		cookieJar: new CookieJar(),
		interface: {
			codecEncode: encodeURIComponent,
			codecDecode: decodeURIComponent,
			getInjectScripts(_meta, _handler, _html, script) {
				return ["frame-config.js", "scramjet.js", "proxy-client.js"].map((f) =>
					script(`${location.origin}/.iyowa/${f}`),
				);
			},
		},
	};
}
export function transport(): ProxyTransport {
	return {
		ready: true,
		init: async () => {},
		connect() {
			throw new DOMException("Managed frame WebSocket transport unavailable", "NotSupportedError");
		},
		async request(url, method, body, headers, signal) {
			const virtual = globalThis.__iyowaFrame.virtual;
			if (url.origin !== virtual) throw Error("Cross-origin managed request refused");
			if (globalThis.__iyowaFrame.publicSource) {
				if (method !== "GET" && method !== "HEAD")
					throw Error("Public controlled-frame transport is read-only");
				const reply = await fetch(
					`/.iyowa/upstream?path=${encodeURIComponent(url.pathname + url.search)}`,
					{ headers: { "X-Iyowa-Source": "1" }, credentials: "omit", signal },
				);
				if (!reply.ok)
					throw Error((await reply.text()) || `Frame source returned HTTP ${reply.status}`);
				const redirect = reply.headers.get("X-Iyowa-Redirect");
				if (redirect) throw new FrameRedirect(redirect);
				return {
					body: method === "HEAD" ? new ArrayBuffer(0) : await reply.arrayBuffer(),
					headers: [
						["content-type", reply.headers.get("X-Iyowa-Type") || "application/octet-stream"],
					],
					status: Number(reply.headers.get("X-Iyowa-Status")) || 502,
					statusText: "",
				};
			}
			const packaged = virtual === "https://bundle.invalid";
			const target = packaged
				? `${location.origin}/.iyowa/resource${url.pathname}${url.search}`
				: url.href;
			const r = await fetch(target, {
				method,
				body,
				// The browser supplies its own transport and navigation headers. Forward app data
				// headers only, so an ordinary GET doesn't acquire a synthetic CORS preflight.
				headers: headers.filter(
					([k, v]) =>
						/^(content-type|range|x-[\w-]+)$/i.test(k) ||
						(/^(accept|accept-language)$/i.test(k) && v.length <= 128),
				),
				credentials: "omit",
				referrerPolicy: "no-referrer",
				redirect: "error",
				signal,
			});
			// The operator-configured transport also supports publisher-approved CORS requests.
			if (!packaged && r.headers.get("X-Iyowa-Embed") !== "allow")
				throw Error("Publisher did not opt in to managed embedding");
			return {
				body: await r.arrayBuffer(),
				headers: [...r.headers],
				status: r.status,
				statusText: r.statusText,
			};
		},
	};
}
