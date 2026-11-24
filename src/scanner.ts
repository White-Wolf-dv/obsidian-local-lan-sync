import { Platform, requestUrl, RequestUrlResponse } from "obsidian";
import { getLocalLanIps } from "./server";
import {
	DEFAULT_PORT,
	DISCOVERY_APP_ID,
	DiscoveredPeer,
	PairedHostConfig,
	ScanController,
} from "./types";

const COMMON_LAN_SUBNETS = [
	"192.168.1",
	"192.168.0",
	"192.168.43",
	"192.168.137",
	"192.168.100",
	"192.168.2",
	"10.0.0",
];

export function safeResponseJson<T>(res: RequestUrlResponse): T | null {
	try {
		if (!res || typeof res.text !== "string" || !res.text.trim()) {
			return null;
		}
		return JSON.parse(res.text) as T;
	} catch {
		return null;
	}
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = window.setTimeout(() => reject(new Error("Timeout")), ms);
		promise.then(
			(val) => {
				window.clearTimeout(timer);
				resolve(val);
			},
			(err) => {
				window.clearTimeout(timer);
				reject(err);
			}
		);
	});
}

export function extractSubnetPrefix(input: string): string | null {
	const cleaned = (input || "").trim();
	const m3 = cleaned.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\.\d{1,3})?$/);
	if (!m3) return null;
	const a = Number(m3[1]);
	const b = Number(m3[2]);
	const c = Number(m3[3]);
	if (a > 255 || b > 255 || c > 255) return null;
	if (a === 127 || a === 0 || (a === 169 && b === 254)) return null;
	return `${a}.${b}.${c}`;
}

async function detectMobileLocalSubnet(): Promise<string | null> {
	try {
		const RTC = (window as unknown as { RTCPeerConnection?: typeof RTCPeerConnection })
			.RTCPeerConnection;
		if (!RTC) return null;

		return await new Promise<string | null>((resolve) => {
			let settled = false;
			const pc = new RTC({ iceServers: [] });

			const finish = (subnet: string | null) => {
				if (settled) return;
				settled = true;
				try {
					pc.close();
				} catch {
					// Ignore
				}
				resolve(subnet);
			};

			const timer = window.setTimeout(() => finish(null), 500);

			pc.onicecandidate = (evt) => {
				if (!evt || !evt.candidate || !evt.candidate.candidate) return;
				const match = evt.candidate.candidate.match(
					/(192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})/
				);
				if (match) {
					const prefix = extractSubnetPrefix(match[1]);
					if (prefix) {
						window.clearTimeout(timer);
						finish(prefix);
					}
				}
			};

			pc.createDataChannel("lan-probe");
			pc.createOffer()
				.then((offer) => pc.setLocalDescription(offer))
				.catch(() => {
					window.clearTimeout(timer);
					finish(null);
				});
		});
	} catch {
		return null;
	}
}

export async function getCandidateSubnets(hints: string[] = []): Promise<string[]> {
	const ordered: string[] = [];
	const pushUnique = (raw: string | null | undefined) => {
		if (!raw) return;
		const prefix = extractSubnetPrefix(raw);
		if (prefix && !ordered.includes(prefix)) {
			ordered.push(prefix);
		}
	};

	for (const h of hints) {
		pushUnique(h);
	}

	if (Platform.isDesktopApp) {
		for (const ip of getLocalLanIps()) {
			pushUnique(ip);
		}
	} else {
		const detected = await detectMobileLocalSubnet();
		pushUnique(detected);
	}

	for (const common of COMMON_LAN_SUBNETS) {
		pushUnique(common);
	}

	return ordered;
}

function getSmartHostOctets(skipOctet?: number): { fast: number[]; rest: number[] } {
	const fast: number[] = [];
	const rest: number[] = [];

	for (let i = 1; i <= 254; i++) {
		if (i === skipOctet) continue;
		if ((i >= 2 && i <= 45) || (i >= 100 && i <= 145) || i === 1) {
			fast.push(i);
		} else {
			rest.push(i);
		}
	}
	return { fast, rest };
}

interface DiscoverResponse {
	app?: string;
	vaultId?: string;
	deviceName?: string;
	hostLocalName?: string;
	port?: number;
}

export async function probeDiscoverHost(
	ip: string,
	port: number,
	timeoutMs = 700
): Promise<DiscoveredPeer | null> {
	try {
		const res = await withTimeout(
			requestUrl({
				url: `http://${ip}:${port}/discover`,
				method: "GET",
				throw: false,
			}),
			timeoutMs
		);
		if (res.status !== 200) return null;
		const data = safeResponseJson<DiscoverResponse>(res);
		if (!data || data.app !== DISCOVERY_APP_ID || !data.vaultId) {
			return null;
		}
		return {
			deviceName: data.deviceName || "Desktop host",
			ip,
			hostLocalName: data.hostLocalName || "",
			port: data.port || port,
			vaultId: data.vaultId,
			lastSeen: Date.now(),
		};
	} catch {
		return null;
	}
}

export async function probeAuthenticatedHost(
	baseUrl: string,
	host: PairedHostConfig,
	timeoutMs = 1200
): Promise<boolean> {
	try {
		const res = await withTimeout(
			requestUrl({
				url: `${baseUrl}/ping`,
				method: "GET",
				headers: {
					"X-Sync-Token": host.token,
				},
				throw: false,
			}),
			timeoutMs
		);
		if (res.status !== 200) return false;
		const data = safeResponseJson<{ ok?: boolean; vaultId?: string }>(res);
		return Boolean(data && data.ok && data.vaultId === host.vaultId);
	} catch {
		return false;
	}
}

export async function scanLanForHosts(options: {
	ownVaultId: string;
	port?: number;
	subnetHints?: string[];
	singleSubnetOnly?: boolean;
	controller: ScanController;
	onFound: (peer: DiscoveredPeer) => void;
	onProgress?: (statusText: string) => void;
}): Promise<DiscoveredPeer[]> {
	const port = options.port || DEFAULT_PORT;
	const foundMap = new Map<string, DiscoveredPeer>();
	const subnets =
		options.singleSubnetOnly && options.subnetHints?.length
			? options.subnetHints
					.map((s) => extractSubnetPrefix(s))
					.filter((s): s is string => Boolean(s))
			: await getCandidateSubnets(options.subnetHints || []);

	const batchSize = 20;
	const { fast, rest } = getSmartHostOctets();

	const scanBatchList = async (subnet: string, octets: number[], phaseLabel: string) => {
		for (let i = 0; i < octets.length; i += batchSize) {
			if (options.controller.aborted) return;
			const batch = octets.slice(i, i + batchSize);
			if (options.onProgress) {
				const pct = Math.min(100, Math.round(((i + batch.length) / octets.length) * 100));
				options.onProgress(`Scanning ${subnet}.x (${phaseLabel} ${pct}%)...`);
			}

			const results = await Promise.all(
				batch.map((octet) => probeDiscoverHost(`${subnet}.${octet}`, port, 650))
			);

			for (const peer of results) {
				if (peer && peer.vaultId !== options.ownVaultId && !foundMap.has(peer.vaultId)) {
					foundMap.set(peer.vaultId, peer);
					options.onFound(peer);
				}
			}
		}
	};

	for (const subnet of subnets) {
		if (options.controller.aborted) break;
		await scanBatchList(subnet, fast, "quick");
		if (foundMap.size > 0 && !options.singleSubnetOnly) {
			await scanBatchList(subnet, rest, "full");
			return Array.from(foundMap.values());
		}
	}

	for (const subnet of subnets) {
		if (options.controller.aborted) break;
		await scanBatchList(subnet, rest, "deep");
		if (foundMap.size > 0) {
			return Array.from(foundMap.values());
		}
	}

	return Array.from(foundMap.values());
}

export async function resolveReachableHost(
	host: PairedHostConfig,
	preferredSubnet: string,
	onIpUpdated: (newIp: string) => Promise<void>,
	onStatus?: (message: string) => void
): Promise<string | null> {
	if (host.hostIp) {
		onStatus?.(`Connecting to ${host.hostName} (${host.hostIp})...`);
		const directUrl = `http://${host.hostIp}:${host.port}`;
		if (await probeAuthenticatedHost(directUrl, host, 1500)) {
			return directUrl;
		}
	}

	if (host.hostLocalName) {
		onStatus?.(`Searching for ${host.hostLocalName}...`);
		const localUrl = `http://${host.hostLocalName}:${host.port}`;
		if (await probeAuthenticatedHost(localUrl, host, 1800)) {
			return localUrl;
		}

		const bareName = host.hostLocalName.replace(/\.local$/i, "");
		if (bareName && bareName !== host.hostLocalName) {
			const bareUrl = `http://${bareName}:${host.port}`;
			if (await probeAuthenticatedHost(bareUrl, host, 1800)) {
				return bareUrl;
			}
		}
	}

	const hints: string[] = [];
	if (preferredSubnet) hints.push(preferredSubnet);
	if (host.hostIp) hints.push(host.hostIp);

	const subnets = await getCandidateSubnets(hints);
	const savedParts = host.hostIp ? host.hostIp.split(".") : [];
	const savedSubnet =
		savedParts.length === 4 ? `${savedParts[0]}.${savedParts[1]}.${savedParts[2]}` : "";
	const savedLastOctet = savedParts.length === 4 ? Number(savedParts[3]) : undefined;

	const batchSize = 20;

	const searchOctets = async (subnet: string, octets: number[]): Promise<string | null> => {
		for (let i = 0; i < octets.length; i += batchSize) {
			const batch = octets.slice(i, i + batchSize);
			onStatus?.(
				`Host IP changed — scanning Wi-Fi (${subnet}.${batch[0]}-${batch[batch.length - 1]})...`
			);

			const results = await Promise.all(
				batch.map(async (octet) => {
					const ip = `${subnet}.${octet}`;
					const ok = await probeAuthenticatedHost(`http://${ip}:${host.port}`, host, 650);
					return ok ? ip : null;
				})
			);

			const foundIp = results.find((ip) => ip !== null);
			if (foundIp) {
				return foundIp;
			}
		}
		return null;
	};

	for (const subnet of subnets) {
		const { fast } = getSmartHostOctets(subnet === savedSubnet ? savedLastOctet : undefined);
		const foundIp = await searchOctets(subnet, fast);
		if (foundIp) {
			await onIpUpdated(foundIp);
			return `http://${foundIp}:${host.port}`;
		}
	}

	for (const subnet of subnets) {
		const { rest } = getSmartHostOctets(subnet === savedSubnet ? savedLastOctet : undefined);
		const foundIp = await searchOctets(subnet, rest);
		if (foundIp) {
			await onIpUpdated(foundIp);
			return `http://${foundIp}:${host.port}`;
		}
	}

	return null;
}
