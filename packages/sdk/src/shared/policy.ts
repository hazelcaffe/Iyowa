import type { Manifest } from "./types.ts";

/** Names that shipped before standardization, still found in published bundles. */
const ALIASES: Record<string, string[]> = { "controlled-frame": ["controlledframe"] };

/** Whether the manifest's permissions_policy enables a feature for the app's own origin. */
export function allows(manifest: Manifest, feature: string, id: string): boolean {
	return [feature, ...(ALIASES[feature] ?? [])].some((name) => {
		const list = manifest.permissions_policy?.[name];
		return (
			Array.isArray(list) &&
			list.some((s) =>
				["self", "*", "src", `isolated-app://${id}`, `isolated-app://${id}/`].includes(s),
			)
		);
	});
}

/** IWA-only features additionally require cross-origin isolation, as in Chrome. */
export function allowsIsolated(manifest: Manifest, feature: string, id: string): boolean {
	return allows(manifest, feature, id) && allows(manifest, "cross-origin-isolated", id);
}

/** Browser capabilities needed to implement the IWA's declared APIs. */
export function browserAllows(manifest: Manifest, feature: string, id: string): boolean {
	if (allows(manifest, feature, id)) return true;
	// getAllScreensMedia is implemented with the standard screen-share picker.
	return feature === "display-capture" && allowsIsolated(manifest, "all-screens-capture", id);
}

/** Standard features delegated to the app frame. Unknown names produce console warnings, so keep this current. */
export const browserFeatures = [
	"accelerometer",
	"autoplay",
	"bluetooth",
	"camera",
	"clipboard-read",
	"clipboard-write",
	"compute-pressure",
	"cross-origin-isolated",
	"display-capture",
	"encrypted-media",
	"fullscreen",
	"gamepad",
	"geolocation",
	"gyroscope",
	"hid",
	"identity-credentials-get",
	"idle-detection",
	"local-fonts",
	"magnetometer",
	"microphone",
	"midi",
	"otp-credentials",
	"payment",
	"picture-in-picture",
	"publickey-credentials-create",
	"publickey-credentials-get",
	"screen-wake-lock",
	"serial",
	"storage-access",
	"usb",
	"web-share",
	"window-management",
	"xr-spatial-tracking",
];

/** Platform-dependent names: Chromium warns when it doesn't know one, so only send them when declared. */
export const platformFeatures = new Set(["bluetooth", "web-share"]);

/** Features the runtime implements or mediates itself, for display in launchers. */
export const runtimeFeatures: Record<string, string> = {
	"direct-sockets": "TCP and UDP sockets",
	"direct-sockets-private": "Sockets to devices on your local network",
	"direct-sockets-multicast": "UDP multicast",
	"controlled-frame": "Embed and control other websites",
	controlledframe: "Embed and control other websites",
	"local-network": "Reach devices on your local network",
	"loopback-network": "Reach services on this computer",
	"all-screens-capture": "Capture screens",
	"window-management": "Window management",
	"cross-origin-isolated": "Cross-origin isolation",
};

export function isLoopbackHost(host: string): boolean {
	const h = host.replace(/^\[|\]$/g, "").toLowerCase();
	return (
		h === "localhost" ||
		h.endsWith(".localhost") ||
		h === "::1" ||
		h === "::" ||
		h === "0.0.0.0" ||
		/^127(?:\.\d{1,3}){3}$/.test(h)
	);
}

/** Literal addresses (or names) that are certainly not on the public internet. DNS can add more. */
export function isPrivateHost(host: string): boolean {
	const h = host.replace(/^\[|\]$/g, "").toLowerCase();
	return (
		isLoopbackHost(h) ||
		h.endsWith(".local") ||
		h.endsWith(".lan") ||
		h.endsWith(".internal") ||
		h.endsWith(".home.arpa") ||
		/^10\./.test(h) ||
		/^192\.168\./.test(h) ||
		/^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
		/^169\.254\./.test(h) ||
		/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h) ||
		/^f[cd][0-9a-f]{2}:/.test(h) ||
		/^fe[89ab][0-9a-f]:/.test(h)
	);
}

export const defaultPermissions = (): { "local-network": "prompt" } => ({ "local-network": "prompt" });
