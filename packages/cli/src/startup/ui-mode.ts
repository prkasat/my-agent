export type InteractiveUiMode = "tui" | "repl";

export function resolveInteractiveUiMode(options: {
	argv: string[];
	stdinIsTTY: boolean;
	stdoutIsTTY: boolean;
}): InteractiveUiMode {
	const wantsTui = options.argv.includes("--tui");
	const wantsRepl = options.argv.includes("--repl");
	if (wantsTui && wantsRepl) {
		throw new Error("--tui and --repl cannot be used together");
	}
	if (wantsTui) {
		return "tui";
	}
	if (wantsRepl) {
		return "repl";
	}
	return options.stdinIsTTY && options.stdoutIsTTY ? "tui" : "repl";
}
