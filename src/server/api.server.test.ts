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
					kind: string;
					blockReason: string | null;
					prompt: string;
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
				kind: string;
				blockReason: string | null;
				prompt: string;
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
const fakeCodexPath = join(testRoot, "fake-codex.js");
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
const emit = (payload) => console.log(JSON.stringify(payload));
emit({
  type: "system",
  subtype: "init",
  cwd: process.cwd(),
  session_id: sessionId,
});
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
let pendingRequest = null;
let persistentSession = false;
let interruptibleSession = false;
let interruptTimer = null;

function getPrompt(message) {
  const content = message?.message?.content;
  return typeof content === "string" ? content : "";
}

function emitSimpleResult(text) {
  emit({
    type: "assistant",
    message: {
      content: [
        {
          type: "text",
          text,
        },
      ],
    },
  });
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    stop_reason: "end_turn",
    session_id: sessionId,
    permission_denials: [],
  });
}

function finish(text, linger = false) {
  emitSimpleResult(text);
  if (!linger) {
    process.exit(0);
  }
}

rl.on("close", () => {
  process.exit(0);
});

rl.on("line", (line) => {
  const message = JSON.parse(line);

  if (message.type === "control_request" && message.request?.subtype === "interrupt") {
    if (interruptTimer) {
      clearTimeout(interruptTimer);
      interruptTimer = null;
    }

    if (interruptibleSession) {
      emit({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: null,
        stop_reason: null,
        session_id: sessionId,
        total_cost_usd: 0,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        modelUsage: {},
        permission_denials: [],
        errors: ["interrupted"],
      });
      return;
    }

    if (pendingRequest) {
      emit({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Interrupted.",
        stop_reason: "end_turn",
        session_id: sessionId,
        permission_denials: [],
      });
      process.exit(0);
    }
  }

  if (pendingRequest) {
    if (message.type !== "control_response") {
      return;
    }

    const activeRequest = pendingRequest;
    pendingRequest = null;
    const behavior = message.response?.response?.behavior;

    if (behavior !== "allow") {
      emitSimpleResult("Denied.");
      process.exit(0);
    }

    if (activeRequest === "approval") {
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
      finish("Done.");
      return;
    }

    finish("Answered.");
    return;
  }

  if (message.type !== "user") {
    return;
  }

  const prompt = getPrompt(message);

  if (prompt.includes("git commit")) {
    pendingRequest = "approval";
    emit({
      type: "control_request",
      request_id: "req-1",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: {
          command: "git commit --allow-empty -m test",
          description: "Create empty commit with message test",
        },
        tool_use_id: "tool-1",
      },
    });
    return;
  }

  if (prompt.includes("ask me a question")) {
    pendingRequest = "question";
    emit({
      type: "control_request",
      request_id: "req-2",
      request: {
        subtype: "confirm",
        prompt: "Claude needs confirmation to continue.",
      },
    });
    return;
  }

  if (prompt.includes("trigger retry")) {
    emit({
      type: "progress",
      data: {
        toolUseResult: "Request failed with status code 429, retrying in 7s (attempt 2)",
      },
    });
    finish("Recovered.");
    return;
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
    return;
  }

  if (prompt.includes("stay open across turns")) {
    persistentSession = true;
    emitSimpleResult("First turn.");
    return;
  }

  if (prompt.includes("interrupt me")) {
    interruptibleSession = true;
    emit({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "text_delta",
          text: "Working...",
        },
      },
      session_id: sessionId,
    });
    interruptTimer = setTimeout(() => {
      interruptTimer = null;
      emitSimpleResult("Too late.");
    }, 1_000);
    return;
  }

  if (persistentSession) {
    emitSimpleResult(\`Echo: \${prompt}\`);
    process.exit(0);
    return;
  }

  if (interruptibleSession) {
    emitSimpleResult(\`After interrupt: \${prompt}\`);
    process.exit(0);
    return;
  }

  if (prompt.includes("linger after result")) {
    finish("Lingered.", true);
    return;
  }

  finish(prompt);
});
`,
	);
	await Bun.$`chmod +x ${fakeClaudePath}`.quiet();
	await Bun.write(
		fakeCodexPath,
		`#!/usr/bin/env bun
const readline = require("node:readline");

const args = process.argv.slice(2);

if (args[0] === "--version") {
  console.log("codex 0.0.0-test");
  process.exit(0);
}

const rl = readline.createInterface({ input: process.stdin });
const emit = (payload) => console.log(JSON.stringify(payload));
const notify = (method, params) => emit({ method, params });
const respond = (id, result) => emit({ id, result });

let threadId = "fake-codex-thread";
let activeTurnId = null;
let pendingApprovalId = null;
let pendingItemId = null;
let interruptTimer = null;

function createThread() {
  return {
    id: threadId,
    preview: "",
    ephemeral: false,
    modelProvider: "openai",
    createdAt: 1774965391,
    updatedAt: 1774965391,
    status: { type: "idle" },
    path: \`/tmp/\${threadId}.jsonl\`,
    cwd: process.cwd(),
    cliVersion: "0.0.0-test",
    source: "appServer",
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  };
}

function createTurn(status = "inProgress", error = null) {
  return {
    id: activeTurnId,
    items: [],
    status,
    error,
  };
}

function readPrompt(params) {
  const input = Array.isArray(params?.input) ? params.input : [];
  const textEntry = input.find(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      entry.type === "text" &&
      typeof entry.text === "string",
  );
  return typeof textEntry?.text === "string" ? textEntry.text : "";
}

function completeTurn(text) {
  const reasoningId = \`rs-\${activeTurnId}\`;
  const messageId = \`msg-\${activeTurnId}\`;
  notify("item/started", {
    threadId,
    turnId: activeTurnId,
    item: {
      type: "reasoning",
      id: reasoningId,
      summary: [],
      content: [],
    },
  });
  notify("item/reasoning/summaryTextDelta", {
    threadId,
    turnId: activeTurnId,
    itemId: reasoningId,
    delta: "Thinking.\\n",
    summaryIndex: 0,
  });
  notify("item/completed", {
    threadId,
    turnId: activeTurnId,
    item: {
      type: "reasoning",
      id: reasoningId,
      summary: ["Thinking.\\n"],
      content: [],
    },
  });
  notify("item/started", {
    threadId,
    turnId: activeTurnId,
    item: {
      type: "agentMessage",
      id: messageId,
      text: "",
      phase: "final_answer",
      memoryCitation: null,
    },
  });
  notify("item/agentMessage/delta", {
    threadId,
    turnId: activeTurnId,
    itemId: messageId,
    delta: "Echo: ",
  });
  notify("item/agentMessage/delta", {
    threadId,
    turnId: activeTurnId,
    itemId: messageId,
    delta: text,
  });
  notify("item/completed", {
    threadId,
    turnId: activeTurnId,
    item: {
      type: "agentMessage",
      id: messageId,
      text: \`Echo: \${text}\`,
      phase: "final_answer",
      memoryCitation: null,
    },
  });
  notify("thread/tokenUsage/updated", {
    threadId,
    turnId: activeTurnId,
    tokenUsage: {
      total: {
        totalTokens: 10,
        inputTokens: 6,
        cachedInputTokens: 1,
        outputTokens: 3,
        reasoningOutputTokens: 1,
      },
      last: {
        totalTokens: 10,
        inputTokens: 6,
        cachedInputTokens: 1,
        outputTokens: 3,
        reasoningOutputTokens: 1,
      },
      modelContextWindow: 1000,
    },
  });
  notify("turn/completed", {
    threadId,
    turn: createTurn("completed"),
  });
  activeTurnId = null;
}

rl.on("close", () => process.exit(0));

rl.on("line", (line) => {
  const message = JSON.parse(line);

  if (pendingApprovalId && message.id === pendingApprovalId) {
    notify("serverRequest/resolved", {
      threadId,
      requestId: pendingApprovalId,
    });

    if (message.result?.decision === "accept") {
      notify("item/completed", {
        threadId,
        turnId: activeTurnId,
        item: {
          type: "commandExecution",
          id: pendingItemId,
          command: "bun test",
          cwd: process.cwd(),
          processId: null,
          source: "model",
          status: "completed",
          commandActions: [],
          aggregatedOutput: "tests passed",
          exitCode: 0,
          durationMs: 12,
        },
      });
      pendingApprovalId = null;
      pendingItemId = null;
      completeTurn("Approved.");
      return;
    }

    notify("item/completed", {
      threadId,
      turnId: activeTurnId,
      item: {
        type: "commandExecution",
        id: pendingItemId,
        command: "bun test",
        cwd: process.cwd(),
        processId: null,
        source: "model",
        status: "declined",
        commandActions: [],
        aggregatedOutput: "",
        exitCode: null,
        durationMs: null,
      },
    });
    notify("turn/completed", {
      threadId,
      turn: createTurn("completed"),
    });
    pendingApprovalId = null;
    pendingItemId = null;
    activeTurnId = null;
    return;
  }

  if (message.method === "initialize") {
    respond(message.id, {
      userAgent: "fake-codex",
      codexHome: "/tmp/.codex",
      platformFamily: "unix",
      platformOs: "macos",
    });
    return;
  }

  if (message.method === "initialized") {
    return;
  }

  if (message.method === "thread/start") {
    respond(message.id, {
      thread: createThread(),
      model: "gpt-5.4",
      modelProvider: "openai",
      serviceTier: null,
      cwd: process.cwd(),
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: {
        type: "workspaceWrite",
        writableRoots: [],
        readOnlyAccess: { type: "fullAccess" },
        networkAccess: true,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
      reasoningEffort: "high",
    });
    notify("thread/started", { thread: createThread() });
    return;
  }

  if (message.method === "thread/resume") {
    threadId = message.params?.threadId ?? threadId;
    respond(message.id, {
      thread: createThread(),
      model: "gpt-5.4",
      modelProvider: "openai",
      serviceTier: null,
      cwd: process.cwd(),
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: {
        type: "workspaceWrite",
        writableRoots: [],
        readOnlyAccess: { type: "fullAccess" },
        networkAccess: true,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
      reasoningEffort: "high",
    });
    return;
  }

  if (message.method === "turn/start") {
    activeTurnId = \`turn-\${Date.now()}\`;
    respond(message.id, { turn: createTurn("inProgress") });
    notify("turn/started", { threadId, turn: createTurn("inProgress") });
    const prompt = readPrompt(message.params);

    if (prompt.includes("need approval")) {
      pendingApprovalId = \`req-\${activeTurnId}\`;
      pendingItemId = \`cmd-\${activeTurnId}\`;
      notify("item/started", {
        threadId,
        turnId: activeTurnId,
        item: {
          type: "commandExecution",
          id: pendingItemId,
          command: "bun test",
          cwd: process.cwd(),
          processId: null,
          source: "model",
          status: "inProgress",
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      });
      emit({
        id: pendingApprovalId,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId,
          turnId: activeTurnId,
          itemId: pendingItemId,
          reason: "Run tests",
          command: "bun test",
          cwd: process.cwd(),
        },
      });
      return;
    }

    if (prompt.includes("interrupt me")) {
      pendingItemId = \`cmd-\${activeTurnId}\`;
      notify("item/started", {
        threadId,
        turnId: activeTurnId,
        item: {
          type: "commandExecution",
          id: pendingItemId,
          command: "sleep 30",
          cwd: process.cwd(),
          processId: null,
          source: "model",
          status: "inProgress",
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      });
      interruptTimer = setTimeout(() => {
        interruptTimer = null;
        notify("item/completed", {
          threadId,
          turnId: activeTurnId,
          item: {
            type: "commandExecution",
            id: pendingItemId,
            command: "sleep 30",
            cwd: process.cwd(),
            processId: null,
            source: "model",
            status: "completed",
            commandActions: [],
            aggregatedOutput: "too late",
            exitCode: 0,
            durationMs: 1000,
          },
        });
        notify("turn/completed", {
          threadId,
          turn: createTurn("completed"),
        });
        pendingItemId = null;
        activeTurnId = null;
      }, 1000);
      return;
    }

    completeTurn(prompt);
    return;
  }

  if (message.method === "turn/interrupt") {
    if (interruptTimer) {
      clearTimeout(interruptTimer);
      interruptTimer = null;
    }

    respond(message.id, {});
    notify("turn/completed", {
      threadId,
      turn: createTurn("interrupted"),
    });
    pendingItemId = null;
    activeTurnId = null;
  }
});
`,
	);
	await Bun.$`chmod +x ${fakeCodexPath}`.quiet();

	Bun.env.SHELLEPORT_CLAUDE_BIN = fakeClaudePath;
	Bun.env.SHELLEPORT_CODEX_BIN = fakeCodexPath;
	Bun.env.SHELLEPORT_DATA_DIR = dataDir;

	const auth = await import("~/server/auth.server");
	auth.setAdminToken("test-token");
	handleApiRequest = (await import("~/server/api.server")).handleApiRequest;
	sessionBroker = (await import("~/server/session-broker.server")).sessionBroker;
	sessionStore = (await import("~/server/store.server")).sessionStore;
});

afterAll(async () => {
	delete Bun.env.SHELLEPORT_CLAUDE_BIN;
	delete Bun.env.SHELLEPORT_CODEX_BIN;
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

	test("reports Codex managed session support in provider capabilities", async () => {
		const response = await handleApiRequest(
			new Request("http://localhost/api/providers", {
				headers: authHeader,
			}),
		);
		expect(response.status).toBe(200);
		const body = await readJson<{
			providers: Array<{
				capabilities: {
					canCreate: boolean;
					supportsApprovals: boolean;
				};
				id: string;
				status: string;
			}>;
		}>(response);
		expect(body.providers.find((provider) => provider.id === "codex")).toMatchObject({
			id: "codex",
			status: "ready",
			capabilities: {
				canCreate: true,
				supportsApprovals: true,
			},
		});
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

	test("streams Codex assistant deltas and records usage", async () => {
		const createResponse = await handleApiRequest(
			new Request("http://localhost/api/sessions", {
				method: "POST",
				headers: {
					...authHeader,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					provider: "codex",
					cwd: testRoot,
				}),
			}),
		);
		expect(createResponse.status).toBe(201);
		const createBody = await readJson<{ session: { id: string } }>(createResponse);
		const sessionId = createBody.session.id;

		const streamResponse = await handleApiRequest(
			new Request(`http://localhost/api/sessions/${sessionId}/events`, {
				headers: authHeader,
			}),
		);
		expect(streamResponse.status).toBe(200);
		const reader = streamResponse.body!.getReader();
		const state = { buffer: "" };
		const snapshot = await nextSseMessage(reader, state);
		expect(snapshot.type).toBe("snapshot");

		const formData = new FormData();
		formData.set("prompt", "hello codex");
		const inputResponse = await handleApiRequest(
			new Request(`http://localhost/api/sessions/${sessionId}/input`, {
				method: "POST",
				headers: authHeader,
				body: formData,
			}),
		);
		expect(inputResponse.status).toBe(202);

		const firstDelta = await waitForMessage(
			reader,
			state,
			(message) =>
				message.type === "event" &&
				message.payload.kind === "text" &&
				message.payload.data.role === "assistant" &&
				message.payload.data.text === "Echo: ",
		);
		if (firstDelta.type !== "event") {
			throw new Error("Expected assistant delta event");
		}

		const secondDelta = await waitForMessage(
			reader,
			state,
			(message) =>
				message.type === "event" &&
				message.payload.kind === "text" &&
				message.payload.data.role === "assistant" &&
				message.payload.data.text === "hello codex",
		);
		if (secondDelta.type !== "event") {
			throw new Error("Expected assistant delta event");
		}

		await waitForMessage(
			reader,
			state,
			(message) => message.type === "session" && message.payload.status === "idle",
		);
		reader.releaseLock();

		const detail = sessionBroker.getSessionDetail(sessionId);
		expect(detail).not.toBeNull();
		if (!detail) {
			throw new Error("Expected session detail");
		}

		expect(detail.session.providerSessionRef).toBe("fake-codex-thread");
		expect(
			detail.events.some(
				(event) => event.kind === "text" && event.data.role === "thinking",
			),
		).toBe(true);
		expect(detail.session.usage).toMatchObject({
			inputTokens: 6,
			outputTokens: 4,
			cacheReadInputTokens: 1,
			cacheCreationInputTokens: 0,
			costUsd: null,
			model: "gpt-5.4",
		});
	});

	test("handles Codex approval requests inline", async () => {
		const createResponse = await handleApiRequest(
			new Request("http://localhost/api/sessions", {
				method: "POST",
				headers: {
					...authHeader,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					provider: "codex",
					cwd: testRoot,
				}),
			}),
		);
		expect(createResponse.status).toBe(201);
		const createBody = await readJson<{ session: { id: string } }>(createResponse);
		const sessionId = createBody.session.id;

		const streamResponse = await handleApiRequest(
			new Request(`http://localhost/api/sessions/${sessionId}/events`, {
				headers: authHeader,
			}),
		);
		expect(streamResponse.status).toBe(200);
		const reader = streamResponse.body!.getReader();
		const state = { buffer: "" };
		await nextSseMessage(reader, state);

		const formData = new FormData();
		formData.set("prompt", "need approval");
		const inputResponse = await handleApiRequest(
			new Request(`http://localhost/api/sessions/${sessionId}/input`, {
				method: "POST",
				headers: authHeader,
				body: formData,
			}),
		);
		expect(inputResponse.status).toBe(202);

		const approvalMessage = await waitForMessage(
			reader,
			state,
			(message) => message.type === "request" && message.payload.kind === "approval",
		);
		if (approvalMessage.type !== "request") {
			throw new Error("Expected approval request");
		}
		expect(approvalMessage.payload.data.toolUseId).toContain("cmd-");

		const approvalResponse = await handleApiRequest(
			new Request(`http://localhost/api/requests/${approvalMessage.payload.id}/respond`, {
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
		expect(approvalResponse.status).toBe(200);

		const toolResultMessage = await waitForMessage(
			reader,
			state,
			(message) =>
				message.type === "event" &&
				message.payload.kind === "tool-result" &&
				message.payload.data.output === "tests passed",
		);
		if (toolResultMessage.type !== "event") {
			throw new Error("Expected tool result");
		}

		await waitForMessage(
			reader,
			state,
			(message) => message.type === "session" && message.payload.status === "idle",
		);
		reader.releaseLock();

		const detail = sessionBroker.getSessionDetail(sessionId);
		expect(detail).not.toBeNull();
		if (!detail) {
			throw new Error("Expected session detail");
		}

		expect(detail.pendingRequests.every((request) => request.status !== "pending")).toBe(true);
		expect(
			detail.events.some(
				(event) =>
					event.kind === "tool-result" && event.data.output === "tests passed",
			),
		).toBe(true);
	});

	test("interrupts Codex turns through app-server control", async () => {
		const createResponse = await handleApiRequest(
			new Request("http://localhost/api/sessions", {
				method: "POST",
				headers: {
					...authHeader,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					provider: "codex",
					cwd: testRoot,
				}),
			}),
		);
		expect(createResponse.status).toBe(201);
		const createBody = await readJson<{ session: { id: string } }>(createResponse);
		const sessionId = createBody.session.id;

		const streamResponse = await handleApiRequest(
			new Request(`http://localhost/api/sessions/${sessionId}/events`, {
				headers: authHeader,
			}),
		);
		expect(streamResponse.status).toBe(200);
		const reader = streamResponse.body!.getReader();
		const state = { buffer: "" };
		await nextSseMessage(reader, state);

		const formData = new FormData();
		formData.set("prompt", "interrupt me");
		const inputResponse = await handleApiRequest(
			new Request(`http://localhost/api/sessions/${sessionId}/input`, {
				method: "POST",
				headers: authHeader,
				body: formData,
			}),
		);
		expect(inputResponse.status).toBe(202);

		await waitForMessage(
			reader,
			state,
			(message) =>
				message.type === "event" &&
				message.payload.kind === "tool-call" &&
				message.payload.data.toolName === "Bash",
		);

		const interruptResponse = await handleApiRequest(
			new Request(`http://localhost/api/sessions/${sessionId}/control`, {
				method: "POST",
				headers: {
					...authHeader,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					action: "interrupt",
				}),
			}),
		);
		expect(interruptResponse.status).toBe(200);

		await waitForMessage(
			reader,
			state,
			(message) => message.type === "session" && message.payload.status === "interrupted",
		);
		reader.releaseLock();

		const detail = sessionBroker.getSessionDetail(sessionId);
		expect(detail).not.toBeNull();
		if (!detail) {
			throw new Error("Expected session detail");
		}

		expect(detail.session.status).toBe("interrupted");
		expect(
			detail.events.some(
				(event) => event.kind === "system" && event.summary === "Session interrupted",
			),
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

	test("preserves accumulated cost when active usage has null costUsd", () => {
		const session = sessionStore.createSession({
			provider: "claude",
			title: "track usage",
			cwd: testRoot,
			permissionMode: "bypassPermissions",
			allowedTools: [],
		});

		sessionStore.updateSessionUsage(session.id, {
			inputTokens: 12,
			outputTokens: 4,
			cacheReadInputTokens: 1200,
			cacheCreationInputTokens: 600,
			costUsd: 0.045784,
			model: "claude-opus-4-6[1m]",
		});
		sessionStore.resetSessionUsageProgress(session.id);

		sessionStore.updateSessionUsage(session.id, {
			inputTokens: 1,
			outputTokens: 2,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			costUsd: null,
			model: "claude-opus-4-6[1m]",
		});

		const nextSession = sessionStore.resetSessionUsageProgress(session.id);

		expect(nextSession?.usage).toMatchObject({
			inputTokens: 13,
			outputTokens: 6,
			cacheReadInputTokens: 1200,
			cacheCreationInputTokens: 600,
			costUsd: 0.045784,
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

	test("deletes archived sessions through the sessions API route", async () => {
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

		const activeDeleteResponse = await handleApiRequest(
			new Request(`http://localhost/api/sessions/${sessionId}`, {
				method: "DELETE",
				headers: authHeader,
			}),
		);
		expect(activeDeleteResponse.status).toBe(409);

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

		const deleteResponse = await handleApiRequest(
			new Request(`http://localhost/api/sessions/${sessionId}`, {
				method: "DELETE",
				headers: authHeader,
			}),
		);
		expect(deleteResponse.status).toBe(200);
		expect(sessionStore.getSession(sessionId)).toBeNull();
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
			protocolFrames: Array<{
				direction: string;
				frame: Record<string, unknown>;
			}>;
		}>(detailResponse);
		expect(detail.session.status).toBe("idle");
		expect(detail.session.allowedTools).toEqual([]);
		expect(detail.pendingRequests).toHaveLength(0);
		expect(
			detail.protocolFrames.map((frame) => ({
				direction: frame.direction,
				type: frame.frame.type,
			})),
		).toEqual(
			expect.arrayContaining([
				{ direction: "out", type: "user" },
				{ direction: "in", type: "control_request" },
				{ direction: "out", type: "control_response" },
				{ direction: "in", type: "assistant" },
				{ direction: "in", type: "result" },
			]),
		);

		await reader.cancel();
	});

	test("finishes sessions when Claude keeps the process open after a terminal result", async () => {
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
					prompt: "linger after result",
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
		const lingeredMessage = await waitForMessage(
			reader,
			streamState,
			(message) =>
				message.type === "event" &&
				message.payload.kind === "text" &&
				message.payload.data.text === "Lingered.",
		);
		expect(lingeredMessage.type).toBe("event");

		const idleMessage = await waitForMessage(
			reader,
			streamState,
			(message) => message.type === "session" && message.payload.status === "idle",
		);
		expect(idleMessage.type).toBe("session");

		await reader.cancel();
	});

	test("reuses a persistent Claude child across turns", async () => {
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
					prompt: "stay open across turns",
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
		const firstTurnMessage = await waitForMessage(
			reader,
			streamState,
			(message) =>
				message.type === "event" &&
				message.payload.kind === "text" &&
				message.payload.data.text === "First turn.",
		);
		expect(firstTurnMessage.type).toBe("event");

		const firstIdleMessage = await waitForMessage(
			reader,
			streamState,
			(message) => message.type === "session" && message.payload.status === "idle",
		);
		expect(firstIdleMessage.type).toBe("session");

		const formData = new FormData();
		formData.set("prompt", "second turn");
		const inputResponse = await handleApiRequest(
			new Request(`http://localhost/api/sessions/${sessionId}/input`, {
				method: "POST",
				headers: authHeader,
				body: formData,
			}),
		);
		expect(inputResponse.status).toBe(202);

		const secondTurnMessage = await waitForMessage(
			reader,
			streamState,
			(message) =>
				message.type === "event" &&
				message.payload.kind === "text" &&
				message.payload.data.text === "Echo: second turn",
		);
		expect(secondTurnMessage.type).toBe("event");

		const detailResponse = await handleApiRequest(
			new Request(`http://localhost/api/sessions/${sessionId}`, {
				headers: authHeader,
			}),
		);
		expect(detailResponse.status).toBe(200);
		const detail = await readJson<{
			protocolFrames: Array<{
				frame: Record<string, unknown>;
			}>;
		}>(detailResponse);
		expect(detail.protocolFrames.filter((frame) => frame.frame.type === "system")).toHaveLength(1);

		await reader.cancel();
	});

	test("interrupts a persistent Claude run without failing the session", async () => {
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
					prompt: "interrupt me",
				}),
			}),
		);
		expect(createResponse.status).toBe(201);
		const createJson = await readJson<{ session: { id: string } }>(createResponse);
		const sessionId = createJson.session.id;

		const interruptResponse = await handleApiRequest(
			new Request(`http://localhost/api/sessions/${sessionId}/control`, {
				method: "POST",
				headers: {
					...authHeader,
					"content-type": "application/json",
				},
				body: JSON.stringify({ action: "interrupt" }),
			}),
		);
		expect(interruptResponse.status).toBe(200);

		let interruptedDetail: {
			session: { providerSessionRef: string | null; status: string };
			events: Array<{ kind: string }>;
		} | null = null;

		for (let attempt = 0; attempt < 20; attempt += 1) {
			const detailResponse = await handleApiRequest(
				new Request(`http://localhost/api/sessions/${sessionId}`, {
					headers: authHeader,
				}),
			);
			expect(detailResponse.status).toBe(200);
			const detail = await readJson<{
				session: { providerSessionRef: string | null; status: string };
				events: Array<{ kind: string }>;
			}>(detailResponse);

			if (detail.session.status === "interrupted") {
				interruptedDetail = detail;
				break;
			}

			await Bun.sleep(50);
		}

		if (!interruptedDetail) {
			throw new Error("Session did not interrupt");
		}

		const providerSessionRef = interruptedDetail.session.providerSessionRef;
		expect(interruptedDetail.session.status).toBe("interrupted");
		expect(providerSessionRef).not.toBeNull();
		expect(interruptedDetail.events.some((event) => event.kind === "error")).toBe(false);

		const formData = new FormData();
		formData.set("prompt", "after interrupt");
		const inputResponse = await handleApiRequest(
			new Request(`http://localhost/api/sessions/${sessionId}/input`, {
				method: "POST",
				headers: authHeader,
				body: formData,
			}),
		);
		expect(inputResponse.status).toBe(202);

		let resumedDetail: {
			session: { providerSessionRef: string | null; status: string };
			protocolFrames: Array<{ direction: string; frame: Record<string, unknown> }>;
			events: Array<{ kind: string; data: Record<string, unknown> }>;
		} | null = null;

		for (let attempt = 0; attempt < 40; attempt += 1) {
			const resumedDetailResponse = await handleApiRequest(
				new Request(`http://localhost/api/sessions/${sessionId}`, {
					headers: authHeader,
				}),
			);
			expect(resumedDetailResponse.status).toBe(200);
			const detail = await readJson<{
				session: { providerSessionRef: string | null; status: string };
				protocolFrames: Array<{ direction: string; frame: Record<string, unknown> }>;
				events: Array<{ kind: string; data: Record<string, unknown> }>;
			}>(resumedDetailResponse);

			if (
				detail.session.status === "idle" &&
				detail.events.some(
					(event) =>
						event.kind === "state" && event.data.result === "After interrupt: after interrupt",
				)
			) {
				resumedDetail = detail;
				break;
			}

			await Bun.sleep(50);
		}

		if (!resumedDetail) {
			throw new Error("Session did not resume after interrupt");
		}

		expect(resumedDetail.session.status).toBe("idle");
		expect(resumedDetail.session.providerSessionRef).toBe(providerSessionRef);
		expect(
			resumedDetail.protocolFrames.some((frame) => {
				const request =
					frame.frame.request && typeof frame.frame.request === "object"
						? frame.frame.request
						: null;

				return (
					frame.direction === "out" &&
					frame.frame.type === "control_request" &&
					request !== null &&
					"subtype" in request &&
					request.subtype === "interrupt"
				);
			}),
		).toBe(true);
	});

	test("maps generic Claude control requests into pending questions", async () => {
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
					prompt: "Please ask me a question before continuing",
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
		const questionMessage = await waitForMessage(
			reader,
			streamState,
			(message) =>
				(message.type === "request" && message.payload.status === "pending") ||
				(message.type === "snapshot" && message.payload.pendingRequests.length > 0),
		);

		let pendingRequest: {
			id: string;
			kind: string;
			blockReason: string | null;
			prompt: string;
			status: string;
			data: Record<string, unknown>;
		} | null = null;

		if (questionMessage.type === "request") {
			pendingRequest = questionMessage.payload;
		}

		if (questionMessage.type === "snapshot") {
			pendingRequest = questionMessage.payload.pendingRequests[0] ?? null;
		}

		if (!pendingRequest) {
			throw new Error("Expected pending request");
		}

		expect(pendingRequest.kind).toBe("question");
		expect(pendingRequest.blockReason).toBe(null);
		expect(pendingRequest.prompt).toBe("Claude needs confirmation to continue.");
		expect(pendingRequest.data.subtype).toBe("confirm");

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

		const answeredMessage = await waitForMessage(
			reader,
			streamState,
			(message) =>
				message.type === "event" &&
				message.payload.kind === "text" &&
				message.payload.data.text === "Answered.",
		);
		expect(answeredMessage.type).toBe("event");

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

	test("rate-limits login attempts after threshold", async () => {
		const { checkLoginRateLimit, recordFailedLoginAttempt, resetLoginRateLimit, setAdminToken } =
			await import("~/server/auth.server");

		// Exhaust the rate limit bucket from a unique IP
		const ip = `10.99.99.${Math.floor(Math.random() * 200)}`;
		const makeRequest = () =>
			new Request("http://localhost/api/auth/session", {
				method: "POST",
				headers: { "x-forwarded-for": ip, "content-type": "application/json" },
				body: JSON.stringify({ token: "wrong" }),
			});

		// First 10 attempts should pass the rate limit check
		for (let i = 0; i < 10; i++) {
			expect(() => checkLoginRateLimit(makeRequest())).not.toThrow();
			recordFailedLoginAttempt(makeRequest());
		}

		// 11th should be rejected
		expect(() => checkLoginRateLimit(makeRequest())).toThrow();

		resetLoginRateLimit(makeRequest());

		const token = setAdminToken("known-good-token");
		const successResponse = await handleApiRequest(
			new Request("http://localhost/api/auth/session", {
				method: "POST",
				headers: { "x-forwarded-for": ip, "content-type": "application/json" },
				body: JSON.stringify({ token }),
			}),
		);
		expect(successResponse.status).toBe(200);

		expect(() => checkLoginRateLimit(makeRequest())).not.toThrow();
		setAdminToken("test-token");
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

	test("rejects create-session effort that does not match the selected model", async () => {
		const response = await handleApiRequest(
			new Request("http://localhost/api/sessions", {
				method: "POST",
				headers: {
					...authHeader,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					provider: "claude",
					cwd: testRoot,
					model: "haiku",
					effort: "medium",
				}),
			}),
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			code: "invalid_effort",
		});
	});

	test("rejects model changes that leave an existing session with invalid effort", async () => {
		const session = sessionStore.createSession({
			provider: "claude",
			cwd: testRoot,
			title: "Needs clamp",
			model: "opus",
			effort: "max",
			permissionMode: "default",
			allowedTools: [],
		});

		const response = await handleApiRequest(
			new Request(`http://localhost/api/sessions/${session.id}/meta`, {
				method: "POST",
				headers: {
					...authHeader,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					model: "sonnet",
				}),
			}),
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			code: "invalid_effort",
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
