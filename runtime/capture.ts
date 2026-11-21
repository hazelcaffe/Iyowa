import { allows } from "./policy.ts";
import type { GuestConfig } from "./types.ts";

// Native all-screens capture requires an installed, specially permissioned app. Retain the
// array contract; never infer permission to capture an additional surface from the first.
export function installCapture({ manifest, id }: GuestConfig) {
	const devices = navigator.mediaDevices;
	if (!devices || "getAllScreensMedia" in devices || typeof devices.getDisplayMedia !== "function") return;
	Object.defineProperty(devices, "getAllScreensMedia", {
		configurable: true,
		value: async () => {
			if (
				!allows(manifest, "all-screens-capture", id) ||
				!allows(manifest, "cross-origin-isolated", id)
			)
				throw new DOMException("Manifest does not grant all-screens-capture", "NotAllowedError");
			// Call directly on the click stack: getDisplayMedia checks transient activation.
			return [await devices.getDisplayMedia({ video: true, audio: false })];
		},
	});
}
