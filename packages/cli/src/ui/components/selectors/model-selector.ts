/**
 * ModelSelector - Overlay for selecting AI models
 */

import {
	type Component,
	SelectList,
	type SelectItem,
	type SelectListTheme,
	type OverlayHandle,
	type TUI,
} from "@mariozechner/pi-tui";

export interface ModelInfo {
	/** Model identifier */
	id: string;
	/** Display name */
	name: string;
	/** Optional description */
	description?: string;
	/** Provider (e.g., "anthropic", "openai") */
	provider?: string;
	/** Whether this is the default model */
	isDefault?: boolean;
}

export interface ModelSelectorOptions {
	/** Theme for the select list */
	theme: SelectListTheme;
	/** Maximum visible items (default: 10) */
	maxVisible?: number;
	/** Callback when a model is selected */
	onSelect?: (model: ModelInfo) => void;
	/** Callback when selector is cancelled */
	onCancel?: () => void;
}

/**
 * Creates a model selector overlay.
 *
 * @throws {Error} If models array is empty
 *
 * Usage:
 * ```typescript
 * const selector = createModelSelector(tui, models, {
 *   theme: selectListTheme,
 *   onSelect: (model) => console.log(`Selected: ${model.name}`),
 * });
 *
 * // The overlay is automatically shown
 * // Call selector.hide() to close it
 * ```
 */
export function createModelSelector(
	tui: TUI,
	models: ModelInfo[],
	options: ModelSelectorOptions
): OverlayHandle {
	if (models.length === 0) {
		throw new Error("ModelSelector requires at least one model.");
	}

	const items: SelectItem[] = models.map((model) => ({
		value: model.id,
		label: formatModelLabel(model),
		description: model.description,
	}));

	const selectList = new SelectList(
		items,
		options.maxVisible ?? 10,
		options.theme,
		{
			minPrimaryColumnWidth: 20,
			maxPrimaryColumnWidth: 40,
		}
	);

	// Find and select the default model
	const defaultIndex = models.findIndex((m) => m.isDefault);
	if (defaultIndex >= 0) {
		selectList.setSelectedIndex(defaultIndex);
	}

	const overlay = tui.showOverlay(selectList, {
		anchor: "center",
		width: "60%",
		maxHeight: "50%",
	});

	selectList.onSelect = (item: SelectItem) => {
		const model = models.find((m) => m.id === item.value);
		if (model) {
			overlay.hide();
			options.onSelect?.(model);
		}
	};

	selectList.onCancel = () => {
		overlay.hide();
		options.onCancel?.();
	};

	return overlay;
}

function formatModelLabel(model: ModelInfo): string {
	if (model.provider) {
		return `${model.name} (${model.provider})`;
	}
	return model.name;
}

/**
 * Common AI models that can be used as defaults
 */
export const COMMON_MODELS: ModelInfo[] = [
	{
		id: "claude-sonnet-4-20250514",
		name: "Claude Sonnet 4",
		provider: "anthropic",
		description: "Latest Claude Sonnet - fast and capable",
	},
	{
		id: "claude-opus-4-20250514",
		name: "Claude Opus 4",
		provider: "anthropic",
		description: "Most capable Claude model",
	},
	{
		id: "claude-haiku-3-5-20241022",
		name: "Claude Haiku 3.5",
		provider: "anthropic",
		description: "Fast and efficient",
	},
	{
		id: "gpt-4o",
		name: "GPT-4o",
		provider: "openai",
		description: "OpenAI's flagship model",
	},
	{
		id: "gpt-4o-mini",
		name: "GPT-4o Mini",
		provider: "openai",
		description: "Smaller, faster GPT-4o",
	},
];
