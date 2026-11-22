import type { AppInfo } from "@iyowa/sdk";
import { useState } from "react";
import { runtime } from "../runtime.ts";

/** Manifest icon, or a monogram tile derived from the app's identity. */
export function AppIcon({ app, size = 40 }: { app: Pick<AppInfo, "id" | "name" | "icon">; size?: number }) {
	const [broken, setBroken] = useState(false);
	const src = app.icon && !broken ? runtime.iconURL(app as AppInfo) : undefined;
	if (src)
		return (
			<img
				className="app-icon"
				src={src}
				alt=""
				width={size}
				height={size}
				onError={() => setBroken(true)}
				draggable={false}
			/>
		);
	let hash = 0;
	for (const c of app.id) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
	const letter = [...app.name.trim()][0]?.toUpperCase() ?? "?";
	return (
		<span
			className="app-icon monogram"
			aria-hidden="true"
			style={{
				width: size,
				height: size,
				fontSize: size * 0.46,
				background: `hsl(${hash % 360} 55% 48%)`,
			}}
		>
			{letter}
		</span>
	);
}
