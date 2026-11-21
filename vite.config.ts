import { defineConfig } from "vite";
export default defineConfig({ build: { target: "esnext", outDir: "dist/ui" }, server: { hmr: false } });
