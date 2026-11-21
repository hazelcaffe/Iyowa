declare module "@mercuryworkshop/wisp-js/client" {
	interface Stream {
		send(data: Uint8Array): void;
		close(reason?: number): void;
		onmessage: (data: Uint8Array) => void;
		onclose: (reason: number) => void;
		send_buffer: Uint8Array[];
	}
	export const client: {
		ClientConnection: new (
			url: string,
		) => {
			onopen: () => void;
			onerror: () => void;
			onclose: () => void;
			ws: WebSocket;
			close(): void;
			create_stream(host: string, port: number, protocol: string): Stream;
		};
	};
}
declare module "@mercuryworkshop/wisp-js/server" {
	import type { WebSocket } from "ws";
	export const logging: { ERROR: number; set_level(level: number): void };
	export const server: {
		options: { allow_loopback_ips: boolean; allow_private_ips: boolean; stream_limit_total: number };
		ServerConnection: new (
			socket: WebSocket,
			path: string,
			options: { wisp_version: number },
		) => {
			setup(): Promise<void>;
			run(): Promise<void>;
			create_stream(id: number, type: number, host: string, port: number): void;
			send_close_packet(id: number, reason: number): Promise<void>;
		};
	};
}
