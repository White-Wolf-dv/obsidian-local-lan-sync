import { App, requestUrl } from "obsidian";
import { arrayBufferToBase64, base64ToArrayBuffer } from "./crypto";
import {
	buildConflictPath,
	buildVaultManifest,
	ensureParentDirs,
	sanitizeVaultPath,
	trashVaultFile,
} from "./hash";
import { extractSubnetPrefix, resolveReachableHost, safeResponseJson } from "./scanner";
import { LocalSyncSettings, SyncSummary, VaultManifest } from "./types";

async function fetchRemoteManifest(baseUrl: string, token: string): Promise<VaultManifest> {
	const res = await requestUrl({
		url: `${baseUrl}/manifest`,
		method: "GET",
		headers: {
			"X-Sync-Token": token,
		},
		throw: false,
	});

	if (res.status === 401) {
		throw new Error("Authentication failed (token mismatch). Please unpair and connect again.");
	}
	if (res.status !== 200) {
		throw new Error(`Host returned HTTP ${res.status} while fetching manifest.`);
	}

	const data = safeResponseJson<{ files?: VaultManifest }>(res);
	if (!data) {
		throw new Error("Host returned invalid manifest response.");
	}
	return data.files || {};
}

async function downloadRemoteFile(
	baseUrl: string,
	token: string,
	path: string
): Promise<ArrayBuffer> {
	const res = await requestUrl({
		url: `${baseUrl}/file/download?path=${encodeURIComponent(path)}`,
		method: "GET",
		headers: {
			"X-Sync-Token": token,
		},
		throw: false,
	});
	if (res.status !== 200) {
		throw new Error(`Download failed for "${path}" (HTTP ${res.status})`);
	}
	const parsed = safeResponseJson<{ ok?: boolean; data?: string }>(res);
	if (!parsed || typeof parsed.data !== "string") {
		throw new Error(`Invalid download payload for "${path}"`);
	}
	return base64ToArrayBuffer(parsed.data);
}

async function uploadLocalFile(
	baseUrl: string,
	token: string,
	path: string,
	data: ArrayBuffer
): Promise<void> {
	const res = await requestUrl({
		url: `${baseUrl}/file/upload?path=${encodeURIComponent(path)}`,
		method: "POST",
		headers: {
			"X-Sync-Token": token,
		},
		contentType: "application/json",
		body: JSON.stringify({ data: arrayBufferToBase64(data) }),
		throw: false,
	});
	if (res.status !== 200) {
		const errBody = safeResponseJson<{ error?: string }>(res);
		throw new Error(
			`Upload failed for "${path}" (HTTP ${res.status}${errBody?.error ? `: ${errBody.error}` : ""})`
		);
	}
}

async function deleteRemoteFile(
	baseUrl: string,
	token: string,
	path: string
): Promise<void> {
	const res = await requestUrl({
		url: `${baseUrl}/file/delete?path=${encodeURIComponent(path)}`,
		method: "POST",
		headers: {
			"X-Sync-Token": token,
		},
		contentType: "application/json",
		body: "{}",
		throw: false,
	});
	if (res.status !== 200 && res.status !== 404) {
		throw new Error(`Remote delete failed for "${path}" (HTTP ${res.status})`);
	}
}

export async function runManualSync(
	app: App,
	settings: LocalSyncSettings,
	saveSettings: () => Promise<void>,
	onStatus?: (message: string) => void
): Promise<SyncSummary> {
	if (!settings.pairedHost) {
		throw new Error("No host computer paired yet.");
	}

	const host = settings.pairedHost;
	const configDir = app.vault.configDir;
	const summary: SyncSummary = {
		pulled: 0,
		pushed: 0,
		deletedLocal: 0,
		deletedRemote: 0,
		conflicts: 0,
		unchanged: 0,
		errors: [],
	};

	const baseUrl = await resolveReachableHost(
		host,
		settings.preferredSubnet,
		async (newIp) => {
			host.hostIp = newIp;
			const subnet = extractSubnetPrefix(newIp);
			if (subnet) {
				settings.preferredSubnet = subnet;
			}
			await saveSettings();
		},
		onStatus
	);

	if (!baseUrl) {
		throw new Error(
			`Could not find "${host.hostName}" on Wi-Fi. Ensure the host computer is open on the same Wi-Fi and port ${host.port} is allowed in the firewall.`
		);
	}

	onStatus?.(`Comparing files with ${host.hostName}...`);
	const [localResult, remoteManifest] = await Promise.all([
		buildVaultManifest(app, settings.hashCache, settings.excludePatterns),
		fetchRemoteManifest(baseUrl, host.token),
	]);

	const localManifest = localResult.manifest;
	settings.hashCache = localResult.updatedCache;

	const baseState = settings.lastSyncState || {};
	const nextState: Record<string, string> = {};

	const allPaths = new Set<string>([
		...Object.keys(localManifest),
		...Object.keys(remoteManifest),
		...Object.keys(baseState),
	]);

	for (const rawPath of allPaths) {
		const path = sanitizeVaultPath(rawPath, configDir);
		if (!path) continue;

		const L = localManifest[path]?.hash;
		const R = remoteManifest[path]?.hash;
		const B = baseState[path];

		try {
			if (L === R) {
				if (L) {
					nextState[path] = L;
					summary.unchanged++;
				}
				continue;
			}

			if (L && !R) {
				if (B && B === L) {
					await trashVaultFile(app, path);
					delete settings.hashCache[path];
					summary.deletedLocal++;
				} else {
					onStatus?.(`Uploading ${path}...`);
					const data = await app.vault.adapter.readBinary(path);
					await uploadLocalFile(baseUrl, host.token, path, data);
					nextState[path] = L;
					summary.pushed++;
				}
				continue;
			}

			if (!L && R) {
				if (B && B === R) {
					await deleteRemoteFile(baseUrl, host.token, path);
					summary.deletedRemote++;
				} else {
					onStatus?.(`Downloading ${path}...`);
					const data = await downloadRemoteFile(baseUrl, host.token, path);
					await ensureParentDirs(app, path);
					await app.vault.adapter.writeBinary(path, data);
					nextState[path] = R;
					summary.pulled++;
				}
				continue;
			}

			if (L && R && L !== R) {
				if (B && B === L) {
					onStatus?.(`Updating ${path}...`);
					const data = await downloadRemoteFile(baseUrl, host.token, path);
					await ensureParentDirs(app, path);
					await app.vault.adapter.writeBinary(path, data);
					nextState[path] = R;
					summary.pulled++;
				} else if (B && B === R) {
					onStatus?.(`Uploading ${path}...`);
					const data = await app.vault.adapter.readBinary(path);
					await uploadLocalFile(baseUrl, host.token, path, data);
					nextState[path] = L;
					summary.pushed++;
				} else {
					onStatus?.(`Saving conflict copy for ${path}...`);
					const localBytes = await app.vault.adapter.readBinary(path);
					const remoteBytes = await downloadRemoteFile(baseUrl, host.token, path);
					const conflictPath = buildConflictPath(path);

					await ensureParentDirs(app, conflictPath);
					await app.vault.adapter.writeBinary(conflictPath, localBytes);
					await uploadLocalFile(baseUrl, host.token, conflictPath, localBytes);

					await app.vault.adapter.writeBinary(path, remoteBytes);

					nextState[path] = R;
					nextState[conflictPath] = L;
					summary.conflicts++;
				}
			}
		} catch (err) {
			if (B) {
				nextState[path] = B;
			}
			const msg = err instanceof Error ? err.message : String(err);
			summary.errors.push(`${path}: ${msg}`);
		}
	}

	if (summary.pulled > 0 || summary.conflicts > 0) {
		const refreshed = await buildVaultManifest(app, settings.hashCache, settings.excludePatterns);
		settings.hashCache = refreshed.updatedCache;
	}

	settings.lastSyncState = nextState;
	settings.lastSyncTime = Date.now();
	await saveSettings();

	return summary;
}
