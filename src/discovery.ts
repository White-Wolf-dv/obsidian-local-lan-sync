import { Platform } from "obsidian";
import { DISCOVERY_APP_ID, DISCOVERY_PORT, DiscoveredPeer } from "./types";

interface NodeDgramSocket {
	bind(port?: number | (() => void), callback?: () => void): void;
	setBroadcast(flag: boolean): void;
	send(
		msg: string | Uint8Array,
		port: number,
		address: string,
		callback?: (err: Error | null) => void
	): void;
	on(event: string, listener: (...args: unknown[]) => void): void;
	close(callback?: () => void): void;
}

interface NodeDgramModule {
	createSocket(options: { type: "udp4"; reuseAddr?: boolean } | "udp4"): NodeDgramSocket;
}

function getDgram(): NodeDgramModule | null {
	if (!Platform.isDesktopApp) return null;
	try {
		const req = (window as unknown as { require: (mod: string) => unknown }).require;
		return req("dgram") as NodeDgramModule;
	} catch {
		return null;
	}
}

export interface HostBeaconPayload {
	app: string;
	deviceName: string;
	ip: string;
	hostLocalName: string;
	port: number;
	vaultId: string;
	pairCode: string;
}

export class UdpHostBroadcaster {
	private socket: NodeDgramSocket | null = null;
	private timer: number | null = null;
	private payload: HostBeaconPayload | null = null;

	start(payload: HostBeaconPayload): void {
		this.stop();
		const dgram = getDgram();
		if (!dgram) return;

		this.payload = payload;

		try {
			const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
			this.socket = socket;

			socket.on("error", () => {
				// Ignore transient network errors
			});

			socket.bind(0, () => {
				try {
					socket.setBroadcast(true);
					this.sendOnce();
					this.timer = window.setInterval(() => this.sendOnce(), 1500);
				} catch {
					// Ignore broadcast permission errors
				}
			});
		} catch {
			this.stop();
		}
	}

	updateIp(ip: string): void {
		if (this.payload) {
			this.payload.ip = ip;
			this.sendOnce();
		}
	}

	private sendOnce(): void {
		if (!this.socket || !this.payload) return;
		const message = JSON.stringify(this.payload);

		const targets = new Set<string>(["255.255.255.255"]);
		const parts = this.payload.ip.split(".");
		if (parts.length === 4) {
			targets.add(`${parts[0]}.${parts[1]}.${parts[2]}.255`);
		}

		for (const target of targets) {
			try {
				this.socket.send(message, DISCOVERY_PORT, target);
			} catch {
				// Ignore interface errors
			}
		}
	}

	stop(): void {
		if (this.timer !== null) {
			window.clearInterval(this.timer);
			this.timer = null;
		}
		if (this.socket) {
			try {
				this.socket.close();
			} catch {
				// Ignore
			}
			this.socket = null;
		}
		this.payload = null;
	}
}

export class UdpClientDiscoverer {
	private socket: NodeDgramSocket | null = null;
	private peers: Map<string, DiscoveredPeer> = new Map();
	private cleanupTimer: number | null = null;

	start(ownVaultId: string, onUpdate: (peers: DiscoveredPeer[]) => void): boolean {
		this.stop();
		const dgram = getDgram();
		if (!dgram) return false;

		try {
			const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
			this.socket = socket;

			socket.on("error", () => {
				// Ignore bind/network errors
			});

			socket.on("message", (msg: unknown, rinfo: unknown) => {
				try {
					const raw = String(msg);
					const parsed = JSON.parse(raw) as Partial<HostBeaconPayload>;
					if (parsed.app !== DISCOVERY_APP_ID) return;
					if (!parsed.vaultId || parsed.vaultId === ownVaultId) return;
					if (!parsed.port) return;

					const remoteInfo = rinfo as { address?: string };
					const ip = parsed.ip || remoteInfo?.address || "";
					if (!ip) return;

					const peer: DiscoveredPeer = {
						deviceName: parsed.deviceName || "Desktop host",
						ip,
						hostLocalName: parsed.hostLocalName || "",
						port: Number(parsed.port),
						vaultId: parsed.vaultId,
						pairCode: parsed.pairCode,
						lastSeen: Date.now(),
					};

					this.peers.set(peer.vaultId, peer);
					onUpdate(Array.from(this.peers.values()));
				} catch {
					// Ignore malformed packets
				}
			});

			socket.bind(DISCOVERY_PORT);

			this.cleanupTimer = window.setInterval(() => {
				const cutoff = Date.now() - 8000;
				let changed = false;
				for (const [id, peer] of this.peers.entries()) {
					if (peer.lastSeen < cutoff) {
						this.peers.delete(id);
						changed = true;
					}
				}
				if (changed) {
					onUpdate(Array.from(this.peers.values()));
				}
			}, 2500);

			return true;
		} catch {
			this.stop();
			return false;
		}
	}

	stop(): void {
		if (this.cleanupTimer !== null) {
			window.clearInterval(this.cleanupTimer);
			this.cleanupTimer = null;
		}
		if (this.socket) {
			try {
				this.socket.close();
			} catch {
				// Ignore
			}
			this.socket = null;
		}
		this.peers.clear();
	}
}
