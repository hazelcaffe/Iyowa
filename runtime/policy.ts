import type { Manifest } from "./types.ts";
export function allows(manifest: Manifest, name: string, id: string) {
	const list = manifest.permissions_policy?.[name];
	return (
		Array.isArray(list) &&
		list.some((s) => ["self", "*", "src", `isolated-app://${id}`, `isolated-app://${id}/`].includes(s))
	);
}
export const browserFeatures = [
	"accelerometer",
	"ambient-light-sensor",
	"autoplay",
	"camera",
	"clipboard-read",
	"clipboard-write",
	"display-capture",
	"encrypted-media",
	"fullscreen",
	"gamepad",
	"geolocation",
	"gyroscope",
	"hid",
	"idle-detection",
	"local-fonts",
	"magnetometer",
	"microphone",
	"midi",
	"payment",
	"picture-in-picture",
	"publickey-credentials-get",
	"screen-wake-lock",
	"serial",
	"speaker-selection",
	"usb",
	"web-share",
	"window-management",
	"xr-spatial-tracking",
	"cross-origin-isolated",
];
