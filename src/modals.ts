import { App, Modal, Notice, Platform, requestUrl, Setting } from "obsidian";
import { generateRandomHex } from "./crypto";
import { UdpClientDiscoverer, UdpHostBroadcaster } from "./discovery";
import { createQrSvgElement } from "./qr";
import {
	extractSubnetPrefix,
	safeResponseJson,
	scanLanForHosts,
} from "./scanner";
import { getDesktopHostname, getLocalLanIps, LocalSyncServer } from "./server";
import {
	DEFAULT_PORT,
	DISCOVERY_APP_ID,
	DiscoveredPeer,
	LocalSyncSettings,
	PairedHostConfig,
	PROTOCOL_ACTION,
	ScanController,
} from "./types";

export function buildPairingUri(settings: LocalSyncSettings, ip: string): string {
	const rawHostname = getDesktopHostname();
	const deviceName = settings.deviceName || rawHostname;
	const params = new URLSearchParams({
		ip,
		host: `${rawHostname}.local`,
		port: String(settings.hostPort),
		token: settings.hostToken,
		id: settings.vaultId,
		name: deviceName,
	});
	return `obsidian://${PROTOCOL_ACTION}?${params.toString()}`;
}

export function parsePairingUri(uriText: string): PairedHostConfig | null {
	const trimmed = uriText.trim();
	if (!trimmed) return null;

	try {
		const queryStart = trimmed.indexOf("?");
		if (queryStart === -1) return null;
		const params = new URLSearchParams(trimmed.slice(queryStart + 1));

		const ip = params.get("ip") || "";
		const host = params.get("host") || "";
		const port = Number(params.get("port") || "0");
		const token = params.get("token") || "";
		const id = params.get("id") || "";
		const name = params.get("name") || "Desktop host";

		if (!ip || !port || !token || !id) {
			return null;
		}

		return {
			vaultId: id,
			hostName: name,
			hostIp: ip,
			hostLocalName: host,
			port,
			token,
		};
	} catch {
		return null;
	}
}

export class PairHostModal extends Modal {
	private broadcaster = new UdpHostBroadcaster();
	private qrWrapperEl: HTMLElement | null = null;
	private addressInfoEl: HTMLElement | null = null;
	private selectedIp = "";
	private currentUri = "";

	constructor(
		app: App,
		private settings: LocalSyncSettings,
		private server: LocalSyncServer
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("local-sync-modal");

		contentEl.createEl("h2", { text: "Pair new device" });

		const ips = getLocalLanIps();
		if (ips.length === 0) {
			contentEl.createEl("p", {
				text: "No local Wi-Fi or LAN IP address detected. Connect this computer to your local network and try again.",
			});
			return;
		}

		this.selectedIp = ips[0];
		const pairCode = generateRandomHex(8);
		this.server.openPairingWindow(pairCode, 180000);

		const rawHostname = getDesktopHostname();
		this.broadcaster.start({
			app: DISCOVERY_APP_ID,
			deviceName: this.settings.deviceName || rawHostname,
			ip: this.selectedIp,
			hostLocalName: `${rawHostname}.local`,
			port: this.settings.hostPort,
			vaultId: this.settings.vaultId,
			pairCode,
		});

		const qrCard = contentEl.createDiv({ cls: "local-sync-qr-card" });
		this.qrWrapperEl = qrCard.createDiv({ cls: "local-sync-qr-wrapper" });
		this.addressInfoEl = qrCard.createDiv({ cls: "local-sync-hint" });
		this.renderQr();

		const badge = qrCard.createDiv({ cls: "local-sync-status-badge" });
		badge.createSpan({ cls: "local-sync-status-dot" });
		badge.createSpan({ text: "Discoverable on local Wi-Fi (phone and desktop)" });

		if (ips.length > 1) {
			new Setting(contentEl)
				.setName("Network interface IP")
				.setDesc("Choose your local Wi-Fi/LAN IP address.")
				.addDropdown((dd) => {
					for (const ip of ips) {
						dd.addOption(ip, ip);
					}
					dd.setValue(this.selectedIp);
					dd.onChange((val) => {
						this.selectedIp = val;
						this.broadcaster.updateIp(val);
						this.renderQr();
					});
				});
		}

		const actions = contentEl.createDiv({ cls: "local-sync-actions" });

		const copyBtn = actions.createEl("button", { text: "Copy pairing link" });
		copyBtn.addEventListener("click", () => {
			void (async () => {
				try {
					await navigator.clipboard.writeText(this.currentUri);
					new Notice("Pairing link copied.");
				} catch {
					new Notice("Could not copy to clipboard.");
				}
			})();
		});

		const closeBtn = actions.createEl("button", { text: "Done", cls: "mod-cta" });
		closeBtn.addEventListener("click", () => this.close());
	}

	private renderQr(): void {
		if (!this.qrWrapperEl) return;
		this.qrWrapperEl.empty();
		this.currentUri = buildPairingUri(this.settings, this.selectedIp);
		this.qrWrapperEl.appendChild(createQrSvgElement(this.currentUri));

		if (this.addressInfoEl) {
			this.addressInfoEl.setText(
				`LAN address: ${this.selectedIp}:${this.settings.hostPort} — Open "Scan Wi-Fi and connect" on your other device, or scan this QR code.`
			);
		}
	}

	onClose(): void {
		this.broadcaster.stop();
		this.server.closePairingWindow();
		this.contentEl.empty();
	}
}

export class PairApprovalModal extends Modal {
	private resolved = false;

	constructor(
		app: App,
		private remoteDeviceName: string,
		private onDecision: (approved: boolean) => void
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("local-sync-modal");

		contentEl.createEl("h2", { text: "Allow device connection?" });
		contentEl.createEl("p", {
			text: `"${this.remoteDeviceName}" on your local Wi-Fi wants to pair and sync with this vault.`,
		});

		const actions = contentEl.createDiv({ cls: "local-sync-actions" });

		const denyBtn = actions.createEl("button", { text: "Deny" });
		denyBtn.addEventListener("click", () => this.finish(false));

		const allowBtn = actions.createEl("button", { text: "Approve", cls: "mod-cta" });
		allowBtn.addEventListener("click", () => this.finish(true));
	}

	private finish(approved: boolean): void {
		if (this.resolved) return;
		this.resolved = true;
		this.onDecision(approved);
		this.close();
	}

	onClose(): void {
		if (!this.resolved) {
			this.resolved = true;
			this.onDecision(false);
		}
		this.contentEl.empty();
	}
}

export class PairClientModal extends Modal {
	private udpDiscoverer = new UdpClientDiscoverer();
	private scanController: ScanController = { aborted: false };
	private discoveredPeers = new Map<string, DiscoveredPeer>();
	private peerListEl: HTMLElement | null = null;
	private statusTextEl: HTMLElement | null = null;
	private rescanBtn: HTMLButtonElement | null = null;
	private subnetInputEl: HTMLInputElement | null = null;
	private isScanning = false;

	constructor(
		app: App,
		private settings: LocalSyncSettings,
		private onPaired: (host: PairedHostConfig) => Promise<void>
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("local-sync-modal");

		contentEl.createEl("h2", { text: "Find and connect to host" });
		contentEl.createEl("p", {
			cls: "local-sync-hint",
			text: "Scanning your local Wi-Fi network for available host computers...",
		});

		const scanBar = contentEl.createDiv({ cls: "local-sync-scan-bar" });
		this.statusTextEl = scanBar.createSpan({ text: "Starting network scan..." });
		this.rescanBtn = scanBar.createEl("button", { text: "Rescan" });
		this.rescanBtn.addEventListener("click", () => {
			void this.startNetworkScan();
		});

		this.peerListEl = contentEl.createDiv({ cls: "local-sync-peer-list" });
		this.renderPeers();

		const subnetRow = contentEl.createDiv({ cls: "local-sync-subnet-row" });
		this.subnetInputEl = subnetRow.createEl("input", {
			cls: "local-sync-subnet-input",
			attr: {
				type: "text",
				placeholder: "Optional subnet (e.g. 192.168.1)",
				value: this.settings.preferredSubnet || "",
			},
		});
		const scanSubnetBtn = subnetRow.createEl("button", { text: "Scan subnet" });
		scanSubnetBtn.addEventListener("click", () => {
			const val = this.subnetInputEl?.value.trim() || "";
			if (val && !extractSubnetPrefix(val)) {
				new Notice("Enter a valid subnet such as 192.168.1.");
				return;
			}
			void this.startNetworkScan(val || undefined);
		});

		contentEl.createEl("hr", { cls: "local-sync-divider" });

		contentEl.createEl("h4", { text: "Or paste pairing link" });
		const textarea = contentEl.createEl("textarea", {
			cls: "local-sync-uri-box",
			attr: {
				placeholder: `obsidian://${PROTOCOL_ACTION}?ip=...`,
			},
		});

		const actions = contentEl.createDiv({ cls: "local-sync-actions" });
		const pasteBtn = actions.createEl("button", { text: "Connect via link" });
		pasteBtn.addEventListener("click", () => {
			void (async () => {
				const parsed = parsePairingUri(textarea.value);
				if (!parsed) {
					new Notice("Invalid pairing link.");
					return;
				}
				await this.onPaired(parsed);
				this.close();
			})();
		});

		if (Platform.isDesktopApp) {
			this.udpDiscoverer.start(this.settings.vaultId, (peers) => {
				for (const peer of peers) {
					this.addOrUpdatePeer(peer);
				}
			});
		}

		void this.startNetworkScan();
	}

	private addOrUpdatePeer(peer: DiscoveredPeer): void {
		this.discoveredPeers.set(peer.vaultId, peer);
		this.renderPeers();
	}

	private async startNetworkScan(explicitSubnet?: string): Promise<void> {
		if (this.isScanning) {
			this.scanController.aborted = true;
		}

		this.scanController = { aborted: false };
		const activeController = this.scanController;
		this.isScanning = true;
		if (this.rescanBtn) this.rescanBtn.disabled = true;

		const hints: string[] = [];
		if (explicitSubnet) hints.push(explicitSubnet);
		else if (this.settings.preferredSubnet) hints.push(this.settings.preferredSubnet);
		if (this.settings.pairedHost?.hostIp) hints.push(this.settings.pairedHost.hostIp);

		try {
			await scanLanForHosts({
				ownVaultId: this.settings.vaultId,
				port: this.settings.hostPort || DEFAULT_PORT,
				subnetHints: hints,
				singleSubnetOnly: Boolean(explicitSubnet),
				controller: activeController,
				onFound: (peer) => {
					this.addOrUpdatePeer(peer);
				},
				onProgress: (msg) => {
					if (!activeController.aborted && this.statusTextEl) {
						this.statusTextEl.setText(msg);
					}
				},
			});

			if (!activeController.aborted && this.statusTextEl) {
				const count = this.discoveredPeers.size;
				this.statusTextEl.setText(
					count > 0
						? `Found ${count} host computer(s) on Wi-Fi.`
						: "No host found. Check the host firewall (port 27123) and Wi-Fi connection."
				);
			}
		} finally {
			if (this.scanController === activeController) {
				this.isScanning = false;
				if (this.rescanBtn) this.rescanBtn.disabled = false;
			}
		}
	}

	private renderPeers(): void {
		if (!this.peerListEl) return;
		this.peerListEl.empty();

		const peers = Array.from(this.discoveredPeers.values());
		if (peers.length === 0) {
			this.peerListEl.createDiv({
				cls: "local-sync-hint",
				text: this.isScanning
					? "Looking for host computers on local Wi-Fi..."
					: "No host detected yet. Make sure the host computer is running.",
			});
			return;
		}

		for (const peer of peers) {
			const row = this.peerListEl.createDiv({ cls: "local-sync-peer-item" });
			const info = row.createDiv({ cls: "local-sync-peer-info" });
			info.createDiv({ cls: "local-sync-peer-name", text: peer.deviceName });
			info.createDiv({ cls: "local-sync-peer-sub", text: `${peer.ip}:${peer.port}` });

			const connectBtn = row.createEl("button", { text: "Connect", cls: "mod-cta" });
			connectBtn.addEventListener("click", () => {
				void (async () => {
					connectBtn.disabled = true;
					connectBtn.setText("Approve on host...");

					try {
						const res = await requestUrl({
							url: `http://${peer.ip}:${peer.port}/pair-request`,
							method: "POST",
							contentType: "application/json",
							body: JSON.stringify({
								deviceName: this.settings.deviceName || getDesktopHostname(),
								pairCode: peer.pairCode || "",
							}),
							throw: false,
						});

						const data = safeResponseJson<{
							approved?: boolean;
							vaultId?: string;
							hostName?: string;
							hostLocalName?: string;
							port?: number;
							token?: string;
							error?: string;
						}>(res);

						if (res.status !== 200 || !data?.approved || !data.token || !data.vaultId) {
							new Notice(data?.error || `Connection denied (HTTP ${res.status}).`);
							connectBtn.disabled = false;
							connectBtn.setText("Connect");
							return;
						}

						this.scanController.aborted = true;
						await this.onPaired({
							vaultId: data.vaultId,
							hostName: data.hostName || peer.deviceName,
							hostIp: peer.ip,
							hostLocalName: data.hostLocalName || peer.hostLocalName,
							port: data.port || peer.port,
							token: data.token,
						});
						this.close();
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						new Notice(`Could not connect to ${peer.ip}: ${msg}`);
						connectBtn.disabled = false;
						connectBtn.setText("Connect");
					}
				})();
			});
		}
	}

	onClose(): void {
		this.scanController.aborted = true;
		this.udpDiscoverer.stop();
		this.contentEl.empty();
	}
}
