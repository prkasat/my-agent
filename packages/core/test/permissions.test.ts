import { describe, expect, it, vi } from "vitest";
import {
	BUILTIN_READ_TOOL_NAMES,
	createPermissionChecker,
	type AskDecision,
	type PermissionAskContext,
	type PermissionMode,
} from "../src/agent/permissions.js";
import type {
	AgentContext,
	BeforeToolCallContext,
} from "../src/agent/types.js";

const fakeContext: AgentContext = {
	messages: [],
	model: { id: "test", name: "T", provider: "p", contextWindow: 1000 } as any,
	systemPrompt: "",
	tools: [],
};

function makeCtx(name: string, args: Record<string, unknown>): BeforeToolCallContext {
	return {
		toolCall: { id: "call_1", name, arguments: JSON.stringify(args) },
		args,
		context: fakeContext,
	};
}

describe("createPermissionChecker — always-blocked floor", () => {
	for (const mode of ["auto", "ask", "deny", "read-only"] as PermissionMode[]) {
		it(`(${mode}) destructive bash command is always blocked`, async () => {
			const checker = createPermissionChecker(mode);
			const result = await checker.check(makeCtx("bash", { command: "rm -rf /tmp/data" }));
			expect(result.action).toBe("block");
		});

		it(`(${mode}) protected path is always blocked`, async () => {
			const checker = createPermissionChecker(mode);
			const result = await checker.check(makeCtx("read", { path: "/etc/shadow" }));
			expect(result.action).toBe("block");
		});
	}
});

describe("createPermissionChecker — auto mode", () => {
	it("allows write tools without confirmation", async () => {
		const checker = createPermissionChecker("auto");
		const result = await checker.check(makeCtx("write", { path: "/tmp/x.txt", content: "hi" }));
		expect(result.action).toBe("allow");
	});

	it("blocks tools listed in requireConfirmation (back-compat behavior)", async () => {
		const checker = createPermissionChecker("auto", {
			requireConfirmation: new Set(["dangerous_tool"]),
		});
		const result = await checker.check(makeCtx("dangerous_tool", { x: 1 }));
		expect(result.action).toBe("block");
		if (result.action === "block") {
			expect(result.reason).toMatch(/explicit confirmation/);
		}
	});
});

describe("createPermissionChecker — deny mode", () => {
	it("blocks all write tools (write/edit/bash/notebook_edit)", async () => {
		const checker = createPermissionChecker("deny");
		for (const name of ["write", "edit", "bash", "notebook_edit"]) {
			const result = await checker.check(makeCtx(name, {}));
			expect(result.action).toBe("block");
		}
	});

	it("allows read tools when host opts in via knownReadOnly", async () => {
		const checker = createPermissionChecker("deny", {
			knownReadOnly: new Set(BUILTIN_READ_TOOL_NAMES),
		});
		const result = await checker.check(makeCtx("read", { path: "/tmp/safe.txt" }));
		expect(result.action).toBe("allow");
	});

	it('"read-only" is a back-compat alias for deny', async () => {
		const checker = createPermissionChecker("read-only");
		const result = await checker.check(makeCtx("write", { path: "/tmp/x.txt", content: "hi" }));
		expect(result.action).toBe("block");
	});
});

describe("createPermissionChecker — ask mode", () => {
	it("default-denies write tools when no onAsk callback is supplied", async () => {
		const checker = createPermissionChecker("ask");
		const result = await checker.check(makeCtx("write", { path: "/tmp/x", content: "y" }));
		expect(result.action).toBe("block");
		if (result.action === "block") {
			expect(result.reason).toMatch(/onAsk callback/);
		}
	});

	it("calls onAsk for each write tool and respects allow_once", async () => {
		const onAsk = vi
			.fn<(ctx: PermissionAskContext) => Promise<AskDecision>>()
			.mockResolvedValue("allow_once");
		const checker = createPermissionChecker("ask", { onAsk });

		const r1 = await checker.check(makeCtx("write", { path: "/tmp/a", content: "1" }));
		const r2 = await checker.check(makeCtx("write", { path: "/tmp/b", content: "2" }));
		expect(r1.action).toBe("allow");
		expect(r2.action).toBe("allow");
		expect(onAsk).toHaveBeenCalledTimes(2);
	});

	it("allow_session caches by tool name — no further prompts for that tool", async () => {
		const onAsk = vi
			.fn<(ctx: PermissionAskContext) => Promise<AskDecision>>()
			.mockResolvedValueOnce("allow_session")
			.mockResolvedValue("deny");
		const checker = createPermissionChecker("ask", { onAsk });

		const r1 = await checker.check(makeCtx("write", { path: "/tmp/a" }));
		const r2 = await checker.check(makeCtx("write", { path: "/tmp/b" }));
		const r3 = await checker.check(makeCtx("edit", { path: "/tmp/c" })); // different tool
		expect(r1.action).toBe("allow");
		expect(r2.action).toBe("allow"); // cached, no prompt
		expect(r3.action).toBe("block"); // different tool, prompt fired and was denied
		expect(onAsk).toHaveBeenCalledTimes(2); // first write, then edit
	});

	it("deny decision blocks the tool with a user-denied reason", async () => {
		const onAsk = vi
			.fn<(ctx: PermissionAskContext) => Promise<AskDecision>>()
			.mockResolvedValue("deny");
		const checker = createPermissionChecker("ask", { onAsk });
		const result = await checker.check(makeCtx("write", { path: "/tmp/x" }));
		expect(result.action).toBe("block");
		if (result.action === "block") {
			expect(result.reason).toMatch(/User denied/);
		}
	});

	it("read tools never trigger onAsk when host opts in via knownReadOnly", async () => {
		const onAsk = vi.fn<(ctx: PermissionAskContext) => Promise<AskDecision>>();
		const checker = createPermissionChecker("ask", {
			onAsk,
			knownReadOnly: new Set(BUILTIN_READ_TOOL_NAMES),
		});
		const r = await checker.check(makeCtx("read", { path: "/tmp/x" }));
		expect(r.action).toBe("allow");
		expect(onAsk).not.toHaveBeenCalled();
	});

	it("requireConfirmation extends the set of tools that ask", async () => {
		const onAsk = vi
			.fn<(ctx: PermissionAskContext) => Promise<AskDecision>>()
			.mockResolvedValue("allow_once");
		const checker = createPermissionChecker("ask", {
			onAsk,
			requireConfirmation: new Set(["mcp_tool"]),
		});

		const r = await checker.check(makeCtx("mcp_tool", { foo: "bar" }));
		expect(r.action).toBe("allow");
		expect(onAsk).toHaveBeenCalledOnce();
	});

	it("ask context surfaces command and filePath when present", async () => {
		const seen: PermissionAskContext[] = [];
		const onAsk = async (ctx: PermissionAskContext) => {
			seen.push(ctx);
			return "allow_once" as const;
		};
		const checker = createPermissionChecker("ask", { onAsk });
		await checker.check(makeCtx("bash", { command: "echo hi" }));
		await checker.check(makeCtx("write", { path: "/tmp/x", content: "y" }));

		expect(seen[0].command).toBe("echo hi");
		expect(seen[0].filePath).toBeUndefined();
		expect(seen[1].filePath).toBe("/tmp/x");
		expect(seen[1].command).toBeUndefined();
	});
});

describe("createPermissionChecker — Tier-2 pass-2 regression: fail-closed for unknown tools", () => {
	it("(deny) blocks an unknown custom tool even though it's not in the built-in WRITE_TOOLS set", async () => {
		// Pre-fix: a host registers a custom tool `deploy`, sets mode to
		// deny expecting writes blocked, and the model invokes it
		// successfully because `deploy` ∉ {write, edit, bash, notebook_edit}.
		// That's a real permission-boundary bypass.
		const checker = createPermissionChecker("deny");
		const result = await checker.check(makeCtx("deploy", { env: "prod" }));
		expect(result.action).toBe("block");
	});

	it("(ask) prompts for an unknown custom tool instead of silently allowing", async () => {
		const onAsk = vi
			.fn<(ctx: PermissionAskContext) => Promise<AskDecision>>()
			.mockResolvedValue("deny");
		const checker = createPermissionChecker("ask", { onAsk });
		const result = await checker.check(makeCtx("github_create_pr", { title: "x" }));
		expect(result.action).toBe("block"); // user denied via prompt
		expect(onAsk).toHaveBeenCalledOnce();
		expect(onAsk.mock.calls[0][0].toolName).toBe("github_create_pr");
	});

	it("(ask) default-denies an unknown tool when no onAsk callback is supplied", async () => {
		const checker = createPermissionChecker("ask");
		const result = await checker.check(makeCtx("run_sql", { query: "DROP TABLE x" }));
		expect(result.action).toBe("block");
		if (result.action === "block") {
			expect(result.reason).toMatch(/onAsk callback/);
		}
	});

	it("(deny) knownReadOnly extends the safe set for caller-registered read tools", async () => {
		const checker = createPermissionChecker("deny", {
			knownReadOnly: new Set(["docs_lookup", "fetch_url"]),
		});
		const r1 = await checker.check(makeCtx("docs_lookup", { topic: "react" }));
		const r2 = await checker.check(makeCtx("fetch_url", { url: "https://example.com" }));
		expect(r1.action).toBe("allow");
		expect(r2.action).toBe("allow");
	});

	it("(auto) preserves back-compat — unknown tools still allowed in auto mode", async () => {
		// Auto mode is the existing permissive default; we only fail-closed
		// in ask/deny because that's where users explicitly request gating.
		// Tightening auto would be a behavior break for existing hosts.
		const checker = createPermissionChecker("auto");
		const result = await checker.check(makeCtx("custom_tool", { x: 1 }));
		expect(result.action).toBe("allow");
	});
});

describe("createPermissionChecker — Tier-2 pass-3 regression: requireConfirmation overrides knownReadOnly/KNOWN_READ_TOOLS", () => {
	it("(deny) blocks `read` when listed in requireConfirmation", async () => {
		// Pre-pass-3 bug: KNOWN_READ_TOOLS lookup happened first so the
		// host's explicit requireConfirmation policy was silently
		// ignored for read/ls/find/grep. A host trying to require
		// approval before any file read would get free file reads.
		const checker = createPermissionChecker("deny", {
			requireConfirmation: new Set(["read"]),
		});
		const result = await checker.check(makeCtx("read", { path: "/tmp/safe.txt" }));
		expect(result.action).toBe("block");
	});

	it("(ask) prompts for `read` when listed in requireConfirmation", async () => {
		const onAsk = vi
			.fn<(ctx: PermissionAskContext) => Promise<AskDecision>>()
			.mockResolvedValue("deny");
		const checker = createPermissionChecker("ask", {
			requireConfirmation: new Set(["read"]),
			onAsk,
		});
		const result = await checker.check(makeCtx("read", { path: "/tmp/x.txt" }));
		expect(result.action).toBe("block"); // user denied via prompt
		expect(onAsk).toHaveBeenCalledOnce();
		expect(onAsk.mock.calls[0][0].toolName).toBe("read");
	});

	it("(deny) requireConfirmation also overrides custom-host knownReadOnly extension", async () => {
		// A host that puts a custom tool in BOTH knownReadOnly and
		// requireConfirmation gets the requireConfirmation behavior.
		const checker = createPermissionChecker("deny", {
			knownReadOnly: new Set(["docs_lookup"]),
			requireConfirmation: new Set(["docs_lookup"]),
		});
		const result = await checker.check(makeCtx("docs_lookup", { topic: "x" }));
		expect(result.action).toBe("block");
	});
});

describe("createPermissionChecker — Tier-2 pass-7 regression: protected-path floor walks all args fields", () => {
	// Pre-pass-7 bug: the protected-path floor only checked args.path. A
	// custom read tool whitelisted via knownReadOnly that carried its
	// target under any other field (filePath, file_path, file, etc.) could
	// read /etc/shadow, ~/.ssh/id_rsa, .env, and similar protected paths
	// in deny mode. Verified locally before the fix that
	// `createPermissionChecker("deny", { knownReadOnly: new Set(["docs_lookup"]) })`
	// allowed `{filePath: "/etc/shadow"}`.
	const protectedPath = "/etc/shadow";
	const aliasFields = ["path", "filePath", "file_path", "file", "pathname", "target"];

	for (const field of aliasFields) {
		it(`(deny) blocks knownReadOnly tool with protected path under "${field}"`, async () => {
			const checker = createPermissionChecker("deny", {
				knownReadOnly: new Set(["custom_read"]),
			});
			const result = await checker.check(makeCtx("custom_read", { [field]: protectedPath }));
			expect(result.action).toBe("block");
			if (result.action === "block") {
				expect(result.reason).toMatch(/Protected path/);
			}
		});

		it(`(ask) blocks knownReadOnly tool with protected path under "${field}"`, async () => {
			const onAsk = vi
				.fn<(ctx: PermissionAskContext) => Promise<AskDecision>>()
				.mockResolvedValue("allow_once");
			const checker = createPermissionChecker("ask", {
				knownReadOnly: new Set(["custom_read"]),
				onAsk,
			});
			const result = await checker.check(makeCtx("custom_read", { [field]: protectedPath }));
			expect(result.action).toBe("block");
			expect(onAsk).not.toHaveBeenCalled(); // Floor catches it before any prompt.
		});
	}

	it("(deny) blocks protected path nested inside a custom-tool args object", async () => {
		// Real custom tools sometimes wrap arguments: {target: {path: "..."}}.
		// The floor must descend into nested values, not just inspect leaf
		// keys at top level.
		const checker = createPermissionChecker("deny", {
			knownReadOnly: new Set(["custom_read"]),
		});
		const result = await checker.check(
			makeCtx("custom_read", { target: { path: "/etc/shadow" } }),
		);
		expect(result.action).toBe("block");
	});

	it("(deny) blocks protected path inside an array argument", async () => {
		const checker = createPermissionChecker("deny", {
			knownReadOnly: new Set(["custom_read"]),
		});
		const result = await checker.check(
			makeCtx("custom_read", { paths: ["/tmp/safe.txt", "/etc/shadow"] }),
		);
		expect(result.action).toBe("block");
	});

	it("(deny) blocks ssh key path under any field name", async () => {
		const checker = createPermissionChecker("deny", {
			knownReadOnly: new Set(["custom_read"]),
		});
		const result = await checker.check(
			makeCtx("custom_read", { keyfile: "/home/user/.ssh/id_rsa" }),
		);
		expect(result.action).toBe("block");
	});

	it("(auto) protected paths are blocked even in auto mode (always-blocked floor)", async () => {
		// Auto mode is permissive for unknown tools, but the floor must hold.
		const checker = createPermissionChecker("auto");
		const result = await checker.check(
			makeCtx("custom_tool", { filePath: "/home/user/.aws/credentials" }),
		);
		expect(result.action).toBe("block");
	});

	it("(deny) tolerates pathological deeply-nested args without infinite recursion", async () => {
		// Walker must terminate cleanly on deep structures (no stack
		// overflow, no hang) regardless of depth.
		let nested: unknown = "/tmp/safe.txt";
		for (let i = 0; i < 50; i++) {
			nested = { wrapped: nested };
		}
		const checker = createPermissionChecker("deny", {
			knownReadOnly: new Set(["custom_read"]),
		});
		const result = await checker.check(makeCtx("custom_read", { deep: nested }));
		// Path is benign so this should be allowed (the floor just shouldn't crash).
		expect(result.action).toBe("allow");
	});

	it("(deny) Tier-2 pass-8 regression: protected path nested past depth 5 is still blocked", async () => {
		// Pre-pass-8 bug: iterStringValues stopped descending at depth > 5.
		// A knownReadOnly-whitelisted tool could smuggle /etc/shadow under
		// {a:{b:{c:{d:{e:{f:"/etc/shadow"}}}}}} and have it allowed in
		// deny mode. The walker is now depth-unbounded with cycle detection.
		let nested: unknown = "/etc/shadow";
		for (let i = 0; i < 12; i++) {
			nested = { wrapped: nested };
		}
		const checker = createPermissionChecker("deny", {
			knownReadOnly: new Set(["custom_read"]),
		});
		const result = await checker.check(makeCtx("custom_read", { deep: nested }));
		expect(result.action).toBe("block");
	});

	it("(deny) tolerates a cyclic args object without infinite recursion", async () => {
		// Defensive: the permission boundary should never deadlock or
		// stack-overflow even on a malformed (non-JSON) argument blob.
		// Cycle detection in iterPathLikeValues uses a WeakSet — we have
		// to bypass makeCtx (which JSON-stringifies) since cyclic args
		// can't be serialized to begin with.
		const cyclic: Record<string, unknown> = { path: "/tmp/safe.txt" };
		cyclic.self = cyclic;
		const checker = createPermissionChecker("deny", {
			knownReadOnly: new Set(["custom_read"]),
		});
		const ctx: BeforeToolCallContext = {
			toolCall: { id: "call_1", name: "custom_read", arguments: "{}" },
			args: cyclic,
			context: fakeContext,
		};
		const result = await checker.check(ctx);
		expect(result.action).toBe("allow");
	});
});

describe("createPermissionChecker — Tier-2 pass-10 regression: real paths with spaces + exact protected directories", () => {
	// Pre-pass-10 issue 1: looksLikePath rejected ANY string with
	// whitespace, so a custom knownReadOnly tool could pass a real path
	// containing spaces ("Application Support", "Program Files") under
	// an unlisted key and bypass the floor entirely.
	it("(deny) blocks knownReadOnly tool with absolute path containing spaces", async () => {
		const checker = createPermissionChecker("deny", {
			knownReadOnly: new Set(["custom_read"]),
		});
		const result = await checker.check(
			makeCtx("custom_read", {
				privateKey: "/Users/pk/Library/Application Support/id_rsa",
			}),
		);
		expect(result.action).toBe("block");
	});

	it("(deny) blocks knownReadOnly tool with relative path containing spaces", async () => {
		const checker = createPermissionChecker("deny", {
			knownReadOnly: new Set(["custom_read"]),
		});
		const result = await checker.check(
			makeCtx("custom_read", {
				configPath: "./My Secrets/credentials.json",
			}),
		);
		expect(result.action).toBe("block");
	});

	it("(deny) blocks Windows-style path with spaces", async () => {
		const checker = createPermissionChecker("deny", {
			knownReadOnly: new Set(["custom_read"]),
		});
		const result = await checker.check(
			makeCtx("custom_read", {
				keyfile: "C:\\Users\\Administrator\\.ssh\\id_rsa",
			}),
		);
		expect(result.action).toBe("block");
	});

	// Pre-pass-10 issue 2: PROTECTED_PATH_PATTERNS required a trailing
	// slash. ls/find on the exact protected directory bypassed the floor.
	const exactDirCases: Array<[string, string]> = [
		["/etc", "ls /etc"],
		["~/.ssh", "ls ~/.ssh"],
		["/Users/pk/.aws", "find /Users/pk/.aws"],
		["/usr", "ls /usr"],
		["/sys", "ls /sys"],
		["/boot", "ls /boot"],
		["~/.gnupg", "ls ~/.gnupg"],
	];

	for (const [path, label] of exactDirCases) {
		it(`(deny) blocks built-in read on exact protected dir "${path}" (${label})`, async () => {
			const checker = createPermissionChecker("deny", {
				knownReadOnly: new Set(BUILTIN_READ_TOOL_NAMES),
			});
			const result = await checker.check(makeCtx("ls", { path }));
			expect(result.action).toBe("block");
			if (result.action === "block") {
				expect(result.reason).toMatch(/Protected path/);
			}
		});
	}

	it("(deny) blocks find tool on exact ~/.ssh", async () => {
		const checker = createPermissionChecker("deny", {
			knownReadOnly: new Set(BUILTIN_READ_TOOL_NAMES),
		});
		const result = await checker.check(makeCtx("find", { path: "~/.ssh" }));
		expect(result.action).toBe("block");
	});

	it("(deny) does NOT block paths that merely have a protected name as a substring", async () => {
		// Boundary-aware patterns: `/etcetera` is not `/etc`, `.envelope`
		// is not `.env`, `id_rsa_other` is not `id_rsa`. Verify we don't
		// over-block in pursuit of catching the exact-dir case.
		const checker = createPermissionChecker("deny", {
			knownReadOnly: new Set(BUILTIN_READ_TOOL_NAMES),
		});
		const benign = [
			"/tmp/etcetera/file.txt",
			"/tmp/.envelope.bak",
			"/tmp/id_rsa_demo.txt", // demo file with id_rsa in name
		];
		for (const path of benign) {
			const result = await checker.check(makeCtx("ls", { path }));
			expect(result.action).toBe("allow");
		}
	});

	it("(deny) blocks .env.local and similar dotfile variants", async () => {
		const checker = createPermissionChecker("deny", {
			knownReadOnly: new Set(BUILTIN_READ_TOOL_NAMES),
		});
		for (const path of ["/repo/.env.local", "./.env.production", ".env.staging"]) {
			const result = await checker.check(makeCtx("ls", { path }));
			expect(result.action).toBe("block");
		}
	});

	it("(deny) blocks descendant under id_rsa-style key (id_rsa.pub)", async () => {
		const checker = createPermissionChecker("deny", {
			knownReadOnly: new Set(BUILTIN_READ_TOOL_NAMES),
		});
		const result = await checker.check(makeCtx("read", { path: "~/.ssh/id_rsa.pub" }));
		expect(result.action).toBe("block");
	});

	it("(auto) bash command targeting exact /etc directory is blocked", async () => {
		// The bash command check uses the same patterns. Verify exact-dir
		// hardening also covers bash.
		const checker = createPermissionChecker("auto");
		const result = await checker.check(makeCtx("bash", { command: "ls /etc" }));
		expect(result.action).toBe("block");
	});
});

describe("createPermissionChecker — Tier-2 pass-9 regression: bare protected basenames under unlisted keys are blocked", () => {
	// Pre-pass-9 bug: pass-8's path-shape heuristic only fired on strings
	// starting with /, ~/, ./, ../, or a Windows drive letter. A bare
	// basename like ".env" or "id_rsa" carried under an unlisted custom
	// field (configPath, secretFile, privateKey, …) was never inspected,
	// so a knownReadOnly custom tool could read those files in deny mode.
	// The fix: also yield short, filename-safe strings (no whitespace,
	// only path-safe characters), which catches bare basenames without
	// flipping on prose.
	const cases: Array<[string, string]> = [
		["configPath", ".env"],
		["secretFile", ".env.local"],
		["privateKey", "id_rsa"],
		["sshKey", "id_ed25519"],
		["credsFile", "credentials.json"],
		["npmrc", ".npmrc"],
		["netrc", ".netrc"],
	];

	for (const [field, value] of cases) {
		it(`(deny) blocks knownReadOnly tool with bare "${value}" under "${field}"`, async () => {
			const checker = createPermissionChecker("deny", {
				knownReadOnly: new Set(["custom_read"]),
			});
			const result = await checker.check(makeCtx("custom_read", { [field]: value }));
			expect(result.action).toBe("block");
			if (result.action === "block") {
				expect(result.reason).toMatch(/Protected path/);
			}
		});

		it(`(ask) blocks knownReadOnly tool with bare "${value}" under "${field}" before prompting`, async () => {
			const onAsk = vi
				.fn<(ctx: PermissionAskContext) => Promise<AskDecision>>()
				.mockResolvedValue("allow_once");
			const checker = createPermissionChecker("ask", {
				knownReadOnly: new Set(["custom_read"]),
				onAsk,
			});
			const result = await checker.check(makeCtx("custom_read", { [field]: value }));
			expect(result.action).toBe("block");
			expect(onAsk).not.toHaveBeenCalled();
		});
	}

	it("(auto) prose mentioning the same basenames still passes (regression must not undo pass-8)", async () => {
		// Whitespace disqualifies the string from filename-shape, so the
		// pass-8 false-positive fix still holds.
		const checker = createPermissionChecker("auto");
		const result = await checker.check(
			makeCtx("write", {
				path: "/tmp/note.md",
				content: "Files like .env, id_rsa, and credentials.json are sensitive.",
			}),
		);
		expect(result.action).toBe("allow");
	});

	it("(auto) harmless short identifier strings under unlisted keys are not blocked", async () => {
		// FILENAME_SHAPE_RE matches `abc-123` so it gets yielded, but no
		// protected pattern matches it — the floor must let it through.
		const checker = createPermissionChecker("auto");
		const result = await checker.check(
			makeCtx("custom_tool", {
				userId: "abc-123",
				version: "1.2.3",
				slug: "hello.world",
			}),
		);
		expect(result.action).toBe("allow");
	});
});

describe("createPermissionChecker — Tier-2 pass-8 regression: floor does not block freeform text content", () => {
	// Pre-pass-8 bug: walking every string leaf with `/\.env\b/` etc. meant
	// any tool argument that mentioned `.env` or `/etc/...` in prose was
	// blocked, even in `auto` mode. That broke legitimate write/edit calls
	// with notes mentioning sensitive filenames, test fixtures referencing
	// `/etc/passwd`, and oldString/newString diffs. The floor is now
	// constrained to PATH_LIKE values (path-shape or path-named field)
	// so freeform text passes through.
	it("(auto) write tool with content mentioning .env in prose is allowed", async () => {
		const checker = createPermissionChecker("auto");
		const result = await checker.check(
			makeCtx("write", {
				path: "/tmp/note.md",
				content: "Do not commit .env or copy ~/.ssh/id_rsa",
			}),
		);
		expect(result.action).toBe("allow");
	});

	it("(auto) edit tool with oldString/newString text mentioning /etc/ is allowed", async () => {
		const checker = createPermissionChecker("auto");
		const result = await checker.check(
			makeCtx("edit", {
				path: "/tmp/code.ts",
				oldString: "// Reads from /etc/passwd in tests",
				newString: "// Reads from /etc/passwd via fixture",
			}),
		);
		expect(result.action).toBe("allow");
	});

	it("(auto) tool with description string referencing protected paths is allowed", async () => {
		const checker = createPermissionChecker("auto");
		const result = await checker.check(
			makeCtx("custom_tool", {
				description: "Documents how to handle .env files and id_rsa keys",
				count: 3,
			}),
		);
		expect(result.action).toBe("allow");
	});

	it("(auto) tool with multi-line text containing protected path tokens is allowed", async () => {
		// Whitespace/newlines disqualify a string from path-shape, so a
		// content blob that happens to contain `/etc/shadow` in prose
		// should not be blocked.
		const checker = createPermissionChecker("auto");
		const result = await checker.check(
			makeCtx("write", {
				path: "/tmp/walkthrough.md",
				content: "Step 1: do not look at /etc/shadow.\nStep 2: never read ~/.ssh/id_rsa.\n",
			}),
		);
		expect(result.action).toBe("allow");
	});

	it("(deny) write tool with protected path under `path` is still blocked (real path field)", async () => {
		// Sanity: relaxing the floor for prose must NOT relax it for the
		// canonical `path` field, even on built-in writes.
		const checker = createPermissionChecker("deny");
		const result = await checker.check(
			makeCtx("write", { path: "/etc/shadow", content: "x" }),
		);
		expect(result.action).toBe("block");
		if (result.action === "block") {
			expect(result.reason).toMatch(/Protected path/);
		}
	});
});

describe("createPermissionChecker — Tier-2 pass-5 regression: no implicit name-based read allowlist", () => {
	for (const name of BUILTIN_READ_TOOL_NAMES) {
		it(`(deny) blocks bare-name "${name}" when host did not opt in via knownReadOnly`, async () => {
			// Pre-pass-5 bug: KNOWN_READ_TOOLS was an internal allowlist
			// applied automatically by name. A host running deny mode that
			// registered a *custom* mutating tool with a colliding name
			// (e.g. an MCP plugin tool literally named "read" that writes
			// remote state) would have it auto-classified as safe and
			// silently allowed. Identity-by-name is unreliable when the
			// tool registry is open — safety classification is now opt-in
			// only via knownReadOnly.
			const checker = createPermissionChecker("deny");
			const result = await checker.check(makeCtx(name, { path: "/tmp/safe.txt" }));
			expect(result.action).toBe("block");
		});

		it(`(ask) prompts for bare-name "${name}" when host did not opt in via knownReadOnly`, async () => {
			const onAsk = vi
				.fn<(ctx: PermissionAskContext) => Promise<AskDecision>>()
				.mockResolvedValue("deny");
			const checker = createPermissionChecker("ask", { onAsk });
			const result = await checker.check(makeCtx(name, { path: "/tmp/safe.txt" }));
			expect(result.action).toBe("block");
			expect(onAsk).toHaveBeenCalledOnce();
			expect(onAsk.mock.calls[0][0].toolName).toBe(name);
		});
	}

	it("BUILTIN_READ_TOOL_NAMES contains the historical bundled-read names", async () => {
		// Lock the constant so a future refactor renaming a built-in read
		// tool can't silently shrink the published opt-in set without
		// updating the export contract.
		expect(new Set(BUILTIN_READ_TOOL_NAMES)).toEqual(
			new Set(["read", "ls", "find", "grep"]),
		);
	});
});

describe("createPermissionChecker — Tier-2 pass-4 regression: knownReadOnly cannot downgrade built-in writes", () => {
	for (const tool of ["bash", "write", "edit", "notebook_edit"]) {
		it(`(deny) blocks built-in write "${tool}" even when listed in knownReadOnly`, async () => {
			// Pre-pass-4 bug: a host passing knownReadOnly: Set(['bash'])
			// could reclassify built-in writes as safe and bypass deny
			// mode entirely. Verified locally against the built output
			// before the fix: bash command "mkdir /tmp/pwn" returned
			// {action: "allow"} under deny mode with bash in knownReadOnly.
			// Built-in writes must be non-overridable.
			const checker = createPermissionChecker("deny", {
				knownReadOnly: new Set([tool]),
			});
			// Use a non-destructive command for bash so the always-blocked
			// floor isn't what stops execution — we want to prove the
			// deny-mode classifier specifically blocks it.
			const args = tool === "bash" ? { command: "mkdir /tmp/safe" } : { path: "/tmp/x" };
			const result = await checker.check(makeCtx(tool, args));
			expect(result.action).toBe("block");
		});

		it(`(ask) prompts for built-in write "${tool}" even when listed in knownReadOnly`, async () => {
			const onAsk = vi
				.fn<(ctx: PermissionAskContext) => Promise<AskDecision>>()
				.mockResolvedValue("deny");
			const checker = createPermissionChecker("ask", {
				knownReadOnly: new Set([tool]),
				onAsk,
			});
			const args = tool === "bash" ? { command: "mkdir /tmp/safe" } : { path: "/tmp/x" };
			const result = await checker.check(makeCtx(tool, args));
			expect(result.action).toBe("block"); // user denied via prompt
			expect(onAsk).toHaveBeenCalledOnce();
			expect(onAsk.mock.calls[0][0].toolName).toBe(tool);
		});
	}
});
