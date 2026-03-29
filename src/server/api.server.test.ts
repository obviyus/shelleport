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
	  }
	| {
			type: "queued-inputs";
			payload: Array<{
				id: string;
				prompt: string;
			}>;
	  };

type SessionUsageDetailResponse = {
	session: {
		usage: Record<string, unknown> | null;
	};
	events: Array<{
		data: Record<string, unknown>;
		kind: string;
	}>;
};

const testRoot = join(Bun.env.TMPDIR ?? "/tmp", `shelleport-api-${Bun.randomUUIDv7()}`);
const fakeClaudePath = join(testRoot, "fake-claude.js");
const dataDir = join(testRoot, "data");
const authHeader = { authorization: "Bearer test-token" };

let handleApiRequest: typeof import("~/server/api.server").handleApiRequest;
let sessionBroker: typeof import("~/server/session-broker.server").sessionBroker;
let sessionStore: typeof import("~/server/store.server").sessionStore;

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

if (prompt.includes("track usage")) {
  emit({
    type: "assistant",
    message: {
      model: "claude-opus-4-6",
      content: [
        {
          type: "text",
          text: "Tracked.",
        },
      ],
      usage: {
        input_tokens: 12,
        output_tokens: 3,
        cache_read_input_tokens: 1200,
        cache_creation_input_tokens: 600,
      },
    },
  });
  emit({
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed",
      resetsAt: 1774623600,
      rateLimitType: "five_hour",
      isUsingOverage: false,
    },
  });
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Tracked.",
    stop_reason: "end_turn",
    session_id: sessionId,
    total_cost_usd: 0.045784,
    usage: {
      input_tokens: 12,
      output_tokens: 4,
      cache_read_input_tokens: 1200,
      cache_creation_input_tokens: 600,
    },
    modelUsage: {
      "claude-opus-4-6[1m]": {
        inputTokens: 12,
        outputTokens: 4,
      },
    },
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

	const auth = await import("~/server/auth.server");
	auth.setAdminToken("test-token");
	handleApiRequest = (await import("~/server/api.server")).handleApiRequest;
	sessionBroker = (await import("~/server/session-broker.server")).sessionBroker;
	sessionStore = (await import("~/server/store.server")).sessionStore;
});

afterAll(async () => {
	delete Bun.env.SHELLEPORT_CLAUDE_BIN;
	delete Bun.env.SHELLEPORT_DATA_DIR;
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

	test("reports Claude attachment support in provider capabilities", async () => {
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
					supportsAttachments: boolean;
				};
			}>;
		}>(response);
		expect(
			body.providers.find((provider) => provider.id === "claude")?.capabilities.supportsAttachments,
		).toBe(true);
	});

	test("rejects managed Claude sessions when the CLI is unavailable", async () => {
		Bun.env.SHELLEPORT_CLAUDE_BIN = join(testRoot, "missing-claude");
		try {
			const providersResponse = await handleApiRequest(
				new Request("http://localhost/api/providers", {
					headers: authHeader,
				}),
			);
			expect(providersResponse.status).toBe(200);
			const providersBody = await readJson<{
				providers: Array<{
					id: string;
					status: string;
					statusDetail: string | null;
				}>;
			}>(providersResponse);
			expect(providersBody.providers.find((provider) => provider.id === "claude")).toMatchObject({
				id: "claude",
				status: "partial",
				statusDetail: "Claude CLI not found in PATH. Install it or set SHELLEPORT_CLAUDE_BIN.",
			});

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
					}),
				}),
			);
			expect(createResponse.status).toBe(400);
			const createBody = await readJson<{ error: string }>(createResponse);
			expect(createBody.error).toBe(
				"Claude CLI not found in PATH. Install it or set SHELLEPORT_CLAUDE_BIN.",
			);
		} finally {
			Bun.env.SHELLEPORT_CLAUDE_BIN = fakeClaudePath;
		}
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

	test("auto-titles sessions from the create-session prompt", async () => {
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
					prompt: "Ship the release\nWith details below",
				}),
			}),
		);
		expect(createResponse.status).toBe(201);
		expect(await readJson<{ session: { title: string } }>(createResponse)).toMatchObject({
			session: {
				title: "Ship the release",
			},
		});
	});

	test("defaults Claude sessions to bypass permissions", async () => {
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
					title: "Bypass default",
				}),
			}),
		);
		expect(createResponse.status).toBe(201);
		expect(await readJson<{ session: { permissionMode: string } }>(createResponse)).toMatchObject({
			session: {
				permissionMode: "bypassPermissions",
			},
		});
	});

	test("allows opting Claude sessions back into approval prompts", async () => {
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
					permissionMode: "default",
					title: "Approval mode",
				}),
			}),
		);
		expect(createResponse.status).toBe(201);
		expect(await readJson<{ session: { permissionMode: string } }>(createResponse)).toMatchObject({
			session: {
				permissionMode: "default",
			},
		});
	});

	test("recovers stale running sessions after restart", async () => {
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
					title: "Recover stale run",
				}),
			}),
		);
		expect(createResponse.status).toBe(201);
		const createJson = await readJson<{ session: { id: string } }>(createResponse);
		const sessionId = createJson.session.id;

		sessionStore.updateSession(sessionId, {
			status: "running",
			statusDetail: {
				attempt: null,
				blockReason: null,
				message: null,
				nextRetryTime: null,
				waitKind: null,
			},
			pid: 4242,
		});

		sessionBroker.recoverInterruptedRuns();

		const detailResponse = await handleApiRequest(
			new Request(`http://localhost/api/sessions/${sessionId}`, {
				headers: authHeader,
			}),
		);
		expect(detailResponse.status).toBe(200);
		expect(
			await readJson<{
				session: {
					status: string;
					pid: number | null;
					statusDetail: {
						message: string | null;
					};
				};
			}>(detailResponse),
		).toMatchObject({
			session: {
				status: "interrupted",
				pid: null,
				statusDetail: {
					message: "Shelleport restarted while this run was active.",
				},
			},
		});
	});

	test("recovers stale waiting sessions without a pending request after restart", async () => {
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
					title: "Recover stale wait",
				}),
			}),
		);
		expect(createResponse.status).toBe(201);
		const createJson = await readJson<{ session: { id: string } }>(createResponse);
		const sessionId = createJson.session.id;

		sessionStore.updateSession(sessionId, {
			status: "waiting",
			statusDetail: {
				attempt: null,
				blockReason: "permission",
				message: null,
				nextRetryTime: null,
				waitKind: "approval",
			},
			pid: 4242,
		});

		sessionBroker.recoverInterruptedRuns();

		const detailResponse = await handleApiRequest(
			new Request(`http://localhost/api/sessions/${sessionId}`, {
				headers: authHeader,
			}),
		);
		expect(detailResponse.status).toBe(200);
		expect(
			await readJson<{
				session: {
					status: string;
					pid: number | null;
					statusDetail: {
						message: string | null;
						waitKind: string | null;
						blockReason: string | null;
					};
				};
			}>(detailResponse),
		).toMatchObject({
			session: {
				status: "interrupted",
				pid: null,
				statusDetail: {
					message: "Shelleport restarted while this session was waiting for input.",
					waitKind: null,
					blockReason: null,
				},
			},
		});
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

	test("auto-titles default sessions on the first sent prompt", async () => {
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
				}),
			}),
		);
		expect(createResponse.status).toBe(201);
		const createJson = await readJson<{ session: { id: string; title: string } }>(createResponse);
		expect(createJson.session.title).toBe("Claude Code session");

		const formData = new FormData();
		formData.set("prompt", "Investigate flaky test failures");

		const inputResponse = await handleApiRequest(
			new Request(`http://localhost/api/sessions/${createJson.session.id}/input`, {
				method: "POST",
				headers: authHeader,
				body: formData,
			}),
		);
		expect(inputResponse.status).toBe(202);
		expect(await readJson<{ session: { title: string } }>(inputResponse)).toMatchObject({
			session: {
				title: "Investigate flaky test failures",
			},
		});
	});

	test("does not overwrite manual session titles on sent prompts", async () => {
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
					title: "Pinned title",
				}),
			}),
		);
		expect(createResponse.status).toBe(201);
		const createJson = await readJson<{ session: { id: string } }>(createResponse);

		const formData = new FormData();
		formData.set("prompt", "Try to replace the title");

		const inputResponse = await handleApiRequest(
			new Request(`http://localhost/api/sessions/${createJson.session.id}/input`, {
				method: "POST",
				headers: authHeader,
				body: formData,
			}),
		);
		expect(inputResponse.status).toBe(202);
		expect(await readJson<{ session: { title: string } }>(inputResponse)).toMatchObject({
			session: {
				title: "Pinned title",
			},
		});
	});

	test("paginates session events from newest to oldest", async () => {
		const session = sessionBroker.createSession({
			provider: "claude",
			cwd: testRoot,
			permissionMode: "default",
		});
		if (!session) {
			throw new Error("Expected session");
		}

		for (let index = 1; index <= 5; index += 1) {
			sessionStore.appendEvent(session.id, {
				kind: "text",
				summary: `event ${index}`,
				data: {
					role: "assistant",
					text: `event ${index}`,
				},
			});
		}

		const latestResponse = await handleApiRequest(
			new Request(`http://localhost/api/sessions/${session.id}?limit=2`, {
				headers: authHeader,
			}),
		);
		expect(latestResponse.status).toBe(200);
		const latestDetail = await readJson<{
			totalEvents: number;
			events: Array<{
				sequence: number;
			}>;
		}>(latestResponse);
		expect(latestDetail.totalEvents).toBe(5);
		expect(latestDetail.events.map((event) => event.sequence)).toEqual([4, 5]);

		const olderResponse = await handleApiRequest(
			new Request(`http://localhost/api/sessions/${session.id}?before=4&limit=2`, {
				headers: authHeader,
			}),
		);
		expect(olderResponse.status).toBe(200);
		const olderDetail = await readJson<{
			totalEvents: number;
			events: Array<{
				sequence: number;
			}>;
		}>(olderResponse);
		expect(olderDetail.totalEvents).toBe(5);
		expect(olderDetail.events.map((event) => event.sequence)).toEqual([2, 3]);
	});

	test("rejects invalid event pagination parameters", async () => {
		const session = sessionBroker.createSession({
			provider: "claude",
			cwd: testRoot,
			permissionMode: "default",
		});
		if (!session) {
			throw new Error("Expected session");
		}

		const invalidBeforeResponse = await handleApiRequest(
			new Request(`http://localhost/api/sessions/${session.id}?before=nope`, {
				headers: authHeader,
			}),
		);
		expect(invalidBeforeResponse.status).toBe(400);
		expect(await readJson<{ code: string }>(invalidBeforeResponse)).toMatchObject({
			code: "invalid_before",
		});

		const invalidLimitResponse = await handleApiRequest(
			new Request(`http://localhost/api/sessions/${session.id}?limit=501`, {
				headers: authHeader,
			}),
		);
		expect(invalidLimitResponse.status).toBe(400);
		expect(await readJson<{ code: string }>(invalidLimitResponse)).toMatchObject({
			code: "invalid_limit",
		});
	});

	test("tracks Claude usage and rate limit details on the session", async () => {
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
					prompt: "track usage",
				}),
			}),
		);
		expect(createResponse.status).toBe(201);
		const createJson = await readJson<{ session: { id: string } }>(createResponse);

		let detail: SessionUsageDetailResponse | null = null;

		for (let attempt = 0; attempt < 100; attempt += 1) {
			const detailResponse = await handleApiRequest(
				new Request(`http://localhost/api/sessions/${createJson.session.id}`, {
					headers: authHeader,
				}),
			);
			expect(detailResponse.status).toBe(200);
			const nextDetail = await readJson<SessionUsageDetailResponse>(detailResponse);
			detail = nextDetail;

			const hasUsage = nextDetail.events.some((event) => typeof event.data.usage === "object");
			const hasLimit = nextDetail.events.some((event) => typeof event.data.limit === "object");

			if (hasUsage && hasLimit) {
				break;
			}

			await Bun.sleep(20);
		}

		expect(detail).not.toBeNull();
		if (!detail) {
			throw new Error("Expected session detail");
		}

		const events = detail.events;
		const usageEvent = [...events].reverse().find((event) => typeof event.data.usage === "object");
		const limitEvent = [...events].reverse().find((event) => typeof event.data.limit === "object");

		expect(usageEvent?.data.usage).toMatchObject({
			inputTokens: 12,
			outputTokens: 4,
			cacheReadInputTokens: 1200,
			cacheCreationInputTokens: 600,
			costUsd: 0.045784,
			model: "claude-opus-4-6[1m]",
		});
		expect(limitEvent?.data.limit).toMatchObject({
			status: "allowed",
			window: "five_hour",
			resetsAt: 1774623600 * 1000,
			isUsingOverage: false,
		});
		expect(detail.session.usage).toMatchObject({
			inputTokens: 12,
			outputTokens: 4,
			cacheReadInputTokens: 1200,
			cacheCreationInputTokens: 600,
			costUsd: 0.045784,
			model: "claude-opus-4-6[1m]",
		});
	});

	test("accumulates Claude usage across multiple runs in one session", async () => {
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
					prompt: "track usage",
				}),
			}),
		);
		expect(createResponse.status).toBe(201);
		const createJson = await readJson<{ session: { id: string } }>(createResponse);

		for (let attempt = 0; attempt < 100; attempt += 1) {
			const session = sessionStore.getSession(createJson.session.id);

			if (session?.status === "idle" && session.usage?.outputTokens === 4) {
				break;
			}

			await Bun.sleep(20);
		}

		const formData = new FormData();
		formData.set("prompt", "track usage");
		const inputResponse = await handleApiRequest(
			new Request(`http://localhost/api/sessions/${createJson.session.id}/input`, {
				method: "POST",
				headers: authHeader,
				body: formData,
			}),
		);
		expect(inputResponse.status).toBe(202);

		let session = sessionStore.getSession(createJson.session.id);

		for (let attempt = 0; attempt < 100; attempt += 1) {
			session = sessionStore.getSession(createJson.session.id);

			if (session?.status === "idle" && session.usage?.outputTokens === 8) {
				break;
			}

			await Bun.sleep(20);
		}

		expect(session?.usage).toMatchObject({
			inputTokens: 24,
			outputTokens: 8,
			cacheReadInputTokens: 2400,
			cacheCreationInputTokens: 1200,
			costUsd: 0.091568,
			model: "claude-opus-4-6[1m]",
		});
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
		const createJson = await readJson<{ session: { id: string; archived: boolean } }>(
			createResponse,
		);
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
		expect(
			(await readJson<{ session: { archived: boolean } }>(archiveResponse)).session.archived,
		).toBe(true);

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

	test("deletes archived sessions with full cleanup", async () => {
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
					title: "Delete me",
				}),
			}),
		);
		expect(createResponse.status).toBe(201);
		const createJson = await readJson<{ session: { id: string } }>(createResponse);
		const sessionId = createJson.session.id;

		// Cannot delete a non-archived session
		const earlyDeleteResponse = await handleApiRequest(
			new Request(`http://localhost/api/sessions/${sessionId}`, {
				method: "DELETE",
				headers: authHeader,
			}),
		);
		expect(earlyDeleteResponse.status).toBe(409);
		expect(await readJson<{ code: string }>(earlyDeleteResponse)).toMatchObject({
			code: "session_not_archived",
		});

		// Archive first
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

		const uploadedPath = join(testRoot, ".shelleport", "uploads", sessionId, "orphan.txt");
		await Bun.$`mkdir -p ${join(testRoot, ".shelleport", "uploads", sessionId)}`;
		await Bun.write(uploadedPath, "orphan");
		expect(await Bun.file(uploadedPath).exists()).toBe(true);

		// Now delete should succeed
		const deleteResponse = await handleApiRequest(
			new Request(`http://localhost/api/sessions/${sessionId}`, {
				method: "DELETE",
				headers: authHeader,
			}),
		);
		expect(deleteResponse.status).toBe(200);
		const deleteJson = await readJson<{ session: { id: string; title: string } }>(deleteResponse);
		expect(deleteJson.session.id).toBe(sessionId);

		// Session should be gone from the list
		const listResponse = await handleApiRequest(
			new Request("http://localhost/api/sessions", {
				headers: authHeader,
			}),
		);
		const listJson = await readJson<{ sessions: Array<{ id: string }> }>(listResponse);
		expect(listJson.sessions.find((session) => session.id === sessionId)).toBeUndefined();

		// Fetching the deleted session should 404
		const detailResponse = await handleApiRequest(
			new Request(`http://localhost/api/sessions/${sessionId}`, {
				headers: authHeader,
			}),
		);
		expect(detailResponse.status).toBe(404);
		expect(await Bun.file(uploadedPath).exists()).toBe(false);
	});

	test("renames and pins sessions", async () => {
		const firstResponse = await handleApiRequest(
			new Request("http://localhost/api/sessions", {
				method: "POST",
				headers: {
					...authHeader,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					provider: "claude",
					cwd: testRoot,
					title: "Alpha",
				}),
			}),
		);
		expect(firstResponse.status).toBe(201);
		const firstSession = await readJson<{ session: { id: string } }>(firstResponse);

		await Bun.sleep(5);

		const secondResponse = await handleApiRequest(
			new Request("http://localhost/api/sessions", {
				method: "POST",
				headers: {
					...authHeader,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					provider: "claude",
					cwd: testRoot,
					title: "Bravo",
				}),
			}),
		);
		expect(secondResponse.status).toBe(201);
		const secondSession = await readJson<{ session: { id: string } }>(secondResponse);

		const renameResponse = await handleApiRequest(
			new Request(`http://localhost/api/sessions/${firstSession.session.id}/meta`, {
				method: "POST",
				headers: {
					...authHeader,
					"content-type": "application/json",
				},
				body: JSON.stringify({ title: "Pinned Alpha", pinned: true }),
			}),
		);
		expect(renameResponse.status).toBe(200);
		expect(
			await readJson<{ session: { title: string; pinned: boolean } }>(renameResponse),
		).toMatchObject({
			session: {
				title: "Pinned Alpha",
				pinned: true,
			},
		});

		const listResponse = await handleApiRequest(
			new Request("http://localhost/api/sessions", {
				headers: authHeader,
			}),
		);
		expect(listResponse.status).toBe(200);
		const listJson = await readJson<{
			sessions: Array<{
				id: string;
				title: string;
				pinned: boolean;
			}>;
		}>(listResponse);
		const firstIndex = listJson.sessions.findIndex(
			(session) => session.id === firstSession.session.id,
		);
		const secondIndex = listJson.sessions.findIndex(
			(session) => session.id === secondSession.session.id,
		);
		expect(firstIndex).toBeGreaterThanOrEqual(0);
		expect(secondIndex).toBeGreaterThanOrEqual(0);
		expect(listJson.sessions[firstIndex]).toMatchObject({
			id: firstSession.session.id,
			title: "Pinned Alpha",
			pinned: true,
		});
		expect(listJson.sessions[secondIndex]).toMatchObject({
			id: secondSession.session.id,
			title: "Bravo",
			pinned: false,
		});
		expect(firstIndex).toBeLessThan(secondIndex);
	});

	test("searches sessions with fts prefixes", async () => {
		await Bun.$`mkdir -p ${join(testRoot, "alpha-workspace")} ${join(testRoot, "bravo-workspace")}`.quiet();

		const alphaResponse = await handleApiRequest(
			new Request("http://localhost/api/sessions", {
				method: "POST",
				headers: {
					...authHeader,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					provider: "claude",
					cwd: join(testRoot, "alpha-workspace"),
					title: "Refactor search index",
				}),
			}),
		);
		expect(alphaResponse.status).toBe(201);
		const alphaSession = await readJson<{ session: { id: string } }>(alphaResponse);

		const bravoResponse = await handleApiRequest(
			new Request("http://localhost/api/sessions", {
				method: "POST",
				headers: {
					...authHeader,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					provider: "claude",
					cwd: join(testRoot, "bravo-workspace"),
					title: "Pin threads",
				}),
			}),
		);
		expect(bravoResponse.status).toBe(201);
		const bravoSession = await readJson<{ session: { id: string } }>(bravoResponse);

		const searchResponse = await handleApiRequest(
			new Request("http://localhost/api/sessions?q=refac%20alpha", {
				headers: authHeader,
			}),
		);
		expect(searchResponse.status).toBe(200);
		const searchJson = await readJson<{
			sessions: Array<{
				id: string;
				title: string;
			}>;
		}>(searchResponse);
		expect(searchJson.sessions.some((session) => session.id === alphaSession.session.id)).toBe(
			true,
		);
		expect(searchJson.sessions.some((session) => session.title === "Refactor search index")).toBe(
			true,
		);
		expect(searchJson.sessions.some((session) => session.id === bravoSession.session.id)).toBe(
			false,
		);
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

	test("queues session input on the server while approval is pending", async () => {
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
		expect(
			await readJson<{
				session: {
					queuedInputCount: number;
					status: string;
				};
			}>(inputResponse),
		).toMatchObject({
			session: {
				queuedInputCount: 1,
				status: "waiting",
			},
		});

		const queuedInputsMessage = await waitForMessage(
			reader,
			streamState,
			(message) =>
				message.type === "queued-inputs" &&
				message.payload.length === 1 &&
				message.payload[0]?.prompt === "Second prompt",
		);
		expect(queuedInputsMessage.type).toBe("queued-inputs");
		if (queuedInputsMessage.type !== "queued-inputs") {
			throw new Error("Expected queued inputs");
		}

		const queuedInputId = queuedInputsMessage.payload[0]?.id;

		if (!queuedInputId) {
			throw new Error("Expected queued input id");
		}

		const updateQueuedInputResponse = await handleApiRequest(
			new Request(`http://localhost/api/sessions/${sessionId}/queued-inputs/${queuedInputId}`, {
				method: "PATCH",
				headers: {
					...authHeader,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					prompt: "Edited prompt",
				}),
			}),
		);
		expect(updateQueuedInputResponse.status).toBe(200);

		const editedQueuedInputsMessage = await waitForMessage(
			reader,
			streamState,
			(message) =>
				message.type === "queued-inputs" &&
				message.payload.length === 1 &&
				message.payload[0]?.prompt === "Edited prompt",
		);
		expect(editedQueuedInputsMessage.type).toBe("queued-inputs");

		const detailWhileQueuedResponse = await handleApiRequest(
			new Request(`http://localhost/api/sessions/${sessionId}`, {
				headers: authHeader,
			}),
		);
		expect(detailWhileQueuedResponse.status).toBe(200);
		expect(
			await readJson<{
				session: {
					queuedInputCount: number;
				};
				queuedInputs: Array<{
					prompt: string;
				}>;
				events: Array<{
					kind: string;
					data: Record<string, unknown>;
				}>;
			}>(detailWhileQueuedResponse),
		).toMatchObject({
			session: {
				queuedInputCount: 1,
			},
			queuedInputs: [{ prompt: "Edited prompt" }],
		});

		const deleteQueuedInputResponse = await handleApiRequest(
			new Request(`http://localhost/api/sessions/${sessionId}/queued-inputs/${queuedInputId}`, {
				method: "DELETE",
				headers: authHeader,
			}),
		);
		expect(deleteQueuedInputResponse.status).toBe(200);

		const emptiedQueuedInputsMessage = await waitForMessage(
			reader,
			streamState,
			(message) => message.type === "queued-inputs" && message.payload.length === 0,
		);
		expect(emptiedQueuedInputsMessage.type).toBe("queued-inputs");

		const detailAfterDeleteResponse = await handleApiRequest(
			new Request(`http://localhost/api/sessions/${sessionId}`, {
				headers: authHeader,
			}),
		);
		expect(detailAfterDeleteResponse.status).toBe(200);
		expect(
			await readJson<{
				session: {
					queuedInputCount: number;
				};
				queuedInputs: Array<{
					prompt: string;
				}>;
			}>(detailAfterDeleteResponse),
		).toMatchObject({
			session: {
				queuedInputCount: 0,
			},
			queuedInputs: [],
		});

		const finalQueuedFormData = new FormData();
		finalQueuedFormData.set("prompt", "Final queued prompt");

		const finalQueueResponse = await handleApiRequest(
			new Request(`http://localhost/api/sessions/${sessionId}/input`, {
				method: "POST",
				headers: authHeader,
				body: finalQueuedFormData,
			}),
		);
		expect(finalQueueResponse.status).toBe(202);

		const finalQueuedInputsMessage = await waitForMessage(
			reader,
			streamState,
			(message) =>
				message.type === "queued-inputs" &&
				message.payload.length === 1 &&
				message.payload[0]?.prompt === "Final queued prompt",
		);
		expect(finalQueuedInputsMessage.type).toBe("queued-inputs");

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

		const queuedPromptMessage = await waitForMessage(
			reader,
			streamState,
			(message) =>
				message.type === "event" &&
				message.payload.kind === "text" &&
				message.payload.data.role === "assistant" &&
				message.payload.data.text === "Final queued prompt",
		);
		expect(queuedPromptMessage.type).toBe("event");

		for (let attempt = 0; attempt < 100; attempt += 1) {
			const session = sessionStore.getSession(sessionId);

			if (session?.status === "idle" && session.queuedInputCount === 0) {
				break;
			}

			await Bun.sleep(20);
		}

		const detailAfterDrainResponse = await handleApiRequest(
			new Request(`http://localhost/api/sessions/${sessionId}`, {
				headers: authHeader,
			}),
		);
		expect(detailAfterDrainResponse.status).toBe(200);
		expect(
			await readJson<{
				session: {
					queuedInputCount: number;
					status: string;
				};
			}>(detailAfterDrainResponse),
		).toMatchObject({
			session: {
				queuedInputCount: 0,
				status: "idle",
			},
		});

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

	test("stores uploaded attachments inside the session cwd and forwards their paths", async () => {
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
					title: "Attachments",
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
			join(process.cwd(), "public/assets/preview.jpg"),
		).arrayBuffer();
		const formData = new FormData();
		formData.set("prompt", "Tell me what you received.");
		formData.append("attachments", new File([imageBytes], "diagram.png", { type: "image/jpeg" }));

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
			join(process.cwd(), "public/assets/preview.jpg"),
		).arrayBuffer();
		const formData = new FormData();
		formData.set("prompt", "Normalize this image.");
		formData.append("attachments", new File([imageBytes], "preview.png", { type: "image/png" }));

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

	test("stores non-image file attachments and forwards their paths", async () => {
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
					title: "File attachment",
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

		const textContent = "hello world\n";
		const formData = new FormData();
		formData.set("prompt", "Read this file.");
		formData.append("attachments", new File([textContent], "notes.txt", { type: "text/plain" }));

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
		expect(text).toContain("Use this file as context:");
		expect(text).toContain(".txt");
		expect(text).toContain("Read this file.");

		const uploadedPathMatch = text.match(/\/[^\s]+\.txt/);
		expect(uploadedPathMatch).not.toBeNull();

		const uploadedPath = uploadedPathMatch?.[0];

		if (!uploadedPath) {
			throw new Error("Expected uploaded path");
		}

		const uploadedFile = Bun.file(uploadedPath);
		expect(await uploadedFile.exists()).toBe(true);
		expect(await uploadedFile.text()).toBe(textContent);

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

	test("rejects too many attachments", async () => {
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
					title: "Too many attachments",
				}),
			}),
		);
		expect(createResponse.status).toBe(201);
		const createJson = await readJson<{ session: { id: string } }>(createResponse);
		const sessionId = createJson.session.id;

		const formData = new FormData();
		formData.set("prompt", "Too many files.");
		for (let i = 0; i < 11; i++) {
			formData.append(
				"attachments",
				new File([`content-${i}`], `file-${i}.txt`, { type: "text/plain" }),
			);
		}

		const inputResponse = await handleApiRequest(
			new Request(`http://localhost/api/sessions/${sessionId}/input`, {
				method: "POST",
				headers: authHeader,
				body: formData,
			}),
		);
		expect(inputResponse.status).toBe(400);
		expect(await inputResponse.json()).toMatchObject({
			code: "too_many_attachments",
		});
	});

	test("rejects oversized attachment", async () => {
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
					title: "Oversized attachment",
				}),
			}),
		);
		expect(createResponse.status).toBe(201);
		const createJson = await readJson<{ session: { id: string } }>(createResponse);
		const sessionId = createJson.session.id;

		const formData = new FormData();
		formData.set("prompt", "Big file.");
		const oversizedBuffer = new Uint8Array(25 * 1024 * 1024 + 1);
		formData.append(
			"attachments",
			new File([oversizedBuffer], "huge.bin", { type: "application/octet-stream" }),
		);

		const inputResponse = await handleApiRequest(
			new Request(`http://localhost/api/sessions/${sessionId}/input`, {
				method: "POST",
				headers: authHeader,
				body: formData,
			}),
		);
		expect(inputResponse.status).toBe(400);
		expect(await inputResponse.json()).toMatchObject({
			code: "attachment_too_large",
		});
	});

	test("rejects attachments exceeding total size limit", async () => {
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
					title: "Total size exceeded",
				}),
			}),
		);
		expect(createResponse.status).toBe(201);
		const createJson = await readJson<{ session: { id: string } }>(createResponse);
		const sessionId = createJson.session.id;

		const formData = new FormData();
		formData.set("prompt", "Multiple large files.");
		// 3 files at 20 MB each = 60 MB, exceeding the 50 MB total limit
		const largeBuffer = new Uint8Array(20 * 1024 * 1024);
		for (let i = 0; i < 3; i++) {
			formData.append(
				"attachments",
				new File([largeBuffer], `large-${i}.bin`, { type: "application/octet-stream" }),
			);
		}

		const inputResponse = await handleApiRequest(
			new Request(`http://localhost/api/sessions/${sessionId}/input`, {
				method: "POST",
				headers: authHeader,
				body: formData,
			}),
		);
		expect(inputResponse.status).toBe(400);
		const json = await inputResponse.json();
		expect(json.code).toBe("attachments_total_too_large");
	});
});
