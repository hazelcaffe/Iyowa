import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import {
	Cable,
	Code,
	Frame,
	Layers,
	type LucideIcon,
	MonitorUp,
	PanelBottom,
	ShieldCheck,
} from "lucide-react";
import { Marked, type Tokens } from "marked";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Static GitHub Pages site: a landing page plus docs/*.md rendered with one shared layout.
// Every link is relative, so the output works at /Iyowa/ on Pages and from any local server.

const REPO = "https://github.com/hazelcaffe/Iyowa";
const SITE = "https://hazelcaffe.github.io/Iyowa/";
const path = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const root = path("../../");
const out = path("./dist/");

const DOCS = [
	{ slug: "architecture", file: "architecture.md", nav: "How it works" },
	{ slug: "sdk", file: "sdk.md", nav: "SDK" },
	{ slug: "compatibility", file: "compatibility.md", nav: "Compatibility" },
] as const;

const esc = (s: string) =>
	s.replace(
		/[&<>"']/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
	);
const icon = (Icon: LucideIcon, size = 20) =>
	renderToStaticMarkup(createElement(Icon, { size, "aria-hidden": true }));
/** GitHub's mark (Lucide ships no brand icons). */
const github = (size: number) =>
	`<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"/></svg>`;
const slugify = (text: string) =>
	text
		.toLowerCase()
		.replace(/<[^>]+>/g, "")
		.replace(/&[a-z]+;/g, "")
		.replace(/[^\w\s-]/g, "")
		.trim()
		.replace(/\s+/g, "-");

/** Map a link written for GitHub (relative to `from`, a repo path) to its place on the site. */
function siteLink(href: string, from: string, prefix: string): string {
	if (/^[a-z][a-z\d+.-]*:|^#|^\/\//i.test(href)) return href;
	const [target = "", hash = ""] = href.split("#");
	const resolved = posix.normalize(posix.join(posix.dirname(from), target));
	const doc = DOCS.find((d) => resolved === `docs/${d.file}`);
	if (doc) return `${prefix}${doc.slug}/${hash ? `#${hash}` : ""}`;
	if (resolved === "README.md") return `${prefix}${hash ? `#${hash}` : ""}`;
	if (resolved.startsWith("docs/assets/"))
		return `${prefix}assets/${resolved.slice("docs/assets/".length)}`;
	return `${REPO}/blob/main/${resolved}${hash ? `#${hash}` : ""}`;
}

function renderDoc(markdown: string, from: string, prefix: string) {
	const toc: { id: string; text: string }[] = [];
	let title = "";
	const marked = new Marked({
		gfm: true,
		renderer: {
			heading({ tokens, depth }: Tokens.Heading) {
				const html = this.parser.parseInline(tokens);
				if (depth === 1) {
					title ||= html.replace(/<[^>]+>/g, "");
					return `<h1>${html}</h1>\n`;
				}
				const id = slugify(html);
				if (depth === 2) toc.push({ id, text: html.replace(/<[^>]+>/g, "") });
				return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${html}</h${depth}>\n`;
			},
			link({ href, title: linkTitle, tokens }: Tokens.Link) {
				const url = siteLink(href, from, prefix);
				const external = /^https?:/.test(url) && !url.startsWith(SITE);
				return `<a href="${esc(url)}"${linkTitle ? ` title="${esc(linkTitle)}"` : ""}${external ? ' rel="noopener"' : ""}>${this.parser.parseInline(tokens)}</a>`;
			},
			image({ href, text }: Tokens.Image) {
				return `<img src="${esc(siteLink(href, from, prefix))}" alt="${esc(text)}" loading="lazy">`;
			},
			code({ text, lang }: Tokens.Code) {
				const language = lang ? ` data-lang="${esc(lang)}"` : "";
				return `<div class="code"${language}><button class="copy" type="button" aria-label="Copy code">Copy</button><pre><code>${esc(text)}</code></pre></div>\n`;
			},
			table(token: Tokens.Table) {
				const cell = (c: Tokens.TableCell) => this.parser.parseInline(c.tokens);
				const head = token.header.map((c) => `<th>${cell(c)}</th>`).join("");
				const rows = token.rows
					.map((r) => `<tr>${r.map((c) => `<td>${cell(c)}</td>`).join("")}</tr>`)
					.join("");
				return `<div class="table"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>\n`;
			},
		},
	});
	const html = marked.parse(markdown, { async: false });
	return { html, title, toc };
}

function layout(options: {
	title: string;
	description: string;
	prefix: string;
	current: string;
	body: string;
	wide?: boolean;
}) {
	const { title, description, prefix, current, body } = options;
	const nav = DOCS.map(
		(d) =>
			`<a href="${prefix}${d.slug}/"${current === d.slug ? ' aria-current="page"' : ""}>${d.nav}</a>`,
	).join("");
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${SITE}assets/app.png">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<link rel="stylesheet" href="${prefix}style.css">
</head>
<body>
<a class="skip" href="#content">Skip to content</a>
<header class="top">
	<nav class="bar" aria-label="Site">
		<a class="brand" href="${prefix}">iyowa</a>
		<div class="links">${nav}<a class="github" href="${REPO}" aria-label="Iyowa on GitHub">${github(18)}<span>GitHub</span></a></div>
	</nav>
</header>
<main id="content">
${body}
</main>
<footer class="foot">
	<p>Iyowa is free software under the <a href="${REPO}/blob/main/LICENSE">GNU AGPL v3.0 or later</a>. <a href="${REPO}">Source on GitHub</a> · <a href="${REPO}/issues">Issues</a> · <a href="${REPO}/blob/main/CONTRIBUTING.md">Contributing</a></p>
</footer>
<script>
for (const b of document.querySelectorAll(".copy")) b.addEventListener("click", async () => {
	await navigator.clipboard.writeText(b.nextElementSibling.textContent);
	b.textContent = "Copied"; setTimeout(() => (b.textContent = "Copy"), 1500);
});
</script>
</body>
</html>
`;
}

function landing(prefix: string) {
	const feature = (Icon: LucideIcon, title: string, text: string) =>
		`<li class="feature"><span class="feature-icon">${icon(Icon)}</span><h3>${title}</h3><p>${text}</p></li>`;
	const quickstart = renderDoc(
		"```sh\ngit clone https://github.com/hazelcaffe/Iyowa.git\ncd Iyowa\ncorepack enable\npnpm install\npnpm dev   # open http://localhost:4178\n```",
		"README.md",
		prefix,
	).html;
	return `
<section class="hero">
	<p class="eyebrow">Open-source Isolated Web App runtime</p>
	<h1>Isolated Web Apps,<br>in any Chromium tab.</h1>
	<p class="lede">Iyowa verifies signed <code>.swbn</code> bundles and runs them with Direct Sockets, Controlled Frame and screen capture. You don't need ChromeOS, enterprise policy or browser flags. Upstream apps like the ChromeOS Kitchen Sink run unmodified.</p>
	<p class="actions"><a class="button primary" href="#start">Get started</a><a class="button" href="${REPO}">${github(17)} View on GitHub</a></p>
	<picture class="shot hero-shot">
		<source srcset="${prefix}assets/app-dark.png" media="(prefers-color-scheme: dark)">
		<img src="${prefix}assets/app.png" alt="Iyowa running three Isolated Web Apps; Kitchen Sink's controlled frame shows Google inside the app" width="1440" height="900">
	</picture>
</section>

<section class="band">
	<h2>Everything an IWA expects</h2>
	<ul class="features">
		${feature(ShieldCheck, "Verified installs", "Install from a file or by drag and drop, or paste a bundle or <code>update.json</code> URL. Ed25519 and P-256 signatures are checked, and updates must keep the signing key.")}
		${feature(Cable, "Direct Sockets", "<code>TCPSocket</code>, <code>TCPServerSocket</code> and <code>UDPSocket</code> with streams, BYOB reads and multicast, over a policy-checked Wisp relay or real OS ports.")}
		${feature(Frame, "Controlled Frame", "<code>&lt;controlledframe&gt;</code> runs any site through a per-partition Scramjet proxy with in-browser TLS. It supports injection, interception, context menus and new windows.")}
		${feature(MonitorUp, "Screens and windows", "<code>getAllScreensMedia()</code>, <code>display-mode: unframed</code>, in-tab popups, <code>launchQueue</code> and protocol handlers.")}
		${feature(PanelBottom, "Logs and sockets", "A bottom panel shows the runtime's events and every app's console, or each live socket with its route and traffic.")}
		${feature(Code, "An SDK", "The launcher is just a client of <code>@iyowa/sdk</code>. Embed IWAs in your own UI with <code>IwaRuntime</code> and <code>IwaSession</code>.")}
	</ul>
</section>

<section class="band">
	<h2>See it run</h2>
	<div class="gallery">
		<figure><img class="shot" src="${prefix}assets/sockets.png" alt="Socket Lab with the Sockets panel open" loading="lazy" width="1440" height="900"><figcaption>Raw TCP and UDP from an app, in the Sockets panel.</figcaption></figure>
		<figure><img class="shot" src="${prefix}assets/logs.png" alt="The Logs panel with runtime events and socket activity" loading="lazy" width="1440" height="900"><figcaption>Runtime events and every app's output in one log.</figcaption></figure>
		<figure><img class="shot" src="${prefix}assets/permission-prompt.png" alt="A local network request shown under the toolbar" loading="lazy" width="1440" height="900"><figcaption>Reaching your computer or LAN asks first.</figcaption></figure>
	</div>
</section>

<section class="band split">
	<div>
		<h2>One decision for you</h2>
		<p>The manifest decides what an app may use, just as it does for an installed IWA in Chrome. Iyowa asks you about one thing: <strong>local network access</strong>. Public internet sockets and websites follow the manifest. Reaching this computer or your LAN, and listening on real ports, waits for your answer.</p>
		<p>If you block it, apps keep working: their loopback servers and clients stay on a private network inside the tab. The relay checks each destination after DNS resolution, so a public name can't rebind to a private address.</p>
		<p><a href="${prefix}architecture/">How Iyowa works →</a></p>
	</div>
	<div>
		<h2>Tested against real apps</h2>
		<ul class="checks">
			<li>${icon(Layers, 16)}<span><a href="https://github.com/chromeos/iwa-sink">ChromeOS IWA Kitchen Sink</a>, 1.7.0 and 0.1.0</span></li>
			<li>${icon(Layers, 16)}<span><a href="https://github.com/michaelwasserman/iwa-windowing-example">IWA Windowing Example</a></span></li>
			<li>${icon(Layers, 16)}<span><a href="https://github.com/michaelwasserman/iwa-bundling-example">IWA Bundling Example</a></span></li>
		</ul>
		<p>Sockets, OAuth over a loopback listener, screen capture, unframed mode, popups and a live Google page in a controlled frame are all checked in CI. <a href="${prefix}compatibility/">See the compatibility notes →</a></p>
	</div>
</section>

<section class="band" id="start">
	<h2>Get started</h2>
	<p>You need Node.js 24 or newer and a current Chromium-based browser.</p>
	${quickstart}
	<p>Then choose <strong>Try an example</strong>, or use <strong>Install → Public apps</strong> for the Kitchen Sink. The <a href="${prefix}sdk/">SDK reference</a> shows how to build your own launcher.</p>
</section>
`;
}

await rm(out, { recursive: true, force: true });
await mkdir(`${out}assets`, { recursive: true });
for (const file of await readdir(`${root}docs/assets`))
	await copyFile(`${root}docs/assets/${file}`, `${out}assets/${file}`);
await copyFile(path("./style.css"), `${out}style.css`);
await copyFile(
	path("./node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2"),
	`${out}assets/inter-latin-wght-normal.woff2`,
);
await writeFile(`${out}.nojekyll`, "");

await writeFile(
	`${out}index.html`,
	layout({
		title: "Iyowa: Isolated Web Apps in any Chromium tab",
		description:
			"Open-source runtime that runs signed Isolated Web Apps in a normal browser tab, with Direct Sockets, Controlled Frame and screen capture.",
		prefix: "./",
		current: "",
		body: landing("./"),
	}),
);

for (const doc of DOCS) {
	const prefix = "../";
	const { html, title, toc } = renderDoc(
		await readFile(`${root}docs/${doc.file}`, "utf8"),
		`docs/${doc.file}`,
		prefix,
	);
	const contents = toc.length
		? `<nav class="toc" aria-label="On this page"><p>On this page</p>${toc.map((t) => `<a href="#${t.id}">${esc(t.text)}</a>`).join("")}<a class="edit" href="${REPO}/edit/main/docs/${doc.file}">Edit on GitHub</a></nav>`
		: "";
	await mkdir(`${out}${doc.slug}`, { recursive: true });
	await writeFile(
		`${out}${doc.slug}/index.html`,
		layout({
			title: `${title} · Iyowa`,
			description: `${title}: Iyowa documentation.`,
			prefix,
			current: doc.slug,
			body: `<div class="doc-layout"><article class="doc">${html}</article>${contents}</div>`,
		}),
	);
}
console.log(`Built the site into ${out}`);
