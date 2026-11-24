import { App, Platform } from "obsidian";
import { arrayBufferToBase64, base64ToArrayBuffer } from "./crypto";
import {
	buildVaultManifest,
	ensureParentDirs,
	sanitizeVaultPath,
	shouldExclude,
	trashVaultFile,
} from "./hash";
import {
	DISCOVERY_APP_ID,
	LocalSyncSettings,
	MAX_UPLOAD_BYTES,
	PairApprovalResult,
	PairingSession,
} from "./types";

interface NodeIncomingMessage {
	method?: string;
	url?: string;
	headers: Record<string, string | string[] | undefined>;
	on(event: string, listener: (...args: unknown[]) => void): void;
	destroy(): void;
}

interface NodeServerResponse {
	statusCode: number;
	setHeader(name: string, value: string | number): void;
	end(chunk?: string | Uint8Array): void;
}

interface NodeHttpServer {
	listen(port: number, host: string, callback?: () => void): void;
	close(callback?: () => void): void;
	on(event: string, listener: (...args: unknown[]) => void): void;
}

interface NodeHttpModule {
	createServer(
		handler: (req: NodeIncomingMessage, res: NodeServerResponse) => void
	): NodeHttpServer;
}

interface NodeNetInterface {
	address: string;
	family: string | number;
	internal: boolean;
}

interface NodeOsModule {
	hostname(): string;
	networkInterfaces(): Record<string, NodeNetInterface[] | undefined>;
}

function nodeRequire<T>(name: string): T | null {
	if (!Platform.isDesktopApp) return null;
	try {
		const req = (window as unknown as { require: (mod: string) => unknown }).require;
		return req(name) as T;
	} catch {
		return null;
	}
}

export function getDesktopHostname(): string {
	const osMod = nodeRequire<NodeOsModule>("os");
	if (!osMod) return "Mobile device";
	try {
		return osMod.hostname() || "Desktop host";
	} catch {
		return "Desktop host";
	}
}

export function getLocalLanIps(): string[] {
	const osMod = nodeRequire<NodeOsModule>("os");
	if (!osMod) return [];

	const scored: Array<{ ip: string; score: number }> = [];
	const interfaces = osMod.networkInterfaces();

	for (const [ifaceName, addrs] of Object.entries(interfaces)) {
		if (!addrs) continue;
		const lowerName = ifaceName.toLowerCase();
		const isVirtualOrVpn =
			lowerName.includes("vethernet") ||
			lowerName.includes("wsl") ||
			lowerName.includes("docker") ||
			lowerName.includes("virtual") ||
			lowerName.includes("vmware") ||
			lowerName.includes("vbox") ||
			lowerName.includes("hyper-v") ||
			lowerName.includes("tailscale") ||
			lowerName.includes("zerotier") ||
			lowerName.includes("wintun") ||
			lowerName.includes("wireguard") ||
			lowerName.includes("sing") ||
			lowerName.includes("clash") ||
			lowerName.includes("v2ray") ||
			lowerName.includes("nekoray") ||
			lowerName.includes("vpn") ||
			lowerName.includes("bluetooth") ||
			lowerName.includes("loopback") ||
			lowerName.includes("npcap") ||
			lowerName.includes("tun") ||
			lowerName.includes("tap");

		for (const info of addrs) {
			const isV4 = info.family === "IPv4" || info.family === 4;
			if (!isV4 || info.internal) continue;
			if (info.address.startsWith("169.254.")) continue;
			if (info.address.startsWith("198.18.") || info.address.startsWith("198.19.")) continue;

			let score = 50;
			if (info.address.startsWith("192.168.")) score += 45;
			else if (info.address.startsWith("10.")) score += 25;
			else if (/^172\.(1[6-9]|2\d|3[01])\./.test(info.address)) score += 10;

			if (lowerName.includes("wi-fi") || lowerName.includes("wifi") || lowerName.includes("wlan")) {
				score += 25;
			} else if (lowerName.includes("ethernet") || lowerName.includes("eth") || lowerName.includes("en0")) {
				score += 18;
			}

			if (isVirtualOrVpn) score -= 80;

			scored.push({ ip: info.address, score });
		}
	}

	scored.sort((a, b) => b.score - a.score);
	return Array.from(new Set(scored.map((s) => s.ip)));
}

function setCorsHeaders(res: NodeServerResponse): void {
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Sync-Token");
}

function sendJson(res: NodeServerResponse, status: number, payload: unknown): void {
	const body = JSON.stringify(payload);
	res.statusCode = status;
	setCorsHeaders(res);
	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.setHeader("Cache-Control", "no-store");
	res.end(body);
}

function readRequestBody(req: NodeIncomingMessage, maxBytes: number): Promise<Uint8Array> {
	return new Promise((resolve, reject) => {
		const chunks: Uint8Array[] = [];
		let total = 0;

		req.on("data", (chunk: unknown) => {
			const buf = chunk as Uint8Array;
			total += buf.byteLength;
			if (total > maxBytes) {
				req.destroy();
				reject(new Error("Payload too large"));
				return;
			}
			chunks.push(buf);
		});

		req.on("end", () => {
			const combined = new Uint8Array(total);
			let offset = 0;
			for (const chunk of chunks) {
				combined.set(chunk, offset);
				offset += chunk.byteLength;
			}
			resolve(combined);
		});

		req.on("error", (err: unknown) => {
			reject(err instanceof Error ? err : new Error("Request read error"));
		});
	});
}

export class LocalSyncServer {
	private server: NodeHttpServer | null = null;
	private running = false;
	private activePort = 0;
	private pairingSession: PairingSession | null = null;
	private pendingApproval = false;

	constructor(
		private app: App,
		private getSettings: () => LocalSyncSettings,
		private saveSettings: () => Promise<void>,
		private onPairApprovalRequest: (remoteDeviceName: string) => Promise<PairApprovalResult>
	) {}

	isRunning(): boolean {
		return this.running;
	}

	getPort(): number {
		return this.activePort;
	}

	openPairingWindow(pairCode: string, durationMs = 180000): void {
		this.pairingSession = {
			pairCode,
			expiresAt: Date.now() + durationMs,
		};
	}

	closePairingWindow(): void {
		this.pairingSession = null;
	}

	start(port: number): Promise<void> {
		return new Promise((resolve, reject) => {
			if (!Platform.isDesktopApp) {
				resolve();
				return;
			}

			this.stop();

			const http = nodeRequire<NodeHttpModule>("http");
			if (!http) {
				reject(new Error("Node http module is unavailable."));
				return;
			}

			const srv = http.createServer((req, res) => {
				void this.handleRequest(req, res);
			});

			srv.on("error", (err: unknown) => {
				this.running = false;
				this.server = null;
				reject(err instanceof Error ? err : new Error("Failed to start server"));
			});

			srv.listen(port, "0.0.0.0", () => {
				this.server = srv;
				this.running = true;
				this.activePort = port;
				resolve();
			});
		});
	}

	stop(): void {
		this.closePairingWindow();
		if (this.server) {
			try {
				this.server.close();
			} catch {
				// Ignore
			}
			this.server = null;
		}
		this.running = false;
		this.activePort = 0;
	}

	private isAuthorized(req: NodeIncomingMessage): boolean {
		const settings = this.getSettings();
		const header = req.headers["x-sync-token"];
		const provided = Array.isArray(header) ? header[0] : header;
		return Boolean(settings.hostToken && provided && provided === settings.hostToken);
	}

	private async handleRequest(req: NodeIncomingMessage, res: NodeServerResponse): Promise<void> {
		try {
			const method = (req.method || "GET").toUpperCase();
			if (method === "OPTIONS") {
				res.statusCode = 204;
				setCorsHeaders(res);
				res.end();
				return;
			}

			const rawUrl = req.url || "/";
			const parsedUrl = new URL(rawUrl, "http://127.0.0.1");
			const pathname = parsedUrl.pathname;
			const settings = this.getSettings();
			const configDir = this.app.vault.configDir;

			// Public LAN auto-discovery endpoint (exposes only device name and vault ID, no files or secrets)
			if (method === "GET" && (pathname === "/discover" || pathname === "/")) {
				const rawHostname = getDesktopHostname();
				sendJson(res, 200, {
					app: DISCOVERY_APP_ID,
					vaultId: settings.vaultId,
					deviceName: settings.deviceName || rawHostname,
					hostLocalName: `${rawHostname}.local`,
					port: settings.hostPort,
				});
				return;
			}

			// Pairing request endpoint (requires explicit approval modal on host)
			if (method === "POST" && pathname === "/pair-request") {
				await this.handlePairRequest(req, res);
				return;
			}

			if (!this.isAuthorized(req)) {
				sendJson(res, 401, { error: "Unauthorized. Please re-pair this device." });
				return;
			}

			if (method === "GET" && pathname === "/ping") {
				sendJson(res, 200, {
					ok: true,
					vaultId: settings.vaultId,
					deviceName: settings.deviceName || getDesktopHostname(),
				});
				return;
			}

			if (method === "GET" && pathname === "/manifest") {
				const { manifest, updatedCache } = await buildVaultManifest(
					this.app,
					settings.hashCache,
					settings.excludePatterns
				);
				settings.hashCache = updatedCache;
				await this.saveSettings();

				sendJson(res, 200, {
					vaultId: settings.vaultId,
					deviceName: settings.deviceName || getDesktopHostname(),
					files: manifest,
				});
				return;
			}

			if (method === "GET" && pathname === "/file/download") {
				const cleanPath = sanitizeVaultPath(parsedUrl.searchParams.get("path") || "", configDir);
				if (!cleanPath || shouldExclude(cleanPath, settings.excludePatterns, configDir)) {
					sendJson(res, 400, { error: "Invalid or excluded file path" });
					return;
				}
				if (!(await this.app.vault.adapter.exists(cleanPath))) {
					sendJson(res, 404, { error: "File not found" });
					return;
				}
				const data = await this.app.vault.adapter.readBinary(cleanPath);
				sendJson(res, 200, { ok: true, data: arrayBufferToBase64(data) });
				return;
			}

			if (method === "POST" && pathname === "/file/upload") {
				const cleanPath = sanitizeVaultPath(parsedUrl.searchParams.get("path") || "", configDir);
				if (!cleanPath || shouldExclude(cleanPath, settings.excludePatterns, configDir)) {
					sendJson(res, 400, { error: "Invalid or excluded file path" });
					return;
				}
				const bodyBytes = await readRequestBody(req, MAX_UPLOAD_BYTES);
				const bodyText = new TextDecoder("utf-8").decode(bodyBytes);
				const parsed = JSON.parse(bodyText) as { data?: string };
				if (typeof parsed.data !== "string") {
					sendJson(res, 400, { error: "Missing base64 file payload" });
					return;
				}
				const arrayBuffer = base64ToArrayBuffer(parsed.data);
				await ensureParentDirs(this.app, cleanPath);
				await this.app.vault.adapter.writeBinary(cleanPath, arrayBuffer);
				delete settings.hashCache[cleanPath];
				sendJson(res, 200, { ok: true });
				return;
			}

			if (method === "POST" && pathname === "/file/delete") {
				const cleanPath = sanitizeVaultPath(parsedUrl.searchParams.get("path") || "", configDir);
				if (!cleanPath || shouldExclude(cleanPath, settings.excludePatterns, configDir)) {
					sendJson(res, 400, { error: "Invalid or excluded file path" });
					return;
				}
				await trashVaultFile(this.app, cleanPath);
				delete settings.hashCache[cleanPath];
				sendJson(res, 200, { ok: true });
				return;
			}

			if (pathname === "/file") {
				const cleanPath = sanitizeVaultPath(parsedUrl.searchParams.get("path") || "", configDir);
				if (!cleanPath || shouldExclude(cleanPath, settings.excludePatterns, configDir)) {
					sendJson(res, 400, { error: "Invalid or excluded file path" });
					return;
				}

				if (method === "GET") {
					if (!(await this.app.vault.adapter.exists(cleanPath))) {
						sendJson(res, 404, { error: "File not found" });
						return;
					}
					const data = await this.app.vault.adapter.readBinary(cleanPath);
					const bytes = new Uint8Array(data);
					res.statusCode = 200;
					setCorsHeaders(res);
					res.setHeader("Content-Type", "application/octet-stream");
					res.setHeader("Content-Length", bytes.byteLength);
					res.end(bytes);
					return;
				}

				if (method === "PUT") {
					const bytes = await readRequestBody(req, MAX_UPLOAD_BYTES);
					const arrayBuffer = bytes.buffer.slice(
						bytes.byteOffset,
						bytes.byteOffset + bytes.byteLength
					) as ArrayBuffer;
					await ensureParentDirs(this.app, cleanPath);
					await this.app.vault.adapter.writeBinary(cleanPath, arrayBuffer);
					delete settings.hashCache[cleanPath];
					sendJson(res, 200, { ok: true });
					return;
				}

				if (method === "DELETE") {
					await trashVaultFile(this.app, cleanPath);
					delete settings.hashCache[cleanPath];
					sendJson(res, 200, { ok: true });
					return;
				}
			}

			sendJson(res, 404, { error: "Not found" });
		} catch (err) {
			const message = err instanceof Error ? err.message : "Internal server error";
			sendJson(res, 500, { error: message });
		}
	}

	private async handlePairRequest(req: NodeIncomingMessage, res: NodeServerResponse): Promise<void> {
		if (this.pendingApproval) {
			sendJson(res, 429, {
				approved: false,
				error: "Another pairing approval is already open on host.",
			});
			return;
		}

		const bodyBytes = await readRequestBody(req, 16 * 1024);
		const bodyText = new TextDecoder("utf-8").decode(bodyBytes);
		let parsed: { deviceName?: string; pairCode?: string } = {};
		try {
			if (bodyText.trim()) {
				parsed = JSON.parse(bodyText) as { deviceName?: string; pairCode?: string };
			}
		} catch {
			sendJson(res, 400, { approved: false, error: "Invalid JSON" });
			return;
		}

		if (
			this.pairingSession &&
			parsed.pairCode &&
			Date.now() <= this.pairingSession.expiresAt &&
			parsed.pairCode !== this.pairingSession.pairCode
		) {
			sendJson(res, 403, { approved: false, error: "Invalid pairing code" });
			return;
		}

		const requesterName = (parsed.deviceName || "LAN device").slice(0, 80);
		this.pendingApproval = true;
		let decision: PairApprovalResult;
		try {
			decision = await this.onPairApprovalRequest(requesterName);
		} finally {
			this.pendingApproval = false;
		}

		if (!decision.approved) {
			sendJson(res, 403, { approved: false, error: "Denied by host user" });
			return;
		}

		const settings = this.getSettings();
		const rawHostname = getDesktopHostname();
		const hostName = settings.deviceName || rawHostname;

		sendJson(res, 200, {
			approved: true,
			vaultId: settings.vaultId,
			hostName,
			hostLocalName: `${rawHostname}.local`,
			port: settings.hostPort,
			token: settings.hostToken,
		});
	}
}
