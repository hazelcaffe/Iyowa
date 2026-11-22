import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Tests run against built runtime assets and the built launcher UI. */
export default function setup() {
	if (process.env.IYOWA_SKIP_BUILD) return;
	execFileSync("pnpm", ["build"], {
		cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
		stdio: "inherit",
	});
}
