import { SCRAMJETCLIENT, ScramjetClient } from "@mercuryworkshop/scramjet";
import {
	applicableItems,
	globToRegExp,
	type MenuContext,
	type MenuItem,
	renderMenu,
} from "../runtime/frame-menu.ts";
import { frameContext, type Natives, workerTransport } from "./context.ts";

// Runs at the top of every proxied document in a controlled-frame partition, before page scripts.
// Scramjet rewrites what the page sees: message origins, postMessage payloads, window.parent and
// listener callbacks. Everything this bridge needs is captured, and every listener registered,
// before the client hooks the document.

const config = globalThis.__iyowaFrame;
const boot = globalThis.__iyowaFrameBoot ?? { cookies: "", headers: [], history: [] };
const preinstalled = Reflect.get(globalThis, SCRAMJETCLIENT) as ScramjetClient | undefined;
/** The partition's top document talks to the embedding app; nested frames are ordinary page content. */
const isTop = !preinstalled && window.frameElement === null;

const listen = EventTarget.prototype.addEventListener;
const portPost = MessagePort.prototype.postMessage;
const natives: Natives = {
	Worker: globalThis.Worker,
	fetch: globalThis.fetch.bind(globalThis),
	listen,
	post: Worker.prototype.postMessage,
};
const storage = { local: globalThis.localStorage, session: globalThis.sessionStorage };
const caches = globalThis.caches;
const idb = globalThis.indexedDB;
const services = navigator.serviceWorker;
const serviceOf = () => services?.controller ?? null;
const owner = window.parent;
const ownerPost = owner.postMessage.bind(owner);
const reply = (port: MessagePort, value: unknown) => {
	portPost.call(port, value);
	port.close();
};

const context = frameContext();
if (boot.cookies) context.cookieJar.load(boot.cookies);
const transport = workerTransport(natives);
let client: ScramjetClient | undefined;
const href = () => String(client?.url.href ?? "");

function install(scope: typeof globalThis): ScramjetClient {
	const existing = Reflect.get(scope, SCRAMJETCLIENT) as ScramjetClient | undefined;
	if (existing) {
		existing.syncDocumentInit({
			initHeaders: boot.headers,
			history: boot.history,
			cookies: boot.cookies,
		});
		return existing;
	}
	const created = new ScramjetClient(scope, {
		context,
		transport,
		initHeaders: boot.headers,
		history: boot.history,
		sendSetCookie: async (cookies) => {
			serviceOf()?.postMessage({
				iyowa: "cookies",
				cookies: cookies.map((entry) => ({ url: String(entry.url), cookie: entry.cookie })),
			});
		},
		hookSubcontext: (child) => install(child as unknown as typeof globalThis),
	});
	created.hook();
	return created;
}

if (isTop) {
	const post = (message: Record<string, unknown>, transfer: Transferable[] = []) =>
		ownerPost({ iyowa: "frame", ...message }, config.parent, transfer);
	const emit = (name: string, fields: Record<string, unknown> = {}) =>
		post({ kind: "event", name, fields });
	let patterns: string[] = [];
	let menuItems: MenuItem[] = [];
	let muted = false;
	let userAgent: string | undefined;
	const matches = (url: string) =>
		patterns.some((p) => p === "*" || p === "<all_urls>" || globToRegExp(p).test(url));

	if (services) {
		listen.call(services, "message", ((e: MessageEvent) => {
			const m = e.data;
			if (m?.iyowa === "intercept" && e.ports[0]) {
				const port = e.ports[0];
				if (matches(m.url)) post({ kind: "intercept", request: m }, [port]);
				else reply(port, {});
			} else if (m?.iyowa === "request-done" && matches(m.url))
				post({ kind: "request-done", request: m });
		}) as EventListener);
		services.startMessages();
	}

	async function clear(types?: Record<string, boolean>) {
		const all = !types || Object.keys(types).length === 0;
		const want = (k: string) => all || !!types?.[k];
		if (want("localStorage")) storage.local.clear();
		if (want("sessionStorage")) storage.session.clear();
		if (want("cookies")) {
			context.cookieJar.clear();
			serviceOf()?.postMessage({ iyowa: "clear-cookies" });
		}
		if (want("cache") || want("cacheStorage"))
			for (const key of await caches.keys()) if (key !== "iyowa-frame") await caches.delete(key);
		if (want("indexedDB"))
			for (const db of await idb.databases())
				if (db.name)
					await new Promise<void>((ok, no) => {
						const r = idb.deleteDatabase(db.name as string);
						r.onsuccess = () => ok();
						r.onerror = () => no(r.error);
						r.onblocked = () => ok();
					});
	}

	async function command(op: string, arg: unknown): Promise<unknown> {
		switch (op) {
			case "script":
				// Rewritten like page script, so `location` etc. describe the proxied site.
				if (!client) throw new Error("The page is still starting");
				return await (client.indirectEval as (code: string) => unknown)(String(arg));
			case "css": {
				const style = document.createElement("style");
				style.dataset.iyowaInserted = "";
				style.textContent = String(arg);
				(document.head || document.documentElement).append(style);
				return;
			}
			case "menus":
				menuItems = Array.isArray(arg) ? (arg as MenuItem[]) : [];
				return;
			case "interceptors":
				patterns = Array.isArray(arg) ? arg.map(String) : [];
				serviceOf()?.postMessage({ iyowa: "intercepting", active: patterns.length > 0 });
				return;
			case "clear":
				return clear(arg as Record<string, boolean> | undefined);
			case "mute":
				muted = !!arg;
				for (const media of document.querySelectorAll<HTMLMediaElement>("audio,video"))
					media.muted = muted;
				return;
			case "audible":
				return [...document.querySelectorAll<HTMLMediaElement>("audio,video")].some(
					(m) => !m.paused && !m.muted && m.volume > 0,
				);
			case "user-agent":
				userAgent = typeof arg === "string" && arg ? arg : undefined;
				Object.defineProperty(navigator, "userAgent", {
					configurable: true,
					get: () => userAgent ?? Reflect.get(Navigator.prototype, "userAgent", navigator),
				});
				return;
			case "print":
				print();
				return;
			case "stop":
				stop();
				return;
			case "find": {
				const found =
					(window as Window & { find?: (s: string) => boolean }).find?.(String(arg)) ?? false;
				return { numberOfMatches: found ? 1 : 0, activeMatchOrdinal: found ? 1 : 0 };
			}
			default:
				throw new Error(`Unknown controlled frame operation: ${op}`);
		}
	}

	listen.call(window, "message", ((e: MessageEvent) => {
		if (e.source !== owner || e.origin !== config.parent || e.data?.iyowa !== "cf") return;
		const { op, arg, id } = e.data;
		void command(op, arg).then(
			(value) => {
				if (!id) return;
				try {
					post({ kind: "reply", id, value });
				} catch {
					// Results must be structured-cloneable; fall back to their JSON form.
					post({ kind: "reply", id, value: JSON.parse(JSON.stringify(value) ?? "null") });
				}
			},
			(error) => id && post({ kind: "reply", id, error: String((error as Error)?.message ?? error) }),
		);
	}) as EventListener);

	listen.call(window, "DOMContentLoaded", () =>
		emit("contentload", { url: href(), title: document.title }),
	);
	listen.call(window, "load", () => emit("loadstop", { url: href(), title: document.title }));
	listen.call(
		window,
		"play",
		(e: Event) => {
			if (muted && e.target instanceof HTMLMediaElement) e.target.muted = true;
		},
		true,
	);

	// New windows are offered to the app ("newwindow"); it may attach them to another frame.
	const openWindow = (url?: string | URL, name = "", features = "") => {
		emit("newwindow", {
			targetUrl: url ? new URL(String(url), href()).href : "about:blank",
			name,
			windowOpenDisposition: /popup|width|height/.test(features) ? "new_popup" : "new_foreground_tab",
		});
		return null;
	};
	listen.call(
		window,
		"click",
		(e: Event) => {
			const a = e.composedPath().find((n) => n instanceof HTMLAnchorElement) as
				| HTMLAnchorElement
				| undefined;
			if (!a || e.defaultPrevented || !a.href) return;
			const target = a.target.toLowerCase();
			if (target === "_blank" || (target && !["_self", "_top", "_parent"].includes(target))) {
				e.preventDefault();
				openWindow(client ? client.unrewriteUrl(a.href) : a.href, a.target);
			}
		},
		true,
	);

	listen.call(window, "contextmenu", ((e: MouseEvent) => {
		if (!(e.target instanceof Element) || !menuItems.length) return;
		const target = e.target;
		const link = (target.closest("a") as HTMLAnchorElement | null)?.href;
		const src = target.getAttribute("src");
		const menu: MenuContext = {
			x: e.clientX,
			y: e.clientY,
			selectionText: getSelection()?.toString() || "",
			linkUrl: link && client ? client.unrewriteUrl(link) : "",
			srcUrl: src && client ? client.unrewriteUrl(new URL(src, location.href).href) : "",
			mediaType:
				target.localName === "img"
					? "image"
					: ["video", "audio"].includes(target.localName)
						? target.localName
						: "",
			editable: target.matches("input,textarea,[contenteditable],[contenteditable=true]"),
		};
		// The app's items replace the page menu where they apply; otherwise the browser's menu shows.
		const items = applicableItems(menuItems, menu, href());
		if (!items.length) return;
		e.preventDefault();
		renderMenu(items, menu, (id) =>
			post({ kind: "menu-click", id, context: { ...menu, pageUrl: href() } }),
		);
	}) as EventListener);

	client = install(globalThis);
	Object.defineProperty(window, "open", { configurable: true, writable: true, value: openWindow });

	const levels = { debug: -1, log: 0, info: 0, warn: 1, error: 2 } as const;
	for (const level of Object.keys(levels) as (keyof typeof levels)[]) {
		const native = console[level].bind(console);
		console[level] = (...args: unknown[]) => {
			native(...args);
			emit("consolemessage", {
				level: levels[level],
				message: args.map(String).join(" ").slice(0, 4000),
				line: 0,
				sourceId: href(),
			});
		};
	}
	emit("loadcommit", { url: href(), isTopLevel: true });
} else {
	client = install(globalThis);
}
