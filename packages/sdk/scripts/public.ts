import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { readBundle } from "../src/bundle/verify.ts";
import { download } from "../src/host/download.ts";

/** Pinned public IWAs used by the compatibility tests, cached in <repo>/.cache/public. */
export const PUBLIC_DIR = fileURLToPath(new URL("../../../.cache/public/", import.meta.url));

export const PUBLIC_IWAS: [name: string, url: string, sha256: string][] = [
	[
		"kitchen-sink",
		"https://github.com/chromeos/iwa-sink/releases/download/v1.7.0/iwa-sink.swbn",
		"6fdb1089baeafef213c0f191015ccebb630e9fd5e04dd9afaf81509f79bc551e",
	],
	[
		"kitchen-sink-legacy",
		"https://github.com/chromeos/iwa-sink/releases/download/v0.1.0/iwa-sink.swbn",
		"0f933925f804215a3d214b9146e4305a897a33737c139264db3267144b7e1289",
	],
	[
		"iwa-bundling-example",
		"https://raw.githubusercontent.com/michaelwasserman/iwa-bundling-example/ef59ada5649cef9f669d1d9a3fb53f5a5b5bca58/iwa-bundling-example.swbn",
		"007c99caad63e8fae0b72b12323c1ca02056144792e4f92f23e47f7f01559e03",
	],
	[
		"iwa-windowing-example",
		"https://raw.githubusercontent.com/michaelwasserman/iwa-windowing-example/b6ec696afe30069143fa5907e5b29bd7e6cd0353/iwa-windowing-example.swbn",
		"379487c5ddd5df90663fb776806d2c261a459c80f7d488d177023cc0c3ecba03",
	],
];

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Download (or reuse cached copies of) every pinned bundle, verifying hashes and signatures. */
export async function fetchPublicIwas(): Promise<void> {
	await mkdir(PUBLIC_DIR, { recursive: true });
	for (const [name, url, pin] of PUBLIC_IWAS) {
		const file = `${PUBLIC_DIR}${name}.swbn`;
		let bytes: Uint8Array | undefined = await readFile(file).catch(() => undefined);
		if (!bytes || sha256(bytes) !== pin) {
			bytes = (await download(url)).bytes;
			if (sha256(bytes) !== pin) throw new Error(`Public artifact hash changed: ${name}`);
			await writeFile(file, bytes);
		}
		const app = readBundle(bytes);
		console.log(`${name}: ${app.name} ${app.version} (${app.exchanges} exchanges)`);
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await fetchPublicIwas();
