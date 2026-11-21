import { installSockets } from "./sockets.ts";

if (globalThis.__iyowaConfig) installSockets(globalThis.__iyowaConfig);
