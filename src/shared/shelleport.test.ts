import { describe, expect, test } from "bun:test";

import {
	getDefaultEffortLevel,
	getSupportedEffortLevels,
	normalizeEffortLevel,
	supportsEffortLevel,
} from "~/shared/shelleport";

describe("effort levels", () => {
	test("allows max only on opus models", () => {
		expect(getSupportedEffortLevels("sonnet")).toEqual(["low", "medium", "high"]);
		expect(getSupportedEffortLevels("opus")).toEqual(["low", "medium", "high", "max"]);
		expect(getSupportedEffortLevels("haiku")).toEqual([]);
		expect(
			getSupportedEffortLevels("gpt-5.1-codex-mini", [
				{
					id: "gpt-5.1-codex-mini",
					label: "gpt-5.1-codex-mini",
					supportedEfforts: ["medium", "high"],
				},
			]),
		).toEqual(["medium", "high"]);
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

	test("uses provider defaults when available", () => {
		expect(
			getDefaultEffortLevel("gpt-5.3-codex-spark", [
				{
					defaultEffort: "high",
					id: "gpt-5.3-codex-spark",
					label: "GPT-5.3-Codex-Spark",
					supportedEfforts: ["low", "medium", "high", "max"],
				},
			]),
		).toBe("high");
	});
});
