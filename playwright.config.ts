import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "packages",
	testMatch: "*/tests/**/*.spec.ts",
	workers: 2,
	timeout: 40000,
	expect: { timeout: 10000 },
	reporter: "list",
	globalSetup: "./packages/sdk/tests/e2e/setup.ts",
	use: { browserName: "chromium", trace: "retain-on-failure" },
});
