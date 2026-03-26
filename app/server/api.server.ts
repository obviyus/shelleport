import type {
	CreateSessionInput,
	ImportSessionPayload,
	RequestResponsePayload,
	SessionControlPayload,
	SessionInputPayload,
	SessionStreamMessage,
} from "~/lib/shelleport";
import { requireApiAuth } from "~/server/auth.server";
import { sessionBroker } from "~/server/session-broker.server";
import { getProvider, listProviders } from "~/server/providers/registry.server";

async function readJson<T>(request: Request) {
	return (await request.json()) as T;
}

function writeSseMessage(controller: ReadableStreamDefaultController<string>, message: SessionStreamMessage) {
	controller.enqueue(`data: ${JSON.stringify(message)}\n\n`);
}

function createSessionEventStream(sessionId: string) {
	let unsubscribe = () => {};

	return new ReadableStream<string>({
		start(controller) {
			const detail = sessionBroker.getSessionDetail(sessionId);

			if (!detail) {
				controller.error(new Error("Session not found"));
				return;
			}

			let lastSequence = detail.session.lastEventSequence;
			writeSseMessage(controller, {
				type: "snapshot",
				payload: detail,
			});

			unsubscribe = sessionBroker.subscribe(sessionId, (message) => {
				if (message.type === "event") {
					if (message.payload.sequence <= lastSequence) {
						return;
					}

					lastSequence = message.payload.sequence;
				}

				if (message.type === "snapshot") {
					lastSequence = message.payload.session.lastEventSequence;
				}

				writeSseMessage(controller, message);
			});

			for (const event of sessionBroker.getSessionDetail(sessionId)?.events ?? []) {
				if (event.sequence <= lastSequence) {
					continue;
				}

				lastSequence = event.sequence;
				writeSseMessage(controller, {
					type: "event",
					payload: event,
				});
			}
		},
		cancel() {
			unsubscribe();
		},
	});
}

function jsonError(status: number, error: string) {
	return Response.json({ error }, { status });
}

export async function handleApiRequest(request: Request) {
	await requireApiAuth(request);

	const url = new URL(request.url);
	const segments = url.pathname.split("/").filter(Boolean);

	if (request.method === "GET" && url.pathname === "/api/providers") {
		return Response.json({ providers: listProviders() });
	}

	if (request.method === "GET" && segments[0] === "api" && segments[1] === "providers" && segments[3] === "sessions") {
		const providerId = segments[2];

		if (providerId !== "claude" && providerId !== "codex") {
			return jsonError(404, "Unknown provider");
		}

		return Response.json({ sessions: await getProvider(providerId).listHistoricalSessions() });
	}

	if (request.method === "GET" && url.pathname === "/api/sessions") {
		return Response.json({ sessions: sessionBroker.listSessions() });
	}

	if (request.method === "POST" && url.pathname === "/api/sessions") {
		const payload = await readJson<CreateSessionInput>(request);
		const session = sessionBroker.createSession(payload);
		return Response.json({ session }, { status: 201 });
	}

	if (request.method === "POST" && url.pathname === "/api/sessions/import") {
		const payload = await readJson<ImportSessionPayload>(request);
		const session = await sessionBroker.importSession(payload);
		return Response.json({ session }, { status: 201 });
	}

	if (segments[0] === "api" && segments[1] === "sessions" && segments[2]) {
		const sessionId = segments[2];

		if (request.method === "GET" && segments.length === 3) {
			const detail = sessionBroker.getSessionDetail(sessionId);
			return detail ? Response.json(detail) : jsonError(404, "Session not found");
		}

		if (request.method === "GET" && segments[3] === "events") {
			if (!sessionBroker.getSessionDetail(sessionId)) {
				return jsonError(404, "Session not found");
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
			const payload = await readJson<SessionInputPayload>(request);
			const session = await sessionBroker.sendInput(sessionId, payload);
			return Response.json({ session }, { status: 202 });
		}

		if (request.method === "POST" && segments[3] === "control") {
			const payload = await readJson<SessionControlPayload>(request);
			sessionBroker.controlSession(sessionId, payload);
			return Response.json({ ok: true });
		}
	}

	if (request.method === "POST" && segments[0] === "api" && segments[1] === "requests" && segments[2] && segments[3] === "respond") {
		const payload = await readJson<RequestResponsePayload>(request);
		const requestRecord = await sessionBroker.respondToRequest(segments[2], payload);
		return Response.json({ request: requestRecord });
	}

	return jsonError(404, "Not found");
}
