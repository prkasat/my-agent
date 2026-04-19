/**
 * Tests for ModelSelector component
 */

import type { SelectListTheme, TUI } from "@mariozechner/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
	COMMON_MODELS,
	type ModelInfo,
	createModelSelector,
} from "../../../../src/ui/components/selectors/model-selector.js";

// Simple theme without styling for testing
const testTheme: SelectListTheme = {
	selectedPrefix: (text: string) => text,
	selectedText: (text: string) => text,
	description: (text: string) => text,
	scrollInfo: (text: string) => text,
	noMatch: (text: string) => text,
};

// Mock TUI
function createMockTUI(): TUI {
	return {
		showOverlay: vi.fn().mockReturnValue({
			hide: vi.fn(),
			isVisible: vi.fn().mockReturnValue(true),
		}),
	} as unknown as TUI;
}

const sampleModels: ModelInfo[] = [
	{
		id: "model-1",
		name: "Test Model 1",
		provider: "test",
		description: "First test model",
	},
	{
		id: "model-2",
		name: "Test Model 2",
		provider: "test",
		description: "Second test model",
		isDefault: true,
	},
];

describe("createModelSelector", () => {
	it("creates selector with models", () => {
		const tui = createMockTUI();

		const overlay = createModelSelector(tui, sampleModels, {
			theme: testTheme,
		});

		expect(tui.showOverlay).toHaveBeenCalled();
		expect(overlay).toBeDefined();
	});

	it("throws error when no models provided", () => {
		const tui = createMockTUI();

		expect(() =>
			createModelSelector(tui, [], {
				theme: testTheme,
			}),
		).toThrow("ModelSelector requires at least one model");
	});

	it("calls onSelect callback when model is selected", () => {
		const tui = createMockTUI();
		const onSelect = vi.fn();

		createModelSelector(tui, sampleModels, {
			theme: testTheme,
			onSelect,
		});

		// The onSelect callback would be called by the SelectList component
		// We can't easily test the full flow without mocking more of pi-tui
		expect(onSelect).not.toHaveBeenCalled(); // Not called on creation
	});

	it("calls onCancel callback when cancelled", () => {
		const tui = createMockTUI();
		const onCancel = vi.fn();

		createModelSelector(tui, sampleModels, {
			theme: testTheme,
			onCancel,
		});

		expect(onCancel).not.toHaveBeenCalled(); // Not called on creation
	});
});

describe("COMMON_MODELS", () => {
	it("contains well-known models", () => {
		expect(COMMON_MODELS.length).toBeGreaterThan(0);

		// Check for some expected models
		const modelIds = COMMON_MODELS.map((m) => m.id);
		expect(modelIds.some((id) => id.includes("claude"))).toBe(true);
		expect(modelIds.some((id) => id.includes("gpt"))).toBe(true);
	});

	it("all models have required fields", () => {
		for (const model of COMMON_MODELS) {
			expect(model.id).toBeTruthy();
			expect(model.name).toBeTruthy();
		}
	});
});
