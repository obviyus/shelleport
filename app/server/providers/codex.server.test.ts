import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseCodexHistoricalSession } from "~/server/providers/codex.server";

const tempPaths: string[] = [];
const tempDir = Bun.env.TMPDIR ?? "/tmp";

afterEach(async () => {
	for (const path of tempPaths.splice(0)) {
		await Bun.$`rm -f ${path}`.quiet();
	}
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
