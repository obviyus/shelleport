import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";

type TurnSample = {
	firstEventMs: number;
	turnMs: number;
	lastSequence: number;
};

type SessionStreamMessage =
	| {
			type: "snapshot";
			payload: {
				session: {
					status: string;
					lastEventSequence: number;
				};
			};
	  }
	| {
			type: "session";
			payload: {
				status: string;
				lastEventSequence: number;
			};
	  }
	| {
			type: "event";
			payload: {
				sequence: number;
				kind: string;
			};
	  };

const host = "127.0.0.1";
const port = 43000 + Math.floor(Math.random() * 1000);
const adminToken = "bench-token";
const dataDir = await mkdtemp(join(tmpdir(), "shelleport-claude-bench-data-"));
const claudeBin = Bun.which("claude") ?? "claude";
const iterations = 3;
const prompts = [
	"Reply with the single word READY and nothing else.",
	"Reply with the single word AGAIN and nothing else.",
	"Reply with the single word DONE and nothing else.",
];

process.env.SHELLEPORT_DATA_DIR = dataDir;
process.env.SHELLEPORT_CLAUDE_BIN = claudeBin;
process.env.NODE_ENV = "production";

function median(values: number[]) {
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

async function waitFor(url: string) {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(url);
			if (response.ok) {
				return;
			}
		} catch {}
		await Bun.sleep(100);
	}
	throw new Error(`Timed out waiting for ${url}`);
}

async function login(baseUrl: string) {
	const response = await fetch(`${baseUrl}/api/auth/session`, {
		body: JSON.stringify({ token: adminToken }),
		headers: {
			"Content-Type": "application/json",
		},
		method: "POST",
	});
	if (!response.ok) {
		throw new Error(`Login failed: ${response.status}`);
	}
	const setCookie = response.headers.get("set-cookie");
	if (!setCookie) {
		throw new Error("Missing auth cookie");
	}
	return setCookie.split(";")[0];
}

async function readSseMessage(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	state: { buffer: string },
): Promise<SessionStreamMessage> {
	for (;;) {
		const boundary = state.buffer.indexOf("\n\n");
		if (boundary !== -1) {
			const chunk = state.buffer.slice(0, boundary);
			state.buffer = state.buffer.slice(boundary + 2);
			const dataLine = chunk.split("\n").find((line) => line.startsWith("data: "));
			if (!dataLine) {
				continue;
			}
			return JSON.parse(dataLine.slice("data: ".length)) as SessionStreamMessage;
		}
		const { done, value } = await reader.read();
		if (done) {
			throw new Error("SSE stream closed");
		}
		state.buffer += new TextDecoder().decode(value);
	}
}

async function waitForTurn(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	state: { buffer: string },
	startSequence: number,
): Promise<TurnSample> {
	const startedAt = performance.now();
	let firstEventMs: number | null = null;
	let latestSequence = startSequence;

	for (;;) {
		const message = await readSseMessage(reader, state);

		if (message.type === "event" && message.payload.sequence > startSequence) {
			latestSequence = Math.max(latestSequence, message.payload.sequence);
			if (firstEventMs === null) {
				firstEventMs = performance.now() - startedAt;
			}
			continue;
		}

		if (message.type === "session") {
			latestSequence = Math.max(latestSequence, message.payload.lastEventSequence);
			if (
				message.payload.status !== "running" &&
				message.payload.status !== "retrying" &&
				message.payload.status !== "waiting" &&
				latestSequence > startSequence
			) {
				return {
					firstEventMs: firstEventMs ?? performance.now() - startedAt,
					turnMs: performance.now() - startedAt,
					lastSequence: latestSequence,
				};
			}
		}
	}
}

async function benchmarkDirect(cwd: string, extraArgs: string[]) {
	const samples: number[] = [];
	for (const prompt of prompts) {
		const start = performance.now();
		const subprocess = Bun.spawn(
			[
				claudeBin,
				"-p",
				"--verbose",
				"--include-partial-messages",
				"--output-format",
				"stream-json",
				...extraArgs,
				"--permission-mode",
				"bypassPermissions",
				prompt,
			],
			{
				cwd,
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		await subprocess.exited;
		samples.push(performance.now() - start);
	}
	return median(samples);
}

async function runIteration(baseUrl: string, cookie: string) {
	const createStartedAt = performance.now();
	const createResponse = await fetch(`${baseUrl}/api/sessions`, {
		body: JSON.stringify({
			cwd: process.cwd(),
			provider: "claude",
			title: "Claude bench session",
			permissionMode: "bypassPermissions",
		}),
		headers: {
			"Content-Type": "application/json",
			Cookie: cookie,
		},
		method: "POST",
	});
	if (createResponse.status !== 201) {
		throw new Error(`Create session failed: ${createResponse.status}`);
	}
	const createSessionMs = performance.now() - createStartedAt;
	const createJson = (await createResponse.json()) as { session: { id: string } };
	const sessionId = createJson.session.id;

	const eventsResponse = await fetch(`${baseUrl}/api/sessions/${sessionId}/events`, {
		headers: {
			Cookie: cookie,
		},
	});
	if (!eventsResponse.ok || !eventsResponse.body) {
		throw new Error(`Open SSE failed: ${eventsResponse.status}`);
	}
	const reader = eventsResponse.body.getReader();
	const state = { buffer: "" };
	let lastSequence = 0;

	const initialSnapshot = await readSseMessage(reader, state);
	if (initialSnapshot.type !== "snapshot") {
		throw new Error("Expected snapshot");
	}
	lastSequence = initialSnapshot.payload.session.lastEventSequence;

	const turnSamples: TurnSample[] = [];
	try {
		for (const prompt of prompts) {
			const form = new FormData();
			form.set("prompt", prompt);
			const inputResponse = await fetch(`${baseUrl}/api/sessions/${sessionId}/input`, {
				body: form,
				headers: {
					Cookie: cookie,
				},
				method: "POST",
			});
			if (inputResponse.status !== 202) {
				throw new Error(`Send input failed: ${inputResponse.status}`);
			}
			const turn = await waitForTurn(reader, state, lastSequence);
			turnSamples.push(turn);
			lastSequence = turn.lastSequence;
		}
	} finally {
		await reader.cancel();
	}

	return {
		createSessionMs,
		turnSamples,
	};
}

const auth = await import("~/server/auth.server");
auth.setAdminToken(adminToken);

const child = Bun.spawn(
	["bun", "run", "server.ts", "serve", "--host", host, "--port", String(port)],
	{
		env: {
			...process.env,
			HOST: host,
			PORT: String(port),
			NODE_ENV: "production",
			SHELLEPORT_DATA_DIR: dataDir,
			SHELLEPORT_CLAUDE_BIN: claudeBin,
			SHELLEPORT_CLAUDE_BARE: process.env.SHELLEPORT_CLAUDE_BARE ?? "0",
		},
		stdout: "pipe",
		stderr: "pipe",
	},
);

try {
	const baseUrl = `http://${host}:${port}`;
	await waitFor(`${baseUrl}/health`);
	const cookie = await login(baseUrl);
	const samples: Awaited<ReturnType<typeof runIteration>>[] = [];
	for (let index = 0; index < iterations; index += 1) {
		samples.push(await runIteration(baseUrl, cookie));
	}

	const firstTurns = samples.map((sample) => sample.turnSamples[0]?.turnMs ?? 0);
	const secondTurns = samples.map((sample) => sample.turnSamples[1]?.turnMs ?? 0);
	const thirdTurns = samples.map((sample) => sample.turnSamples[2]?.turnMs ?? 0);
	const firstEvents = samples.flatMap((sample) =>
		sample.turnSamples.map((turn) => turn.firstEventMs),
	);
	const createSessionTimes = samples.map((sample) => sample.createSessionMs);
	const directSpawnMs = await benchmarkDirect(process.cwd(), []);
	const directBareMs = await benchmarkDirect(process.cwd(), ["--bare"]);
	const conversationTotalMs = median(firstTurns) + median(secondTurns) + median(thirdTurns);

	console.log(`METRIC conversation_total_ms=${conversationTotalMs.toFixed(3)}`);
	console.log(`METRIC first_turn_ms=${median(firstTurns).toFixed(3)}`);
	console.log(`METRIC second_turn_ms=${median(secondTurns).toFixed(3)}`);
	console.log(`METRIC third_turn_ms=${median(thirdTurns).toFixed(3)}`);
	console.log(`METRIC first_event_ms=${median(firstEvents).toFixed(3)}`);
	console.log(`METRIC create_session_ms=${median(createSessionTimes).toFixed(3)}`);
	console.log(`METRIC direct_spawn_ms=${directSpawnMs.toFixed(3)}`);
	console.log(`METRIC direct_bare_ms=${directBareMs.toFixed(3)}`);
	console.log(JSON.stringify({ samples, directSpawnMs, directBareMs }, null, 2));
} finally {
	child.kill();
	await child.exited.catch(() => {});
	await rm(dataDir, { force: true, recursive: true });
}
