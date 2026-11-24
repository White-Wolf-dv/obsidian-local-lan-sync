import { Notice, ObsidianProtocolData, Platform, Plugin } from "obsidian";
import { generateRandomHex } from "./crypto";
import { PairApprovalModal, PairClientModal, PairHostModal } from "./modals";
import { extractSubnetPrefix } from "./scanner";
import { getDesktopHostname, LocalSyncServer } from "./server";
import { LocalSyncSettingTab } from "./settings";
import { runManualSync } from "./syncEngine";
import {
	DEFAULT_EXCLUDE_PATTERNS,
	DEFAULT_SETTINGS,
	LocalSyncSettings,
	PairedHostConfig,
	PROTOCOL_ACTION,
} from "./types";

export default class LocalLanSyncPlugin extends Plugin {
	settings: LocalSyncSettings = { ...DEFAULT_SETTINGS };
	server!: LocalSyncServer;

	private ribbonEl: HTMLElement | null = null;
	private isSyncing = false;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.server = new LocalSyncServer(
			this.app,
			() => this.settings,
			() => this.saveSettings(),
			(remoteDeviceName) => this.promptPairApproval(remoteDeviceName)
		);

		if (Platform.isDesktopApp && this.settings.hostEnabled) {
			await this.applyHostServerState();
		}

		this.registerObsidianProtocolHandler(PROTOCOL_ACTION, async (params) => {
			await this.handlePairingProtocol(params);
		});

		this.ribbonEl = this.addRibbonIcon("refresh-cw", "Local LAN sync: sync now", () => {
			if (this.settings.pairedHost) {
				void this.triggerManualSync();
			} else {
				this.openConnectModal();
			}
		});

		this.addCommand({
			id: "sync-now",
			name: "Sync now",
			callback: async () => {
				await this.triggerManualSync();
			},
		});

		if (Platform.isDesktopApp) {
			this.addCommand({
				id: "pair-new-device",
				name: "Pair new device (show QR code)",
				callback: () => {
					this.openPairHostModal();
				},
			});
		}

		this.addCommand({
			id: "connect-to-host",
			name: "Scan Wi-Fi and connect to host",
			callback: () => {
				this.openConnectModal();
			},
		});

		this.addSettingTab(new LocalSyncSettingTab(this.app, this));
	}

	onunload(): void {
		if (this.server) {
			this.server.stop();
		}
	}

	async loadSettings(): Promise<void> {
		const loaded = (await this.loadData()) as Partial<LocalSyncSettings> | null;
		this.settings = {
			...DEFAULT_SETTINGS,
			...(loaded || {}),
			excludePatterns: loaded?.excludePatterns?.length
				? loaded.excludePatterns
				: [...DEFAULT_EXCLUDE_PATTERNS],
			lastSyncState: loaded?.lastSyncState || {},
			hashCache: loaded?.hashCache || {},
		};

		let dirty = false;
		if (!this.settings.vaultId) {
			this.settings.vaultId = generateRandomHex(12);
			dirty = true;
		}
		if (!this.settings.hostToken) {
			this.settings.hostToken = generateRandomHex(16);
			dirty = true;
		}
		if (!this.settings.deviceName) {
			this.settings.deviceName = Platform.isDesktopApp ? getDesktopHostname() : "Mobile device";
			dirty = true;
		}
		if (!Platform.isDesktopApp && this.settings.hostEnabled) {
			this.settings.hostEnabled = false;
			dirty = true;
		}

		if (dirty) {
			await this.saveSettings();
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	async applyHostServerState(): Promise<void> {
		if (!Platform.isDesktopApp) return;

		if (!this.settings.hostEnabled) {
			this.server.stop();
			return;
		}

		try {
			await this.server.start(this.settings.hostPort);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(
				`Could not start host server on port ${this.settings.hostPort} (${msg}).`
			);
		}
	}

	openPairHostModal(): void {
		if (!Platform.isDesktopApp) {
			new Notice("Host mode is only available on desktop.");
			return;
		}
		if (!this.server.isRunning()) {
			new Notice("Enable the host server in settings first.");
			return;
		}
		new PairHostModal(this.app, this.settings, this.server).open();
	}

	openConnectModal(onDone?: () => void): void {
		new PairClientModal(this.app, this.settings, async (host) => {
			await this.applyPairedHost(host);
			if (onDone) onDone();
		}).open();
	}

	private async applyPairedHost(host: PairedHostConfig): Promise<void> {
		const isDifferentVault = this.settings.pairedHost?.vaultId !== host.vaultId;
		this.settings.pairedHost = host;
		const subnet = extractSubnetPrefix(host.hostIp);
		if (subnet) {
			this.settings.preferredSubnet = subnet;
		}
		if (isDifferentVault) {
			this.settings.lastSyncState = {};
			this.settings.lastSyncTime = null;
		}
		await this.saveSettings();
		new Notice(
			`Paired with "${host.hostName}" (${host.hostIp}). Click the sync icon whenever you want to sync.`,
			6000
		);
	}

	private async handlePairingProtocol(params: ObsidianProtocolData): Promise<void> {
		const ip = params.ip || "";
		const host = params.host || "";
		const port = Number(params.port || "0");
		const token = params.token || "";
		const id = params.id || "";
		const name = params.name || "Desktop host";

		if (!ip || !port || !token || !id) {
			new Notice("Invalid pairing QR link.");
			return;
		}

		await this.applyPairedHost({
			vaultId: id,
			hostName: name,
			hostIp: ip,
			hostLocalName: host,
			port,
			token,
		});
	}

	private promptPairApproval(remoteDeviceName: string): Promise<{ approved: boolean }> {
		return new Promise((resolve) => {
			let settled = false;
			const timer = window.setTimeout(() => {
				if (!settled) {
					settled = true;
					modal.close();
					resolve({ approved: false });
				}
			}, 60000);

			const modal = new PairApprovalModal(this.app, remoteDeviceName, (approved) => {
				if (!settled) {
					settled = true;
					window.clearTimeout(timer);
					resolve({ approved });
				}
			});
			modal.open();
		});
	}

	async triggerManualSync(): Promise<void> {
		if (!this.settings.pairedHost) {
			new Notice("Not paired to a host computer yet. Scanning Wi-Fi...");
			this.openConnectModal();
			return;
		}

		if (this.isSyncing) {
			new Notice("Sync is already in progress...");
			return;
		}

		this.isSyncing = true;
		this.ribbonEl?.addClass("local-sync-spinning");
		const statusNotice = new Notice(
			`Syncing with ${this.settings.pairedHost.hostName}...`,
			0
		);

		try {
			const result = await runManualSync(
				this.app,
				this.settings,
				() => this.saveSettings(),
				(msg) => statusNotice.setMessage(msg)
			);
			statusNotice.hide();

			const deleted = result.deletedLocal + result.deletedRemote;
			const changes = result.pulled + result.pushed + deleted + result.conflicts;

			if (changes === 0 && result.errors.length === 0) {
				new Notice(`Already up to date (${result.unchanged} files checked).`, 4000);
			} else {
				const parts: string[] = [];
				if (result.pulled > 0) parts.push(`${result.pulled} received`);
				if (result.pushed > 0) parts.push(`${result.pushed} sent`);
				if (deleted > 0) parts.push(`${deleted} trashed`);
				if (result.conflicts > 0) parts.push(`${result.conflicts} conflict(s)`);
				if (result.errors.length > 0) parts.push(`${result.errors.length} error(s)`);
				new Notice(`Sync complete: ${parts.join(", ")}.`, 6000);
				if (result.errors.length > 0) {
					new Notice(`First error: ${result.errors[0]}`, 8000);
				}
			}
		} catch (err) {
			statusNotice.hide();
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(`Sync failed: ${msg}`, 8000);
		} finally {
			this.isSyncing = false;
			this.ribbonEl?.removeClass("local-sync-spinning");
		}
	}
}
