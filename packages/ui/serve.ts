import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { buildSdk } from "@iyowa/sdk/build";
import { createHost, type UiHandler, type UiUpgrade } from "@iyowa/sdk/host";

// Serves the Iyowa launcher on http://localhost:<port> with the SDK host behind it.
//   node serve.ts         production build from ./dist (run `pnpm build` first)
//   node serve.ts --dev   Vite dev middleware; rebuilds the SDK runtime at startup
const dev = process.argv.includes("--dev");
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

let ui: { dir: string } | { handler: UiHandler; upgrade: UiUpgrade } = { dir: here("./dist") };
let closeVite = async () => {};
if (dev) {
	await buildSdk();
	const { createServer } = await import("vite");
	// Vite's HMR socket shares the launcher origin: the host forwards its upgrades here.
	const upgrades = new EventEmitter();
	const vite = await createServer({
		configFile: here("./vite.config.ts"),
		root: here("."),
		server: { middlewareMode: true, hmr: { server: upgrades as unknown as Server } },
		appType: "spa",
	});
	closeVite = () => vite.close();
	ui = {
		handler: (req, res, next) => vite.middlewares(req, res, next),
		upgrade: (req, socket, head) => void upgrades.emit("upgrade", req, socket, head),
	};
}

const host = await createHost({
	port: Number(process.env.PORT || 4178),
	dataDir: process.env.IYOWA_DATA || here("../../.iyowa"),
	ui,
});
console.log(`Iyowa is running at ${host.origin}${dev ? " (development)" : ""}`);
for (const signal of ["SIGINT", "SIGTERM"] as const)
	process.once(signal, () => {
		void Promise.all([host.close(), closeVite()]).then(() => process.exit(0));
	});
