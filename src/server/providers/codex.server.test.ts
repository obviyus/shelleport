import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mapCodexRateLimits, parseCodexHistoricalSession } from "~/server/providers/codex.server";

const tempPaths: string[] = [];
const tempDir = Bun.env.TMPDIR ?? "/tmp";

afterEach(async () => {
	for (const path of tempPaths.splice(0)) {
		await Bun.$`rm -f ${path}`.quiet();
	}
});

describe("mapCodexRateLimits", () => {
	test("maps primary and secondary Codex rate limit windows", () => {
		expect(
			mapCodexRateLimits({
				rateLimits: {
					primary: {
						usedPercent: 42,
						windowDurationMins: 300,
						resetsAt: 1778053081,
					},
					secondary: {
						usedPercent: 26,
						windowDurationMins: 10080,
						resetsAt: 1778578512,
					},
				},
			}),
		).toEqual([
			{
				isUsingOverage: null,
				resetsAt: 1778053081000,
				status: null,
				utilization: 42,
				window: "300m",
			},
			{
				isUsingOverage: null,
				resetsAt: 1778578512000,
				status: null,
				utilization: 26,
				window: "10080m",
			},
		]);
	});

	test("skips incomplete Codex rate limit windows", () => {
		expect(
			mapCodexRateLimits({
				rateLimits: {
					primary: { usedPercent: 42, windowDurationMins: 300 },
					secondary: null,
				},
			}),
		).toEqual([]);
	});
});

describe("parseCodexHistoricalSession", () => {
	test("reads metadata from a Codex jsonl file", async () => {
		const path = join(tempDir, `codex-history-${Bun.randomUUIDv7()}.jsonl`);
		tempPaths.push(path);
		await Bun.write(
			path,
			[
				JSON.stringify({
					type: "session_meta",
					payload: {
						id: "codex-session-1",
						cwd: "/tmp/codex",
						timestamp: "2026-03-26T00:00:00.000Z",
						originator: "codex_cli",
					},
				}),
			].join("\n"),
		);

		const session = await parseCodexHistoricalSession(path);

		expect(session).not.toBeNull();
		expect(session).toMatchObject({
			provider: "codex",
			providerSessionRef: "codex-session-1",
			cwd: "/tmp/codex",
		});
	});
});
