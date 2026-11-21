import { ScramjetClient } from "@mercuryworkshop/scramjet";
import { type MenuContext, renderMenu } from "../frame-menu.ts";
import { context, transport } from "./context.ts";

const parentOrigin = globalThis.__iyowaFrame.parent,
	owner = window.parent,
	post = owner.postMessage.bind(owner),
	// biome-ignore lint/security/noGlobalEval: executeScript is explicitly evaluated in the managed guest realm, from its pinned owner only.
	evaluate = window.eval;
const emit = (name: string, fields: Record<string, unknown> = {}) =>
	post({ iyowa: "event", name, fields }, parentOrigin);
// Each (bundle, partition, virtual site) has a distinct real origin. Capture its stores
// before the Scramjet client wraps them, including the unprefixed IDB database names.
const nativeLocal = window.localStorage,
	nativeSession = window.sessionStorage,
	clearLocal = nativeLocal.clear.bind(nativeLocal),
	clearSession = nativeSession.clear.bind(nativeSession),
	listDB = indexedDB.databases.bind(indexedDB),
	deleteDB = indexedDB.deleteDatabase.bind(indexedDB),
	listCaches = caches.keys.bind(caches),
	deleteCache = caches.delete.bind(caches);
const services = navigator.serviceWorker;
let muted = false;
addEventListener(
	"play",
	(e) => {
		if (muted && e.target instanceof HTMLMediaElement) e.target.muted = true;
	},
	true,
);
addEventListener("contextmenu", (e) => {
	if (!(e.target instanceof Element)) return;
	e.preventDefault();
	const target = e.target;
	const context: MenuContext = {
		x: e.clientX,
		y: e.clientY,
		selectionText: getSelection()?.toString() || "",
		linkUrl: target.closest("a")?.href || "",
		srcUrl: target.getAttribute("src") || "",
		mediaType: target.localName === "img" ? "image" : target.localName,
		editable: target.matches("input,textarea,[contenteditable=true]"),
	};
	const channel = new MessageChannel();
	channel.port1.onmessage = (e) => {
		channel.port1.close();
		renderMenu(e.data, context, (id) => post({ iyowa: "menu-click", id, context }, parentOrigin));
	};
	post({ iyowa: "menu", context }, parentOrigin, [channel.port2]);
});
services.addEventListener("message", (e) => {
	if (e.data?.iyowa === "intercept" && e.ports[0]) post(e.data, parentOrigin, [e.ports[0]]);
});
addEventListener("message", async (e) => {
	if (e.source !== owner || e.origin !== parentOrigin || e.data?.iyowa !== "command") return;
	const { op, arg, id } = e.data;
	try {
		let value: unknown;
		if (op === "script") value = await evaluate(String(arg));
		else if (op === "mute") {
			muted = Boolean(arg);
			for (const media of document.querySelectorAll<HTMLMediaElement>("video,audio"))
				media.muted = muted;
		} else if (op === "muted") value = muted;
		else if (op === "audible")
			value = [...document.querySelectorAll<HTMLMediaElement>("video,audio")].some(
				(m) => !m.paused && !m.muted && m.volume > 0,
			);
		else if (op === "print") window.print();
		else if (op === "css") {
			const style = document.createElement("style");
			style.textContent = arg;
			document.head.append(style);
		} else if (op === "clear") {
			const all = !arg;
			if (all || arg.localStorage) clearLocal();
			if (all || arg.sessionStorage) clearSession();
			if (all || arg.cookies) {
				ctx.cookieJar.clear();
				nativeLocal.removeItem("iyowa:jar");
			}
			if (all || arg.cacheStorage || arg.cache)
				await Promise.all((await listCaches()).map((k) => deleteCache(k)));
			if (all || arg.indexedDB)
				await Promise.all(
					(await listDB())
						.filter((x) => x.name)
						.map(
							(x) =>
								new Promise<void>((ok, no) => {
									const r = deleteDB(x.name as string);
									r.onsuccess = () => ok();
									r.onerror = () => no(r.error);
									r.onblocked = () => no(Error("Database in use"));
								}),
						),
				);
		} else throw Error("Unknown frame operation");
		post({ iyowa: "reply", id, value }, parentOrigin);
	} catch (error) {
		post({ iyowa: "reply", id, error: String(error) }, parentOrigin);
	}
});
addEventListener("DOMContentLoaded", () => emit("contentload"));
addEventListener("load", () => emit("loadstop"));
for (const level of ["log", "warn", "error", "info", "debug"] as const) {
	const native = console[level].bind(console);
	console[level] = (...args) => {
		native(...args);
		emit("consolemessage", { level, message: args.map(String).join(" ") });
	};
}
const ctx = context(),
	net = transport();
const stored = nativeLocal.getItem("iyowa:jar");
if (stored) ctx.cookieJar.load(stored);
function hook(scope: typeof globalThis): ScramjetClient {
	const c = new ScramjetClient(scope, {
		context: ctx,
		transport: net,
		initHeaders: [],
		history: [],
		sendSetCookie: async (entries) => {
			for (const entry of entries) ctx.cookieJar.setCookies(entry.cookie, entry.url);
			nativeLocal.setItem("iyowa:jar", ctx.cookieJar.dump());
		},
		hookSubcontext: (child) => hook(child as typeof globalThis),
	});
	c.hook();
	return c;
}
hook(globalThis);
// A controlled guest cannot directly create a system window. Expose the request to its owner.
window.open = (url, name) => {
	if (url)
		emit("newwindow", {
			targetUrl: new URL(String(url), globalThis.__iyowaFrame.virtual).href,
			name: name || "",
		});
	return null;
};
addEventListener("click", (e) => {
	const a = e.target instanceof Element ? e.target.closest('a[target="_blank"]') : null;
	if (a instanceof HTMLAnchorElement) {
		e.preventDefault();
		emit("newwindow", { targetUrl: a.href, name: "_blank" });
	}
});
emit("loadcommit");
