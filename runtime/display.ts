import { allows } from "./policy.ts";
import type { GuestConfig, Manifest } from "./types.ts";

const modes = ["unframed", "borderless", "window-controls-overlay", "standalone", "minimal-ui"];
export function displayMode(m: Manifest, unframed = true) {
	return (
		m.display_override?.find((v) => modes.includes(v) && (v !== "unframed" || unframed)) ||
		(["browser", "minimal-ui"].includes(m.display || "") ? "minimal-ui" : "standalone")
	);
}

export function installDisplay({ manifest, id }: GuestConfig) {
	const nativeMatch = window.matchMedia.bind(window);
	const switchable =
		manifest.display_override?.includes("unframed") && allows(manifest, "window-management", id);
	let mode = displayMode(manifest, false);
	const originals = new WeakMap<MediaList, { query: string; rendered: string }>();
	function updateMedia(media: MediaList) {
		const prev = originals.get(media);
		const query = prev?.rendered === media.mediaText ? prev.query : media.mediaText;
		if (!query.includes("display-mode")) return;
		const rendered = displayQuery(query, mode);
		if (media.mediaText !== rendered) media.mediaText = rendered;
		originals.set(media, { query, rendered: media.mediaText });
	}
	function rules(list: CSSRuleList) {
		for (const rule of list) {
			if (rule instanceof CSSMediaRule || rule instanceof CSSImportRule) updateMedia(rule.media);
			if (rule instanceof CSSGroupingRule) rules(rule.cssRules);
		}
	}
	function sheet(s: CSSStyleSheet | null) {
		if (!s) return;
		try {
			updateMedia(s.media);
			rules(s.cssRules);
		} catch (e) {
			if (!(e instanceof DOMException && e.name === "SecurityError")) throw e;
		}
	}
	function refresh() {
		for (const s of document.styleSheets) sheet(s);
		for (const s of document.adoptedStyleSheets) sheet(s);
	}
	function inspect(n: Node) {
		if (n instanceof HTMLStyleElement || n instanceof HTMLLinkElement) sheet(n.sheet);
		else if (n instanceof Element)
			for (const el of n.querySelectorAll<HTMLStyleElement | HTMLLinkElement>(
				'style,link[rel~="stylesheet"]',
			))
				sheet(el.sheet);
	}
	new MutationObserver((batch) => {
		for (const r of batch) {
			if (r.target instanceof HTMLStyleElement) sheet(r.target.sheet);
			for (const n of r.addedNodes) inspect(n);
		}
	}).observe(document, { childList: true, subtree: true });
	document.addEventListener(
		"load",
		(e) => {
			if (e.target instanceof HTMLLinkElement) sheet(e.target.sheet);
		},
		true,
	);
	document.addEventListener("DOMContentLoaded", refresh);
	refresh();
	const listeners = new Set<() => void>();
	window.matchMedia = (query) => {
		if (!/\bdisplay-mode\s*:/i.test(query)) return nativeMatch(query);
		if (!switchable) return nativeMatch(displayQuery(query, mode));
		// Re-evaluate compound queries on either native changes or an IWA display transition.
		const events = new EventTarget();
		let native = nativeMatch(displayQuery(query, mode));
		let previous = native.matches;
		const result = Object.assign(events, {
			get media() {
				return query;
			},
			onchange: null as MediaQueryList["onchange"],
			addListener(fn: EventListener | null) {
				if (fn) events.addEventListener("change", fn);
			},
			removeListener(fn: EventListener | null) {
				if (fn) events.removeEventListener("change", fn);
			},
		}) as MediaQueryList;
		Object.defineProperty(result, "matches", { get: () => native.matches });
		function changed() {
			if (native.matches === previous) return;
			previous = native.matches;
			const e = new MediaQueryListEvent("change", { media: query, matches: previous });
			result.dispatchEvent(e);
			result.onchange?.call(result, e);
		}
		native.addEventListener("change", changed);
		listeners.add(() => {
			native.removeEventListener("change", changed);
			native = nativeMatch(displayQuery(query, mode));
			native.addEventListener("change", changed);
			changed();
		});
		return result;
	};
	if (!switchable) return;
	function permission(granted: boolean) {
		const next = displayMode(manifest, granted);
		if (mode === next) return;
		mode = next;
		refresh();
		for (const fn of listeners) fn();
	}
	// The permission grant, not a particular app button/selector, controls unframed mode.
	void navigator.permissions
		.query({ name: "window-management" as PermissionName })
		.then((status) => {
			permission(status.state === "granted");
			status.addEventListener("change", () => permission(status.state === "granted"));
		})
		.catch(() => {});
	const w = window as Window & { getScreenDetails?: () => Promise<unknown> };
	const get = w.getScreenDetails?.bind(w);
	if (get)
		w.getScreenDetails = async () => {
			const screens = await get();
			permission(true);
			return screens;
		};
}
// Keep compound conditions and user preferences native; only the installed display mode is virtual.
export function displayQuery(query: string, mode: string) {
	return query.replace(/\(\s*display-mode\s*:\s*([\w-]+)\s*\)/gi, (original, v: string) =>
		v === "fullscreen" ? original : v === mode ? "(min-width: 0px)" : "(max-width: -1px)",
	);
}
