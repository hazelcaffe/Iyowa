import type { KeyObject } from "node:crypto";
import type { Manifest } from "../src/shared/types.ts";
import { signApp, testKey } from "./sign.ts";

export { testKey } from "./sign.ts";
export const demoKey = testKey("Iyowa public test fixture");

/** The automated-test app: one page per runtime feature, addressed by element IDs in the tests. */
export function probe(changes: Partial<Manifest> = {}, key: KeyObject = demoKey, overrideId?: string) {
	return signApp(
		{
			name: "Iyowa probe",
			description: "Automated runtime test fixture",
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
		},
		{
			"/lab/":
				'<!doctype html><meta charset=utf-8><title>Iyowa probe</title><link rel="stylesheet" href="/main.css"><h1>Iyowa probe</h1><p id="result">Starting…</p><controlledframe id="view" partition="persist:probe" src="/guest/"></controlledframe><script type="module" src="main.js"></script>',
			"/main.css":
				"body{font-family:system-ui} controlledframe{border:1px solid silver;width:400px;height:200px}",
			"/lab/main.js": `import {value} from './value.js';const r=document.querySelector('#result');const w=new Worker('./worker.js',{type:'module'});w.onmessage=e=>{r.textContent=value+' / '+e.data;w.terminate()};w.postMessage(1);`,
			"/lab/value.js": `export const value='ES module OK'`,
			"/lab/worker.js": `import {value} from './value.js';self.onmessage=()=>postMessage(value && 'worker '+typeof TCPSocket)`,
			"/lab/echo-worker.js": `onmessage=async({data:port})=>{try{const s=new TCPSocket('::1',port);const w=(await s.opened).writable.getWriter();await w.write(new Uint8Array([91]));w.releaseLock();await s.close();postMessage('done');}catch(e){postMessage(String(e))}}`,
			"/guest/":
				'<!doctype html><title>Managed guest</title><h2>Managed guest</h2><p id="value"></p><a id="next" href="/guest/next.html">Next</a><script src="/guest/read.js"></script>',
			"/guest/next.html": "<!doctype html><title>Second page</title><h2>Second page</h2>",
			"/guest/read.js": `fetch('/data.json').then(r=>r.json()).then(d=>document.querySelector('#value').textContent=d.name);`,
			"/data.json": '{"name":"Bundled JSON"}',
			"/bytes": new Uint8Array([0, 1, 2, 3, 254, 255]),
			"/sw.js": `self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',e=>{if(new URL(e.request.url).pathname==='/offline-probe')e.respondWith(new Response('app service worker'));});`,
		},
		key,
		overrideId,
	);
}
