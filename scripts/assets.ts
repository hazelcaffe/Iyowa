import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { fixture } from "../fixtures/bundle.ts";
import { frameDemo } from "../fixtures/frame-demo.ts";

await mkdir("dist/runtime", { recursive: true });
const js = "/.iyowa/";
await Promise.all([
	build({
		entryPoints: {
			guest: "runtime/guest.ts",
			worker: "runtime/worker.ts",
			hub: "runtime/virtual-hub.ts",
			"proxy-client": "runtime/proxy/client.ts",
			"proxy-start": "runtime/proxy/start.ts",
		},
		outdir: "dist/runtime",
		format: "iife",
		target: "esnext",
		bundle: true,
	}),
	build({
		entryPoints: ["runtime/proxy/sw.ts"],
		outfile: "dist/runtime/proxy-sw.js",
		bundle: true,
		format: "iife",
		target: "esnext",
		// Scramjet snapshots URL.createObjectURL at import time, even in a service worker.
		banner: {
			js: `URL.createObjectURL ??= () => { throw new DOMException('Blob URL creation is unavailable in Service Workers','NotSupportedError'); }; URL.revokeObjectURL ??= () => {}; importScripts('${js}frame-config.js','${js}scramjet.js');`,
		},
	}),
	build({
		entryPoints: ["sdk/index.ts"],
		outfile: "dist/sdk.js",
		format: "esm",
		bundle: true,
		target: "esnext",
	}),
	copyFile("node_modules/@mercuryworkshop/scramjet/dist/scramjet_bundled.js", "dist/runtime/scramjet.js"),
	writeFile("dist/example.swbn", await fixture()),
	writeFile("dist/controlled-frame-demo.swbn", await frameDemo()),
]);
