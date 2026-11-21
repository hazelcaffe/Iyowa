import { FrameMenus, type MenuContext } from "./frame-menu.ts";
import { allows } from "./policy.ts";
import type { GuestConfig } from "./types.ts";

type Frame = HTMLElement & { src: string; partition: string };
type Source = { code?: string; files?: string[]; file?: string };
type State = {
	menus: FrameMenus;
	iframe: HTMLIFrameElement;
	history: string[];
	index: number;
	epoch: number;
	managed: string;
	ready: boolean;
	zoom: number;
	last: string;
	redirects: number;
	failure?: HTMLElement;
	partition: string;
	observer: ResizeObserver;
	pending: Map<string, (value: unknown, error?: string) => void>;
	interceptors: Set<Interceptor>;
	scripts: Map<string, ContentScript>;
};
type ContentScript = { name: string; matches?: string[]; js?: Source; css?: Source };
const unsupported = (s: string) => new DOMException(s, "NotSupportedError");
const events = [
	"loadstart",
	"loadcommit",
	"contentload",
	"loadstop",
	"loadabort",
	"loadredirect",
	"sizechanged",
	"zoomchange",
	"consolemessage",
	"newwindow",
	"dialog",
	"permissionrequest",
	"close",
];
function matches(patterns: (string | { test: (url: string) => boolean })[], url: string) {
	return patterns.some((p) =>
		typeof p === "string"
			? p === "<all_urls>" ||
				new RegExp(
					"^" +
						p
							.split("*")
							.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
							.join(".*") +
						"$",
				).test(url)
			: p.test(url),
	);
}
class Interceptor extends EventTarget {
	patterns: string[];
	blocking: boolean;
	constructor(o: { urlPatterns?: string[]; blocking?: boolean }) {
		super();
		this.patterns = o.urlPatterns || ["*"];
		this.blocking = !!o.blocking;
	}
}

export function installFrames(config: GuestConfig) {
	const states = new WeakMap<Frame, State>(),
		active = new Set<Frame>();
	const session = crypto.randomUUID(),
		enabled =
			allows(config.manifest, "controlled-frame", config.id) &&
			allows(config.manifest, "cross-origin-isolated", config.id);
	function fire(el: Frame, type: string, props: Record<string, unknown> = {}) {
		const e = Object.assign(new CustomEvent(type, { detail: props, cancelable: true }), {
			isTopLevel: true,
			url: el.src,
			...props,
		});
		el.dispatchEvent(e);
		const cb = Reflect.get(el, `on${type}`);
		if (typeof cb === "function") cb.call(el, e);
		return e;
	}
	function state(el: Frame) {
		return states.get(el) || upgrade(el);
	}
	function reset(s: State) {
		s.ready = false;
		s.managed = "";
		s.failure?.remove();
		s.failure = undefined;
		s.iframe.style.display = "block";
		s.epoch++;
		for (const cb of s.pending.values()) cb(undefined, "Frame navigated or detached");
		s.pending.clear();
	}
	function failed(el: Frame, reason: string, target: string) {
		const s = state(el);
		s.ready = false;
		s.failure?.remove();
		s.iframe.style.display = "none";
		const panel = document.createElement("div"),
			message = document.createElement("p");
		panel.setAttribute("role", "status");
		message.textContent = reason;
		panel.append(message);
		try {
			const u = new URL(target, location.href);
			if (u.protocol === "https:" && !u.username && !u.password) {
				const link = document.createElement("a");
				link.href = u.href;
				link.target = "_blank";
				link.rel = "noopener noreferrer";
				link.textContent = `Open ${u.hostname} in a browser tab`;
				panel.append(link);
			}
		} catch {
			/* Invalid URL: display only the error. */
		}
		s.failure = panel;
		el.append(panel);
		fire(el, "loadabort", { url: target, reason });
	}
	function send(el: Frame, op: string, arg?: unknown): Promise<unknown> {
		const s = state(el);
		if (!s.ready || !s.managed)
			return Promise.reject(unsupported("This operation requires a loaded, managed frame"));
		return new Promise((ok, no) => {
			const id = crypto.randomUUID();
			const timer = setTimeout(() => {
				s.pending.delete(id);
				no(Error("Controlled frame request timed out"));
			}, 5000);
			s.pending.set(id, (v, error) => {
				clearTimeout(timer);
				if (error) no(Error(error));
				else ok(v);
			});
			s.iframe.contentWindow?.postMessage({ iyowa: "command", id, op, arg }, s.managed);
		});
	}
	async function source(o: Source) {
		if (typeof o.code === "string") return o.code;
		const files = o.files || (o.file ? [o.file] : []);
		if (!files.length) throw TypeError("Expected code or files");
		return (
			await Promise.all(
				files.map(async (f) => {
					const u = new URL(f, location.href);
					if (u.origin !== location.origin) throw TypeError("File must be bundled");
					const r = await fetch(u);
					if (!r.ok) throw Error(`Missing ${f}`);
					return r.text();
				}),
			)
		).join("\n");
	}
	async function navigate(el: Frame, raw: string, push = true, redirect = false) {
		const s = state(el);
		reset(s);
		if (!redirect) s.redirects = 0;
		const epoch = s.epoch;
		try {
			if (!enabled) throw new DOMException("controlled-frame not granted", "NotAllowedError");
			const u = new URL(
				raw.replace(`isolated-app://${config.id}/`, `${location.origin}/`),
				location.href,
			);
			if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
				throw Error("Unsupported frame URL");
			for (const i of s.interceptors)
				if (matches(i.patterns, u.href)) {
					const e = Object.assign(new Event("beforerequest", { cancelable: i.blocking }), {
						url: u.href,
						method: "GET",
						typeOfResource: "main_frame",
					});
					if (!i.dispatchEvent(e)) throw Error("Navigation blocked by interceptor");
				}
			s.last = u.href;
			fire(el, "loadstart", { url: u.href });
			if (push) {
				s.history.splice(s.index + 1, Infinity, u.href);
				s.index = s.history.length - 1;
			}
			if (
				u.origin === location.origin ||
				u.protocol === "https:" ||
				config.managedOrigins.includes(u.origin)
			) {
				const virtual = u.origin === location.origin ? "https://bundle.invalid" : u.origin;
				const partition = el.partition.startsWith("persist:")
					? el.partition
					: `${session}:${el.partition}`;
				const r = await fetch("/.iyowa/frame-session", {
					method: "POST",
					body: JSON.stringify({ virtual, partition }),
				});
				if (!r.ok) throw Error(await r.text());
				const { origin } = await r.json();
				if (s.epoch !== epoch) return;
				s.managed = origin;
				s.iframe.src = `${origin}/.iyowa/start#${encodeURIComponent(virtual + u.pathname + u.search + u.hash)}`;
			} else {
				throw Error("Remote controlled frames need HTTPS or a configured development origin");
			}
		} catch (e) {
			if (s.epoch === epoch) {
				s.managed = "";
				s.iframe.removeAttribute("src");
				failed(el, e instanceof Error ? e.message : String(e), raw);
			}
		}
	}
	function upgrade(el: Frame): State {
		const existing = states.get(el);
		if (existing) return existing;
		const iframe = document.createElement("iframe");
		iframe.title = "Controlled frame";
		iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-downloads");
		iframe.style.cssText = "width:100%;height:100%;border:0;display:block";
		const observer = new ResizeObserver(([r]) => {
			if (r)
				fire(el, "sizechanged", { newWidth: r.contentRect.width, newHeight: r.contentRect.height });
		});
		const s: State = {
			menus: new FrameMenus(),
			iframe,
			history: [],
			index: -1,
			last: "",
			redirects: 0,
			epoch: 0,
			managed: "",
			ready: false,
			zoom: 1,
			partition: "",
			observer,
			pending: new Map(),
			interceptors: new Set(),
			scripts: new Map(),
		};
		states.set(el, s);
		const go = async (n: number) => {
			const i = s.index + n;
			if (!s.history[i]) return false;
			s.index = i;
			await navigate(el, s.history[i], false);
			return true;
		};
		Object.defineProperties(el, {
			contextMenus: { value: s.menus },
			src: {
				configurable: true,
				get: () => el.getAttribute("src") || "",
				set: (v: string) => el.setAttribute("src", v),
			},
			partition: {
				configurable: true,
				get: () => el.getAttribute("partition") || "",
				set: (v: string) => el.setAttribute("partition", v),
			},
			contentWindow: { get: () => iframe.contentWindow },
			request: {
				value: {
					createWebRequestInterceptor: (o: ConstructorParameters<typeof Interceptor>[0]) => {
						const i = new Interceptor(o);
						s.interceptors.add(i);
						return i;
					},
					removeWebRequestInterceptor: (i: Interceptor) => s.interceptors.delete(i),
				},
			},
		});
		Object.assign(el, {
			back: () => go(-1),
			forward: () => go(1),
			go,
			canGoBack: () => s.index > 0,
			canGoForward: () => s.index + 1 < s.history.length,
			reload: () => navigate(el, s.last || el.src, false),
			stop: () => {
				reset(s);
				iframe.removeAttribute("src");
				fire(el, "loadabort", { reason: "Stopped" });
			},
			getZoom: async () => s.zoom,
			setZoom: async (v: number) => {
				if (!Number.isFinite(v) || v <= 0) throw TypeError("Invalid zoom");
				const oldZoomFactor = s.zoom;
				s.zoom = v;
				iframe.style.transformOrigin = "top left";
				iframe.style.transform = `scale(${v})`;
				iframe.style.width = `${100 / v}%`;
				iframe.style.height = `${100 / v}%`;
				fire(el, "zoomchange", { oldZoomFactor, newZoomFactor: v });
			},
			executeScript: async (o: Source) => [await send(el, "script", await source(o))],
			insertCSS: async (o: Source) => {
				await send(el, "css", await source(o));
			},
			clearData: async (o?: { since?: number }, types?: Record<string, boolean>) => {
				if (o?.since) throw unsupported("Time-range clearing is unavailable");
				if (
					types &&
					Object.entries(types).some(
						([k, v]) =>
							v &&
							![
								"cookies",
								"sessionStorage",
								"localStorage",
								"cache",
								"cacheStorage",
								"indexedDB",
							].includes(k),
					)
				)
					throw unsupported("Unsupported storage type");
				await send(el, "clear", types);
			},
			addContentScripts: async (list: ContentScript[]) => {
				for (const c of list) s.scripts.set(c.name, c);
			},
			removeContentScripts: async (names?: string[]) => {
				if (names) for (const n of names) s.scripts.delete(n);
				else s.scripts.clear();
			},
			focus: () => iframe.focus(),
			getUserAgent: () => navigator.userAgent,
			setAudioMuted: (mute: boolean) => send(el, "mute", Boolean(mute)),
			isAudioMuted: () => send(el, "muted"),
			getAudioState: () => send(el, "audible"),
			print: () => send(el, "print"),
		});
		return s;
	}
	// "controlledframe" is not a valid custom element name. Upgrade parser-created instances
	// before app scripts can retrieve them, and programmatic instances at creation time.
	const create = Document.prototype.createElement;
	Document.prototype.createElement = function (name: string, options?: ElementCreationOptions) {
		const el = create.call(this, name, options);
		if (name.toLowerCase() === "controlledframe") upgrade(el as Frame);
		return el;
	};
	function connect(el: Frame) {
		const s = upgrade(el);
		if (!el.contains(s.iframe)) el.append(s.iframe);
		if (active.has(el)) return;
		active.add(el);
		s.observer.observe(el);
		if (el.src) void navigate(el, el.src);
	}
	const visit = (n: Node, fn: (el: Frame) => void) => {
		if (n instanceof Element) {
			if (n.localName === "controlledframe") fn(n as Frame);
			for (const el of n.querySelectorAll<Frame>("controlledframe")) fn(el);
		}
	};
	new MutationObserver((records) => {
		for (const rec of records) {
			if (rec.type === "attributes") {
				const el = rec.target as Frame;
				if (el.localName === "controlledframe" && el.isConnected) {
					const s = states.get(el);
					if (s && s.last !== el.src && el.src) void navigate(el, el.src);
				}
			}
			for (const n of rec.addedNodes)
				visit(n, (el) => {
					if (el.isConnected) connect(el);
				});
			for (const n of rec.removedNodes)
				visit(n, (el) => {
					if (!el.isConnected) {
						const s = state(el);
						reset(s);
						s.observer.disconnect();
						active.delete(el);
					}
				});
		}
	}).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["src"] });
	document.addEventListener("DOMContentLoaded", () => {
		for (const el of document.querySelectorAll<Frame>("controlledframe")) connect(el);
	});
	addEventListener("message", (e) => {
		for (const el of active) {
			const s = state(el);
			if (e.source !== s.iframe.contentWindow || e.origin !== s.managed) continue;
			const d = e.data;
			if (d?.iyowa === "redirect" && typeof d.url === "string") {
				if (++s.redirects > 6) {
					failed(el, "Too many frame redirects", s.last);
					break;
				}
				fire(el, "loadredirect", { oldUrl: s.last, newUrl: d.url });
				s.history[s.index] = d.url;
				void navigate(el, d.url, false, true);
			} else if (d?.iyowa === "menu" && e.ports[0]) {
				const items = s.menus.applicable(d.context as MenuContext, s.last, matches);
				e.ports[0].postMessage(items);
				e.ports[0].close();
			} else if (d?.iyowa === "menu-click" && s.menus.items.has(d.id)) {
				s.menus.dispatchEvent(
					Object.assign(new Event("click"), { menuItemId: d.id, pageUrl: s.last, ...d.context }),
				);
			} else if (d?.iyowa === "intercept" && e.ports[0]) {
				let headers = new Headers(d.headers);
				let block = false;
				const url = String(d.url).replace("https://bundle.invalid/", `${location.origin}/`);
				for (const i of s.interceptors)
					if (matches(i.patterns, url)) {
						const fields = { url, method: d.method, typeOfResource: "xmlhttprequest" };
						if (
							!i.dispatchEvent(
								Object.assign(new Event("beforerequest", { cancelable: i.blocking }), fields),
							)
						)
							block = true;
						if (
							!i.dispatchEvent(
								Object.assign(
									new Event("beforesendheaders", { cancelable: i.blocking }),
									fields,
									{
										headers: new Headers(headers),
										setRequestHeaders: (next: Headers) => {
											if (i.blocking) headers = new Headers(next);
										},
									},
								),
							)
						)
							block = true;
					}
				e.ports[0].postMessage({ block, headers: [...headers] });
				e.ports[0].close();
			} else if (d?.iyowa === "reply") {
				s.pending.get(d.id)?.(d.value, d.error);
				s.pending.delete(d.id);
			} else if (d?.iyowa === "event" && events.includes(d.name)) {
				if (d.name === "loadabort") {
					failed(el, String(d.fields?.reason || "Frame unavailable"), s.last);
					break;
				}
				if (d.name === "loadcommit") s.ready = true;
				if (d.name === "contentload")
					for (const c of s.scripts.values())
						if (matches(c.matches || ["*"], s.last)) {
							const apply = async () => {
								if (c.css) await send(el, "css", await source(c.css));
								if (c.js) await send(el, "script", await source(c.js));
							};
							void apply().catch(console.warn);
						}
				const props = { url: s.last, ...d.fields };
				if (d.name === "newwindow")
					props.window = {
						attach: (other: Frame) => {
							other.src = String(props.targetUrl).replace(
								"https://bundle.invalid/",
								`${location.origin}/`,
							);
						},
						discard: () => {},
					};
				fire(el, d.name, props);
			}
			break;
		}
	});
	const style = document.createElement("style");
	// A grid/flex track can stretch the frame; a default size must not pin the Kitchen Sink
	// demo to a 300px box when the author gives it the whole remaining row.
	style.textContent =
		":where(controlledframe){display:inline-block;min-inline-size:min(300px,100%);min-block-size:150px;overflow:auto}";
	(document.head || document.documentElement).append(style);
}
