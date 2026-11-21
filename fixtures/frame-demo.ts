import { BundleBuilder } from "wbn";
import { NodeCryptoSigningStrategy, SignedWebBundle } from "wbn-sign";
import { testKey } from "./bundle.ts";

// A visible smoke test independent of a third-party search site's embedding policy.
export async function frameDemo() {
	const b = new BundleBuilder("b2");
	const add = (path: string, type: string, body: string) =>
		b.addExchange(path, 200, { "content-type": type }, body);
	add(
		"/.well-known/manifest.webmanifest",
		"application/manifest+json",
		JSON.stringify({
			name: "Iyowa Controlled Frame Demo",
			version: "1.0.0",
			start_url: "/",
			permissions_policy: { "cross-origin-isolated": ["self"], "controlled-frame": ["self"] },
		}),
	);
	add(
		"/",
		"text/html",
		`<!doctype html><meta charset=utf-8><title>Controlled Frame Demo</title><style>body{font:1rem system-ui}controlledframe{display:block;width:100%;height:65vh;border:1px solid gray}output{display:block;margin:1rem 0}</style><h1>Controlled Frame Demo</h1><button id="bundled">Bundled page</button> <button id="remote">Live MDN page</button> <button id="highlight" disabled>Highlight headings</button><output aria-live="polite">Loading…</output><controlledframe src="/guest.html"></controlledframe><script src="/demo.js"></script>`,
	);
	add(
		"/guest.html",
		"text/html",
		"<!doctype html><meta charset=utf-8><title>Bundled page</title><h1>Bundled page</h1><p>Select Live MDN page to load a public site through the Scramjet proxy.</p>",
	);
	add(
		"/demo.js",
		"text/javascript",
		`const view=document.querySelector('controlledframe'),out=document.querySelector('output'),highlight=document.querySelector('#highlight');document.querySelector('#bundled').onclick=()=>view.src='/guest.html';document.querySelector('#remote').onclick=()=>view.src='https://mdn.github.io/dom-examples/';view.onloadstart=()=>{out.textContent='Loading…';highlight.disabled=true};view.onloadabort=e=>out.textContent=e.reason;view.onloadstop=async()=>{try{out.textContent='Frame title: '+(await view.executeScript({code:'document.title'}))[0];highlight.disabled=false}catch(e){out.textContent=String(e)}};highlight.onclick=()=>view.insertCSS({code:'h1,h2,h3 { background: gold !important; color: black !important; }'});`,
	);
	return (
		await SignedWebBundle.fromWebBundle(b.createBundle(), [
			new NodeCryptoSigningStrategy(testKey("Iyowa public frame demo")),
		])
	).getSignedWebBundleBytes();
}
