export const EXTENSION_API_VERSION = "1.0.0";

interface Semver {
	major: number;
	minor: number;
	patch: number;
}

export function isExtensionApiCompatible(
	range: string | undefined,
	hostVersion: string = EXTENSION_API_VERSION,
): boolean {
	if (!range || range.trim() === "" || range.trim() === "*") return true;

	const host = parseSemver(hostVersion);
	if (!host) return false;

	for (const clause of range
		.split("||")
		.map((entry) => entry.trim())
		.filter(Boolean)) {
		if (matchesClause(clause, host)) return true;
	}
	return false;
}

function matchesClause(clause: string, host: Semver): boolean {
	if (clause === "*" || clause === "latest") return true;

	if (/^\d+(?:\.x|\.\*)$/i.test(clause)) {
		return host.major === Number.parseInt(clause, 10);
	}

	if (/^\d+$/.test(clause)) {
		return host.major === Number.parseInt(clause, 10);
	}

	if (clause.startsWith("^")) {
		const base = parseSemver(clause.slice(1));
		return base ? host.major === base.major && compareSemver(host, base) >= 0 : false;
	}

	if (clause.startsWith("~")) {
		const base = parseSemver(clause.slice(1));
		return base ? host.major === base.major && host.minor === base.minor && compareSemver(host, base) >= 0 : false;
	}

	const comparators = clause.split(/\s+/).filter(Boolean);
	if (comparators.length > 1 || /^[<>]=?|=/.test(comparators[0] ?? "")) {
		return comparators.every((comparator) => matchesComparator(comparator, host));
	}

	const exact = parseSemver(clause);
	return exact ? compareSemver(host, exact) === 0 : false;
}

function matchesComparator(comparator: string, host: Semver): boolean {
	const match = comparator.match(/^(>=|<=|>|<|=)?(.+)$/);
	if (!match) return false;
	const [, op = "=", versionText] = match;
	const version = parseSemver(versionText.trim());
	if (!version) return false;
	const cmp = compareSemver(host, version);
	if (op === ">=") return cmp >= 0;
	if (op === "<=") return cmp <= 0;
	if (op === ">") return cmp > 0;
	if (op === "<") return cmp < 0;
	return cmp === 0;
}

function parseSemver(value: string): Semver | undefined {
	const match = value.trim().match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
	if (!match) return undefined;
	return {
		major: Number.parseInt(match[1], 10),
		minor: Number.parseInt(match[2] ?? "0", 10),
		patch: Number.parseInt(match[3] ?? "0", 10),
	};
}

function compareSemver(left: Semver, right: Semver): number {
	if (left.major !== right.major) return left.major - right.major;
	if (left.minor !== right.minor) return left.minor - right.minor;
	return left.patch - right.patch;
}
