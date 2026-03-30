import { describe, expect, test } from "bun:test";

import {
	getSupportedEffortLevels,
	normalizeEffortLevel,
	supportsEffortLevel,
} from "~/shared/shelleport";

describe("effort levels", () => {
	test("allows max only on opus models", () => {
		expect(getSupportedEffortLevels("sonnet")).toEqual(["low", "medium", "high"]);
		expect(getSupportedEffortLevels("opus")).toEqual(["low", "medium", "high", "max"]);
		expect(getSupportedEffortLevels("haiku")).toEqual([]);
	});

	test("normalizes effort when switching to a stricter model", () => {
		expect(normalizeEffortLevel("sonnet", "max")).toBe("high");
		expect(normalizeEffortLevel("haiku", "high")).toBeNull();
		expect(normalizeEffortLevel("opus", "max")).toBe("max");
	});

	test("treats null effort as always valid", () => {
		expect(supportsEffortLevel("haiku", null)).toBe(true);
		expect(supportsEffortLevel("sonnet", null)).toBe(true);
	});
});
