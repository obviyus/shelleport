import { describe, expect, test } from "bun:test";
import { mapClaudeUsageResponse } from "~/server/providers/claude-usage.server";

describe("mapClaudeUsageResponse", () => {
	test("maps OAuth usage windows into session limits", () => {
		expect(
			mapClaudeUsageResponse({
				five_hour: {
					utilization: 7,
					resets_at: "2025-12-23T16:00:00.000Z",
				},
				seven_day: {
					utilization: 21,
					resets_at: "2025-12-29T23:00:00.000Z",
				},
			}),
		).toEqual([
			{
				status: null,
				resetsAt: Date.parse("2025-12-23T16:00:00.000Z"),
				window: "five_hour",
				isUsingOverage: null,
				utilization: 7,
			},
			{
				status: null,
				resetsAt: Date.parse("2025-12-29T23:00:00.000Z"),
				window: "weekly",
				isUsingOverage: null,
				utilization: 21,
			},
		]);
	});

	test("drops empty windows", () => {
		expect(
			mapClaudeUsageResponse({
				five_hour: {},
				seven_day: {
					utilization: 4,
				},
			}),
		).toEqual([
			{
				status: null,
				resetsAt: null,
				window: "weekly",
				isUsingOverage: null,
				utilization: 4,
			},
		]);
	});
});
