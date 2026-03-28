export type ProviderId = "claude" | "codex";

export type SessionStatus = "idle" | "running" | "waiting" | "retrying" | "failed" | "interrupted";

export type HostEventKind = "text" | "tool-call" | "tool-result" | "state" | "error" | "system";

export type PermissionMode = "default" | "bypassPermissions";

export function getDefaultPermissionMode(providerId: ProviderId): PermissionMode {
	return providerId === "claude" ? "bypassPermissions" : "default";
}

export type ProviderCapabilities = {
	canCreate: boolean;
	canResumeHistorical: boolean;
	canInterrupt: boolean;
	canTerminate: boolean;
	hasStructuredEvents: boolean;
	supportsApprovals: boolean;
	supportsQuestions: boolean;
	supportsAttachments: boolean;
	supportsFork: boolean;
	supportsWorktree: boolean;
	liveResume: "none" | "managed-only" | "provider-managed";
};

export type ProviderSummary = {
	id: ProviderId;
	label: string;
	status: "ready" | "partial" | "planned";
	statusDetail: string | null;
	capabilities: ProviderCapabilities;
};

export type HostSession = {
	id: string;
	provider: ProviderId;
	title: string;
	cwd: string;
	pinned: boolean;
	archived: boolean;
	status: SessionStatus;
	providerSessionRef: string | null;
	pid: number | null;
	imported: boolean;
	permissionMode: PermissionMode;
	allowedTools: string[];
	queuedInputCount: number;
	statusDetail: SessionStatusDetail;
	usage: SessionUsage | null;
	createTime: number;
	updateTime: number;
	lastEventSequence: number;
};

export type HostEvent = {
	id: string;
	sessionId: string;
	sequence: number;
	kind: HostEventKind;
	summary: string;
	data: Record<string, unknown>;
	rawProviderEvent: Record<string, unknown> | null;
	createTime: number;
};

export type PendingRequestKind = "approval" | "question";
export type PendingRequestStatus = "pending" | "resolved" | "rejected";
export type BlockReason = "permission" | "sandbox";

export type SessionStatusDetail = {
	message: string | null;
	attempt: number | null;
	nextRetryTime: number | null;
	waitKind: PendingRequestKind | null;
	blockReason: BlockReason | null;
};

export type SessionUsage = {
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	costUsd: number | null;
	model: string | null;
};

export type SessionLimit = {
	status: string | null;
	resetsAt: number | null;
	window: string | null;
	isUsingOverage: boolean | null;
	utilization: number | null;
};

export type ProviderLimitState = {
	claude: SessionLimit[];
};

export type PendingRequest = {
	id: string;
	sessionId: string;
	provider: ProviderId;
	kind: PendingRequestKind;
	blockReason: BlockReason | null;
	prompt: string;
	status: PendingRequestStatus;
	data: Record<string, unknown>;
	createTime: number;
	updateTime: number;
};

export type QueuedSessionInput = {
	id: string;
	prompt: string;
	attachments: SessionAttachment[];
	createTime: number;
};

export type HistoricalSession = {
	provider: ProviderId;
	providerSessionRef: string;
	title: string;
	cwd: string;
	sourcePath: string;
	createTime: number;
	updateTime: number;
	preview: string;
};

export type SessionDetail = {
	session: HostSession;
	events: HostEvent[];
	totalEvents: number;
	pendingRequests: PendingRequest[];
	queuedInputs: QueuedSessionInput[];
};

export type SessionStreamMessage =
	| {
			type: "snapshot";
			payload: SessionDetail;
	  }
	| {
			type: "session";
			payload: HostSession;
	  }
	| {
			type: "event";
			payload: HostEvent;
	  }
	| {
			type: "request";
			payload: PendingRequest;
	  }
	| {
			type: "queued-inputs";
			payload: QueuedSessionInput[];
	  };

export type CreateSessionInput = {
	provider: ProviderId;
	cwd: string;
	prompt?: string;
	title?: string;
	permissionMode?: PermissionMode;
	allowedTools?: string[];
};

export type SessionAttachment = {
	name: string;
	path: string;
	contentType: string;
};

export type SessionInputPayload = {
	prompt: string;
	attachments: SessionAttachment[];
};

export type SessionControlPayload = {
	action: "interrupt" | "terminate";
};

export type SessionArchivePayload = {
	archived: boolean;
};

export type SessionMetaPayload = {
	title?: string;
	pinned?: boolean;
};

export type DirectoryEntry = {
	name: string;
	path: string;
	kind: "directory" | "file";
};

export type DirectoryListing = {
	path: string;
	parentPath: string | null;
	entries: DirectoryEntry[];
};

export type ImportSessionPayload = {
	provider: ProviderId;
	providerSessionRef: string;
	permissionMode?: PermissionMode;
	allowedTools?: string[];
};

export type RequestResponsePayload = {
	decision: "allow" | "deny";
	toolRule?: string;
};

export type QueuedSessionInputUpdatePayload = {
	prompt: string;
};
