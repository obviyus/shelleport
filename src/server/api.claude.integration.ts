import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

type SessionStreamMessage =
	| {
			type: "snapshot";
			payload: {
				session: {
					id: string;
					status: string;
					allowedTools: string[];
				};
				pendingRequests: Array<{
					id: string;
					blockReason: string | null;
					status: string;
					data: Record<string, unknown>;
				}>;
				queuedInputs: Array<{
					id: string;
					prompt: string;
				}>;
			};
	  }
	| {
			type: "session";
			payload: {
				id: string;
				status: string;
				allowedTools: string[];
			};
	  }
	| {
			type: "event";
			payload: {
				kind: string;
				data: Record<string, unknown>;
			};
	  }
	| {
			type: "request";
			payload: {
				id: string;
				blockReason: string | null;
				status: string;
				data: Record<string, unknown>;
			};
	  }
	| {
			type: "queued-inputs";
			payload: Array<{
				id: string;
				prompt: string;
			}>;
	  };

const testRoot = join(Bun.env.TMPDIR ?? "/tmp", `shelleport-claude-${Bun.randomUUIDv7()}`);
const dataDir = join(testRoot, "data");
const repoDir = join(testRoot, "repo");
const authHeader = { authorization: "Bearer claude-test-token" };

let handleApiRequest: typeof import("~/server/api.server").handleApiRequest;

async function readJson<T>(response: Response) {
	return (await response.json()) as T;
}

async function nextSseMessage(
	reader: ReadableStreamDefaultReader<string | Uint8Array>,
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

		state.buffer += typeof value === "string" ? value : new TextDecoder().decode(value);
	}
}

async function waitForMessage(
	reader: ReadableStreamDefaultReader<string | Uint8Array>,
	state: { buffer: string },
	predicate: (message: SessionStreamMessage) => boolean,
	timeoutMs = 120000,
) {
	const startedAt = Date.now();

	for (;;) {
		if (Date.now() - startedAt > timeoutMs) {
			throw new Error("Timed out waiting for SSE message");
		}

		const message = await nextSseMessage(reader, state);

		if (predicate(message)) {
			return message;
		}
	}
}

beforeAll(async () => {
	await Bun.$`mkdir -p ${dataDir} ${repoDir}`.quiet();
	await Bun.$`git -C ${repoDir} init -q`.quiet();
	await Bun.$`git -C ${repoDir} config user.email shelleport@test.invalid`.quiet();
	await Bun.$`git -C ${repoDir} config user.name shelleport-test`.quiet();

	Bun.env.SHELLEPORT_DATA_DIR = dataDir;

	const cliCheck = Bun.spawn(["claude", "--version"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const exitCode = await cliCheck.exited;

	if (exitCode !== 0) {
		throw new Error("claude CLI is not available");
	}

	const auth = await import("~/server/auth.server");
	auth.setAdminToken("claude-test-token");
	handleApiRequest = (await import("~/server/api.server")).handleApiRequest;
});

afterAll(async () => {
	await Bun.$`rm -rf ${testRoot}`.quiet();
});

describe("real Claude API integration", () => {
	test("runs a simple managed session over SSE", async () => {
		const createResponse = await handleApiRequest(
			new Request("http://localhost/api/sessions", {
				method: "POST",
				headers: {
					...authHeader,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					provider: "claude",
					cwd: repoDir,
					prompt: "Reply with the single word READY and nothing else.",
				}),
			}),
		);
		expect(createResponse.status).toBe(201);
		const createJson = await readJson<{ session: { id: string } }>(createResponse);

		const eventsResponse = await handleApiRequest(
			new Request(`http://localhost/api/sessions/${createJson.session.id}/events`, {
				headers: authHeader,
			}),
		);
		const reader = eventsResponse.body?.getReader();

		if (!reader) {
			throw new Error("Missing SSE body");
		}

		const streamState = { buffer: "" };
		const readyMessage = await waitForMessage(
			reader,
			streamState,
			(message) =>
				message.type === "event" &&
				message.payload.kind === "text" &&
				typeof message.payload.data.text === "string" &&
				message.payload.data.text.toUpperCase().includes("READY"),
		);
		expect(readyMessage.type).toBe("event");

		const idleMessage = await waitForMessage(
			reader,
			streamState,
			(message) => message.type === "session" && message.payload.status === "idle",
		);
		expect(idleMessage.type).toBe("session");

		await reader.cancel();
	});

	test("approves and resumes a real Claude permission denial", async () => {
		const createResponse = await handleApiRequest(
			new Request("http://localhost/api/sessions", {
				method: "POST",
				headers: {
					...authHeader,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					provider: "claude",
					cwd: repoDir,
					prompt:
						"Run git commit --allow-empty -m shelleport-test and then reply with DONE and nothing else.",
				}),
			}),
		);
		expect(createResponse.status).toBe(201);
		const createJson = await readJson<{ session: { id: string } }>(createResponse);
		const sessionId = createJson.session.id;

		const eventsResponse = await handleApiRequest(
			new Request(`http://localhost/api/sessions/${sessionId}/events`, {
				headers: authHeader,
			}),
		);
		const reader = eventsResponse.body?.getReader();

		if (!reader) {
			throw new Error("Missing SSE body");
		}

		const streamState = { buffer: "" };
		const approvalMessage = await waitForMessage(
			reader,
			streamState,
			(message) =>
				(message.type === "request" && message.payload.status === "pending") ||
				(message.type === "snapshot" && message.payload.pendingRequests.length > 0),
		);

		let pendingRequest: {
			id: string;
			blockReason: string | null;
			status: string;
			data: Record<string, unknown>;
		} | null = null;

		if (approvalMessage.type === "request") {
			pendingRequest = approvalMessage.payload;
		}

		if (approvalMessage.type === "snapshot") {
			pendingRequest = approvalMessage.payload.pendingRequests[0] ?? null;
		}

		if (!pendingRequest) {
			throw new Error("Expected pending request");
		}

		expect(pendingRequest.blockReason).toBe("permission");

		const respondResponse = await handleApiRequest(
			new Request(`http://localhost/api/requests/${pendingRequest.id}/respond`, {
				method: "POST",
				headers: {
					...authHeader,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					decision: "allow",
				}),
			}),
		);
		expect(respondResponse.status).toBe(200);

		const doneMessage = await waitForMessage(
			reader,
			streamState,
			(message) =>
				message.type === "event" &&
				message.payload.kind === "text" &&
				typeof message.payload.data.text === "string" &&
				message.payload.data.text.toUpperCase().includes("DONE"),
		);
		expect(doneMessage.type).toBe("event");

		const idleMessage = await waitForMessage(
			reader,
			streamState,
			(message) => message.type === "session" && message.payload.status === "idle",
		);
		expect(idleMessage.type).toBe("session");

		const detailResponse = await handleApiRequest(
			new Request(`http://localhost/api/sessions/${sessionId}`, {
				headers: authHeader,
			}),
		);
		const detail = await readJson<{
			session: {
				status: string;
				allowedTools: string[];
			};
		}>(detailResponse);
		expect(detail.session.allowedTools).toContain("Bash(git commit:*)");
		expect(detail.session.status).toBe("idle");

		await reader.cancel();
	});
});
