export interface ManifestIcon {
	src: string;
	sizes?: string;
	type?: string;
	purpose?: string;
}

export interface Manifest {
	id?: string;
	name?: string;
	short_name?: string;
	description?: string;
	version: string;
	start_url?: string;
	scope?: string;
	display?: string;
	display_override?: string[];
	theme_color?: string;
	background_color?: string;
	icons?: ManifestIcon[];
	permissions_policy?: Record<string, string[]>;
	shortcuts?: { name: string; url: string; description?: string; icons?: ManifestIcon[] }[];
	protocol_handlers?: { protocol: string; url: string }[];
	update_manifest_url?: string;
	launch_handler?: { client_mode?: string | string[] };
}

/** Runtime-mediated permissions. Manifest policies decide what an app may request; these decide what it gets. */
export type PermissionName = "local-network";
export type PermissionState = "prompt" | "granted" | "denied";
export type Permissions = Record<PermissionName, PermissionState>;

export interface AppInfo {
	/** Signed Web Bundle ID (the IWA's identity). */
	id: string;
	/** The IWA's native origin, `isolated-app://<id>`. */
	origin: string;
	/** Real browser origin the runtime serves the app from. */
	appOrigin: string;
	name: string;
	version: string;
	size: number;
	digest: string;
	exchanges: number;
	startPath: string;
	manifest: Manifest;
	permissions: Permissions;
	installedAt: number;
	/** Launcher-origin URL of the best manifest icon, if any. */
	icon?: string;
}

export interface ExampleInfo {
	/** Bundle ID, to tell whether the example is already installed. */
	id: string;
	file: string;
	name: string;
	description: string;
	url: string;
}

export interface GuestConfig {
	id: string;
	manifest: Manifest;
	shellOrigin: string;
	permissions: Permissions;
}

/** Controlled-frame partition configuration, injected into partition documents and workers. */
export interface FrameConfig {
	/** Launcher-visible app origin that embeds this partition. */
	parent: string;
	/** Launcher origin, allowed to embed the partition in addition to the app. */
	shell: string;
	/** Synthetic origin under which packaged app resources are proxied. */
	bundleOrigin: string;
	partition: string;
	persistent: boolean;
}

export const BUNDLE_ORIGIN = "https://bundle.invalid";
