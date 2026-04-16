import { constants, accessSync, realpathSync } from "node:fs";
import * as os from "node:os";
import { basename, dirname, isAbsolute, resolve as resolvePath, sep } from "node:path";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const NARROW_NO_BREAK_SPACE = "\u202F";

function normalizeUnicodeSpaces(str: string): string {
	return str.replace(UNICODE_SPACES, " ");
}

function tryMacOSScreenshotPath(filePath: string): string {
	return filePath.replace(/ (AM|PM)\./g, `${NARROW_NO_BREAK_SPACE}$1.`);
}

function tryNFDVariant(filePath: string): string {
	return filePath.normalize("NFD");
}

function tryCurlyQuoteVariant(filePath: string): string {
	return filePath.replace(/'/g, "\u2019");
}

function fileExists(filePath: string): boolean {
	try {
		accessSync(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

function normalizeAtPrefix(filePath: string): string {
	return filePath.startsWith("@") ? filePath.slice(1) : filePath;
}

export function expandPath(filePath: string): string {
	const normalized = normalizeUnicodeSpaces(normalizeAtPrefix(filePath));
	if (normalized === "~") return os.homedir();
	if (normalized.startsWith("~/")) return os.homedir() + normalized.slice(1);
	return normalized;
}

/**
 * Resolve a path relative to cwd. Handles ~ expansion and absolute paths.
 *
 * NOTE: This is a low-level helper that does NOT validate the path is within
 * cwd. Use resolveAndValidatePath() for tool inputs.
 */
export function resolveToCwd(filePath: string, cwd: string): string {
	const expanded = expandPath(filePath);
	if (isAbsolute(expanded)) return expanded;
	return resolvePath(cwd, expanded);
}

/**
 * Walk up the path until we find an existing component, resolve symlinks
 * there, then reattach the unresolved tail. This lets us validate the
 * effective filesystem location even when the leaf doesn't exist yet
 * (e.g., write tool creating a new file).
 */
export function realpathOrAncestor(p: string): string {
	let current = p;
	const tail: string[] = [];
	while (true) {
		try {
			const real = realpathSync(current);
			if (tail.length === 0) return real;
			// tail accumulated leaf->root, so reverse before joining
			return resolvePath(real, ...tail.reverse());
		} catch {
			const parent = dirname(current);
			if (parent === current) {
				// hit filesystem root without finding any existing component
				return resolvePath(p);
			}
			tail.push(basename(current));
			current = parent;
		}
	}
}

/**
 * Check if a resolved path is within the allowed boundary.
 * Uses path.sep for cross-platform correctness so the prefix
 * check doesn't false-match when separators differ.
 */
export function isPathWithinBoundary(resolvedPath: string, boundary: string): boolean {
	const normalizedPath = resolvePath(resolvedPath);
	const normalizedBoundary = resolvePath(boundary);
	if (normalizedPath === normalizedBoundary) return true;
	return normalizedPath.startsWith(normalizedBoundary + sep);
}

/**
 * Resolve a path and validate that, after symlink resolution, it stays
 * inside the cwd boundary. This is the canonical safe resolver for
 * tool inputs that take a path argument.
 *
 * Defends against:
 * - absolute paths outside cwd
 * - .. traversal that escapes cwd
 * - symlink escapes (a symlink inside cwd that points outside cwd)
 *
 * The returned path is the original resolved path (NOT the realpath),
 * so the tool operates on the user-supplied path and any intra-cwd
 * symlinks behave normally.
 */
export function resolveAndValidatePath(filePath: string, cwd: string): string {
	const resolved = resolveToCwd(filePath, cwd);
	let cwdReal: string;
	try {
		cwdReal = realpathSync(cwd);
	} catch {
		// cwd doesn't exist or isn't accessible; fall back to lexical resolution
		cwdReal = resolvePath(cwd);
	}
	const resolvedReal = realpathOrAncestor(resolved);
	if (!isPathWithinBoundary(resolvedReal, cwdReal)) {
		throw new Error(`Path traversal denied: ${filePath} resolves outside of ${cwd}`);
	}
	return resolved;
}

/**
 * Resolve a read path with macOS filename variant fallbacks AND
 * boundary validation. Tries the exact path first, then macOS screenshot
 * variants (AM/PM spacing, NFD decomposition, curly quotes).
 *
 * The boundary check happens before any variant probing so we don't leak
 * information about files outside cwd via existence checks.
 *
 * IMPORTANT: each variant is independently re-validated through the
 * realpath-based boundary check before being returned. The string
 * transforms keep us lexically inside cwd, but a sibling file with the
 * variant name could itself be a SYMLINK pointing outside cwd — so the
 * realpath of the variant must be re-confirmed each time.
 */
export function resolveReadPath(filePath: string, cwd: string): string {
	const resolved = resolveAndValidatePath(filePath, cwd);
	if (fileExists(resolved)) return resolved;

	let cwdReal: string;
	try {
		cwdReal = realpathSync(cwd);
	} catch {
		cwdReal = resolvePath(cwd);
	}

	const tryVariant = (variant: string): string | null => {
		if (variant === resolved) return null;
		if (!fileExists(variant)) return null;
		// Re-validate: the variant could be a symlink that escapes cwd.
		const variantReal = realpathOrAncestor(variant);
		if (!isPathWithinBoundary(variantReal, cwdReal)) return null;
		return variant;
	};

	const amPm = tryVariant(tryMacOSScreenshotPath(resolved));
	if (amPm) return amPm;

	const nfd = tryNFDVariant(resolved);
	const nfdMatch = tryVariant(nfd);
	if (nfdMatch) return nfdMatch;

	const curly = tryVariant(tryCurlyQuoteVariant(resolved));
	if (curly) return curly;

	const nfdCurly = tryVariant(tryCurlyQuoteVariant(nfd));
	if (nfdCurly) return nfdCurly;

	return resolved;
}
