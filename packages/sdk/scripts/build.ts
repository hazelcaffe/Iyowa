import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { frameLab, socketLab } from "../fixtures/labs.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = join(root, "dist");
const runtime = join(dist, "runtime");
const resolve = createRequire(join(root, "package.json")).resolve;

/** Build everything the host serves: in-app runtime, controlled-frame proxy, SDK and examples. */
export async function buildSdk(): Promise<void> {
	await rm(dist, { recursive: true, force: true });
	await mkdir(runtime, { recursive: true });
	await mkdir(join(dist, "examples"), { recursive: true });
	const common = {
		absWorkingDir: root,
		bundle: true,
		target: "esnext",
		legalComments: "none",
		logLevel: "warning",
	} as const;
	const scramjet = join(dirname(resolve("@mercuryworkshop/scramjet/bundled")), "scramjet_bundled.js");
	await Promise.all([
		build({
			...common,
			entryPoints: {
				guest: "src/runtime/guest.ts",
				worker: "src/runtime/worker.ts",
				hub: "src/runtime/virtual-hub.ts",
				"frame-client": "src/frame/client.ts",
				"frame-worker": "src/frame/worker-client.ts",
				"frame-net": "src/frame/net-worker.ts",
				"frame-error": "src/frame/error.ts",
				start: "src/frame/start.ts",
			},
			outdir: runtime,
			format: "iife",
		}),
		build({
			...common,
			entryPoints: ["src/frame/sw.ts"],
			outfile: join(runtime, "sw.js"),
			format: "iife",
			// Scramjet snapshots URL.createObjectURL when it loads, which service workers lack.
			banner: {
				js: `URL.createObjectURL ??= () => { throw new DOMException("Blob URLs are unavailable in service workers", "NotSupportedError"); }; URL.revokeObjectURL ??= () => {}; importScripts("/.iyowa/frame-config.js", "/.iyowa/scramjet.js");`,
			},
		}),
		build({
			...common,
			entryPoints: ["src/client/index.ts"],
			outfile: join(dist, "sdk.js"),
			format: "esm",
		}),
		copyFile(scramjet, join(runtime, "scramjet.js")),
		copyFile(resolve("libcurl.js/libcurl.wasm"), join(runtime, "libcurl.wasm")),
		frameLab().then((bytes) => writeFile(join(dist, "examples", "controlled-frame-lab.swbn"), bytes)),
		socketLab().then((bytes) => writeFile(join(dist, "examples", "socket-lab.swbn"), bytes)),
	]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const started = performance.now();
	await buildSdk();
	console.log(`Built @iyowa/sdk in ${Math.round(performance.now() - started)} ms`);
}
