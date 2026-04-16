/**
 * Secret redaction for audit log entries.
 *
 * Bash commands and error messages routinely include credentials:
 * `curl -H "Authorization: Bearer sk-..."`, env-style exports, GitHub
 * personal access tokens, AWS keys, etc. The audit log is a
 * developer-readable on-disk trail; without redaction it becomes a
 * passive secret-leak vector if the file is ever shared, attached to a
 * bug report, or scraped from disk.
 *
 * The patterns below favor specificity over coverage. Each one targets
 * a known token shape (issuer-prefixed) or a key=value form whose key
 * matches a sensitivity-naming convention. Generic regex like "any
 * 40-char base64 string" produce too many false positives in real
 * shell output and are deliberately omitted.
 */

const REDACTED = "[REDACTED]";

interface NamedPattern {
	readonly name: string;
	readonly pattern: RegExp;
}

// Issuer-prefixed token shapes. Each pattern is anchored on the issuer
// prefix so we only match plausible secrets, not arbitrary base64.
const TOKEN_PATTERNS: readonly NamedPattern[] = [
	{ name: "github_pat", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
	{ name: "github_legacy", pattern: /\bgh[opusr]_[A-Za-z0-9]{20,}\b/g },
	{ name: "anthropic", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
	// OpenAI: `sk-` and `sk-proj-`. Exclude the `sk-ant-` and `sk_live_`
	// shapes by requiring the first char after `sk-` to NOT start one of
	// those tokens.
	{ name: "openai", pattern: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
	{ name: "google_api", pattern: /\bAIza[A-Za-z0-9_-]{35}\b/g },
	{ name: "aws_access_key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
	{ name: "stripe", pattern: /\bsk_(?:live|test)_[A-Za-z0-9]{20,}\b/g },
	{ name: "slack", pattern: /\bxox[abprs]-[A-Za-z0-9-]{20,}\b/g },
	{
		name: "jwt",
		pattern:
			/\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
	},
];

// HTTP auth headers in any common shell-quoting form. Preserves the
// header name so the redacted log stays readable.
const HEADER_PATTERN = /(Authorization\s*:\s*(?:Bearer|Basic|Token))\s+\S+/gi;

// `KEY=value` for env-style assignments where the key looks sensitive.
// Two patterns: quoted (preserves quotes) and unquoted.
const SENSITIVE_KEY_FRAGMENT =
	"[A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|CREDENTIAL|ACCESS_KEY|SESSION_KEY|AUTH_KEY)";

const QUOTED_ENV_VAR_PATTERN = new RegExp(
	`\\b(${SENSITIVE_KEY_FRAGMENT})=(['"])([^'"]+)\\2`,
	"g",
);
const UNQUOTED_ENV_VAR_PATTERN = new RegExp(
	`\\b(${SENSITIVE_KEY_FRAGMENT})=([^\\s'"]+)`,
	"g",
);

/**
 * Redact every known secret pattern from a single string.
 *
 * Returns the original reference if nothing matched, so callers can
 * cheaply detect "no change" by reference equality.
 */
export function redactSecrets(input: string): string {
	let result = input;
	for (const { pattern } of TOKEN_PATTERNS) {
		result = result.replace(pattern, REDACTED);
	}
	result = result.replace(HEADER_PATTERN, `$1 ${REDACTED}`);
	result = result.replace(QUOTED_ENV_VAR_PATTERN, `$1=$2${REDACTED}$2`);
	result = result.replace(UNQUOTED_ENV_VAR_PATTERN, `$1=${REDACTED}`);
	return result;
}

/**
 * Recursively redact strings inside an arbitrary value.
 *
 * Used for audit metadata, which is `Record<string, unknown>` — callers
 * can put anything in there. Object keys are NOT redacted (they
 * shouldn't contain secrets, only sensitive-naming markers we use to
 * detect the value side).
 */
export function redactValue(value: unknown): unknown {
	if (typeof value === "string") return redactSecrets(value);
	if (value === null || value === undefined) return value;
	if (Array.isArray(value)) return value.map(redactValue);
	if (typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			out[k] = redactValue(v);
		}
		return out;
	}
	return value;
}
