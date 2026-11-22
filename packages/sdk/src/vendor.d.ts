declare module "@mercuryworkshop/wisp-js/client" {
	interface Stream {
		send(data: Uint8Array): void;
		close(reason?: number): void;
		onmessage: (data: Uint8Array) => void;
		onclose: (reason: number) => void;
		continue_received(buffer: number): void;
		send_buffer: Uint8Array[];
		buffer_size: number;
	}
	interface Connection {
		onopen: () => void;
		onerror: () => void;
		onclose: () => void;
		connected: boolean;
		ws: WebSocket;
		close(): void;
		create_stream(host: string, port: number, protocol: "tcp" | "udp"): Stream;
	}
	export const client: {
		ClientConnection: new (url: string) => Connection;
	};
}

declare module "libcurl.js" {
	export const libcurl: {
		load_wasm(url: string): Promise<void>;
		set_websocket(url: string): void;
		logger: (type: string, text: string) => void;
		stderr: (text: string) => void;
		HTTPSession: new (options?: {
			enable_cookies?: boolean;
		}) => { fetch(url: string, init?: Record<string, unknown>): Promise<Response>; close(): void };
		WebSocket: new (
			url: string,
			protocols?: string[],
			options?: { headers?: Record<string, string> },
		) => unknown;
	};
}

declare module "@mercuryworkshop/wisp-js/server" {
	import type { WebSocket } from "ws";

	interface Packet {
		serialize(): unknown;
	}
	interface ServerConnection {
		ws: { send(packet: Packet): Promise<void> };
		TCPSocket: unknown;
		UDPSocket: unknown;
		setup(): Promise<void>;
		run(): Promise<void>;
		create_stream(id: number, type: number, host: string, port: number): void;
		close_stream(id: number, reason?: number, sendPacket?: boolean): Promise<void>;
		send_close_packet(id: number, reason: number): Promise<void>;
	}
	export const logging: { ERROR: number; set_level(level: number): void };
	export const packet: {
		WispPacket: new (init: { type: number; stream_id: number; payload: unknown }) => Packet;
		ContinuePayload: { type: number; new (init: { buffer_remaining: number }): unknown };
	};
	export const server: {
		options: Record<string, unknown> & { send_buffer_size: number };
		ServerConnection: new (
			socket: WebSocket,
			path: string,
			options: { wisp_version: number },
		) => ServerConnection;
	};
}
