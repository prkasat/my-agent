/**
 * Custom keybindings for agent TUI
 *
 * Extends pi-tui keybindings with agent-specific actions.
 */

import type { KeybindingDefinitions, KeyId } from "@earendil-works/pi-tui";

/**
 * Agent-specific keybinding definitions
 *
 * These extend the default pi-tui keybindings with actions
 * specific to AI agent interactions.
 */
export const AGENT_KEYBINDINGS: KeybindingDefinitions = {
	// Tool execution controls
	"agent.tool.expand": {
		defaultKeys: "ctrl+o",
		description: "Expand/collapse tool output",
	},
	"agent.tool.expandAll": {
		defaultKeys: "ctrl+e",
		description: "Expand all tool outputs",
	},
	"agent.tool.collapseAll": {
		defaultKeys: "ctrl+shift+e",
		description: "Collapse all tool outputs",
	},

	// Message navigation
	"agent.message.previous": {
		defaultKeys: "ctrl+p",
		description: "Go to previous message",
	},
	"agent.message.next": {
		defaultKeys: "ctrl+n",
		description: "Go to next message",
	},
	"agent.message.first": {
		defaultKeys: "ctrl+home",
		description: "Go to first message",
	},
	"agent.message.last": {
		defaultKeys: "ctrl+end",
		description: "Go to last message",
	},

	// Session controls
	"agent.session.cancel": {
		defaultKeys: "escape",
		description: "Cancel current operation",
	},
	"agent.session.interrupt": {
		defaultKeys: "ctrl+c",
		description: "Interrupt agent execution",
	},
	"agent.session.clear": {
		defaultKeys: "ctrl+l",
		description: "Clear chat history display",
	},
	"agent.session.new": {
		defaultKeys: "ctrl+shift+n",
		description: "Start new session",
	},

	// Mode switching
	"agent.mode.normal": {
		defaultKeys: "ctrl+1",
		description: "Switch to normal mode",
	},
	"agent.mode.plan": {
		defaultKeys: "ctrl+2",
		description: "Switch to plan mode",
	},
	"agent.mode.auto": {
		defaultKeys: "ctrl+3",
		description: "Switch to auto mode",
	},

	// Model selection
	"agent.model.select": {
		defaultKeys: "ctrl+shift+m",
		description: "Open model selector",
	},

	// Diff viewer controls
	"agent.diff.toggle": {
		defaultKeys: "d",
		description: "Toggle diff view",
	},
	"agent.diff.accept": {
		defaultKeys: "y",
		description: "Accept changes",
	},
	"agent.diff.reject": {
		defaultKeys: "n",
		description: "Reject changes",
	},

	// Copy/clipboard
	"agent.copy.lastResponse": {
		defaultKeys: "ctrl+shift+c",
		description: "Copy last assistant response",
	},
	"agent.copy.codeBlock": {
		defaultKeys: "ctrl+shift+k",
		description: "Copy code block under cursor",
	},

	// Thinking blocks
	"agent.thinking.toggle": {
		defaultKeys: "ctrl+t",
		description: "Expand/collapse thinking blocks",
	},

	// Help
	"agent.help.show": {
		defaultKeys: "f1",
		description: "Show help",
	},
	"agent.help.shortcuts": {
		defaultKeys: "ctrl+/",
		description: "Show keyboard shortcuts",
	},
};

/**
 * Get all agent keybinding action names
 */
export function getAgentKeybindingActions(): string[] {
	return Object.keys(AGENT_KEYBINDINGS);
}

/**
 * Get the default key(s) for an agent action
 */
export function getDefaultKeyForAction(action: string): KeyId | KeyId[] | undefined {
	const binding = AGENT_KEYBINDINGS[action];
	return binding?.defaultKeys;
}

/**
 * Get the description for an agent action
 */
export function getActionDescription(action: string): string | undefined {
	const binding = AGENT_KEYBINDINGS[action];
	return binding?.description;
}
