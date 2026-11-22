import type { GuestConfig } from "../shared/types.ts";
import { installSockets } from "./sockets.ts";

declare global {
	var __iyowaConfig: GuestConfig | undefined;
}

// Dedicated workers can't reach the launcher; they use the permission state captured at load.
if (globalThis.__iyowaConfig) installSockets(globalThis.__iyowaConfig, undefined, () => {});
