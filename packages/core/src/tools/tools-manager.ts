/**
 * Tool management utilities.
 *
 * Handles automatic downloading and management of external CLI tools
 * like ripgrep (rg) and fd that the agent depends on.
 *
 * Security considerations:
 * - Downloads are from official GitHub releases
 * - Pinned versions with SHA-256 checksums are verified
 * - Unknown versions will warn but proceed (for flexibility)
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	createWriteStream,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
} from "node:fs";
import { arch, homedir, platform } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const NETWORK_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * Pinned versions with known SHA-256 checksums.
 * Format: { "tool-version-platform-arch": "sha256hash" }
 *
 * To add/update checksums:
 * 1. Download the asset from GitHub releases
 * 2. Run: shasum -a 256 <filename>
 * 3. Add/update entry below
 *
 * NOTE: Empty object means checksums need to be populated.
 * Downloads will proceed with a warning until checksums are added.
 */
const KNOWN_CHECKSUMS: Record<string, string> = {
	// ripgrep 14.1.1
	"rg-14.1.1-aarch64-apple-darwin": "24ad76777745fbff131c8fbc466742b011f925bfa4fffa2ded6def23b5b937be",
	"rg-14.1.1-x86_64-apple-darwin": "fc87e78f7cb3fea12d69072e7ef3b21509754717b746368fd40d88963630e2b3",
	"rg-14.1.1-aarch64-unknown-linux-gnu": "c827481c4ff4ea10c9dc7a4022c8de5db34a5737cb74484d62eb94a95841ab2f",
	"rg-14.1.1-x86_64-unknown-linux-musl": "4cf9f2741e6c465ffdb7c26f38056a59e2a2544b51f7cc128ef28337eeae4d8e",
	"rg-14.1.1-x86_64-pc-windows-msvc": "d0f534024c42afd6cb4d38907c25cd2b249b79bbe6cc1dbee8e3e37c2b6e25a1",
	// fd 10.2.0
	"fd-10.2.0-aarch64-apple-darwin": "ae6327ba8c9a487cd63edd8bddd97da0207887a66d61e067dfe80c1430c5ae36",
	"fd-10.2.0-x86_64-apple-darwin": "991a648a58870230af9547c1ae33e72cb5c5199a622fe5e540e162d6dba82d48",
	"fd-10.2.0-aarch64-unknown-linux-gnu": "6de8be7a3d8ca27954a6d1e22bc327af4cf6fc7622791e68b820197f915c422b",
	"fd-10.2.0-x86_64-unknown-linux-gnu": "5f9030bcb0e1d03818521ed2e3d74fdb046480a45a4418ccff4f070241b4ed25",
	"fd-10.2.0-x86_64-pc-windows-msvc": "92ac9e6b0a0c6ecdab638ffe210dc786403fff4c66373604cf70df27be45e4fe",
};

/**
 * Pinned versions for each tool.
 * Set to null to use the latest version (less secure, but more flexible).
 */
const PINNED_VERSIONS: Record<string, string | null> = {
	fd: "10.2.0",
	rg: "14.1.1",
};

/**
 * Get the directory where tools are installed.
 */
export function getToolsDir(): string {
	return join(homedir(), ".my-agent", "bin");
}

/**
 * Check if offline mode is enabled via environment variable.
 */
function isOfflineMode(): boolean {
	const value = process.env.MY_AGENT_OFFLINE;
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true";
}

interface ToolConfig {
	name: string;
	displayName: string;
	repo: string;
	binaryName: string;
	tagPrefix: string;
	getAssetName: (version: string, plat: string, architecture: string) => string | null;
}

const TOOLS: Record<string, ToolConfig> = {
	fd: {
		name: "fd",
		displayName: "fd (find alternative)",
		repo: "sharkdp/fd",
		binaryName: "fd",
		tagPrefix: "v",
		getAssetName: (version, plat, architecture) => {
			if (plat === "darwin") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `fd-v${version}-${archStr}-apple-darwin.tar.gz`;
			}
			if (plat === "linux") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `fd-v${version}-${archStr}-unknown-linux-gnu.tar.gz`;
			}
			if (plat === "win32") {
				if (architecture === "arm64") return null;
				return `fd-v${version}-x86_64-pc-windows-msvc.zip`;
			}
			return null;
		},
	},
	rg: {
		name: "rg",
		displayName: "ripgrep",
		repo: "BurntSushi/ripgrep",
		binaryName: "rg",
		tagPrefix: "",
		getAssetName: (version, plat, architecture) => {
			if (plat === "darwin") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `ripgrep-${version}-${archStr}-apple-darwin.tar.gz`;
			}
			if (plat === "linux") {
				if (architecture === "arm64") {
					return `ripgrep-${version}-aarch64-unknown-linux-gnu.tar.gz`;
				}
				return `ripgrep-${version}-x86_64-unknown-linux-musl.tar.gz`;
			}
			if (plat === "win32") {
				if (architecture === "arm64") return null;
				return `ripgrep-${version}-x86_64-pc-windows-msvc.zip`;
			}
			return null;
		},
	},
};

/**
 * Check if a command exists in PATH.
 */
function commandExistsInPath(cmd: string): boolean {
	try {
		const result = spawnSync(cmd, ["--version"], {
			stdio: "pipe",
			timeout: 5000,
		});
		return result.error === undefined || result.error === null;
	} catch {
		return false;
	}
}

/**
 * Get the path to a tool.
 * Checks local tools directory first, then system PATH.
 *
 * @param tool Tool name ("fd" or "rg")
 * @returns Path to tool, or null if not found
 */
export function getToolPath(tool: "fd" | "rg"): string | null {
	const config = TOOLS[tool];
	if (!config) return null;

	const toolsDir = getToolsDir();
	const binaryExt = platform() === "win32" ? ".exe" : "";
	const localPath = join(toolsDir, config.binaryName + binaryExt);

	// Check local installation first
	if (existsSync(localPath)) {
		return localPath;
	}

	// Check system PATH
	if (commandExistsInPath(config.binaryName)) {
		return config.binaryName;
	}

	return null;
}

/**
 * Fetch the latest release version from GitHub.
 */
async function getLatestVersion(repo: string): Promise<string> {
	const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
		headers: { "User-Agent": "my-agent" },
		signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
	});

	if (!response.ok) {
		throw new Error(`GitHub API error: ${response.status}`);
	}

	const data = (await response.json()) as { tag_name: string };
	return data.tag_name.replace(/^v/, "");
}

/**
 * Download a file from URL.
 */
async function downloadFile(url: string, dest: string): Promise<void> {
	const response = await fetch(url, {
		signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
	});

	if (!response.ok) {
		throw new Error(`Download failed: ${response.status}`);
	}

	if (!response.body) {
		throw new Error("No response body");
	}

	const fileStream = createWriteStream(dest);
	await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), fileStream);
}

/**
 * Find a binary recursively in a directory.
 */
function findBinaryRecursively(rootDir: string, binaryFileName: string): string | null {
	const stack: string[] = [rootDir];

	while (stack.length > 0) {
		const currentDir = stack.pop();
		if (!currentDir) continue;
		const entries = readdirSync(currentDir, { withFileTypes: true });

		for (const entry of entries) {
			const fullPath = join(currentDir, entry.name);
			if (entry.isFile() && entry.name === binaryFileName) {
				return fullPath;
			}
			if (entry.isDirectory()) {
				stack.push(fullPath);
			}
		}
	}

	return null;
}

/**
 * Extract a .tar.gz archive.
 */
async function extractTarGz(archivePath: string, extractDir: string): Promise<void> {
	const result = spawnSync("tar", ["xzf", archivePath, "-C", extractDir], {
		stdio: "pipe",
	});

	if (result.error || result.status !== 0) {
		const errMsg = result.error?.message ?? result.stderr?.toString().trim() ?? "unknown error";
		throw new Error(`Failed to extract archive: ${errMsg}`);
	}
}

/**
 * Extract a .zip archive (requires unzip command).
 */
async function extractZip(archivePath: string, extractDir: string): Promise<void> {
	const result = spawnSync("unzip", ["-q", archivePath, "-d", extractDir], {
		stdio: "pipe",
	});

	if (result.error || result.status !== 0) {
		const errMsg = result.error?.message ?? result.stderr?.toString().trim() ?? "unknown error";
		throw new Error(`Failed to extract archive: ${errMsg}`);
	}
}

/**
 * Compute SHA-256 hash of a file.
 */
function computeFileHash(filePath: string): string {
	const content = readFileSync(filePath);
	return createHash("sha256").update(content).digest("hex");
}

/**
 * Get the checksum key for a tool/version/platform combination.
 */
function getChecksumKey(tool: string, version: string, plat: string, architecture: string): string {
	const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
	if (plat === "darwin") {
		return `${tool}-${version}-${archStr}-apple-darwin`;
	}
	if (plat === "linux") {
		if (tool === "rg" && architecture !== "arm64") {
			return `${tool}-${version}-${archStr}-unknown-linux-musl`;
		}
		return `${tool}-${version}-${archStr}-unknown-linux-gnu`;
	}
	if (plat === "win32") {
		return `${tool}-${version}-x86_64-pc-windows-msvc`;
	}
	return `${tool}-${version}-${plat}-${archStr}`;
}

/**
 * Download and install a tool.
 */
async function downloadTool(tool: "fd" | "rg"): Promise<string> {
	const config = TOOLS[tool];
	if (!config) throw new Error(`Unknown tool: ${tool}`);

	const plat = platform();
	const architecture = arch();
	const toolsDir = getToolsDir();

	// Use pinned version if available, otherwise get latest
	let version = PINNED_VERSIONS[tool];
	if (!version) {
		version = await getLatestVersion(config.repo);
	}

	// Get asset name for this platform
	const assetName = config.getAssetName(version, plat, architecture);
	if (!assetName) {
		throw new Error(`Unsupported platform: ${plat}/${architecture}`);
	}

	// Create tools directory
	mkdirSync(toolsDir, { recursive: true });

	const downloadUrl = `https://github.com/${config.repo}/releases/download/${config.tagPrefix}${version}/${assetName}`;
	const archivePath = join(toolsDir, assetName);
	const binaryExt = plat === "win32" ? ".exe" : "";
	const binaryPath = join(toolsDir, config.binaryName + binaryExt);

	// Download
	await downloadFile(downloadUrl, archivePath);

	// Verify checksum if known
	const checksumKey = getChecksumKey(tool, version, plat, architecture);
	const expectedChecksum = KNOWN_CHECKSUMS[checksumKey];
	const actualChecksum = computeFileHash(archivePath);

	if (expectedChecksum) {
		if (actualChecksum !== expectedChecksum) {
			rmSync(archivePath, { force: true });
			throw new Error(
				`Checksum verification failed for ${assetName}\nExpected: ${expectedChecksum}\nGot: ${actualChecksum}\nThis could indicate a corrupted download or supply-chain attack.`,
			);
		}
	} else {
		// Log warning about unverified download (checksum not in our known list)
		// This is a security consideration - ideally all downloads should be verified
		console.warn(
			`[security] No checksum available for ${checksumKey}. Download proceeding without verification. Computed SHA-256: ${actualChecksum}`,
		);
	}

	// Extract into unique temp directory (avoid race conditions)
	const extractDir = join(
		toolsDir,
		`extract_${config.binaryName}_${Date.now()}_${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(extractDir, { recursive: true });

	try {
		if (assetName.endsWith(".tar.gz")) {
			await extractTarGz(archivePath, extractDir);
		} else if (assetName.endsWith(".zip")) {
			await extractZip(archivePath, extractDir);
		} else {
			throw new Error(`Unsupported archive format: ${assetName}`);
		}

		// Find the binary
		const binaryFileName = config.binaryName + binaryExt;
		const extractedDir = join(extractDir, assetName.replace(/\.(tar\.gz|zip)$/, ""));
		const candidates = [join(extractedDir, binaryFileName), join(extractDir, binaryFileName)];
		let extractedBinary = candidates.find((c) => existsSync(c));

		if (!extractedBinary) {
			extractedBinary = findBinaryRecursively(extractDir, binaryFileName) ?? undefined;
		}

		if (!extractedBinary) {
			throw new Error(`Binary not found in archive: expected ${binaryFileName}`);
		}

		// Move to final location
		renameSync(extractedBinary, binaryPath);

		// Make executable (Unix only)
		if (plat !== "win32") {
			chmodSync(binaryPath, 0o755);
		}
	} finally {
		// Cleanup
		rmSync(archivePath, { force: true });
		rmSync(extractDir, { recursive: true, force: true });
	}

	return binaryPath;
}

export interface EnsureToolOptions {
	/** Suppress console output. Default: false */
	silent?: boolean;
	/** Callback for progress updates */
	onProgress?: (message: string) => void;
}

/**
 * Result of ensureTool - includes path and any error that occurred.
 * This allows callers to feed error information back to the LLM.
 */
export interface EnsureToolResult {
	/** Path to the tool, or undefined if unavailable */
	path: string | undefined;
	/** Error message if tool could not be obtained */
	error?: string;
}

/**
 * Ensure a tool is available, downloading if necessary.
 *
 * Returns a result object with path and optional error, allowing callers
 * to provide meaningful error messages to the LLM (e.g., checksum failure,
 * network error, offline mode).
 *
 * @param tool Tool name ("fd" or "rg")
 * @param options Options
 * @returns Result with path and optional error
 */
export async function ensureTool(tool: "fd" | "rg", options?: EnsureToolOptions): Promise<EnsureToolResult> {
	const { silent = false, onProgress } = options ?? {};

	// Check if already available
	const existingPath = getToolPath(tool);
	if (existingPath) {
		return { path: existingPath };
	}

	const config = TOOLS[tool];
	if (!config) return { path: undefined, error: `Unknown tool: ${tool}` };

	// Check offline mode
	if (isOfflineMode()) {
		const error = `${config.displayName} not found. Offline mode enabled, skipping download.`;
		if (!silent && onProgress) {
			onProgress(error);
		}
		return { path: undefined, error };
	}

	// Download
	if (!silent && onProgress) {
		onProgress(`${config.displayName} not found. Downloading...`);
	}

	try {
		const path = await downloadTool(tool);
		if (!silent && onProgress) {
			onProgress(`${config.displayName} installed to ${path}`);
		}
		return { path };
	} catch (e) {
		const error = e instanceof Error ? e.message : String(e);
		if (!silent && onProgress) {
			onProgress(`Failed to download ${config.displayName}: ${error}`);
		}
		return { path: undefined, error };
	}
}
