import type { Manifest } from "./types.ts";

const modes = ["unframed", "borderless", "window-controls-overlay", "standalone", "minimal-ui"];
export function displayMode(m: Manifest) {
	return (
		m.display_override?.find((v) => modes.includes(v)) ||
		(["browser", "minimal-ui"].includes(m.display || "") ? "minimal-ui" : "standalone")
	);
}
// Keep compound conditions and user preferences native; only the installed display mode is virtual.
export function displayQuery(query: string, mode: string) {
	return query.replace(/\(\s*display-mode\s*:\s*([\w-]+)\s*\)/gi, (original, v: string) =>
		v === "fullscreen" ? original : v === mode ? "(min-width: 0px)" : "(max-width: -1px)",
	);
}
