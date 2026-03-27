import { readdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type {
	CreateSessionInput,
	DirectoryListing,
	ImportSessionPayload,
	RequestResponsePayload,
	SessionArchivePayload,
	SessionControlPayload,
	SessionInputPayload,
	SessionStreamMessage,
} from "~/lib/shelleport";
import { requireApiAuth } from "~/server/auth.server";
import { storeSessionAttachments } from "~/server/attachments.server";
import { isApiError, ApiError } from "~/server/api-error.server";
import { sessionBroker } from "~/server/session-broker.server";
import { sessionStore } from "~/server/store.server";
import { getProvider, listProviders } from "~/server/providers/registry.server";

async function readJson<T>(request: Request) {
	try {
		return (await request.json()) as T;
	} catch {
		throw new ApiError(400, "invalid_json", "Invalid JSON body");
	}
}

function writeSseMessage(
	controller: ReadableStreamDefaultController<string>,
	message: SessionStreamMessage,
) {
	controller.enqueue(`data: ${JSON.stringify(message)}\n\n`);
}

async function assertDirectory(path: string, fieldName: string) {
	if (!isAbsolute(path)) {
		throw new ApiError(400, "invalid_cwd", `${fieldName} must be an absolute path`);
	}

	const stat = await Bun.file(path)
		.stat()
		.catch(() => null);

	if (!stat?.isDirectory()) {
		throw new ApiError(400, "invalid_cwd", `${fieldName} must be an existing directory`);
	}
}

function assertProviderId(providerId: unknown, fieldName: string): "claude" | "codex" {
	if (providerId === "claude" || providerId === "codex") {
		return providerId;
	}

	throw new ApiError(400, "invalid_provider", `${fieldName} must be "claude" or "codex"`);
}

function assertPermissionMode(permissionMode: unknown) {
	if (
		permissionMode === undefined ||
		permissionMode === "default" ||
		permissionMode === "dontAsk"
	) {
		return permissionMode;
	}

	throw new ApiError(
		400,
		"invalid_permission_mode",
		'permissionMode must be "default" or "dontAsk"',
	);
}

function assertAllowedTools(allowedTools: unknown) {
	if (allowedTools === undefined) {
		return;
	}

	if (
		!Array.isArray(allowedTools) ||
		allowedTools.some((value) => typeof value !== "string" || value.trim().length === 0)
	) {
		throw new ApiError(
			400,
			"invalid_allowed_tools",
			"allowedTools must be an array of non-empty strings",
		);
	}
}

function validateTitle(title: unknown) {
	if (title === undefined) {
		return;
	}

	if (typeof title !== "string" || title.trim().length === 0) {
		throw new ApiError(400, "invalid_title", "title must be a non-empty string");
	}
}

function validatePrompt(prompt: unknown, fieldName: string, required: boolean) {
	if (prompt === undefined && !required) {
		return;
	}

	if (typeof prompt !== "string" || prompt.trim().length === 0) {
		throw new ApiError(400, "invalid_prompt", `${fieldName} must be a non-empty string`);
	}
}

function validateCreateSessionInput(payload: CreateSessionInput) {
	assertProviderId(payload.provider, "provider");
	validateTitle(payload.title);
	validatePrompt(payload.prompt, "prompt", false);
	assertPermissionMode(payload.permissionMode);
	assertAllowedTools(payload.allowedTools);
	return assertDirectory(payload.cwd, "cwd");
}

function validateImportSessionInput(payload: ImportSessionPayload) {
	assertProviderId(payload.provider, "provider");
	if (
		typeof payload.providerSessionRef !== "string" ||
		payload.providerSessionRef.trim().length === 0
	) {
		throw new ApiError(
			400,
			"invalid_provider_session_ref",
			"providerSessionRef must be a non-empty string",
		);
	}
	assertPermissionMode(payload.permissionMode);
	assertAllowedTools(payload.allowedTools);
}

function validateSessionInput(payload: SessionInputPayload) {
	if (typeof payload.prompt !== "string") {
		throw new ApiError(400, "invalid_prompt", "prompt must be a string");
	}

	if (!Array.isArray(payload.attachments)) {
		throw new ApiError(400, "invalid_attachments", "attachments must be an array");
	}

	for (const attachment of payload.attachments) {
		if (
			typeof attachment.name !== "string" ||
			attachment.name.trim().length === 0 ||
			typeof attachment.path !== "string" ||
			attachment.path.trim().length === 0 ||
			typeof attachment.contentType !== "string" ||
			!attachment.contentType.startsWith("image/")
		) {
			throw new ApiError(400, "invalid_attachments", "attachments must be valid image files");
		}
	}
}

async function readSessionInput(request: Request, sessionId: string): Promise<SessionInputPayload> {
	const formData = await request.formData().catch(() => {
		throw new ApiError(400, "invalid_form_data", "Invalid form data");
	});
	const prompt = formData.get("prompt");

	if (prompt !== null && typeof prompt !== "string") {
		throw new ApiError(400, "invalid_prompt", "prompt must be a string");
	}

	const session = sessionStore.getSession(sessionId);

	if (!session) {
		throw new ApiError(404, "session_not_found", "Session not found");
	}

	const attachments = await storeSessionAttachments(
		sessionId,
		session.cwd,
		formData.getAll("images"),
	);
	return {
		prompt: typeof prompt === "string" ? prompt : "",
		attachments,
	};
}

function validateControlInput(payload: SessionControlPayload) {
	if (payload.action !== "interrupt" && payload.action !== "terminate") {
		throw new ApiError(400, "invalid_control_action", 'action must be "interrupt" or "terminate"');
	}
}

function validateArchiveInput(payload: SessionArchivePayload) {
	if (typeof payload.archived !== "boolean") {
		throw new ApiError(400, "invalid_archived", "archived must be a boolean");
	}
}

function validateRequestResponseInput(payload: RequestResponsePayload) {
	if (payload.decision !== "allow" && payload.decision !== "deny") {
		throw new ApiError(400, "invalid_decision", 'decision must be "allow" or "deny"');
	}

	if (
		payload.toolRule !== undefined &&
		(typeof payload.toolRule !== "string" || payload.toolRule.trim().length === 0)
	) {
		throw new ApiError(400, "invalid_tool_rule", "toolRule must be a non-empty string");
	}
}

function createSessionEventStream(sessionId: string) {
	let unsubscribe = () => {};
	let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

	return new ReadableStream<string>({
		start(controller) {
			const detail = sessionBroker.getSessionDetail(sessionId);

			if (!detail) {
				controller.error(new ApiError(404, "session_not_found", "Session not found"));
				return;
			}

			let lastSequence = detail.session.lastEventSequence;
			writeSseMessage(controller, {
				type: "snapshot",
				payload: detail,
			});

			heartbeatTimer = setInterval(() => {
				controller.enqueue(": heartbeat\n\n");
			}, 15000);

			unsubscribe = sessionBroker.subscribe(sessionId, (message) => {
				if (message.type === "event") {
					if (message.payload.sequence <= lastSequence) {
						return;
					}

					lastSequence = message.payload.sequence;
				}

				writeSseMessage(controller, message);
			});
		},
		cancel() {
			unsubscribe();

			if (heartbeatTimer) {
				clearInterval(heartbeatTimer);
			}
		},
	});
}

function jsonError(status: number, code: string, error: string) {
	return Response.json({ code, error }, { status });
}

function sessionIdFromSegments(segments: string[]) {
	const sessionId = segments[2];

	if (!sessionId || sessionId.trim().length === 0) {
		throw new ApiError(400, "invalid_session_id", "Session id is required");
	}

	return sessionId;
}

async function listDirectory(path: string): Promise<DirectoryListing> {
	await assertDirectory(path, "path");

	const entries = await readdir(path, { withFileTypes: true });
	const sortedEntries = entries
		.map((entry) => ({
			name: entry.name,
			path: join(path, entry.name),
			kind: entry.isDirectory() ? ("directory" as const) : ("file" as const),
		}))
		.sort((left, right) => {
			if (left.kind !== right.kind) {
				return left.kind === "directory" ? -1 : 1;
			}

			return left.name.localeCompare(right.name, undefined, {
				numeric: true,
				sensitivity: "base",
			});
		});
	const parentPath = path === "/" ? null : dirname(path);

	return {
		path,
		parentPath,
		entries: sortedEntries,
	};
}

async function dispatchApiRequest(request: Request) {
	requireApiAuth(request);

	const url = new URL(request.url);
	const segments = url.pathname.split("/").filter(Boolean);

	if (request.method === "GET" && url.pathname === "/api/directories") {
		const path = url.searchParams.get("path");

		if (!path) {
			throw new ApiError(400, "invalid_path", "path is required");
		}

		return Response.json(await listDirectory(path));
	}

	if (request.method === "GET" && url.pathname === "/api/providers") {
		return Response.json({ providers: listProviders() });
	}

	if (
		request.method === "GET" &&
		segments[0] === "api" &&
		segments[1] === "providers" &&
		segments[3] === "sessions"
	) {
		const providerId = assertProviderId(segments[2], "provider");
		return Response.json({ sessions: await getProvider(providerId).listHistoricalSessions() });
	}

	if (request.method === "GET" && url.pathname === "/api/sessions") {
		return Response.json({ sessions: sessionBroker.listSessions() });
	}

	if (request.method === "POST" && url.pathname === "/api/sessions") {
		const payload = await readJson<CreateSessionInput>(request);
		await validateCreateSessionInput(payload);
		const session = sessionBroker.createSession(payload);
		return Response.json({ session }, { status: 201 });
	}

	if (request.method === "POST" && url.pathname === "/api/sessions/import") {
		const payload = await readJson<ImportSessionPayload>(request);
		validateImportSessionInput(payload);
		const session = await sessionBroker.importSession(payload);
		return Response.json({ session }, { status: 201 });
	}

	if (segments[0] === "api" && segments[1] === "sessions" && segments[2]) {
		const sessionId = sessionIdFromSegments(segments);

		if (request.method === "GET" && segments.length === 3) {
			const detail = sessionBroker.getSessionDetail(sessionId);
			return detail
				? Response.json(detail)
				: jsonError(404, "session_not_found", "Session not found");
		}

		if (request.method === "GET" && segments[3] === "events") {
			if (!sessionBroker.getSessionDetail(sessionId)) {
				return jsonError(404, "session_not_found", "Session not found");
			}

			return new Response(createSessionEventStream(sessionId), {
				headers: {
					"Content-Type": "text/event-stream; charset=utf-8",
					"Cache-Control": "no-cache, no-transform",
					Connection: "keep-alive",
				},
			});
		}

		if (request.method === "POST" && segments[3] === "input") {
			const payload = await readSessionInput(request, sessionId);
			validateSessionInput(payload);
			const session = await sessionBroker.sendInput(sessionId, payload);
			return Response.json({ session }, { status: 202 });
		}

		if (request.method === "POST" && segments[3] === "control") {
			const payload = await readJson<SessionControlPayload>(request);
			validateControlInput(payload);
			sessionBroker.controlSession(sessionId, payload);
			return Response.json({ ok: true });
		}

		if (request.method === "POST" && segments[3] === "archive") {
			const payload = await readJson<SessionArchivePayload>(request);
			validateArchiveInput(payload);
			const session = sessionBroker.setSessionArchived(sessionId, payload);
			return Response.json({ session });
		}
	}

	if (
		request.method === "POST" &&
		segments[0] === "api" &&
		segments[1] === "requests" &&
		segments[2] &&
		segments[3] === "respond"
	) {
		const payload = await readJson<RequestResponsePayload>(request);
		validateRequestResponseInput(payload);
		const requestRecord = await sessionBroker.respondToRequest(segments[2], payload);
		return Response.json({ request: requestRecord });
	}

	throw new ApiError(404, "not_found", "Not found");
}

export async function handleApiRequest(request: Request) {
	try {
		return await dispatchApiRequest(request);
	} catch (error) {
		if (isApiError(error)) {
			return jsonError(error.status, error.code, error.message);
		}

		throw error;
	}
}
