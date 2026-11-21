import { execFileSync } from "node:child_process";
export default async function setup() {
	execFileSync("pnpm", ["build"], { stdio: "inherit" });
}
