import { describe, expect, test } from "bun:test";
import { getSessionHeaderBadges } from "~/client/session-stream";

describe("getSessionHeaderBadges", () => {
	test("puts the normalized model badge before usage badges", () => {
		const badges = getSessionHeaderBadges({
			usage: {
				inputTokens: 12,
				outputTokens: 4,
				cacheReadInputTokens: 1200,
				cacheCreationInputTokens: 600,
				costUsd: 0.045784,
				model: "claude-opus-4-6[1m]",
			},
		});

		expect(badges).toEqual([
			{
				key: "model:claude-opus-4-6[1m]",
				label: "claude-opus-4-6",
				title: "claude-opus-4-6[1m]",
				visibility: "lg",
			},
			{
				key: "in:12",
				label: "in 12",
				visibility: "xl",
			},
			{
				key: "out:4",
				label: "out 4",
				visibility: "xl",
			},
			{
				key: "cache-read:1200",
				label: "cache read 1,200",
				visibility: "xl",
			},
			{
				key: "cache-write:600",
				label: "cache write 600",
				visibility: "xl",
			},
			{
				key: "cost:0.045784",
				label: "$0.046",
				visibility: "xl",
			},
		]);
	});

	test("skips the model badge when the session has no model", () => {
		const badges = getSessionHeaderBadges({
			usage: {
				inputTokens: 1,
				outputTokens: 2,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				costUsd: null,
				model: null,
			},
		});

		expect(badges).toEqual([
			{
				key: "in:1",
				label: "in 1",
				visibility: "xl",
			},
			{
				key: "out:2",
				label: "out 2",
				visibility: "xl",
			},
		]);
	});
});
