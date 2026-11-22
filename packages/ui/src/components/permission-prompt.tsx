import type { AppInfo, PermissionRequestEvent } from "@iyowa/sdk";
import { Network } from "lucide-react";
import { useEffect, useRef } from "react";
import { AppIcon } from "./app-icon.tsx";

const COPY: Record<string, { title: string; detail: string }> = {
	"local-network": {
		title: "access devices on your local network",
		detail: "This lets the app connect to this computer and other devices on your network, and accept connections from them. Blocking keeps its sockets inside the app.",
	},
};

export function PermissionPrompt({
	app,
	request,
	onAnswer,
}: {
	app: AppInfo;
	request: PermissionRequestEvent;
	icon?: string;
	onAnswer(state: "granted" | "denied"): void;
}) {
	// Focus the dialog, not a default answer: a stray keypress must not grant access.
	const dialog = useRef<HTMLDivElement>(null);
	useEffect(() => dialog.current?.focus(), []);
	const copy = COPY[request.name] ?? { title: request.name, detail: "" };
	return (
		<div
			ref={dialog}
			tabIndex={-1}
			className="prompt"
			role="alertdialog"
			aria-labelledby="prompt-title"
			aria-describedby="prompt-detail"
		>
			<div className="prompt-head">
				<AppIcon app={app} size={28} />
				<Network size={18} className="prompt-kind" />
			</div>
			<p id="prompt-title" className="prompt-title">
				<strong>{app.name}</strong> wants to {copy.title}
			</p>
			<p id="prompt-detail" className="subtle">
				{copy.detail}
			</p>
			{request.reason && <p className="prompt-reason mono">Requested to {request.reason}</p>}
			<div className="prompt-actions">
				<button type="button" className="button" onClick={() => onAnswer("denied")}>
					Block
				</button>
				<button type="button" className="button primary" onClick={() => onAnswer("granted")}>
					Allow
				</button>
			</div>
		</div>
	);
}
