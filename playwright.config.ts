import { defineConfig } from "@playwright/test";
export default defineConfig({
	testDir: "tests",
	testMatch: "**/*.spec.ts",
	workers: 2,
	timeout: 25000,
	reporter: "list",
	globalSetup: "./tests/setup.ts",
	use: { browserName: "chromium", trace: "retain-on-failure" },
});
