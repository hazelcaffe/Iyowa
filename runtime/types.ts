export interface Manifest {
	name?: string;
	short_name?: string;
	version: string;
	start_url?: string;
	display?: string;
	display_override?: string[];
	permissions_policy?: Record<string, string[]>;
	shortcuts?: { name: string; url: string }[];
	protocol_handlers?: { protocol: string; url: string }[];
	update_manifest_url?: string;
}
export interface AppInfo {
	id: string;
	origin: string;
	name: string;
	version: string;
	size: number;
	digest: string;
	exchanges: number;
	startPath: string;
	manifest: Manifest;
	appOrigin: string;
}
export interface Grant {
	id: string;
	protocol: "tcp" | "udp";
	address: string;
	port: number;
}
export interface GuestConfig {
	id: string;
	manifest: Manifest;
	shellOrigin: string;
	grants: Grant[];
	bindings: Grant[];
	managedOrigins: string[];
}
