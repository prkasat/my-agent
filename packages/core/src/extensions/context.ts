/**
 * Default ExtensionUI/ExtensionActions implementations.
 *
 * The host (CLI/TUI) is expected to install real implementations via
 * ExtensionRunnerOptions. These defaults exist so extensions don't have
 * to null-check the surface; they return sensible no-op / stub values
 * and log a warning.
 */

import type { ExtensionActions, ExtensionUI, UISelectItem } from "./types.js";

export const noopUI: ExtensionUI = {
	async select(_items: UISelectItem[]): Promise<string | null> {
		return null;
	},
	async confirm(_message: string, options?: { defaultValue?: boolean }): Promise<boolean> {
		return options?.defaultValue ?? false;
	},
	async input(_message: string, options?: { defaultValue?: string }): Promise<string | null> {
		return options?.defaultValue ?? null;
	},
	notify(_message: string, _level?: "info" | "warn" | "error"): void {
		/* no-op */
	},
};

export const noopActions: ExtensionActions = {
	sendMessage(_content: string): void {
		/* no-op */
	},
	setModel(_model): void {
		/* no-op */
	},
	setActiveTools(_tools): void {
		/* no-op */
	},
	async fork(): Promise<string> {
		throw new Error("fork() not implemented by the host");
	},
	async navigateTree(_nodeId: string): Promise<void> {
		throw new Error("navigateTree() not implemented by the host");
	},
};
