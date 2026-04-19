import { describe, expect, it } from "vitest";
import { createBashToolDefinition } from "../../src/tools/bash.js";

describe("bash tool", () => {
	it("surfaces timeouts as a clear, simulated failure mode", async () => {
		const definition = createBashToolDefinition("/tmp", {
			operations: {
				async exec(_command, _cwd, options) {
					throw new Error(`timeout:${options.timeout}`);
				},
			},
		});

		await expect(
			definition.execute("tool-call-1", { command: "sleep 999", timeout: 3 }, new AbortController().signal),
		).rejects.toThrow("Command timed out after 3 seconds");
	});
});
