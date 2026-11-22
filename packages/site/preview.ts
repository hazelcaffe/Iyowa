import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

// Serves dist/ under /Iyowa/, the same path GitHub Pages uses.
const dist = fileURLToPath(new URL("./dist", import.meta.url));
const types: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css",
	".png": "image/png",
	".svg": "image/svg+xml",
};
const port = Number(process.env.PORT || 4180);
createServer(async (req, res) => {
	const url = new URL(req.url || "/", "http://localhost");
	if (!url.pathname.startsWith("/Iyowa/")) {
		res.writeHead(302, { Location: "/Iyowa/" }).end();
		return;
	}
	let file = join(dist, normalize(decodeURIComponent(url.pathname.slice("/Iyowa".length))));
	if (!file.startsWith(dist)) return void res.writeHead(403).end();
	if ((await stat(file).catch(() => null))?.isDirectory()) file = join(file, "index.html");
	const body = await readFile(file).catch(() => null);
	if (!body) return void res.writeHead(404).end("Not found");
	res.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream" }).end(body);
}).listen(port, "127.0.0.1", () => console.log(`Site preview: http://localhost:${port}/Iyowa/`));
