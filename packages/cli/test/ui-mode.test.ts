import { describe, expect, it } from "vitest";
import { resolveInteractiveUiMode } from "../src/startup/ui-mode.js";

describe("resolveInteractiveUiMode", () => {
	it("defaults to TUI in an interactive terminal", () => {
		expect(resolveInteractiveUiMode({ argv: [], stdinIsTTY: true, stdoutIsTTY: true })).toBe("tui");
	});

	it("falls back to REPL when stdin/stdout are not interactive", () => {
		expect(resolveInteractiveUiMode({ argv: [], stdinIsTTY: false, stdoutIsTTY: false })).toBe("repl");
	});

	it("honors --repl explicitly", () => {
		expect(resolveInteractiveUiMode({ argv: ["--repl"], stdinIsTTY: true, stdoutIsTTY: true })).toBe("repl");
	});

	it("honors --tui explicitly", () => {
		expect(resolveInteractiveUiMode({ argv: ["--tui"], stdinIsTTY: false, stdoutIsTTY: false })).toBe("tui");
	});

	it("rejects conflicting explicit UI flags", () => {
		expect(() => resolveInteractiveUiMode({ argv: ["--tui", "--repl"], stdinIsTTY: true, stdoutIsTTY: true })).toThrow(
			/cannot be used together/,
		);
	});
});
