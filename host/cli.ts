import { createHost } from "./index.ts";

const host = await createHost({
	port: Number(process.env.PORT || 4178),
	dataDir: process.env.IYOWA_DATA,
	uiDir: process.env.IYOWA_UI_DIR,
	dev: process.argv.includes("--dev"),
	grants: JSON.parse(process.env.IYOWA_SOCKET_GRANTS || "[]"),
	bindings: JSON.parse(process.env.IYOWA_SOCKET_BINDINGS || "[]"),
	managedOrigins: JSON.parse(process.env.IYOWA_FRAME_ORIGINS || "[]"),
});
console.log(`Iyowa: ${host.origin}`);
for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, () => void host.close());
