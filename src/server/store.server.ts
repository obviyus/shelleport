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
	ProviderLimitState,
	ProviderId,
	QueuedSessionInput,
	SessionDetail,
	SessionLimit,
	SessionAttachment,
	SessionStatus,
	SessionStatusDetail,
	SessionUsage,
} from "~/shared/shelleport";
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
		pinned INTEGER NOT NULL DEFAULT 0,
		archived INTEGER NOT NULL DEFAULT 0,
		status TEXT NOT NULL,
		status_detail_json TEXT NOT NULL DEFAULT '{"message":null,"attempt":null,"nextRetryTime":null,"waitKind":null,"blockReason":null}',
		provider_session_ref TEXT,
		pid INTEGER,
		imported INTEGER NOT NULL DEFAULT 0,
		permission_mode TEXT NOT NULL DEFAULT 'default',
		allowed_tools_json TEXT NOT NULL DEFAULT '[]',
		queued_input_count INTEGER NOT NULL DEFAULT 0,
		usage_json TEXT NOT NULL DEFAULT 'null',
		active_usage_json TEXT NOT NULL DEFAULT 'null',
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
	CREATE TABLE IF NOT EXISTS app_auth (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		admin_token_hash TEXT,
		session_secret TEXT NOT NULL,
		create_time INTEGER NOT NULL,
		update_time INTEGER NOT NULL
	);
	CREATE TABLE IF NOT EXISTS app_provider_limits (
		provider TEXT NOT NULL,
		window TEXT NOT NULL,
		status TEXT,
		resets_at INTEGER,
		is_using_overage INTEGER,
		utilization REAL,
		update_time INTEGER NOT NULL,
		PRIMARY KEY (provider, window)
	);
	CREATE TABLE IF NOT EXISTS queued_session_inputs (
		id TEXT PRIMARY KEY,
		session_id TEXT NOT NULL,
		prompt TEXT NOT NULL,
		attachments_json TEXT NOT NULL,
		create_time INTEGER NOT NULL
	);
`);

database.exec(`
	CREATE VIRTUAL TABLE IF NOT EXISTS host_session_fts USING fts5(
		session_id UNINDEXED,
		title,
		cwd,
		provider,
		tokenize = 'unicode61 remove_diacritics 2'
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
	"pinned",
	"ALTER TABLE host_sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
);
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
	"host_sessions",
	"queued_input_count",
	"ALTER TABLE host_sessions ADD COLUMN queued_input_count INTEGER NOT NULL DEFAULT 0",
);
ensureColumn(
	"host_sessions",
	"usage_json",
	"ALTER TABLE host_sessions ADD COLUMN usage_json TEXT NOT NULL DEFAULT 'null'",
);
ensureColumn(
	"host_sessions",
	"active_usage_json",
	"ALTER TABLE host_sessions ADD COLUMN active_usage_json TEXT NOT NULL DEFAULT 'null'",
);
ensureColumn(
	"pending_requests",
	"block_reason",
	"ALTER TABLE pending_requests ADD COLUMN block_reason TEXT",
);
ensureColumn(
	"app_provider_limits",
	"utilization",
	"ALTER TABLE app_provider_limits ADD COLUMN utilization REAL",
);

database.exec(`
	UPDATE host_sessions
	SET permission_mode = 'bypassPermissions'
	WHERE permission_mode = 'dontAsk'
`);

type SqlSessionRow = {
	id: string;
	provider: string;
	title: string;
	cwd: string;
	pinned: number;
	archived: number;
	status: string;
	status_detail_json: string;
	provider_session_ref: string | null;
	pid: number | null;
	imported: number;
	permission_mode: string;
	allowed_tools_json: string;
	queued_input_count: number;
	usage_json: string;
	active_usage_json: string;
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

type SqlAuthRow = {
	id: number;
	admin_token_hash: string | null;
	session_secret: string;
	create_time: number;
	update_time: number;
};

type SqlProviderLimitRow = {
	provider: string;
	window: string;
	status: string | null;
	resets_at: number | null;
	is_using_overage: number | null;
	utilization: number | null;
	update_time: number;
};

type SqlQueuedInputRow = {
	id: string;
	session_id: string;
	prompt: string;
	attachments_json: string;
	create_time: number;
};

type SqlSessionSearchRow = {
	id: string;
	title: string;
	cwd: string;
	provider: string;
};

function parseJsonRecord(value: string) {
	return JSON.parse(value) as Record<string, unknown>;
}

function parseAllowedTools(value: string) {
	return JSON.parse(value) as string[];
}

function parseAttachments(value: string) {
	return JSON.parse(value) as SessionAttachment[];
}

function parseUsage(value: string) {
	const parsed = JSON.parse(value) as SessionUsage | null;
	return parsed;
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
	const totalUsage = parseUsage(row.usage_json);
	const activeUsage = parseUsage(row.active_usage_json);
	const usage = activeUsage ? addUsageTotals(totalUsage, activeUsage) : totalUsage;

	return {
		id: row.id,
		provider: row.provider as ProviderId,
		title: row.title,
		cwd: row.cwd,
		pinned: row.pinned === 1,
		archived: row.archived === 1,
		status: row.status as SessionStatus,
		statusDetail: parseStatusDetail(row.status_detail_json),
		providerSessionRef: row.provider_session_ref,
		pid: row.pid,
		imported: row.imported === 1,
		permissionMode: row.permission_mode as PermissionMode,
		allowedTools: parseAllowedTools(row.allowed_tools_json),
		queuedInputCount: row.queued_input_count,
		usage,
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

function mapQueuedInput(row: SqlQueuedInputRow): QueuedSessionInput {
	return {
		id: row.id,
		prompt: row.prompt,
		attachments: parseAttachments(row.attachments_json),
		createTime: row.create_time,
	};
}

const insertSessionStatement = database.query(
	`INSERT INTO host_sessions (
		id, provider, title, cwd, pinned, archived, status, status_detail_json, provider_session_ref, pid, imported, permission_mode, allowed_tools_json, queued_input_count, usage_json, active_usage_json, last_event_sequence, create_time, update_time
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

const listSessionsStatement = database.query<SqlSessionRow, []>(
	"SELECT * FROM host_sessions ORDER BY pinned DESC, update_time DESC",
);

const getSessionStatement = database.query<SqlSessionRow, [string]>(
	"SELECT * FROM host_sessions WHERE id = ? LIMIT 1",
);

const searchSessionsStatement = database.query<SqlSessionRow, [string]>(
	`SELECT host_sessions.*
		FROM host_session_fts
		JOIN host_sessions ON host_sessions.id = host_session_fts.session_id
		WHERE host_session_fts MATCH ?
		ORDER BY host_sessions.pinned DESC, bm25(host_session_fts), host_sessions.update_time DESC`,
);

const updateSessionStatement = database.query(
	`UPDATE host_sessions
		SET status = ?, status_detail_json = ?, provider_session_ref = ?, pid = ?, title = ?, pinned = ?, archived = ?, permission_mode = ?, allowed_tools_json = ?, queued_input_count = ?, update_time = ?
		WHERE id = ?`,
);

const updateSessionSequenceStatement = database.query(
	"UPDATE host_sessions SET last_event_sequence = ?, update_time = ? WHERE id = ?",
);

const updateSessionUsageStatement = database.query(
	"UPDATE host_sessions SET usage_json = ?, active_usage_json = ?, update_time = ? WHERE id = ?",
);

const insertEventStatement = database.query(
	`INSERT INTO host_events (
		id, session_id, sequence, kind, summary, data_json, raw_provider_event_json, create_time
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
);

const listRecentEventsStatement = database.query<SqlEventRow, [string, number]>(
	"SELECT * FROM (SELECT * FROM host_events WHERE session_id = ? ORDER BY sequence DESC LIMIT ?) ORDER BY sequence ASC",
);

const listEventsBeforeStatement = database.query<SqlEventRow, [string, number, number]>(
	"SELECT * FROM (SELECT * FROM host_events WHERE session_id = ? AND sequence < ? ORDER BY sequence DESC LIMIT ?) ORDER BY sequence ASC",
);

const countEventsStatement = database.query<{ total: number }, [string]>(
	"SELECT COUNT(*) as total FROM host_events WHERE session_id = ?",
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

const getAuthStateStatement = database.query<SqlAuthRow, []>(
	"SELECT * FROM app_auth WHERE id = 1 LIMIT 1",
);

const insertAuthStateStatement = database.query(
	`INSERT INTO app_auth (
		id, admin_token_hash, session_secret, create_time, update_time
	) VALUES (1, ?, ?, ?, ?)`,
);

const updateAuthStateStatement = database.query(
	"UPDATE app_auth SET admin_token_hash = ?, session_secret = ?, update_time = ? WHERE id = 1",
);

const listProviderLimitsStatement = database.query<SqlProviderLimitRow, [string]>(
	"SELECT * FROM app_provider_limits WHERE provider = ? ORDER BY update_time DESC",
);

const getProviderLimitStatement = database.query<SqlProviderLimitRow, [string, string]>(
	"SELECT * FROM app_provider_limits WHERE provider = ? AND window = ? LIMIT 1",
);

const upsertProviderLimitStatement = database.query(
	`INSERT INTO app_provider_limits (
		provider, window, status, resets_at, is_using_overage, utilization, update_time
	) VALUES (?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(provider, window) DO UPDATE SET
		status = excluded.status,
		resets_at = excluded.resets_at,
		is_using_overage = excluded.is_using_overage,
		utilization = excluded.utilization,
		update_time = excluded.update_time`,
);

const listSessionsForSearchSyncStatement = database.query<SqlSessionSearchRow, []>(
	"SELECT id, title, cwd, provider FROM host_sessions",
);

const incrementQueuedInputCountStatement = database.query(
	"UPDATE host_sessions SET queued_input_count = queued_input_count + 1, update_time = ? WHERE id = ?",
);

const decrementQueuedInputCountStatement = database.query(
	"UPDATE host_sessions SET queued_input_count = MAX(queued_input_count - 1, 0), update_time = ? WHERE id = ?",
);

const insertQueuedInputStatement = database.query(
	`INSERT INTO queued_session_inputs (
		id, session_id, prompt, attachments_json, create_time
	) VALUES (?, ?, ?, ?, ?)`,
);

const getNextQueuedInputStatement = database.query<SqlQueuedInputRow, [string]>(
	`SELECT *
		FROM queued_session_inputs
		WHERE session_id = ?
		ORDER BY create_time ASC, id ASC
		LIMIT 1`,
);

const getQueuedInputStatement = database.query<SqlQueuedInputRow, [string, string]>(
	`SELECT *
		FROM queued_session_inputs
		WHERE session_id = ? AND id = ?
		LIMIT 1`,
);

const updateQueuedInputStatement = database.query(
	"UPDATE queued_session_inputs SET prompt = ? WHERE session_id = ? AND id = ?",
);

const deleteQueuedInputStatement = database.query(
	"DELETE FROM queued_session_inputs WHERE session_id = ? AND id = ?",
);

const listQueuedInputsStatement = database.query<SqlQueuedInputRow, [string]>(
	`SELECT *
		FROM queued_session_inputs
		WHERE session_id = ?
		ORDER BY create_time ASC, id ASC`,
);

const clearSessionSearchStatement = database.query("DELETE FROM host_session_fts");

const insertSessionSearchStatement = database.query(
	"INSERT INTO host_session_fts (session_id, title, cwd, provider) VALUES (?, ?, ?, ?)",
);

const deleteSessionSearchStatement = database.query(
	"DELETE FROM host_session_fts WHERE session_id = ?",
);

const deleteSessionStatement = database.query("DELETE FROM host_sessions WHERE id = ?");

const deleteSessionEventsStatement = database.query("DELETE FROM host_events WHERE session_id = ?");

const deleteSessionRequestsStatement = database.query(
	"DELETE FROM pending_requests WHERE session_id = ?",
);

const deleteSessionQueuedInputsStatement = database.query(
	"DELETE FROM queued_session_inputs WHERE session_id = ?",
);

function mapProviderLimit(row: SqlProviderLimitRow): SessionLimit {
	return {
		status: row.status,
		resetsAt: row.resets_at,
		window: row.window,
		isUsingOverage: row.is_using_overage === null ? null : row.is_using_overage === 1,
		utilization: row.utilization,
	};
}

function syncSessionSearchIndex(session: Pick<HostSession, "id" | "title" | "cwd" | "provider">) {
	deleteSessionSearchStatement.run(session.id);
	insertSessionSearchStatement.run(session.id, session.title, session.cwd, session.provider);
}

function incrementQueuedInputCount(sessionId: string) {
	incrementQueuedInputCountStatement.run(createTimestamp(), sessionId);
}

function decrementQueuedInputCount(sessionId: string) {
	decrementQueuedInputCountStatement.run(createTimestamp(), sessionId);
}

function rebuildSessionSearchIndex() {
	clearSessionSearchStatement.run();

	for (const session of listSessionsForSearchSyncStatement.all()) {
		insertSessionSearchStatement.run(session.id, session.title, session.cwd, session.provider);
	}
}

function buildSessionSearchQuery(query: string) {
	return query
		.trim()
		.split(/\s+/)
		.filter((token) => token.length > 0)
		.map((token) => `"${token.replaceAll('"', '""')}"*`)
		.join(" AND ");
}

function addUsageTotals(total: SessionUsage | null, next: SessionUsage | null) {
	if (!next) {
		return total;
	}

	if (!total) {
		return { ...next };
	}

	return {
		inputTokens: total.inputTokens + next.inputTokens,
		outputTokens: total.outputTokens + next.outputTokens,
		cacheReadInputTokens: total.cacheReadInputTokens + next.cacheReadInputTokens,
		cacheCreationInputTokens: total.cacheCreationInputTokens + next.cacheCreationInputTokens,
		costUsd: total.costUsd === null || next.costUsd === null ? null : total.costUsd + next.costUsd,
		model: next.model ?? total.model,
	} satisfies SessionUsage;
}

rebuildSessionSearchIndex();

export type CreateStoredSessionInput = {
	provider: ProviderId;
	title: string;
	cwd: string;
	imported?: boolean;
	providerSessionRef?: string | null;
	permissionMode: PermissionMode;
	allowedTools: string[];
	pinned?: boolean;
};

type SessionUpdate = Partial<
	Pick<
		HostSession,
		| "status"
		| "statusDetail"
		| "providerSessionRef"
		| "pid"
		| "title"
		| "pinned"
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
			pinned: input.pinned ?? false,
			archived: false,
			status: "idle",
			statusDetail: emptyStatusDetail(),
			providerSessionRef: input.providerSessionRef ?? null,
			pid: null,
			imported: input.imported ?? false,
			permissionMode: input.permissionMode,
			allowedTools: input.allowedTools,
			queuedInputCount: 0,
			usage: null,
			lastEventSequence: 0,
			createTime: now,
			updateTime: now,
		};

		insertSessionStatement.run(
			session.id,
			session.provider,
			session.title,
			session.cwd,
			session.pinned ? 1 : 0,
			session.archived ? 1 : 0,
			session.status,
			JSON.stringify(session.statusDetail),
			session.providerSessionRef,
			session.pid,
			session.imported ? 1 : 0,
			session.permissionMode,
			JSON.stringify(session.allowedTools),
			session.queuedInputCount,
			JSON.stringify(session.usage),
			JSON.stringify(null),
			session.lastEventSequence,
			session.createTime,
			session.updateTime,
		);
		syncSessionSearchIndex(session);

		return session;
	},
	listSessions() {
		return listSessionsStatement.all().map(mapSession);
	},
	searchSessions(query: string) {
		const match = buildSessionSearchQuery(query);
		return match.length === 0
			? this.listSessions()
			: searchSessionsStatement.all(match).map(mapSession);
	},
	getSession(sessionId: string) {
		const row = getSessionStatement.get(sessionId);
		return row ? mapSession(row) : null;
	},
	getSessionDetail(
		sessionId: string,
		options?: { limit?: number; before?: number },
	): SessionDetail | null {
		const session = this.getSession(sessionId);

		if (!session) {
			return null;
		}

		const limit = options?.limit ?? 200;
		const before = options?.before ?? null;
		const events =
			before !== null
				? listEventsBeforeStatement.all(sessionId, before, limit).map(mapEvent)
				: listRecentEventsStatement.all(sessionId, limit).map(mapEvent);
		const totalEvents = countEventsStatement.get(sessionId)?.total ?? 0;

		return {
			session,
			events,
			totalEvents,
			pendingRequests: listRequestsStatement.all(sessionId).map(mapRequest),
			queuedInputs: listQueuedInputsStatement.all(sessionId).map(mapQueuedInput),
		};
	},
	getAuthState() {
		return getAuthStateStatement.get() ?? null;
	},
	getProviderLimits(): ProviderLimitState {
		return {
			claude: listProviderLimitsStatement.all("claude").map(mapProviderLimit),
		};
	},
	saveProviderLimit(provider: ProviderId, limit: SessionLimit) {
		if (!limit.window) {
			return;
		}

		const current = getProviderLimitStatement.get(provider, limit.window);
		upsertProviderLimitStatement.run(
			provider,
			limit.window,
			limit.status ?? current?.status ?? null,
			limit.resetsAt ?? current?.resets_at ?? null,
			limit.isUsingOverage === null
				? (current?.is_using_overage ?? null)
				: limit.isUsingOverage
					? 1
					: 0,
			limit.utilization ?? current?.utilization ?? null,
			createTimestamp(),
		);
	},
	saveAuthState(input: { adminTokenHash: string | null; sessionSecret: string }) {
		const current = this.getAuthState();
		const now = createTimestamp();

		if (!current) {
			insertAuthStateStatement.run(input.adminTokenHash, input.sessionSecret, now, now);
			return;
		}

		updateAuthStateStatement.run(input.adminTokenHash, input.sessionSecret, now);
	},
	listEventsAfter(sessionId: string, sequence: number) {
		return listEventsAfterStatement.all(sessionId, sequence).map(mapEvent);
	},
	resetSessionUsageProgress(sessionId: string) {
		const row = getSessionStatement.get(sessionId);

		if (!row) {
			return null;
		}

		const total = parseUsage(row.usage_json);
		const active = parseUsage(row.active_usage_json);
		const nextTotal = active ? addUsageTotals(total, active) : total;
		updateSessionUsageStatement.run(
			JSON.stringify(nextTotal),
			JSON.stringify(null),
			createTimestamp(),
			sessionId,
		);
		return this.getSession(sessionId);
	},
	updateSessionUsage(sessionId: string, usage: SessionUsage) {
		const row = getSessionStatement.get(sessionId);

		if (!row) {
			return null;
		}

		updateSessionUsageStatement.run(
			row.usage_json,
			JSON.stringify(usage),
			createTimestamp(),
			sessionId,
		);
		return this.getSession(sessionId);
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
			pinned: update.pinned ?? current.pinned,
			archived: update.archived ?? current.archived,
			permissionMode: update.permissionMode ?? current.permissionMode,
			allowedTools: update.allowedTools ?? current.allowedTools,
			queuedInputCount: current.queuedInputCount,
			updateTime: createTimestamp(),
		};

		updateSessionStatement.run(
			next.status,
			JSON.stringify(next.statusDetail),
			next.providerSessionRef,
			next.pid,
			next.title,
			next.pinned ? 1 : 0,
			next.archived ? 1 : 0,
			next.permissionMode,
			JSON.stringify(next.allowedTools),
			next.queuedInputCount,
			next.updateTime,
			sessionId,
		);
		syncSessionSearchIndex(next);

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
	enqueueSessionInput(
		sessionId: string,
		input: { prompt: string; attachments: SessionAttachment[] },
	) {
		insertQueuedInputStatement.run(
			createId(),
			sessionId,
			input.prompt,
			JSON.stringify(input.attachments),
			createTimestamp(),
		);
		incrementQueuedInputCount(sessionId);
		return this.getSession(sessionId);
	},
	listQueuedInputs(sessionId: string) {
		return listQueuedInputsStatement.all(sessionId).map(mapQueuedInput);
	},
	getQueuedInput(sessionId: string, queuedInputId: string) {
		const row = getQueuedInputStatement.get(sessionId, queuedInputId);
		return row ? mapQueuedInput(row) : null;
	},
	updateQueuedInput(sessionId: string, queuedInputId: string, prompt: string) {
		updateQueuedInputStatement.run(prompt, sessionId, queuedInputId);
		return this.getQueuedInput(sessionId, queuedInputId);
	},
	deleteQueuedInput(sessionId: string, queuedInputId: string) {
		deleteQueuedInputStatement.run(sessionId, queuedInputId);
		decrementQueuedInputCount(sessionId);
		return this.getSession(sessionId);
	},
	shiftQueuedInput(sessionId: string) {
		const row = getNextQueuedInputStatement.get(sessionId);

		if (!row) {
			return null;
		}

		deleteQueuedInputStatement.run(sessionId, row.id);
		decrementQueuedInputCount(sessionId);
		return {
			prompt: row.prompt,
			attachments: parseAttachments(row.attachments_json),
		};
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
	deleteSession(sessionId: string) {
		const session = this.getSession(sessionId);

		if (!session) {
			return null;
		}

		deleteSessionEventsStatement.run(sessionId);
		deleteSessionRequestsStatement.run(sessionId);
		deleteSessionQueuedInputsStatement.run(sessionId);
		deleteSessionSearchStatement.run(sessionId);
		deleteSessionStatement.run(sessionId);

		return session;
	},
};
