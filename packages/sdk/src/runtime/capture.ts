import { allowsIsolated } from "../shared/policy.ts";
import type { GuestConfig } from "../shared/types.ts";

/**
 * getAllScreensMedia() normally captures every screen without a prompt, for admin-allowlisted apps.
 * In a tab, the closest honest equivalent is the share picker preselected to entire screens:
 * the user chooses, and the app receives the array it expects (with one stream).
 */
export function installCapture({ manifest, id }: GuestConfig) {
	const devices = navigator.mediaDevices;
	if (!devices || "getAllScreensMedia" in devices || typeof devices.getDisplayMedia !== "function") return;
	const getDisplayMedia = devices.getDisplayMedia.bind(devices);
	Object.defineProperty(MediaDevices.prototype, "getAllScreensMedia", {
		configurable: true,
		writable: true,
		value: async function getAllScreensMedia(): Promise<MediaStream[]> {
			if (!allowsIsolated(manifest, "all-screens-capture", id))
				throw new DOMException(
					'The app manifest does not grant "all-screens-capture"',
					"NotAllowedError",
				);
			// Call synchronously from the user's gesture: the picker requires transient activation.
			const stream = await getDisplayMedia({
				video: { displaySurface: "monitor" },
				audio: false,
				monitorTypeSurfaces: "include",
				selfBrowserSurface: "exclude",
				surfaceSwitching: "include",
			} as DisplayMediaStreamOptions);
			return [stream];
		},
	});
}
