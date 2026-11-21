import { createHash, createPrivateKey, type KeyObject } from "node:crypto";
import { BundleBuilder } from "wbn";
import { NodeCryptoSigningStrategy, SignedWebBundle } from "wbn-sign";
import type { Manifest } from "../runtime/types.ts";
// Public, deterministic DEMO key. Never use this identity for real software.
export const testKey = (label: string) =>
	createPrivateKey({
		key: Buffer.concat([
			Buffer.from("302e020100300506032b657004220420", "hex"),
			createHash("sha256").update(label).digest(),
		]),
		format: "der",
		type: "pkcs8",
	});
export const demoKey = testKey("Iyowa public test fixture");
export async function fixture(
	changes: Partial<Manifest> = {},
	key: KeyObject = demoKey,
	overrideId?: string,
) {
	const b = new BundleBuilder("b2");
	const add = (path: string, type: string, body: string | Uint8Array) =>
		b.addExchange(path, 200, { "content-type": type }, body);
	add(
		"/.well-known/manifest.webmanifest",
		"application/manifest+json",
		JSON.stringify({
			name: "Iyowa probe",
			version: "1.0.0",
			start_url: "/lab/",
			permissions_policy: {
				"cross-origin-isolated": ["self"],
				"direct-sockets": ["self"],
				"direct-sockets-private": ["self"],
				"direct-sockets-multicast": ["self"],
				"controlled-frame": ["self"],
			},
			protocol_handlers: [{ protocol: "lab", url: "/lab/?launch=%s" }],
			...changes,
		}),
	);
	add(
		"/lab/",
		"text/html",
		'<!doctype html><meta charset=utf-8><title>Iyowa probe</title><link rel="stylesheet" href="/main.css"><h1>Iyowa probe</h1><p id="result">Starting…</p><controlledframe id="view" partition="persist:probe" src="/guest/"></controlledframe><script type="module" src="main.js"></script>',
	);
	add("/main.css", "text/css", "body{font-family:system-ui} controlledframe{border:1px solid silver}");
	add(
		"/lab/main.js",
		"text/javascript",
		`import {value} from './value.js';const r=document.querySelector('#result');const w=new Worker('./worker.js',{type:'module'});w.onmessage=e=>{r.textContent=value+' / '+e.data;w.terminate()};w.postMessage(1);`,
	);
	add("/lab/value.js", "text/javascript", `export const value='ES module OK'`);
	add(
		"/lab/worker.js",
		"text/javascript",
		`import {value} from './value.js';self.onmessage=()=>postMessage(value && 'worker '+typeof TCPSocket)`,
	);
	add(
		"/guest/",
		"text/html",
		'<!doctype html><title>Managed guest</title><h2>Managed guest</h2><p id="value"></p><script src="/guest/read.js"></script>',
	);
	add(
		"/guest/read.js",
		"text/javascript",
		`fetch('/data.json').then(r=>r.json()).then(d=>document.querySelector('#value').textContent=d.name);`,
	);
	add("/data.json", "application/json", '{"name":"Bundled JSON"}');
	add("/bytes", "application/octet-stream", new Uint8Array([0, 1, 2, 3, 254, 255]));
	add(
		"/sw.js",
		"text/javascript",
		`self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',e=>{if(new URL(e.request.url).pathname==='/offline-probe')e.respondWith(new Response('app service worker'));});`,
	);
	add(
		"/lab/echo-worker.js",
		"text/javascript",
		`onmessage=async({data:port})=>{try{const s=new TCPSocket('::1',port);const w=(await s.opened).writable.getWriter();await w.write(new Uint8Array([91]));w.releaseLock();await s.close();postMessage('done');}catch(e){postMessage(String(e))}}`,
	);
	return (
		await SignedWebBundle.fromWebBundle(
			b.createBundle(),
			[new NodeCryptoSigningStrategy(key)],
			overrideId ? { webBundleId: overrideId } : undefined,
		)
	).getSignedWebBundleBytes();
}
