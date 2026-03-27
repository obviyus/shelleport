import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

type SessionStreamMessage =
	| {
			type: "snapshot";
			payload: {
				session: {
					id: string;
					status: string;
					statusDetail: {
						message: string | null;
						attempt: number | null;
						nextRetryTime: number | null;
					};
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
				statusDetail: {
					message: string | null;
					attempt: number | null;
					nextRetryTime: number | null;
				};
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

if (prompt.includes("trigger retry")) {
  emit({
    type: "progress",
    data: {
      toolUseResult: "Request failed with status code 429, retrying in 7s (attempt 2)",
    },
  });
  emit({
    type: "assistant",
    message: {
      content: [
        {
          type: "text",
          text: "Recovered.",
        },
      ],
    },
  });
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Recovered.",
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
	test("lists directory entries for the launcher browser", async () => {
		const browserRoot = join(testRoot, "browser-root");
		await Bun.$`mkdir -p ${join(browserRoot, "alpha")} ${join(browserRoot, "Zoo")}`.quiet();
		await Bun.write(join(browserRoot, "notes.md"), "# notes");

		const response = await handleApiRequest(
			new Request(`http://localhost/api/directories?path=${encodeURIComponent(browserRoot)}`, {
				headers: authHeader,
			}),
		);
		expect(response.status).toBe(200);
		const body = await readJson<{
			path: string;
			parentPath: string | null;
			entries: Array<{
				name: string;
				path: string;
				kind: string;
			}>;
		}>(response);
		expect(body.path).toBe(browserRoot);
		expect(body.parentPath).toBe(testRoot);
		expect(body.entries.slice(0, 3)).toEqual([
			{
				name: "alpha",
				path: join(browserRoot, "alpha"),
				kind: "directory",
			},
			{
				name: "Zoo",
				path: join(browserRoot, "Zoo"),
				kind: "directory",
			},
			{
				name: "notes.md",
				path: join(browserRoot, "notes.md"),
				kind: "file",
			},
		]);
	});

	test("reports Claude image support in provider capabilities", async () => {
		const response = await handleApiRequest(
			new Request("http://localhost/api/providers", {
				headers: authHeader,
			}),
		);
		expect(response.status).toBe(200);
		const body = await readJson<{
			providers: Array<{
				id: string;
				capabilities: {
					supportsImages: boolean;
				};
			}>;
		}>(response);
		expect(
			body.providers.find((provider) => provider.id === "claude")?.capabilities.supportsImages,
		).toBe(true);
	});

	test("persists create-session prompts in session history", async () => {
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
					prompt: "First prompt",
				}),
			}),
		);
		expect(createResponse.status).toBe(201);
		const createJson = await readJson<{ session: { id: string } }>(createResponse);
		const sessionId = createJson.session.id;

		const detailResponse = await handleApiRequest(
			new Request(`http://localhost/api/sessions/${sessionId}`, {
				headers: authHeader,
			}),
		);
		expect(detailResponse.status).toBe(200);
		const detail = await readJson<{
			events: Array<{
				kind: string;
				data: Record<string, unknown>;
			}>;
		}>(detailResponse);
		expect(
			detail.events
				.filter((event) => event.kind === "text" && event.data.role === "user")
				.map((event) => event.data.text),
		).toEqual(expect.arrayContaining(["First prompt"]));
	});

	test("persists sent prompts in session history", async () => {
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
					title: "Persist input",
				}),
			}),
		);
		expect(createResponse.status).toBe(201);
		const createJson = await readJson<{ session: { id: string } }>(createResponse);
		const sessionId = createJson.session.id;

		const formData = new FormData();
		formData.set("prompt", "Second prompt");

		const inputResponse = await handleApiRequest(
			new Request(`http://localhost/api/sessions/${sessionId}/input`, {
				method: "POST",
				headers: authHeader,
				body: formData,
			}),
		);
		expect(inputResponse.status).toBe(202);

		const detailResponse = await handleApiRequest(
			new Request(`http://localhost/api/sessions/${sessionId}`, {
				headers: authHeader,
			}),
		);
		expect(detailResponse.status).toBe(200);
		const detail = await readJson<{
			events: Array<{
				kind: string;
				data: Record<string, unknown>;
			}>;
		}>(detailResponse);
		expect(
			detail.events
				.filter((event) => event.kind === "text" && event.data.role === "user")
				.map((event) => event.data.text),
		).toEqual(expect.arrayContaining(["Second prompt"]));
	});

	test("archives and unarchives sessions", async () => {
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
					title: "Archive me",
				}),
			}),
		);
		expect(createResponse.status).toBe(201);
		const createJson = await readJson<{ session: { id: string; archived: boolean } }>(createResponse);
		const sessionId = createJson.session.id;
		expect(createJson.session.archived).toBe(false);

		const archiveResponse = await handleApiRequest(
			new Request(`http://localhost/api/sessions/${sessionId}/archive`, {
				method: "POST",
				headers: {
					...authHeader,
					"content-type": "application/json",
				},
				body: JSON.stringify({ archived: true }),
			}),
		);
		expect(archiveResponse.status).toBe(200);
		expect((await readJson<{ session: { archived: boolean } }>(archiveResponse)).session.archived).toBe(
			true,
		);

		const listResponse = await handleApiRequest(
			new Request("http://localhost/api/sessions", {
				headers: authHeader,
			}),
		);
		expect(listResponse.status).toBe(200);
		const listJson = await readJson<{
			sessions: Array<{
				id: string;
				archived: boolean;
			}>;
		}>(listResponse);
		expect(listJson.sessions.find((session) => session.id === sessionId)?.archived).toBe(true);

		const unarchiveResponse = await handleApiRequest(
			new Request(`http://localhost/api/sessions/${sessionId}/archive`, {
				method: "POST",
				headers: {
					...authHeader,
					"content-type": "application/json",
				},
				body: JSON.stringify({ archived: false }),
			}),
		);
		expect(unarchiveResponse.status).toBe(200);
		expect(
			(await readJson<{ session: { archived: boolean } }>(unarchiveResponse)).session.archived,
		).toBe(false);
	});

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

	test("publishes retrying session status before recovery", async () => {
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
					prompt: "trigger retry",
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
		const retryMessage = await waitForMessage(
			reader,
			streamState,
			(message) =>
				message.type === "session" &&
				message.payload.status === "retrying" &&
				message.payload.statusDetail.attempt === 2,
		);
		expect(retryMessage.type).toBe("session");
		if (retryMessage.type !== "session") {
			throw new Error("Expected session message");
		}
		expect(retryMessage.payload.statusDetail.message).toContain("429");
		expect(retryMessage.payload.statusDetail.nextRetryTime).toBeGreaterThan(Date.now());

		const recoveredMessage = await waitForMessage(
			reader,
			streamState,
			(message) =>
				message.type === "event" &&
				message.payload.kind === "text" &&
				message.payload.data.text === "Recovered.",
		);
		expect(recoveredMessage.type).toBe("event");

		await reader.cancel();
	});

	test("stores uploaded images inside the session cwd and forwards their paths", async () => {
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
					title: "Images",
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

		const imageBytes = await Bun.file(
			join(process.cwd(), "public/assets/architecture_diagram.png"),
		).arrayBuffer();
		const formData = new FormData();
		formData.set("prompt", "Tell me what you received.");
		formData.append("images", new File([imageBytes], "diagram.png", { type: "image/jpeg" }));

		const inputResponse = await handleApiRequest(
			new Request(`http://localhost/api/sessions/${sessionId}/input`, {
				method: "POST",
				headers: authHeader,
				body: formData,
			}),
		);
		expect(inputResponse.status).toBe(202);

		const streamState = { buffer: "" };
		const textMessage = await waitForMessage(
			reader,
			streamState,
			(message) =>
				message.type === "event" &&
				message.payload.kind === "text" &&
				typeof message.payload.data.text === "string" &&
				message.payload.data.text.includes(`.shelleport/uploads/${sessionId}/`),
		);
		expect(textMessage.type).toBe("event");
		if (textMessage.type !== "event") {
			throw new Error("Expected text event");
		}

		const text = String(textMessage.payload.data.text);
		expect(text).toContain("Use this image as context:");
		expect(text).toContain("Tell me what you received.");

		const uploadedPathMatch = text.match(/\/[^\s]+\.(jpg|png|gif|webp)/);
		expect(uploadedPathMatch).not.toBeNull();

		const uploadedPath = uploadedPathMatch?.[0];

		if (!uploadedPath) {
			throw new Error("Expected uploaded path");
		}

		const uploadedFile = Bun.file(uploadedPath);
		expect(await uploadedFile.exists()).toBe(true);

		await reader.cancel();
	});

	test("normalizes uploaded image format from actual bytes", async () => {
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
					title: "Normalized image",
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

		const imageBytes = await Bun.file(
			join(process.cwd(), "public/assets/architecture_diagram.png"),
		).arrayBuffer();
		const formData = new FormData();
		formData.set("prompt", "Normalize this image.");
		formData.append(
			"images",
			new File([imageBytes], "architecture_diagram.png", { type: "image/png" }),
		);

		const inputResponse = await handleApiRequest(
			new Request(`http://localhost/api/sessions/${sessionId}/input`, {
				method: "POST",
				headers: authHeader,
				body: formData,
			}),
		);
		expect(inputResponse.status).toBe(202);

		const streamState = { buffer: "" };
		const textMessage = await waitForMessage(
			reader,
			streamState,
			(message) =>
				message.type === "event" &&
				message.payload.kind === "text" &&
				typeof message.payload.data.text === "string" &&
				message.payload.data.text.includes(`.shelleport/uploads/${sessionId}/`),
		);
		expect(textMessage.type).toBe("event");
		if (textMessage.type !== "event") {
			throw new Error("Expected text event");
		}

		const text = String(textMessage.payload.data.text);
		expect(text).toContain(".jpg");

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
