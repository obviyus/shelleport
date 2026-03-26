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
				events: Array<{
					kind: string;
					data: Record<string, unknown>;
				}>;
				pendingRequests: Array<{
					id: string;
					blockReason: string | null;
					status: string;
					data: Record<string, unknown>;
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
	  };

const testRoot = join(Bun.env.TMPDIR ?? "/tmp", `shelleport-api-${Bun.randomUUIDv7()}`);
const fakeClaudePath = join(testRoot, "fake-claude.js");
const dataDir = join(testRoot, "data");
const authHeader = { authorization: "Bearer test-token" };

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
			const dataLine = chunk
				.split("\n")
				.find((line) => line.startsWith("data: "));

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
) {
	for (;;) {
		const message = await nextSseMessage(reader, state);

		if (predicate(message)) {
			return message;
		}
	}
}

beforeAll(async () => {
	await Bun.$`mkdir -p ${testRoot} ${dataDir}`.quiet();
	await Bun.write(
		fakeClaudePath,
		`#!/usr/bin/env bun
const args = process.argv.slice(2);
const resumeIndex = args.indexOf("-r");
const sessionId = resumeIndex === -1 ? "fake-claude-session" : args[resumeIndex + 1];
const prompt = args.at(-1) ?? "";
const allowedTools = [];

for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--allowedTools") {
    allowedTools.push(args[index + 1]);
  }
}

const emit = (payload) => console.log(JSON.stringify(payload));
emit({
  type: "system",
  subtype: "init",
  cwd: process.cwd(),
  session_id: sessionId,
});

const denied = prompt.includes("git commit") && !allowedTools.includes("Bash(git commit:*)");

if (denied) {
  emit({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id: "tool-1",
          name: "Bash",
          input: {
            command: "git commit --allow-empty -m test",
            description: "Create empty commit with message test",
          },
        },
      ],
    },
  });
  emit({
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: "This command requires approval",
          is_error: true,
        },
      ],
    },
  });
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "blocked",
    stop_reason: "end_turn",
    session_id: sessionId,
    permission_denials: [
      {
        tool_name: "Bash",
        tool_use_id: "tool-1",
        tool_input: {
          command: "git commit --allow-empty -m test",
          description: "Create empty commit with message test",
        },
      },
    ],
  });
  process.exit(0);
}

if (prompt.includes("approved this command")) {
  emit({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id: "tool-2",
          name: "Bash",
          input: {
            command: "git commit --allow-empty -m test",
            description: "Create empty commit with message test",
          },
        },
      ],
    },
  });
  emit({
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-2",
          content: "[master (root-commit) deadbee] test",
          is_error: false,
        },
      ],
    },
  });
  emit({
    type: "assistant",
    message: {
      content: [
        {
          type: "text",
          text: "Done.",
        },
      ],
    },
  });
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Done.",
    stop_reason: "end_turn",
    session_id: sessionId,
    permission_denials: [],
  });
  process.exit(0);
}

emit({
  type: "assistant",
  message: {
    content: [
      {
        type: "text",
        text: prompt,
      },
    ],
  },
});
emit({
  type: "result",
  subtype: "success",
  is_error: false,
  result: prompt,
  stop_reason: "end_turn",
  session_id: sessionId,
  permission_denials: [],
});
`,
	);
	await Bun.$`chmod +x ${fakeClaudePath}`.quiet();

	Bun.env.SHELLEPORT_CLAUDE_BIN = fakeClaudePath;
	Bun.env.SHELLEPORT_DATA_DIR = dataDir;
	Bun.env.SHELLEPORT_ADMIN_TOKEN = "test-token";

	handleApiRequest = (await import("~/server/api.server")).handleApiRequest;
});

afterAll(async () => {
	await Bun.$`rm -rf ${testRoot}`.quiet();
});

describe("handleApiRequest", () => {
	test("starts a session, streams SSE, and resumes after approval", async () => {
		const createResponse = await handleApiRequest(
			new Request("http://localhost/api/sessions", {
				method: "POST",
				headers: {
					...authHeader,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					provider: "claude",
					cwd: testRoot,
					prompt: "Run git commit --allow-empty -m test and then say done",
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
		expect(eventsResponse.status).toBe(200);
		expect(eventsResponse.headers.get("content-type")).toContain("text/event-stream");

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

		expect(pendingRequest.data.toolRule).toBe("Bash(git commit:*)");
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
				message.payload.data.text === "Done.",
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
			pendingRequests: Array<{
				status: string;
			}>;
		}>(detailResponse);
		expect(detail.session.status).toBe("idle");
		expect(detail.session.allowedTools).toEqual(["Bash(git commit:*)"]);
		expect(detail.pendingRequests).toHaveLength(0);

		await reader.cancel();
	});

	test("rejects missing auth", async () => {
		const response = await handleApiRequest(
			new Request("http://localhost/api/sessions", {
				headers: {
					"content-type": "application/json",
				},
			}),
		);
		expect(response?.status).toBe(401);
		expect(await response.json()).toMatchObject({
			code: "unauthorized",
		});
	});

	test("rejects invalid create-session cwd", async () => {
		const response = await handleApiRequest(
			new Request("http://localhost/api/sessions", {
				method: "POST",
				headers: {
					...authHeader,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					provider: "claude",
					cwd: "relative/path",
					prompt: "hello",
				}),
			}),
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			code: "invalid_cwd",
		});
	});
});
