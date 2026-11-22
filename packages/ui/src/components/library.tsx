import { type AppInfo, runtimeFeatures } from "@iyowa/sdk";
import { Download, EllipsisVertical, FileUp, FlaskConical, Globe, Link2, Play, Search } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import type { Running } from "../app.tsx";
import { catalog } from "../catalog.ts";
import { runtime, useExamples } from "../runtime.ts";
import { AppIcon } from "./app-icon.tsx";

interface Props {
	apps?: AppInfo[];
	error?: string;
	running: Map<string, Running>;
	onOpen(app: AppInfo): void;
	onDetails(app: AppInfo): void;
	toast(message: string, tone?: "info" | "success" | "error"): void;
}

const FEATURE_CHIPS: Record<string, string> = {
	"direct-sockets": "Sockets",
	"controlled-frame": "Controlled Frame",
	"all-screens-capture": "Screen capture",
	"window-management": "Windows",
	"direct-sockets-private": "Local network",
	controlledframe: "Controlled Frame",
};

export function Library({ apps, error, running, onOpen, onDetails, toast }: Props) {
	const [query, setQuery] = useState("");
	const [busy, setBusy] = useState<string>();
	const [url, setUrl] = useState("");
	const file = useRef<HTMLInputElement>(null);
	const examples = useExamples();

	async function install(label: string, task: () => Promise<AppInfo>, openAfter = true) {
		setBusy(label);
		try {
			const app = await task();
			toast(`Installed ${app.name} ${app.version}`, "success");
			if (openAfter) onOpen(app);
		} catch (e) {
			toast((e as Error).message, "error");
		} finally {
			setBusy(undefined);
		}
	}
	const submitUrl = (e: FormEvent) => {
		e.preventDefault();
		const value = url.trim();
		if (value) void install("url", () => runtime.installURL(value)).then(() => setUrl(""));
	};

	const shown = (apps ?? []).filter(
		(a) =>
			!query ||
			`${a.name} ${a.manifest.short_name ?? ""} ${a.id}`.toLowerCase().includes(query.toLowerCase()),
	);
	const installed = new Set((apps ?? []).map((a) => a.id));
	const featured = catalog.filter((c) => !installed.has(c.id));
	const samples = examples.filter((e) => !installed.has(e.id));

	return (
		<div className="page">
			<header className="page-header">
				<div>
					<h1>Library</h1>
					<p className="subtle">
						Signed Isolated Web Apps, running in this tab with Direct Sockets and Controlled
						Frame.
					</p>
				</div>
				{(apps?.length ?? 0) > 4 && (
					<label className="search">
						<Search size={16} />
						<input
							type="search"
							placeholder="Search apps"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							aria-label="Search apps"
						/>
					</label>
				)}
			</header>

			<section className="install-card" aria-label="Install an app">
				<div className="install-file">
					<FileUp size={22} />
					<div>
						<strong>Install a bundle</strong>
						<span className="subtle">Drop a .swbn anywhere, or</span>
					</div>
					<button
						type="button"
						className="button"
						disabled={!!busy}
						onClick={() => file.current?.click()}
					>
						Choose file…
					</button>
					<input
						ref={file}
						type="file"
						accept=".swbn,application/webbundle"
						hidden
						aria-label="Signed web bundle"
						onChange={(e) => {
							const f = e.target.files?.[0];
							e.target.value = "";
							if (f) void install("file", () => runtime.install(f));
						}}
					/>
				</div>
				<form className="install-url" onSubmit={submitUrl}>
					<Link2 size={18} />
					<input
						type="url"
						required
						placeholder="https://… bundle (.swbn) or update manifest (update.json)"
						value={url}
						onChange={(e) => setUrl(e.target.value)}
						aria-label="Bundle or update manifest URL"
					/>
					<button type="submit" className="button primary" disabled={!!busy}>
						{busy === "url" ? "Installing…" : "Install"}
					</button>
				</form>
			</section>

			<section aria-labelledby="installed-heading">
				<h2 id="installed-heading" className="section-title">
					Installed {apps ? <span className="count">{apps.length}</span> : null}
				</h2>
				{error && <p className="error-text">{error}</p>}
				{apps && apps.length === 0 && (
					<div className="empty">
						<p>No apps yet. Install one of the examples below, or drop a signed bundle here.</p>
					</div>
				)}
				<ul className="app-grid">
					{shown.map((app) => (
						<li key={app.id} className="app-card">
							<button
								type="button"
								className="app-card-main"
								onClick={() => onOpen(app)}
								aria-label={`Open ${app.name}`}
							>
								<AppIcon app={app} size={48} />
								<span className="app-card-text">
									<span className="app-card-name">
										<span className="app-card-title">{app.name}</span>
										{running.has(app.id) && <span className="badge live">Running</span>}
									</span>
									<span className="subtle mono">v{app.version}</span>
									{app.manifest.description && (
										<span className="app-card-desc">{app.manifest.description}</span>
									)}
								</span>
							</button>
							<div className="chips">
								{Object.keys(app.manifest.permissions_policy ?? {})
									.filter((f) => FEATURE_CHIPS[f])
									.map((f) => (
										<span key={f} className="chip" title={runtimeFeatures[f]}>
											{FEATURE_CHIPS[f]}
										</span>
									))}
							</div>
							<div className="app-card-actions">
								<button
									type="button"
									className="button small primary"
									onClick={() => onOpen(app)}
								>
									<Play size={14} /> {running.has(app.id) ? "Switch to" : "Open"}
								</button>
								<button
									type="button"
									className="icon-button"
									aria-label={`Details for ${app.name}`}
									onClick={() => onDetails(app)}
								>
									<EllipsisVertical size={16} />
								</button>
							</div>
						</li>
					))}
				</ul>
			</section>

			{(samples.length > 0 || featured.length > 0) && (
				<section aria-labelledby="discover-heading">
					<h2 id="discover-heading" className="section-title">
						Try an app
					</h2>
					<ul className="discover">
						{samples.map((example) => (
							<li key={example.file} className="discover-item">
								<FlaskConical size={20} className="discover-icon" />
								<div>
									<strong>{example.name}</strong>
									<span className="subtle">{example.description}</span>
									<span className="tag">Built-in example</span>
								</div>
								<button
									type="button"
									className="button small"
									disabled={!!busy}
									onClick={() =>
										install(example.file, async () =>
											runtime.install(await (await fetch(example.url)).blob()),
										)
									}
								>
									<Download size={14} /> {busy === example.file ? "Installing…" : "Install"}
								</button>
							</li>
						))}
						{featured.map((entry) => (
							<li key={entry.id} className="discover-item">
								<Globe size={20} className="discover-icon" />
								<div>
									<strong>{entry.name}</strong>
									<span className="subtle">{entry.description}</span>
									<span className="tag">
										{entry.publisher} ·{" "}
										<a href={entry.source} target="_blank" rel="noreferrer">
											source
										</a>
									</span>
								</div>
								<button
									type="button"
									className="button small"
									disabled={!!busy}
									onClick={() => install(entry.id, () => runtime.installURL(entry.url))}
								>
									<Download size={14} /> {busy === entry.id ? "Downloading…" : "Install"}
								</button>
							</li>
						))}
					</ul>
				</section>
			)}
		</div>
	);
}
