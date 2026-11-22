import { allowsIsolated, isPrivateHost } from "../shared/policy.ts";
import { BUNDLE_ORIGIN, type GuestConfig } from "../shared/types.ts";
import type { Bridge } from "./bridge.ts";
import {
	clonePatterns,
	FrameMenus,
	type MenuItem,
	matchesPattern,
	type UrlPatternLike,
} from "./frame-menu.ts";

/**
 * <controlledframe> for a tab. Each partition is a separate real origin with a Scramjet
 * service worker; this element hosts an iframe of it and exposes the Controlled Frame API.
 * https://wicg.github.io/controlled-frame/
 */

type Source = { code?: string; files?: string[]; file?: string };
interface ContentScript {
	name: string;
	urlPatterns: UrlPatternLike[];
	excludeUrlPatterns: UrlPatternLike[];
	js?: Source;
	css?: Source;
	runAt: "document_start" | "document_end" | "document_idle";
}
interface InterceptorOptions {
	urlPatterns?: unknown[];
	resourceTypes?: string[];
	blocking?: boolean;
	includeHeaders?: "none" | "cors" | "all";
}
interface FrameRequest {
	url: string;
	method: string;
	type: string;
	headers?: [string, string][];
	status?: number;
	error?: string;
}

class WebRequestInterceptor extends EventTarget {
	readonly urlPatterns: UrlPatternLike[];
	readonly resourceTypes?: string[];
	readonly blocking: boolean;
	readonly includeHeaders: string;
	constructor(options: InterceptorOptions = {}) {
		super();
		this.urlPatterns = clonePatterns(options.urlPatterns) ?? ["<all_urls>"];
		this.resourceTypes = options.resourceTypes;
		this.blocking = !!options.blocking;
		this.includeHeaders = options.includeHeaders ?? "none";
	}
	applies(url: string, type: string) {
		return (
			this.urlPatterns.some((p) => matchesPattern(p, url)) &&
			(!this.resourceTypes?.length || this.resourceTypes.includes(type))
		);
	}
}

interface State {
	iframe: HTMLIFrameElement;
	origin: string;
	partitionKey: string;
	navigated: boolean;
	ready: boolean;
	current: string;
	pending?: string;
	history: string[];
	index: number;
	epoch: number;
	zoom: number;
	muted: boolean;
	userAgent?: string;
	attr: string | null;
	calls: Map<string, { ok(v: unknown): void; no(e: Error): void }>;
	interceptors: Set<WebRequestInterceptor>;
	scripts: Map<string, ContentScript>;
	menus: FrameMenus;
	failure?: HTMLElement;
	size: { width: number; height: number };
}

const unsupported = (message: string) => new DOMException(message, "NotSupportedError");
const EVENTS = [
	"loadstart",
	"loadcommit",
	"contentload",
	"loadstop",
	"loadabort",
	"loadredirect",
	"consolemessage",
	"newwindow",
	"close",
	"dialog",
	"permissionrequest",
	"sizechanged",
	"zoomchange",
	"exit",
	"responsive",
	"unresponsive",
];

export function installFrames(config: GuestConfig, bridge: Bridge) {
	const enabled = allowsIsolated(config.manifest, "controlled-frame", config.id);
	const session = crypto.randomUUID();
	const nativeFetch = globalThis.fetch.bind(globalThis);
	const states = new WeakMap<HTMLElement, State>();
	const live = new Set<HTMLElement>();
	const appBase = `isolated-app://${config.id}`;

	/** URL the app sees: bundled pages keep their isolated-app:// identity. */
	const exposed = (virtual: string) =>
		virtual.startsWith(`${BUNDLE_ORIGIN}/`) ? appBase + virtual.slice(BUNDLE_ORIGIN.length) : virtual;
	/** URL the proxy loads. */
	function target(raw: string): string {
		const u = new URL(raw.replace(`${appBase}/`, `${location.origin}/`), document.baseURI);
		if (u.origin === location.origin) return BUNDLE_ORIGIN + u.pathname + u.search + u.hash;
		if (!["http:", "https:"].includes(u.protocol))
			throw new TypeError(`Controlled frames can't load ${u.protocol} URLs`);
		if (u.username || u.password) throw new TypeError("URLs with credentials are not supported");
		return u.href;
	}

	function fire(el: HTMLElement, type: string, props: Record<string, unknown> = {}) {
		const event = Object.assign(
			new Event(type, { cancelable: type === "newwindow" || type === "dialog" }),
			props,
		);
		el.dispatchEvent(event);
		const handler = Reflect.get(el, `on${type}`);
		if (typeof handler === "function") handler.call(el, event);
		return event;
	}

	function state(el: HTMLElement): State {
		return states.get(el) ?? upgrade(el);
	}

	function call(el: HTMLElement, op: string, arg?: unknown): Promise<unknown> {
		const s = state(el);
		if (!s.ready || !s.origin || !s.iframe.contentWindow)
			return Promise.reject(
				new DOMException("The controlled frame has not finished loading", "InvalidStateError"),
			);
		const id = crypto.randomUUID();
		return new Promise((ok, no) => {
			const timer = setTimeout(() => {
				s.calls.delete(id);
				no(new DOMException("The controlled frame did not respond", "TimeoutError"));
			}, 15000);
			s.calls.set(id, {
				ok: (v) => {
					clearTimeout(timer);
					ok(v);
				},
				no: (e) => {
					clearTimeout(timer);
					no(e);
				},
			});
			s.iframe.contentWindow?.postMessage({ iyowa: "cf", id, op, arg }, s.origin);
		});
	}
	/** Fire-and-forget state pushed to the current document. */
	function push(el: HTMLElement, op: string, arg?: unknown) {
		const s = state(el);
		if (s.ready && s.origin)
			s.iframe.contentWindow?.postMessage({ iyowa: "cf", id: "", op, arg }, s.origin);
	}
	function syncDocument(el: HTMLElement) {
		const s = state(el);
		const patterns = [...s.interceptors].flatMap((i) =>
			i.urlPatterns.map((p) => (typeof p === "string" ? p : "*")),
		);
		push(el, "interceptors", patterns);
		push(el, "menus", [...s.menus.items.values()] satisfies MenuItem[]);
		if (s.muted) push(el, "mute", true);
		if (s.userAgent) push(el, "user-agent", s.userAgent);
	}

	async function source(o: Source): Promise<string> {
		if (typeof o?.code === "string") return o.code;
		const files = o?.files ?? (o?.file ? [o.file] : []);
		if (!files.length) throw new TypeError("Expected code or files");
		const parts = await Promise.all(
			files.map(async (f) => {
				const u = new URL(f.replace(`${appBase}/`, "/"), location.href);
				if (u.origin !== location.origin) throw new TypeError(`${f} is not part of the app bundle`);
				const r = await nativeFetch(u);
				if (!r.ok) throw new Error(`Couldn't load ${f}`);
				return r.text();
			}),
		);
		return parts.join("\n;\n");
	}

	async function partitionOrigin(el: HTMLElement, s: State): Promise<string> {
		const name = el.getAttribute("partition") || "";
		const persistent = name.startsWith("persist:");
		const key = persistent ? name : `${session}:${name}`;
		if (s.origin && s.partitionKey === key) return s.origin;
		const r = await nativeFetch("/.iyowa/frame-session", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ partition: key, persistent }),
		});
		if (!r.ok) throw new Error(await r.text());
		s.origin = ((await r.json()) as { origin: string }).origin;
		s.partitionKey = key;
		return s.origin;
	}

	function clearFailure(s: State) {
		s.failure?.remove();
		s.failure = undefined;
		s.iframe.style.visibility = "";
	}
	function fail(el: HTMLElement, url: string, error: unknown) {
		const s = state(el);
		const reason = String((error as Error)?.message ?? error);
		s.pending = undefined;
		s.ready = false;
		clearFailure(s);
		s.iframe.style.visibility = "hidden";
		const panel = document.createElement("div");
		panel.setAttribute("role", "status");
		panel.style.cssText =
			"position:absolute;inset:0;display:grid;place-content:center;gap:.5rem;padding:1rem;text-align:center;font:13px system-ui;color:GrayText;background:Canvas";
		const message = document.createElement("p");
		message.style.margin = "0";
		message.textContent = reason;
		panel.append(message);
		s.failure = panel;
		el.append(panel);
		fire(el, "loadabort", { url, isTopLevel: true, code: -2, reason });
	}

	function intercept(el: HTMLElement, phase: "before" | "done", request: FrameRequest) {
		const s = state(el);
		const url = exposed(request.url);
		const details = {
			url,
			method: request.method,
			type: request.type,
			frameId: 0,
			frameType: "outermost_frame",
			documentId: "",
			initiator: s.current ? new URL(s.current).origin : undefined,
		};
		let block = false;
		let headers = new Headers(request.headers ?? []);
		let replaced = false;
		for (const i of s.interceptors) {
			if (!i.applies(url, request.type)) continue;
			// Spec fields live on event.request; url/method/resourceType are also copied to the event
			// for <webview>-style handlers. (Event.type is read-only, so the resource type can't be.)
			const fields = {
				request: {
					...details,
					headers: i.includeHeaders === "none" ? undefined : new Headers(headers),
				},
				url,
				method: request.method,
				resourceType: request.type,
			};
			if (phase === "before") {
				if (
					!i.dispatchEvent(
						Object.assign(new Event("beforerequest", { cancelable: i.blocking }), fields),
					)
				)
					block = true;
				if (block) break;
				const sendHeaders = Object.assign(
					new Event("beforesendheaders", { cancelable: i.blocking }),
					fields,
					{
						headers: new Headers(headers),
						requestHeaders: new Headers(headers),
						setRequestHeaders(next: HeadersInit) {
							if (!i.blocking)
								throw new DOMException("Interceptor is not blocking", "InvalidStateError");
							headers = new Headers(next);
							replaced = true;
						},
					},
				);
				if (!i.dispatchEvent(sendHeaders)) block = true;
				i.dispatchEvent(
					Object.assign(new Event("sendheaders"), fields, { headers: new Headers(headers) }),
				);
			} else if (request.error) {
				i.dispatchEvent(Object.assign(new Event("erroroccurred"), fields, { error: request.error }));
			} else {
				const response = { statusCode: request.status, headers: new Headers(request.headers ?? []) };
				for (const name of ["headersreceived", "responsestarted", "completed"])
					i.dispatchEvent(
						Object.assign(new Event(name), fields, { response, statusCode: request.status }),
					);
			}
		}
		return { block, headers: replaced ? [...headers] : undefined };
	}

	async function runContentScripts(el: HTMLElement, when: ContentScript["runAt"]) {
		const s = state(el);
		for (const script of s.scripts.values()) {
			if (script.runAt !== when) continue;
			if (!script.urlPatterns.some((p) => matchesPattern(p, s.current))) continue;
			if (script.excludeUrlPatterns.some((p) => matchesPattern(p, s.current))) continue;
			try {
				if (script.css) await call(el, "css", await source(script.css));
				if (script.js) await call(el, "script", await source(script.js));
			} catch (e) {
				console.warn(`Content script "${script.name}" failed:`, e);
			}
		}
	}

	async function navigate(el: HTMLElement, raw: string, mode: "push" | "replace" | "traverse" = "push") {
		const s = state(el);
		const epoch = ++s.epoch;
		for (const c of s.calls.values()) c.no(new DOMException("The frame navigated", "AbortError"));
		s.calls.clear();
		clearFailure(s);
		if (!enabled) {
			fail(
				el,
				raw,
				new DOMException('The app manifest does not grant "controlled-frame"', "NotAllowedError"),
			);
			return;
		}
		let proxied: string;
		try {
			proxied = target(raw);
		} catch (e) {
			fail(el, raw, e);
			return;
		}
		const url = exposed(proxied);
		if (intercept(el, "before", { url: proxied, method: "GET", type: "main_frame" }).block) {
			fail(el, url, new Error("The app blocked this navigation"));
			return;
		}
		fire(el, "loadstart", { url, isTopLevel: true });
		s.pending = url;
		if (mode === "push") {
			s.history.splice(s.index + 1);
			s.history.push(url);
			s.index = s.history.length - 1;
		} else if (mode === "replace" || s.index < 0) {
			if (s.index < 0) s.index = 0;
			s.history[s.index] = url;
		}
		try {
			const host = new URL(proxied).hostname;
			if (!proxied.startsWith(BUNDLE_ORIGIN) && isPrivateHost(host)) {
				const granted =
					(await bridge.permission("local-network", `show ${host} in an embedded frame`)) ===
					"granted";
				if (!granted) throw new Error(`Access to ${host} on your local network was not allowed`);
			}
			const origin = await partitionOrigin(el, s);
			if (s.epoch !== epoch) return;
			s.ready = false;
			const start = `${origin}/.iyowa/start#${encodeURIComponent(proxied)}`;
			const view = `${origin}/view/${encodeURIComponent(proxied)}`;
			const win = s.iframe.contentWindow;
			// Replace (not push) so the launcher tab's own history isn't affected.
			if (s.navigated && win) win.location.replace(s.iframe.dataset.origin === origin ? view : start);
			else s.iframe.src = start;
			s.iframe.dataset.origin = origin;
			s.navigated = true;
		} catch (e) {
			if (s.epoch === epoch) fail(el, url, e);
		}
	}

	function onFrameMessage(
		el: HTMLElement,
		s: State,
		m: Record<string, unknown>,
		ports: readonly MessagePort[],
	) {
		if (m.kind === "reply") {
			const c = s.calls.get(String(m.id));
			s.calls.delete(String(m.id));
			if (m.error) c?.no(new Error(String(m.error)));
			else c?.ok(m.value);
			return;
		}
		if (m.kind === "intercept" && ports[0]) {
			let decision = {};
			try {
				decision = intercept(el, "before", m.request as FrameRequest);
			} catch (e) {
				console.error(e);
			}
			ports[0].postMessage(decision);
			ports[0].close();
			return;
		}
		if (m.kind === "request-done") {
			intercept(el, "done", m.request as FrameRequest);
			return;
		}
		if (m.kind === "menu-click") {
			const context = (m.context ?? {}) as Record<string, unknown>;
			const click = Object.assign(new Event("click"), {
				menuItemId: m.id,
				pageUrl: exposed(String(context.pageUrl ?? s.current)),
				frameUrl: exposed(String(context.pageUrl ?? s.current)),
				linkUrl: context.linkUrl || undefined,
				srcUrl: context.srcUrl || undefined,
				selectionText: context.selectionText || undefined,
				mediaType: context.mediaType || undefined,
				editable: !!context.editable,
			});
			s.menus.dispatchEvent(click);
			s.menus.onclick?.call(s.menus, click);
			return;
		}
		if (m.kind !== "event" || !EVENTS.includes(String(m.name))) return;
		const fields = (m.fields ?? {}) as Record<string, unknown>;
		const url = typeof fields.url === "string" ? exposed(fields.url) : s.current;
		switch (m.name) {
			case "loadcommit": {
				s.ready = true;
				if (s.pending !== undefined) {
					if (url !== s.pending) {
						fire(el, "loadredirect", { oldUrl: s.pending, newUrl: url, isTopLevel: true });
						s.history[s.index] = url;
					}
				} else if (url !== s.history[s.index]) {
					// A navigation started inside the page (link, form, script).
					fire(el, "loadstart", { url, isTopLevel: true });
					s.history.splice(s.index + 1);
					s.history.push(url);
					s.index = s.history.length - 1;
				}
				s.pending = undefined;
				s.current = url;
				clearFailure(s);
				syncDocument(el);
				fire(el, "loadcommit", { url, isTopLevel: true });
				void runContentScripts(el, "document_start");
				return;
			}
			case "contentload":
				fire(el, "contentload", {});
				void runContentScripts(el, "document_end");
				return;
			case "loadstop":
				fire(el, "loadstop", {});
				void runContentScripts(el, "document_idle");
				return;
			case "loadabort":
				fail(el, url, fields.reason ?? "The page could not be loaded");
				return;
			case "newwindow": {
				const targetUrl = exposed(String(fields.targetUrl));
				fire(el, "newwindow", {
					targetUrl,
					name: fields.name,
					windowOpenDisposition: fields.windowOpenDisposition,
					initialWidth: 0,
					initialHeight: 0,
					window: {
						attach(other: HTMLElement) {
							if (other?.localName !== "controlledframe")
								throw new TypeError("Expected a <controlledframe>");
							if (!other.getAttribute("partition") && el.getAttribute("partition"))
								other.setAttribute("partition", el.getAttribute("partition") || "");
							(other as HTMLElement & { src: string }).src = targetUrl;
						},
						discard() {},
					},
				});
				return;
			}
			default:
				fire(el, String(m.name), { ...fields, url });
		}
	}

	function upgrade(el: HTMLElement): State {
		const existing = states.get(el);
		if (existing) return existing;
		const iframe = document.createElement("iframe");
		iframe.title = el.getAttribute("title") || "Embedded content";
		iframe.setAttribute(
			"sandbox",
			"allow-scripts allow-same-origin allow-forms allow-downloads allow-modals allow-popups allow-pointer-lock allow-presentation",
		);
		iframe.allow = "clipboard-write; fullscreen";
		iframe.style.cssText =
			"flex:1 1 auto;align-self:stretch;display:block;border:0;min-width:0;min-height:0";
		const s: State = {
			iframe,
			origin: "",
			partitionKey: "",
			navigated: false,
			ready: false,
			current: "",
			history: [],
			index: -1,
			epoch: 0,
			zoom: 1,
			muted: false,
			attr: null,
			calls: new Map(),
			interceptors: new Set(),
			scripts: new Map(),
			menus: new FrameMenus(),
			size: { width: 0, height: 0 },
		};
		s.menus.onchange = () => push(el, "menus", [...s.menus.items.values()]);
		states.set(el, s);
		const go = async (delta: number) => {
			const i = s.index + delta;
			if (!Number.isInteger(delta) || i < 0 || i >= s.history.length || delta === 0) return false;
			s.index = i;
			await navigate(el, s.history[i] ?? "", "traverse");
			return true;
		};
		new ResizeObserver(([entry]) => {
			if (!entry) return;
			const { width, height } = entry.contentRect;
			if (width === s.size.width && height === s.size.height) return;
			fire(el, "sizechanged", {
				oldWidth: s.size.width,
				oldHeight: s.size.height,
				newWidth: width,
				newHeight: height,
			});
			s.size = { width, height };
		}).observe(el);

		Object.defineProperties(el, {
			src: {
				configurable: true,
				get: () => s.current || el.getAttribute("src") || "",
				set: (value: string) => {
					s.attr = String(value);
					el.setAttribute("src", String(value));
					if (el.isConnected) void navigate(el, String(value));
				},
			},
			partition: {
				configurable: true,
				get: () => el.getAttribute("partition") || "",
				set: (value: string) => {
					if (s.navigated)
						throw new DOMException(
							"The partition can't change after navigation",
							"InvalidStateError",
						);
					el.setAttribute("partition", String(value));
				},
			},
			contentWindow: { configurable: true, get: () => iframe.contentWindow },
			contextMenus: { configurable: true, value: s.menus },
			request: {
				configurable: true,
				value: {
					createWebRequestInterceptor(options: InterceptorOptions) {
						const interceptor = new WebRequestInterceptor(options);
						s.interceptors.add(interceptor);
						syncDocument(el);
						return interceptor;
					},
					removeWebRequestInterceptor(interceptor: WebRequestInterceptor) {
						s.interceptors.delete(interceptor);
						syncDocument(el);
					},
				},
			},
		});
		Object.assign(el, {
			back: () => go(-1),
			forward: () => go(1),
			go: (n: number) => go(n),
			canGoBack: async () => s.index > 0,
			canGoForward: async () => s.index + 1 < s.history.length,
			reload: async () => {
				if (s.current || el.getAttribute("src"))
					await navigate(el, s.current || el.getAttribute("src") || "", "replace");
			},
			stop: async () => {
				await call(el, "stop").catch(() => {});
			},
			terminate: async () => {
				++s.epoch;
				iframe.src = "about:blank";
				s.ready = false;
				s.navigated = false;
				fire(el, "exit", { processId: 0, reason: "killed" });
			},
			executeScript: async (details: Source & { allFrames?: boolean }) => [
				await call(el, "script", await source(details)),
			],
			insertCSS: async (details: Source) => {
				await call(el, "css", await source(details));
			},
			addContentScripts: async (list: (Record<string, unknown> & { name: string })[]) => {
				for (const c of list) {
					if (!c?.name) throw new TypeError("Content scripts need a name");
					const runAt = String(c.runAt ?? c.run_at ?? "document_idle") as ContentScript["runAt"];
					s.scripts.set(c.name, {
						name: c.name,
						urlPatterns: clonePatterns(c.urlPatterns ?? c.matches) ?? ["<all_urls>"],
						excludeUrlPatterns: clonePatterns(c.excludeUrlPatterns ?? c.exclude_matches) ?? [],
						js: c.js as Source | undefined,
						css: c.css as Source | undefined,
						runAt: ["document_start", "document_end", "document_idle"].includes(runAt)
							? runAt
							: "document_idle",
					});
				}
			},
			removeContentScripts: async (names?: string[]) => {
				if (names) for (const n of names) s.scripts.delete(n);
				else s.scripts.clear();
			},
			clearData: async (options: { since?: number } = {}, types?: Record<string, boolean>) => {
				if (options?.since && options.since > 0)
					throw unsupported("Clearing a time range is not supported");
				await call(el, "clear", types);
			},
			getZoom: async () => s.zoom,
			setZoom: async (factor: number) => {
				if (!Number.isFinite(factor) || factor <= 0) throw new TypeError("Invalid zoom factor");
				const oldZoomFactor = s.zoom;
				s.zoom = factor;
				Object.assign(iframe.style, {
					position: factor === 1 ? "" : "absolute",
					inset: factor === 1 ? "" : "0",
					width: factor === 1 ? "" : `${100 / factor}%`,
					height: factor === 1 ? "" : `${100 / factor}%`,
					transform: factor === 1 ? "" : `scale(${factor})`,
					transformOrigin: "0 0",
				});
				fire(el, "zoomchange", { oldZoomFactor, newZoomFactor: factor });
			},
			getZoomMode: async () => "per-view",
			setZoomMode: async () => {},
			setAudioMuted: async (mute: boolean) => {
				s.muted = !!mute;
				await call(el, "mute", s.muted).catch(() => {});
			},
			isAudioMuted: async () => s.muted,
			getAudioState: async () => !!(await call(el, "audible").catch(() => false)),
			getUserAgent: () => s.userAgent ?? navigator.userAgent,
			isUserAgentOverridden: () => s.userAgent !== undefined,
			setUserAgentOverride: (ua: string) => {
				s.userAgent = ua || undefined;
				push(el, "user-agent", s.userAgent ?? "");
			},
			print: async () => {
				await call(el, "print");
			},
			find: async (text: string) => call(el, "find", String(text)),
			stopFinding: () => {},
			captureVisibleRegion: async () => {
				throw unsupported("captureVisibleRegion is not available in a browser tab");
			},
			focus: () => iframe.focus(),
		});
		return s;
	}

	function connect(el: HTMLElement) {
		const s = upgrade(el);
		if (!el.contains(s.iframe)) el.append(s.iframe);
		if (live.has(el)) return;
		live.add(el);
		const src = el.getAttribute("src");
		s.attr = src;
		if (src) void navigate(el, src);
	}

	// "controlledframe" isn't a valid custom element name, so upgrade instances directly.
	const create = Document.prototype.createElement;
	Document.prototype.createElement = function (
		this: Document,
		name: string,
		options?: ElementCreationOptions,
	) {
		const el = create.call(this, name, options);
		if (String(name).toLowerCase() === "controlledframe") upgrade(el);
		return el;
	} as typeof Document.prototype.createElement;
	const visit = (node: Node, fn: (el: HTMLElement) => void) => {
		if (!(node instanceof HTMLElement)) return;
		if (node.localName === "controlledframe") fn(node);
		for (const el of node.querySelectorAll<HTMLElement>("controlledframe")) fn(el);
	};
	new MutationObserver((records) => {
		for (const r of records) {
			if (
				r.type === "attributes" &&
				r.target instanceof HTMLElement &&
				r.target.localName === "controlledframe"
			) {
				const el = r.target;
				const s = states.get(el);
				const src = el.getAttribute("src");
				if (s && el.isConnected && src && src !== s.attr) {
					s.attr = src;
					void navigate(el, src);
				}
				continue;
			}
			for (const n of r.addedNodes) visit(n, (el) => el.isConnected && connect(el));
			for (const n of r.removedNodes)
				visit(n, (el) => {
					if (el.isConnected) return;
					live.delete(el);
					const s = states.get(el);
					if (s) {
						s.epoch++;
						s.ready = false;
						s.navigated = false;
					}
				});
		}
	}).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["src"] });
	document.addEventListener("DOMContentLoaded", () => {
		for (const el of document.querySelectorAll<HTMLElement>("controlledframe")) connect(el);
	});

	addEventListener("message", (e) => {
		if (e.data?.iyowa !== "frame") return;
		for (const el of live) {
			const s = state(el);
			if (e.source !== s.iframe.contentWindow || e.origin !== s.origin) continue;
			onFrameMessage(el, s, e.data, e.ports);
			return;
		}
	});

	const style = document.createElement("style");
	// Like the native element: a 300×150 default that stretches as a grid/flex item.
	style.textContent =
		":where(controlledframe){display:inline-flex;position:relative;overflow:hidden;vertical-align:top}";
	(document.head || document.documentElement).prepend(style);
}
