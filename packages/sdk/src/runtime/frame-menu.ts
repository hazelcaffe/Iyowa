/** A URLPattern as structured-cloneable components, or a glob string. */
export type UrlPatternLike =
	| string
	| Partial<Record<"protocol" | "hostname" | "port" | "pathname" | "search" | "hash", string>>;

export interface MenuItem {
	id: string;
	title: string;
	contexts?: string[];
	enabled?: boolean;
	visible?: boolean;
	checked?: boolean;
	type?: "normal" | "separator" | "checkbox" | "radio";
	documentURLPatterns?: UrlPatternLike[];
	targetURLPatterns?: UrlPatternLike[];
}

export interface MenuContext {
	selectionText: string;
	linkUrl: string;
	srcUrl: string;
	mediaType: string;
	editable: boolean;
	x: number;
	y: number;
}

export function globToRegExp(pattern: string): RegExp {
	return new RegExp(
		`^${pattern
			.split("*")
			.map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
			.join(".*")}$`,
	);
}

export function matchesPattern(pattern: UrlPatternLike, url: string): boolean {
	if (typeof pattern === "string") return pattern === "<all_urls>" || globToRegExp(pattern).test(url);
	const Pattern = (globalThis as { URLPattern?: new (init: object) => { test(u: string): boolean } })
		.URLPattern;
	return Pattern ? new Pattern(pattern).test(url) : false;
}

/** Normalize app-supplied patterns (strings or URLPattern objects) for postMessage. */
export function clonePatterns(list: unknown): UrlPatternLike[] | undefined {
	if (!Array.isArray(list)) return undefined;
	return list.map((p) => {
		if (typeof p === "string") return p;
		const o = p as Record<string, string>;
		return {
			protocol: o.protocol,
			hostname: o.hostname,
			port: o.port,
			pathname: o.pathname,
			search: o.search,
			hash: o.hash,
		};
	});
}

/** The contextMenus API of a controlled frame (state lives in the embedding app). */
export class FrameMenus extends EventTarget {
	readonly items = new Map<string, MenuItem>();
	onchange?: () => void;
	onclick: ((e: Event) => void) | null = null;
	onshow: ((e: Event) => void) | null = null;

	async create(item: MenuItem): Promise<string> {
		const id = item.id || crypto.randomUUID();
		if (this.items.has(id)) throw new Error(`A menu item "${id}" already exists`);
		this.items.set(id, this.#normalize({ ...item, id }));
		this.onchange?.();
		return id;
	}
	async update(id: string, item: Partial<MenuItem>): Promise<void> {
		const old = this.items.get(id);
		if (!old) throw new Error(`Unknown menu item "${id}"`);
		this.items.set(id, this.#normalize({ ...old, ...item, id }));
		this.onchange?.();
	}
	async remove(id: string): Promise<void> {
		if (!this.items.delete(id)) throw new Error(`Unknown menu item "${id}"`);
		this.onchange?.();
	}
	async removeAll(): Promise<void> {
		this.items.clear();
		this.onchange?.();
	}
	#normalize(item: MenuItem): MenuItem {
		return {
			...item,
			documentURLPatterns: clonePatterns(item.documentURLPatterns),
			targetURLPatterns: clonePatterns(item.targetURLPatterns),
		};
	}
}

export function applicableItems(items: MenuItem[], context: MenuContext, url: string): MenuItem[] {
	const types = new Set([
		"all",
		"page",
		...(context.selectionText ? ["selection"] : []),
		...(context.linkUrl ? ["link"] : []),
		...(context.editable ? ["editable"] : []),
		...(context.mediaType ? [context.mediaType] : []),
	]);
	return items.filter(
		(i) =>
			i.visible !== false &&
			(i.contexts?.length ? i.contexts : ["page"]).some((v) => types.has(v)) &&
			(!i.documentURLPatterns?.length || i.documentURLPatterns.some((p) => matchesPattern(p, url))) &&
			(!i.targetURLPatterns?.length ||
				i.targetURLPatterns.some((p) => matchesPattern(p, context.linkUrl || context.srcUrl))),
	);
}

export function renderMenu(items: MenuItem[], context: MenuContext, click: (id: string) => void) {
	document.querySelector("[data-iyowa-context-menu]")?.remove();
	if (!items.length) return;
	const menu = document.createElement("div");
	menu.dataset.iyowaContextMenu = "";
	menu.setAttribute("role", "menu");
	menu.style.cssText = `position:fixed;z-index:2147483647;left:${context.x}px;top:${context.y}px;min-width:160px;background:Canvas;color:CanvasText;border:1px solid color-mix(in srgb, CanvasText 25%, transparent);border-radius:8px;box-shadow:0 8px 24px rgb(0 0 0 / .2);padding:4px;display:grid;font:13px system-ui`;
	for (const i of items) {
		if (i.type === "separator") {
			const hr = document.createElement("hr");
			hr.style.cssText =
				"border:0;border-top:1px solid color-mix(in srgb, CanvasText 15%, transparent);margin:4px 0";
			menu.append(hr);
			continue;
		}
		const b = document.createElement("button");
		b.type = "button";
		b.setAttribute(
			"role",
			i.type === "checkbox" || i.type === "radio" ? `menuitem${i.type}` : "menuitem",
		);
		if (i.type === "checkbox" || i.type === "radio") b.setAttribute("aria-checked", String(!!i.checked));
		b.textContent = `${i.checked ? "✓ " : ""}${i.title.replace("%s", context.selectionText)}`;
		b.disabled = i.enabled === false;
		b.style.cssText = "all:unset;padding:6px 10px;border-radius:5px;cursor:default";
		b.onmouseenter = () => {
			b.style.background = "color-mix(in srgb, Highlight 25%, transparent)";
		};
		b.onmouseleave = () => {
			b.style.background = "";
		};
		b.onclick = () => {
			click(i.id);
			menu.remove();
		};
		menu.append(b);
	}
	document.body.append(menu);
	const dismiss = (e: Event) => {
		if (!menu.contains(e.target as Node)) {
			menu.remove();
			document.removeEventListener("pointerdown", dismiss, true);
		}
	};
	document.addEventListener("pointerdown", dismiss, true);
	menu.onkeydown = (e) => {
		if (e.key === "Escape") menu.remove();
	};
	menu.querySelector("button")?.focus();
}
