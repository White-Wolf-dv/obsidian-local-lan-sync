import { App, normalizePath } from "obsidian";
import { sha256Hex } from "./crypto";
import { HashCacheEntry, VaultManifest } from "./types";

function isConfigDirPath(normalizedPath: string, configDir: string): boolean {
	const cleanConfigDir = normalizePath(configDir);
	if (!cleanConfigDir) return false;
	return normalizedPath === cleanConfigDir || normalizedPath.startsWith(`${cleanConfigDir}/`);
}

export function sanitizeVaultPath(rawPath: string, configDir: string): string | null {
	if (!rawPath || typeof rawPath !== "string") {
		return null;
	}
	const replaced = rawPath.replace(/\\/g, "/").trim();
	if (!replaced || replaced.startsWith("/") || /^[a-zA-Z]:/.test(replaced)) {
		return null;
	}
	const segments = replaced.split("/");
	for (const seg of segments) {
		if (seg === ".." || seg === ".") {
			return null;
		}
	}
	const clean = normalizePath(replaced);
	if (
		!clean ||
		isConfigDirPath(clean, configDir) ||
		clean === ".trash" ||
		clean.startsWith(".trash/")
	) {
		return null;
	}
	return clean;
}

export function shouldExclude(path: string, patterns: string[], configDir: string): boolean {
	const normalized = normalizePath(path.replace(/\\/g, "/"));
	if (isConfigDirPath(normalized, configDir) || normalized.startsWith(".trash/")) {
		return true;
	}

	const fileName = normalized.split("/").pop() || normalized;

	for (const rawPattern of patterns) {
		const pattern = rawPattern.trim().replace(/\\/g, "/");
		if (!pattern) continue;

		if (pattern.endsWith("/")) {
			if (normalized.startsWith(pattern) || normalized.includes("/" + pattern)) {
				return true;
			}
		} else if (pattern.startsWith("*.")) {
			const ext = pattern.slice(1).toLowerCase();
			if (fileName.toLowerCase().endsWith(ext)) {
				return true;
			}
		} else {
			if (
				normalized === pattern ||
				fileName === pattern ||
				normalized.startsWith(pattern + "/")
			) {
				return true;
			}
		}
	}

	return false;
}

export async function ensureParentDirs(app: App, filePath: string): Promise<void> {
	const normalized = normalizePath(filePath);
	const lastSlash = normalized.lastIndexOf("/");
	if (lastSlash === -1) return;

	const dirPath = normalized.slice(0, lastSlash);
	const parts = dirPath.split("/");
	let current = "";
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		const exists = await app.vault.adapter.exists(current);
		if (!exists) {
			await app.vault.adapter.mkdir(current);
		}
	}
}

/**
 * Moves a deleted file to trash respecting the user's configured trash preference.
 */
export async function trashVaultFile(app: App, filePath: string): Promise<void> {
	const normalized = normalizePath(filePath);
	const abstractFile = app.vault.getAbstractFileByPath(normalized);
	if (abstractFile) {
		await app.fileManager.trashFile(abstractFile);
		return;
	}
	if (await app.vault.adapter.exists(normalized)) {
		await app.vault.adapter.trashLocal(normalized);
	}
}

export async function buildVaultManifest(
	app: App,
	existingCache: Record<string, HashCacheEntry>,
	excludePatterns: string[]
): Promise<{ manifest: VaultManifest; updatedCache: Record<string, HashCacheEntry> }> {
	const manifest: VaultManifest = {};
	const updatedCache: Record<string, HashCacheEntry> = {};
	const configDir = app.vault.configDir;

	const files = app.vault.getFiles();

	for (const file of files) {
		const path = normalizePath(file.path);
		if (shouldExclude(path, excludePatterns, configDir)) {
			continue;
		}

		const mtime = file.stat.mtime;
		const size = file.stat.size;
		const cached = existingCache[path];

		let hash: string;
		if (cached && cached.mtime === mtime && cached.size === size) {
			hash = cached.hash;
		} else {
			const data = await app.vault.adapter.readBinary(path);
			hash = await sha256Hex(data);
		}

		manifest[path] = { hash, mtime, size };
		updatedCache[path] = { mtime, size, hash };
	}

	return { manifest, updatedCache };
}

export function buildConflictPath(originalPath: string): string {
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	const stamp =
		`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
		`${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;

	const lastSlash = originalPath.lastIndexOf("/");
	const dir = lastSlash >= 0 ? originalPath.slice(0, lastSlash + 1) : "";
	const fileName = lastSlash >= 0 ? originalPath.slice(lastSlash + 1) : originalPath;

	const dotIndex = fileName.lastIndexOf(".");
	if (dotIndex > 0) {
		const base = fileName.slice(0, dotIndex);
		const ext = fileName.slice(dotIndex);
		return `${dir}${base} (Conflict ${stamp})${ext}`;
	}
	return `${dir}${fileName} (Conflict ${stamp})`;
}
