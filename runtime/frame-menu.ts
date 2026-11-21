export type MenuItem = {
	id: string;
	title: string;
	contexts?: string[];
	enabled?: boolean;
	visible?: boolean;
	type?: "normal" | "separator";
	documentURLPatterns?: (string | { test: (u: string) => boolean })[];
};
export interface MenuContext {
	selectionText: string;
	linkUrl: string;
	srcUrl: string;
	mediaType: string;
	editable: boolean;
	x: number;
	y: number;
}
export class FrameMenus extends EventTarget {
	items = new Map<string, MenuItem>();
	async create(item: MenuItem) {
		if (!item.id || this.items.has(item.id)) throw Error("Expected a unique menu ID");
		this.items.set(item.id, { ...item });
		return item.id;
	}
	async update(id: string, item: Partial<MenuItem>) {
		const old = this.items.get(id);
		if (!old) throw Error("Unknown menu ID");
		this.items.set(id, { ...old, ...item, id });
	}
	async remove(id: string) {
		if (!this.items.delete(id)) throw Error("Unknown menu ID");
	}
	async removeAll() {
		this.items.clear();
	}
	applicable(
		context: MenuContext,
		url: string,
		matches: (patterns: NonNullable<MenuItem["documentURLPatterns"]>, url: string) => boolean,
	) {
		const types = new Set([
			"all",
			"page",
			...(context.selectionText ? ["selection"] : []),
			...(context.linkUrl ? ["link"] : []),
			...(context.editable ? ["editable"] : []),
			context.mediaType,
		]);
		return [...this.items.values()]
			.filter(
				(i) =>
					i.visible !== false &&
					(i.contexts || ["page"]).some((v) => types.has(v)) &&
					(!i.documentURLPatterns || matches(i.documentURLPatterns, url)),
			)
			.map(({ id, title, enabled, type }) => ({ id, title, enabled, type }));
	}
}
export function renderMenu(items: MenuItem[], context: MenuContext, click: (id: string) => void) {
	document.querySelector("[data-iyowa-context-menu]")?.remove();
	if (!items.length) return;
	const menu = document.createElement("div");
	menu.dataset.iyowaContextMenu = "";
	menu.setAttribute("role", "menu");
	menu.style.cssText = `position:fixed;z-index:2147483647;left:${context.x}px;top:${context.y}px;background:Canvas;color:CanvasText;border:1px solid GrayText;padding:2px;display:grid`;
	for (const i of items) {
		if (i.type === "separator") {
			menu.append(document.createElement("hr"));
			continue;
		}
		const b = document.createElement("button");
		b.type = "button";
		b.setAttribute("role", "menuitem");
		b.textContent = i.title.replace("%s", context.selectionText);
		b.disabled = i.enabled === false;
		b.onclick = () => {
			click(i.id);
			menu.remove();
		};
		menu.append(b);
	}
	document.body.append(menu);
	const dismiss = (e: Event) => {
		if (!menu.contains(e.target as Node)) menu.remove();
	};
	document.addEventListener("pointerdown", dismiss, { capture: true, once: true });
	menu.onkeydown = (e) => {
		if (e.key === "Escape") menu.remove();
	};
	menu.querySelector("button")?.focus();
}
