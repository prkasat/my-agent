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
