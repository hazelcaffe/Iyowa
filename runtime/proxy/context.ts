import type { ProxyTransport } from "@mercuryworkshop/proxy-transports";
import { CookieJar, defaultConfig, type ScramjetContext } from "@mercuryworkshop/scramjet";

declare global {
	var __iyowaFrame: { virtual: string; parent: string };
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
			// Rewriting remote documents requires publisher opt-in; ordinary embedding stays native.
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
