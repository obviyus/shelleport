import { Database } from "bun:sqlite";
import type {
	HostEvent,
	HostEventKind,
	HostSession,
	PendingRequest,
	BlockReason,
	PendingRequestKind,
	PendingRequestStatus,
	PermissionMode,
	ProviderId,
	SessionDetail,
	SessionStatus,
	SessionStatusDetail,
} from "~/lib/shelleport";
import { config, ensureDataDir, getDatabasePath } from "~/server/config.server";
import { createId, createTimestamp } from "~/server/id.server";

await ensureDataDir();

const database = new Database(getDatabasePath(), { create: true, strict: true });

database.exec("PRAGMA journal_mode = WAL");

database.exec(`
	CREATE TABLE IF NOT EXISTS host_sessions (
		id TEXT PRIMARY KEY,
		provider TEXT NOT NULL,
		title TEXT NOT NULL,
		cwd TEXT NOT NULL,
		archived INTEGER NOT NULL DEFAULT 0,
		status TEXT NOT NULL,
		status_detail_json TEXT NOT NULL DEFAULT '{"message":null,"attempt":null,"nextRetryTime":null,"waitKind":null,"blockReason":null}',
		provider_session_ref TEXT,
		pid INTEGER,
		imported INTEGER NOT NULL DEFAULT 0,
		permission_mode TEXT NOT NULL DEFAULT 'default',
		allowed_tools_json TEXT NOT NULL DEFAULT '[]',
		last_event_sequence INTEGER NOT NULL DEFAULT 0,
		create_time INTEGER NOT NULL,
		update_time INTEGER NOT NULL
	);
	CREATE TABLE IF NOT EXISTS host_events (
		id TEXT PRIMARY KEY,
		session_id TEXT NOT NULL,
		sequence INTEGER NOT NULL,
		kind TEXT NOT NULL,
		summary TEXT NOT NULL,
		data_json TEXT NOT NULL,
		raw_provider_event_json TEXT,
		create_time INTEGER NOT NULL,
		UNIQUE(session_id, sequence)
	);
	CREATE TABLE IF NOT EXISTS pending_requests (
		id TEXT PRIMARY KEY,
		session_id TEXT NOT NULL,
		provider TEXT NOT NULL,
		kind TEXT NOT NULL,
		block_reason TEXT,
		prompt TEXT NOT NULL,
		status TEXT NOT NULL,
		data_json TEXT NOT NULL,
		create_time INTEGER NOT NULL,
		update_time INTEGER NOT NULL
	);
`);

type SqlColumnRow = {
	name: string;
};

function ensureColumn(tableName: string, columnName: string, sql: string) {
	const columns = database
		.query<SqlColumnRow, []>(`PRAGMA table_info(${tableName})`)
		.all()
		.map((row) => row.name);

	if (!columns.includes(columnName)) {
		database.exec(sql);
	}
}

ensureColumn(
	"host_sessions",
	"archived",
	"ALTER TABLE host_sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
);
ensureColumn(
	"host_sessions",
	"status_detail_json",
	`ALTER TABLE host_sessions ADD COLUMN status_detail_json TEXT NOT NULL DEFAULT '{"message":null,"attempt":null,"nextRetryTime":null,"waitKind":null,"blockReason":null}'`,
);
ensureColumn(
	"host_sessions",
	"permission_mode",
	"ALTER TABLE host_sessions ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'default'",
);
ensureColumn(
	"host_sessions",
	"allowed_tools_json",
	"ALTER TABLE host_sessions ADD COLUMN allowed_tools_json TEXT NOT NULL DEFAULT '[]'",
);
ensureColumn(
	"pending_requests",
	"block_reason",
	"ALTER TABLE pending_requests ADD COLUMN block_reason TEXT",
);

type SqlSessionRow = {
	id: string;
	provider: string;
	title: string;
	cwd: string;
	archived: number;
	status: string;
	status_detail_json: string;
	provider_session_ref: string | null;
	pid: number | null;
	imported: number;
	permission_mode: string;
	allowed_tools_json: string;
	last_event_sequence: number;
	create_time: number;
	update_time: number;
};

type SqlEventRow = {
	id: string;
	session_id: string;
	sequence: number;
	kind: string;
	summary: string;
	data_json: string;
	raw_provider_event_json: string | null;
	create_time: number;
};

type SqlRequestRow = {
	id: string;
	session_id: string;
	provider: string;
	kind: string;
	block_reason: string | null;
	prompt: string;
	status: string;
	data_json: string;
	create_time: number;
	update_time: number;
};

function parseJsonRecord(value: string) {
	return JSON.parse(value) as Record<string, unknown>;
}

function parseAllowedTools(value: string) {
	return JSON.parse(value) as string[];
}

function emptyStatusDetail(): SessionStatusDetail {
	return {
		message: null,
		attempt: null,
		nextRetryTime: null,
		waitKind: null,
		blockReason: null,
	};
}

function parseStatusDetail(value: string) {
	const parsed = JSON.parse(value) as Partial<SessionStatusDetail>;
	return {
		...emptyStatusDetail(),
		...parsed,
	};
}

function mapSession(row: SqlSessionRow): HostSession {
	return {
		id: row.id,
		provider: row.provider as ProviderId,
		title: row.title,
		cwd: row.cwd,
		archived: row.archived === 1,
		status: row.status as SessionStatus,
		statusDetail: parseStatusDetail(row.status_detail_json),
		providerSessionRef: row.provider_session_ref,
		pid: row.pid,
		imported: row.imported === 1,
		permissionMode: row.permission_mode as PermissionMode,
		allowedTools: parseAllowedTools(row.allowed_tools_json),
		lastEventSequence: row.last_event_sequence,
		createTime: row.create_time,
		updateTime: row.update_time,
	};
}

function mapEvent(row: SqlEventRow): HostEvent {
	return {
		id: row.id,
		sessionId: row.session_id,
		sequence: row.sequence,
		kind: row.kind as HostEventKind,
		summary: row.summary,
		data: parseJsonRecord(row.data_json),
		rawProviderEvent: row.raw_provider_event_json
			? parseJsonRecord(row.raw_provider_event_json)
			: null,
		createTime: row.create_time,
	};
}

function mapRequest(row: SqlRequestRow): PendingRequest {
	return {
		id: row.id,
		sessionId: row.session_id,
		provider: row.provider as ProviderId,
		kind: row.kind as PendingRequestKind,
		blockReason: row.block_reason as BlockReason | null,
		prompt: row.prompt,
		status: row.status as PendingRequestStatus,
		data: parseJsonRecord(row.data_json),
		createTime: row.create_time,
		updateTime: row.update_time,
	};
}

const insertSessionStatement = database.query(
	`INSERT INTO host_sessions (
		id, provider, title, cwd, archived, status, status_detail_json, provider_session_ref, pid, imported, permission_mode, allowed_tools_json, last_event_sequence, create_time, update_time
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

const listSessionsStatement = database.query<SqlSessionRow, []>(
	"SELECT * FROM host_sessions ORDER BY update_time DESC",
);

const getSessionStatement = database.query<SqlSessionRow, [string]>(
	"SELECT * FROM host_sessions WHERE id = ? LIMIT 1",
);

const updateSessionStatement = database.query(
	`UPDATE host_sessions
		SET status = ?, status_detail_json = ?, provider_session_ref = ?, pid = ?, title = ?, archived = ?, permission_mode = ?, allowed_tools_json = ?, update_time = ?
		WHERE id = ?`,
);

const updateSessionSequenceStatement = database.query(
	"UPDATE host_sessions SET last_event_sequence = ?, update_time = ? WHERE id = ?",
);

const insertEventStatement = database.query(
	`INSERT INTO host_events (
		id, session_id, sequence, kind, summary, data_json, raw_provider_event_json, create_time
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
);

const listEventsStatement = database.query<SqlEventRow, [string]>(
	"SELECT * FROM host_events WHERE session_id = ? ORDER BY sequence ASC",
);

const listEventsAfterStatement = database.query<SqlEventRow, [string, number]>(
	"SELECT * FROM host_events WHERE session_id = ? AND sequence > ? ORDER BY sequence ASC",
);

const insertRequestStatement = database.query(
	`INSERT INTO pending_requests (
		id, session_id, provider, kind, block_reason, prompt, status, data_json, create_time, update_time
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

const listRequestsStatement = database.query<SqlRequestRow, [string]>(
	"SELECT * FROM pending_requests WHERE session_id = ? AND status = 'pending' ORDER BY create_time ASC",
);

const getRequestStatement = database.query<SqlRequestRow, [string]>(
	"SELECT * FROM pending_requests WHERE id = ? LIMIT 1",
);

const updateRequestStatement = database.query(
	"UPDATE pending_requests SET status = ?, update_time = ?, data_json = ? WHERE id = ?",
);

export type CreateStoredSessionInput = {
	provider: ProviderId;
	title: string;
	cwd: string;
	imported?: boolean;
	providerSessionRef?: string | null;
	permissionMode: PermissionMode;
	allowedTools: string[];
};

type SessionUpdate = Partial<
	Pick<
		HostSession,
		| "status"
		| "statusDetail"
		| "providerSessionRef"
		| "pid"
		| "title"
		| "archived"
		| "permissionMode"
		| "allowedTools"
	>
>;

export const sessionStore = {
	getDataDirectory() {
		return config.dataDir;
	},
	createSession(input: CreateStoredSessionInput) {
		const now = createTimestamp();
		const session: HostSession = {
			id: createId(),
			provider: input.provider,
			title: input.title,
			cwd: input.cwd,
			archived: false,
			status: "idle",
			statusDetail: emptyStatusDetail(),
			providerSessionRef: input.providerSessionRef ?? null,
			pid: null,
			imported: input.imported ?? false,
			permissionMode: input.permissionMode,
			allowedTools: input.allowedTools,
			lastEventSequence: 0,
			createTime: now,
			updateTime: now,
		};

		insertSessionStatement.run(
			session.id,
			session.provider,
			session.title,
			session.cwd,
			session.archived ? 1 : 0,
			session.status,
			JSON.stringify(session.statusDetail),
			session.providerSessionRef,
			session.pid,
			session.imported ? 1 : 0,
			session.permissionMode,
			JSON.stringify(session.allowedTools),
			session.lastEventSequence,
			session.createTime,
			session.updateTime,
		);

		return session;
	},
	listSessions() {
		return listSessionsStatement.all().map(mapSession);
	},
	getSession(sessionId: string) {
		const row = getSessionStatement.get(sessionId);
		return row ? mapSession(row) : null;
	},
	getSessionDetail(sessionId: string): SessionDetail | null {
		const session = this.getSession(sessionId);

		if (!session) {
			return null;
		}

		return {
			session,
			events: listEventsStatement.all(sessionId).map(mapEvent),
			pendingRequests: listRequestsStatement.all(sessionId).map(mapRequest),
		};
	},
	listEventsAfter(sessionId: string, sequence: number) {
		return listEventsAfterStatement.all(sessionId, sequence).map(mapEvent);
	},
	updateSession(sessionId: string, update: SessionUpdate) {
		const current = this.getSession(sessionId);

		if (!current) {
			return null;
		}

		const next: HostSession = {
			...current,
			status: update.status ?? current.status,
			statusDetail: update.statusDetail ?? current.statusDetail,
			providerSessionRef:
				update.providerSessionRef === undefined
					? current.providerSessionRef
					: update.providerSessionRef,
			pid: update.pid === undefined ? current.pid : update.pid,
			title: update.title ?? current.title,
			archived: update.archived ?? current.archived,
			permissionMode: update.permissionMode ?? current.permissionMode,
			allowedTools: update.allowedTools ?? current.allowedTools,
			updateTime: createTimestamp(),
		};

		updateSessionStatement.run(
			next.status,
			JSON.stringify(next.statusDetail),
			next.providerSessionRef,
			next.pid,
			next.title,
			next.archived ? 1 : 0,
			next.permissionMode,
			JSON.stringify(next.allowedTools),
			next.updateTime,
			sessionId,
		);

		return next;
	},
	appendEvent(
		sessionId: string,
		input: {
			kind: HostEventKind;
			summary: string;
			data: Record<string, unknown>;
			rawProviderEvent?: Record<string, unknown> | null;
		},
	) {
		const session = this.getSession(sessionId);

		if (!session) {
			throw new Error(`Unknown session: ${sessionId}`);
		}

		const event: HostEvent = {
			id: createId(),
			sessionId,
			sequence: session.lastEventSequence + 1,
			kind: input.kind,
			summary: input.summary,
			data: input.data,
			rawProviderEvent: input.rawProviderEvent ?? null,
			createTime: createTimestamp(),
		};

		insertEventStatement.run(
			event.id,
			event.sessionId,
			event.sequence,
			event.kind,
			event.summary,
			JSON.stringify(event.data),
			event.rawProviderEvent ? JSON.stringify(event.rawProviderEvent) : null,
			event.createTime,
		);

		updateSessionSequenceStatement.run(event.sequence, event.createTime, sessionId);

		return event;
	},
	createPendingRequest(input: {
		sessionId: string;
		provider: ProviderId;
		kind: PendingRequestKind;
		blockReason: BlockReason | null;
		prompt: string;
		data: Record<string, unknown>;
	}) {
		const now = createTimestamp();
		const request: PendingRequest = {
			id: createId(),
			sessionId: input.sessionId,
			provider: input.provider,
			kind: input.kind,
			blockReason: input.blockReason,
			prompt: input.prompt,
			status: "pending",
			data: input.data,
			createTime: now,
			updateTime: now,
		};

		insertRequestStatement.run(
			request.id,
			request.sessionId,
			request.provider,
			request.kind,
			request.blockReason,
			request.prompt,
			request.status,
			JSON.stringify(request.data),
			request.createTime,
			request.updateTime,
		);

		return request;
	},
	getPendingRequest(requestId: string) {
		const row = getRequestStatement.get(requestId);
		return row ? mapRequest(row) : null;
	},
	resolvePendingRequest(
		requestId: string,
		status: PendingRequestStatus,
		data: Record<string, unknown>,
	) {
		const now = createTimestamp();
		updateRequestStatement.run(status, now, JSON.stringify(data), requestId);
		const request = this.getPendingRequest(requestId);

		if (!request) {
			throw new Error(`Unknown request: ${requestId}`);
		}

		return request;
	},
};
