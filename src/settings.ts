import { App, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import { generateRandomHex } from "./crypto";
import type LocalLanSyncPlugin from "./main";
import { extractSubnetPrefix, resolveReachableHost } from "./scanner";
import { getLocalLanIps } from "./server";
import { DEFAULT_PORT } from "./types";

export class LocalSyncSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: LocalLanSyncPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const settings = this.plugin.settings;

		new Setting(containerEl).setName("Sync connection").setHeading();

		const card = containerEl.createDiv({ cls: "local-sync-settings-card" });
		if (settings.pairedHost) {
			card.createDiv({
				cls: "local-sync-settings-card-title",
				text: `Paired with: ${settings.pairedHost.hostName}`,
			});
			const lastSyncStr = settings.lastSyncTime
				? new Date(settings.lastSyncTime).toLocaleString()
				: "Never synced yet";
			card.createDiv({
				cls: "local-sync-settings-card-meta",
				text: `Address: ${settings.pairedHost.hostIp}:${settings.pairedHost.port} • Last sync: ${lastSyncStr}`,
			});
		} else {
			card.createDiv({
				cls: "local-sync-settings-card-title",
				text: "Not paired to a host computer",
			});
			card.createDiv({
				cls: "local-sync-settings-card-meta",
				text: 'Click "Scan Wi-Fi and connect" to automatically find your host computer on local Wi-Fi.',
			});
		}

		const connSetting = new Setting(containerEl)
			.setName("Manual sync and discovery")
			.setDesc("No automatic background syncing; syncs only when triggered manually.");

		if (settings.pairedHost) {
			connSetting.addButton((btn) =>
				btn
					.setButtonText("Sync now")
					.setCta()
					.onClick(async () => {
						await this.plugin.triggerManualSync();
						this.display();
					})
			);
			connSetting.addButton((btn) =>
				btn.setButtonText("Test connection").onClick(async () => {
					const host = settings.pairedHost;
					if (!host) return;
					const statusNotice = new Notice("Searching for host computer on Wi-Fi...", 0);
					const url = await resolveReachableHost(
						host,
						settings.preferredSubnet,
						async (newIp) => {
							host.hostIp = newIp;
							const prefix = extractSubnetPrefix(newIp);
							if (prefix) settings.preferredSubnet = prefix;
							await this.plugin.saveSettings();
						},
						(msg) => statusNotice.setMessage(msg)
					);
					statusNotice.hide();
					if (url) {
						new Notice(`Connected successfully at ${url}.`, 5000);
					} else {
						new Notice(
							`Host not found. Verify the host computer is running and port ${host.port} is open in the firewall.`,
							7000
						);
					}
					this.display();
				})
			);
			connSetting.addButton((btn) =>
				btn
					.setButtonText("Unpair")
					.setWarning()
					.onClick(async () => {
						settings.pairedHost = null;
						settings.lastSyncState = {};
						settings.lastSyncTime = null;
						await this.plugin.saveSettings();
						new Notice("Unpaired from host computer.");
						this.display();
					})
			);
		} else {
			connSetting.addButton((btn) =>
				btn
					.setButtonText("Scan Wi-Fi and connect")
					.setCta()
					.onClick(() => {
						this.plugin.openConnectModal(() => this.display());
					})
			);
		}

		if (Platform.isDesktopApp) {
			new Setting(containerEl).setName("Host computer").setHeading();

			const ips = getLocalLanIps();
			const primaryIp = ips[0] || "offline";
			const statusText = this.plugin.server.isRunning()
				? `Listening passively on 0.0.0.0:${this.plugin.server.getPort()} • Test URL: http://${primaryIp}:${this.plugin.server.getPort()}/discover`
				: "Host server is stopped";

			new Setting(containerEl)
				.setName("Enable host server")
				.setDesc(statusText)
				.addToggle((toggle) =>
					toggle.setValue(settings.hostEnabled).onChange(async (value) => {
						settings.hostEnabled = value;
						await this.plugin.saveSettings();
						await this.plugin.applyHostServerState();
						this.display();
					})
				);

			new Setting(containerEl)
				.setName("Pair a phone or another computer")
				.setDesc("Shows a QR code and makes this computer discoverable on local Wi-Fi.")
				.addButton((btn) =>
					btn
						.setButtonText("Pair new device")
						.setCta()
						.setDisabled(!settings.hostEnabled)
						.onClick(() => {
							this.plugin.openPairHostModal();
						})
				);

			new Setting(containerEl)
				.setName("Host port")
				.setDesc(`Default is ${DEFAULT_PORT}. Allow TCP port ${settings.hostPort} in your firewall.`)
				.addText((text) =>
					text
						.setPlaceholder(String(DEFAULT_PORT))
						.setValue(String(settings.hostPort))
						.onChange(async (val) => {
							const parsed = Number(val.trim());
							if (Number.isInteger(parsed) && parsed >= 1024 && parsed <= 65535) {
								settings.hostPort = parsed;
								await this.plugin.saveSettings();
								if (settings.hostEnabled) {
									await this.plugin.applyHostServerState();
								}
							}
						})
				);

			new Setting(containerEl)
				.setName("Reset security token")
				.setDesc("Revokes all currently paired devices. You will need to re-pair them.")
				.addButton((btn) =>
					btn
						.setButtonText("Regenerate token")
						.setWarning()
						.onClick(async () => {
							settings.hostToken = generateRandomHex(16);
							await this.plugin.saveSettings();
							new Notice("Security token regenerated.");
						})
				);
		}

		new Setting(containerEl).setName("Advanced").setHeading();

		new Setting(containerEl)
			.setName("Device name")
			.setDesc("Friendly name shown when pairing devices.")
			.addText((text) =>
				text.setValue(settings.deviceName).onChange(async (val) => {
					settings.deviceName = val.trim();
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Preferred Wi-Fi subnet")
			.setDesc("Optional speed boost for auto-scanning (e.g. 192.168.1). Updated automatically on sync.")
			.addText((text) =>
				text
					.setPlaceholder("192.168.1")
					.setValue(settings.preferredSubnet)
					.onChange(async (val) => {
						const trimmed = val.trim();
						if (!trimmed) {
							settings.preferredSubnet = "";
							await this.plugin.saveSettings();
							return;
						}
						const prefix = extractSubnetPrefix(trimmed);
						if (prefix) {
							settings.preferredSubnet = prefix;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName("Excluded paths")
			.setDesc("One path or pattern per line (e.g. Private/, *.tmp). The vault configuration folder is always excluded.")
			.addTextArea((area) => {
				area
					.setValue(settings.excludePatterns.join("\n"))
					.onChange(async (val) => {
						settings.excludePatterns = val
							.split(/\r?\n/)
							.map((line) => line.trim())
							.filter(Boolean);
						await this.plugin.saveSettings();
					});
				area.inputEl.rows = 5;
			});
	}
}
