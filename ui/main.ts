import { type AppInfo, IwaRuntime, type IwaSession } from "../sdk/index.ts";

function element<K extends keyof HTMLElementTagNameMap>(tag: K) {
	const el = document.querySelector(tag);
	if (!el) throw Error(`Missing launcher element: ${tag}`);
	return el;
}
const runtime = new IwaRuntime(),
	file = element("input"),
	form = element("form"),
	select = element("select"),
	status = element("output"),
	view = element("main");
let session: IwaSession | undefined,
	apps: AppInfo[] = [];
async function refresh() {
	apps = await runtime.list();
	select.replaceChildren(...apps.map((app) => new Option(`${app.name} ${app.version}`, app.id)));
}
async function run(app: AppInfo) {
	session?.stop();
	session = runtime.launch(app, view);
	select.value = app.id;
	await session.ready;
	status.value = `Running ${app.name}`;
}
function act(fn: () => Promise<void>) {
	status.value = "Loading…";
	void fn().catch((e) => {
		status.value = String(e);
	});
}
async function imported(app: AppInfo) {
	await refresh();
	await run(app);
}
file.onchange = () =>
	act(async () => {
		const f = file.files?.[0];
		if (f) await imported(await runtime.install(f));
		file.value = "";
	});
form.onsubmit = (e) => {
	e.preventDefault();
	const url = form.querySelector("input")?.value;
	if (url) act(async () => imported(await runtime.installURL(url)));
};
document
	.querySelector("#example")
	?.addEventListener("click", () =>
		act(async () => imported(await runtime.install(await (await fetch("/example.swbn")).blob()))),
	);
document.querySelector("#run")?.addEventListener("click", () =>
	act(async () => {
		const app = apps.find((a) => a.id === select.value);
		if (app) await run(app);
		else status.value = "Select a bundle first";
	}),
);
document.querySelector("#stop")?.addEventListener("click", () => {
	session?.stop();
	session = undefined;
	status.value = "Stopped";
});
document.querySelector("#remove")?.addEventListener("click", () =>
	act(async () => {
		if (session?.app.id === select.value) session.stop();
		if (select.value) await runtime.remove(select.value);
		await refresh();
		status.value = "";
	}),
);
void refresh().catch((e) => {
	status.value = String(e);
});
