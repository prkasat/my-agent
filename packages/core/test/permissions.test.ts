import { describe, expect, it, vi } from "vitest";
import {
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

	it("allows read tools", async () => {
		const checker = createPermissionChecker("deny");
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

	it("read tools never trigger onAsk", async () => {
		const onAsk = vi.fn<(ctx: PermissionAskContext) => Promise<AskDecision>>();
		const checker = createPermissionChecker("ask", { onAsk });
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
