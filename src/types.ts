export const DEFAULT_PORT = 27123;
export const DISCOVERY_PORT = 27124;
export const PROTOCOL_ACTION = "local-sync-pair";
export const DISCOVERY_APP_ID = "obsidian-local-lan-sync";
export const MAX_UPLOAD_BYTES = 140 * 1024 * 1024;

export interface FileManifestEntry {
	hash: string;
	mtime: number;
	size: number;
}

export type VaultManifest = Record<string, FileManifestEntry>;

export interface HashCacheEntry {
	mtime: number;
	size: number;
	hash: string;
}

export interface PairedHostConfig {
	vaultId: string;
	hostName: string;
	hostIp: string;
	hostLocalName: string;
	port: number;
	token: string;
}

export interface LocalSyncSettings {
	vaultId: string;
	deviceName: string;
	hostEnabled: boolean;
	hostPort: number;
	hostToken: string;
	pairedHost: PairedHostConfig | null;
	preferredSubnet: string;
	excludePatterns: string[];
	lastSyncState: Record<string, string>;
	hashCache: Record<string, HashCacheEntry>;
	lastSyncTime: number | null;
}

export const DEFAULT_EXCLUDE_PATTERNS: string[] = [
	".trash/",
	".git/",
	".DS_Store",
	"Thumbs.db",
];

export const DEFAULT_SETTINGS: LocalSyncSettings = {
	vaultId: "",
	deviceName: "",
	hostEnabled: true,
	hostPort: DEFAULT_PORT,
	hostToken: "",
	pairedHost: null,
	preferredSubnet: "",
	excludePatterns: [...DEFAULT_EXCLUDE_PATTERNS],
	lastSyncState: {},
	hashCache: {},
	lastSyncTime: null,
};

export interface SyncSummary {
	pulled: number;
	pushed: number;
	deletedLocal: number;
	deletedRemote: number;
	conflicts: number;
	unchanged: number;
	errors: string[];
}

export interface DiscoveredPeer {
	deviceName: string;
	ip: string;
	hostLocalName: string;
	port: number;
	vaultId: string;
	pairCode?: string;
	lastSeen: number;
}

export interface PairingSession {
	pairCode: string;
	expiresAt: number;
}

export interface PairApprovalResult {
	approved: boolean;
}

export interface ScanController {
	aborted: boolean;
}
