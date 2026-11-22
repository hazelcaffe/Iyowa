import type { AppInfo } from "@iyowa/sdk";
import { Copy, Play, RefreshCw, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { formatBytes, runtime } from "../runtime.ts";
import { AppIcon } from "./app-icon.tsx";
import { PermissionsList } from "./devtools.tsx";

interface Props {
	app: AppInfo;
	running: boolean;
	onClose(): void;
	onOpen(app: AppInfo, path?: string): void;
	onRemoved(app: AppInfo): void;
	toast(message: string, tone?: "info" | "success" | "error"): void;
}

export function AppDetails({ app, running, onClose, onOpen, onRemoved, toast }: Props) {
	const dialog = useRef<HTMLDialogElement>(null);
	const [confirming, setConfirming] = useState(false);
	const [updating, setUpdating] = useState(false);
	useEffect(() => {
		dialog.current?.showModal();
	}, []);

	const update = async () => {
		setUpdating(true);
		try {
			const next = await runtime.update(app);
			toast(
				next.version === app.version
					? `${app.name} is up to date`
					: `Updated ${app.name} to ${next.version}`,
				"success",
			);
		} catch (e) {
			toast((e as Error).message, "error");
		} finally {
			setUpdating(false);
		}
	};
	const remove = async () => {
		try {
			await runtime.remove(app.id);
			onRemoved(app);
		} catch (e) {
			toast((e as Error).message, "error");
		}
	};
	const copy = (text: string) => navigator.clipboard.writeText(text).then(() => toast("Copied"));
	const m = app.manifest;

	return (
		<dialog ref={dialog} className="dialog" onClose={onClose} aria-labelledby="details-title">
			<header className="dialog-header">
				<AppIcon app={app} size={56} />
				<div>
					<h2 id="details-title">{app.name}</h2>
					<p className="subtle">
						Version {app.version}
						{m.short_name && m.short_name !== app.name ? ` · ${m.short_name}` : ""}
					</p>
				</div>
				<button
					type="button"
					className="icon-button push"
					aria-label="Close"
					onClick={() => dialog.current?.close()}
				>
					<X size={18} />
				</button>
			</header>
			{m.description && <p>{m.description}</p>}
			<div className="dialog-actions">
				<button type="button" className="button primary" onClick={() => onOpen(app)}>
					<Play size={15} /> {running ? "Switch to app" : "Open"}
				</button>
				{m.update_manifest_url && (
					<button type="button" className="button" disabled={updating} onClick={update}>
						<RefreshCw size={15} className={updating ? "spin" : ""} /> Check for updates
					</button>
				)}
				{confirming ? (
					<span className="confirm">
						Remove {app.name}?
						<button type="button" className="button danger small" onClick={remove}>
							Remove
						</button>
						<button type="button" className="button small" onClick={() => setConfirming(false)}>
							Cancel
						</button>
					</span>
				) : (
					<button type="button" className="button ghost push" onClick={() => setConfirming(true)}>
						<Trash2 size={15} /> Remove
					</button>
				)}
			</div>

			<h3 className="small-heading">Identity</h3>
			<dl className="facts">
				<dt>Bundle ID</dt>
				<dd className="mono">
					{app.id}
					<button
						type="button"
						className="icon-button small"
						aria-label="Copy bundle ID"
						onClick={() => copy(app.id)}
					>
						<Copy size={13} />
					</button>
				</dd>
				<dt>Origin</dt>
				<dd className="mono">{app.origin}</dd>
				<dt>Runs at</dt>
				<dd className="mono">{app.appOrigin}</dd>
				<dt>Package</dt>
				<dd>
					{formatBytes(app.size)} · {app.exchanges} resources · signature verified
				</dd>
				<dt>SHA-256</dt>
				<dd className="mono small">{app.digest}</dd>
				<dt>Installed</dt>
				<dd>{new Date(app.installedAt).toLocaleString()}</dd>
				{m.update_manifest_url && (
					<>
						<dt>Updates</dt>
						<dd className="mono small">{m.update_manifest_url}</dd>
					</>
				)}
			</dl>

			{(m.shortcuts?.length ?? 0) > 0 && (
				<>
					<h3 className="small-heading">Shortcuts</h3>
					<ul className="link-list">
						{m.shortcuts?.map((s) => (
							<li key={s.url + s.name}>
								<button type="button" className="link" onClick={() => onOpen(app, s.url)}>
									{s.name}
								</button>
								<span className="mono subtle">{s.url}</span>
							</li>
						))}
					</ul>
				</>
			)}
			{(m.protocol_handlers?.length ?? 0) > 0 && (
				<>
					<h3 className="small-heading">Handles links</h3>
					<ul className="link-list">
						{m.protocol_handlers?.map((h) => (
							<li key={h.protocol}>
								<code>{h.protocol}:</code>
								<span className="mono subtle">{h.url}</span>
							</li>
						))}
					</ul>
				</>
			)}

			<h3 className="small-heading">Permissions</h3>
			<PermissionsList app={app} />
		</dialog>
	);
}
