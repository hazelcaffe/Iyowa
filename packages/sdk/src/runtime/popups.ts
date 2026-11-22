import type { GuestConfig } from "../shared/types.ts";

/** An app WindowProxy must have the same storage partition and opener as its creator.
 * A top-level <id>.localhost tab has neither when localhost embeds the app. */
export function installPopups({ id, manifest }: GuestConfig) {
	const original = window.open.bind(window);
	const marker = "data-iyowa-popup";
	function bindChild(child: Window, frame: HTMLIFrameElement) {
		Object.defineProperty(child, "opener", {
			value: frame.hasAttribute("data-noopener") ? null : frame.ownerDocument.defaultView,
			writable: true,
			configurable: true,
		});
		child.close = () => frame.dispatchEvent(new Event("iyowa-close"));
	}
	const ownFrame = window.frameElement;
	// frameElement belongs to the opener's realm, not this window's HTMLIFrameElement constructor.
	if (ownFrame?.localName === "iframe" && ownFrame.hasAttribute(marker))
		bindChild(window, ownFrame as HTMLIFrameElement);
	const named = new Map<string, HTMLIFrameElement>();
	let layer = 2147400000;
	function resolve(raw: string | URL | undefined) {
		const input = String(raw || "about:blank");
		return new URL(input.replace(`isolated-app://${id}/`, `${location.origin}/`), document.baseURI);
	}
	function local(u: URL) {
		return (
			u.href === "about:blank" ||
			(u.origin === location.origin && !u.username && !u.password && !u.pathname.startsWith("/.iyowa/"))
		);
	}
	function open(url?: string | URL, target = "_blank", features = ""): Window | null {
		const u = resolve(url),
			t = target.toLowerCase();
		if (!local(u) || ["_top", "_parent", "_self"].includes(t)) return original(url, target, features);
		const opts = new Map(
			features
				.toLowerCase()
				.split(",")
				.map((p) => {
					const [k, v] = p.trim().split("=");
					return [k, v ?? "yes"] as const;
				}),
		);
		const flag = (k: string) => opts.has(k) && !["0", "no", "false"].includes(opts.get(k) || "");
		const separate = flag("noopener") || flag("noreferrer"),
			name = separate || !target || t === "_blank" ? "" : target;
		const prior = named.get(name);
		if (prior?.isConnected) {
			if (url) prior.src = u.href;
			prior.focus();
			return prior.contentWindow;
		}
		const box = document.createElement("section");
		box.setAttribute("role", "dialog");
		box.setAttribute("aria-label", `${manifest.name || "App"} window`);
		const dimension = (key: string, fallback: number, max: number, min: number) => {
			const n = Number.parseInt(opts.get(key) ?? "", 10);
			return Math.min(max, Math.max(min, Number.isFinite(n) ? n : fallback));
		};
		const w = dimension("width", innerWidth * 0.75, innerWidth, 160),
			h = dimension("height", innerHeight * 0.75, innerHeight, 96);
		const x = dimension("left", (innerWidth - w) / 2, innerWidth - w, 0),
			y = dimension("top", (innerHeight - h) / 2, innerHeight - h, 0);
		box.style.cssText = `position:fixed;display:flex;flex-direction:column;box-sizing:border-box;left:${x}px;top:${y}px;width:${w}px;height:${h}px;max-width:100vw;max-height:100vh;background:Canvas;color:CanvasText;border:1px solid GrayText;box-shadow:0 4px 16px #0005;z-index:${++layer}`;
		const bar = document.createElement("header"),
			label = document.createElement("span"),
			close = document.createElement("button");
		bar.style.cssText =
			"display:flex;align-items:center;justify-content:space-between;flex:0 0 auto;padding:2px 5px;font:menu;background:Canvas;color:CanvasText";
		label.textContent = manifest.name || "App";
		close.textContent = "×";
		close.type = "button";
		close.setAttribute("aria-label", "Close app window");
		bar.append(label, close);
		const frame = document.createElement("iframe");
		frame.setAttribute(marker, "");
		frame.title = `${label.textContent} popup`;
		if (name) frame.name = name;
		if (separate) frame.setAttribute("data-noopener", "");
		frame.style.cssText = "display:block;width:100%;flex:1;min-height:0;border:0";
		function dismiss() {
			if (named.get(name) === frame) named.delete(name);
			box.remove();
		}
		frame.addEventListener("iyowa-close", dismiss);
		close.onclick = dismiss;
		box.addEventListener("pointerdown", () => {
			box.style.zIndex = String(++layer);
		});
		if (u.href !== "about:blank") frame.src = u.href;
		box.append(bar, frame);
		(document.body || document.documentElement).append(box);
		const child = frame.contentWindow;
		if (!child) {
			dismiss();
			return null;
		}
		bindChild(child, frame);
		if (name) named.set(name, frame);
		frame.addEventListener("load", () => {
			const title = frame.contentDocument?.title;
			if (title) label.textContent = title;
		});
		return separate ? null : child;
	}
	window.open = open;
	// Default actions on links do not call the JavaScript window.open function.
	window.addEventListener("click", (e) => {
		if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
		const a = e.composedPath().find((n) => n instanceof HTMLAnchorElement);
		if (
			!(a instanceof HTMLAnchorElement) ||
			a.hasAttribute("download") ||
			!a.target ||
			["_self", "_top", "_parent"].includes(a.target.toLowerCase())
		)
			return;
		const u = resolve(a.href);
		if (local(u)) {
			e.preventDefault();
			open(
				u,
				a.target,
				a.relList.contains("noopener") ||
					a.relList.contains("noreferrer") ||
					(a.target.toLowerCase() === "_blank" && !a.relList.contains("opener"))
					? "noopener"
					: "",
			);
		}
	});
}
