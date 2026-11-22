import type { IwaSession } from "@iyowa/sdk";
import { House, Info, PanelBottom, RotateCw, X } from "lucide-react";
import { useSession } from "../runtime.ts";
import { AppIcon } from "./app-icon.tsx";

interface Props {
	session: IwaSession;
	devtools: boolean;
	onDevtools(): void;
	onDetails(): void;
	onClose(): void;
}

export function AppToolbar({ session, devtools, onDevtools, onDetails, onClose }: Props) {
	useSession(session);
	const app = session.app;
	const errors = session.console.filter((c) => c.level === "error").length;
	const path = session.url.startsWith(app.origin)
		? session.url.slice(app.origin.length) || "/"
		: session.url;
	return (
		<header className="app-toolbar">
			<AppIcon app={app} size={24} />
			<div className="app-title">
				<strong>{session.title || app.name}</strong>
				<span className="mono subtle" title={session.url}>
					isolated-app://{app.id.slice(0, 10)}…{path}
				</span>
			</div>
			<div className="toolbar-actions">
				<button
					type="button"
					className="icon-button"
					title="Start page"
					aria-label="Start page"
					onClick={() => session.navigate(app.startPath)}
				>
					<House size={17} />
				</button>
				<button
					type="button"
					className="icon-button"
					title="Reload"
					aria-label="Reload"
					onClick={() => session.reload()}
				>
					<RotateCw size={17} />
				</button>
				<button
					type="button"
					className={`icon-button${devtools ? " pressed" : ""}`}
					aria-pressed={devtools}
					title="Developer tools"
					aria-label="Developer tools"
					onClick={onDevtools}
				>
					<PanelBottom size={17} />
					{errors > 0 && <span className="badge-count">{errors > 99 ? "99+" : errors}</span>}
				</button>
				<button
					type="button"
					className="icon-button"
					title="App info"
					aria-label="App info"
					onClick={onDetails}
				>
					<Info size={17} />
				</button>
				<button
					type="button"
					className="icon-button"
					title="Close app"
					aria-label="Close app"
					onClick={onClose}
				>
					<X size={17} />
				</button>
			</div>
		</header>
	);
}
