import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { download } from "../host/download.ts";
import { readBundle } from "../runtime/bundle.ts";

const examples = [
	[
		"kitchen-sink",
		"https://github.com/chromeos/iwa-sink/releases/download/v1.7.0/iwa-sink.swbn",
		"6fdb1089baeafef213c0f191015ccebb630e9fd5e04dd9afaf81509f79bc551e",
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
await mkdir(".cache/public", { recursive: true });
for (const [name, url, pin] of examples) {
	const { bytes } = await download(url);
	if (createHash("sha256").update(bytes).digest("hex") !== pin)
		throw Error(`Public artifact hash changed: ${name}`);
	const app = readBundle(bytes);
	await writeFile(`.cache/public/${name}.swbn`, bytes);
	console.log(`${app.name} ${app.version} (${app.exchanges} exchanges)`);
}
