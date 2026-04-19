import { describe, expect, it } from "vitest";
import { EXTENSION_API_VERSION, isExtensionApiCompatible } from "../../src/extensions/version.js";

describe("extension api compatibility", () => {
	it("accepts empty or wildcard declarations", () => {
		expect(isExtensionApiCompatible(undefined, EXTENSION_API_VERSION)).toBe(true);
		expect(isExtensionApiCompatible("*", EXTENSION_API_VERSION)).toBe(true);
	});

	it("accepts common compatible ranges", () => {
		expect(isExtensionApiCompatible("1", "1.0.0")).toBe(true);
		expect(isExtensionApiCompatible("1.x", "1.2.3")).toBe(true);
		expect(isExtensionApiCompatible("^1.0.0", "1.4.0")).toBe(true);
		expect(isExtensionApiCompatible(">=1.0.0 <2.0.0", "1.9.9")).toBe(true);
	});

	it("rejects incompatible ranges", () => {
		expect(isExtensionApiCompatible("2.x", "1.0.0")).toBe(false);
		expect(isExtensionApiCompatible("^2.0.0", "1.4.0")).toBe(false);
		expect(isExtensionApiCompatible(">=2.0.0", "1.9.9")).toBe(false);
	});
});
