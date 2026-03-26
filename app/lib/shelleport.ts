export type ProviderId = "claude" | "codex";

export type SessionStatus = "idle" | "running" | "waiting" | "failed" | "interrupted";

export type HostEventKind =
	| "text"
	| "tool-call"
	| "tool-result"
	| "state"
	| "error"
	| "system";

export type PermissionMode = "default" | "dontAsk";

export type ProviderCapabilities = {
	canCreate: boolean;
	canResumeHistorical: boolean;
	canInterrupt: boolean;
	canTerminate: boolean;
	hasStructuredEvents: boolean;
	supportsApprovals: boolean;
	supportsQuestions: boolean;
	supportsImages: boolean;
	supportsFork: boolean;
	supportsWorktree: boolean;
	liveResume: "none" | "managed-only" | "provider-managed";
};

export type ProviderSummary = {
	id: ProviderId;
	label: string;
	status: "ready" | "partial" | "planned";
	capabilities: ProviderCapabilities;
};

export type HostSession = {
	id: string;
	provider: ProviderId;
	title: string;
	cwd: string;
	status: SessionStatus;
	providerSessionRef: string | null;
	pid: number | null;
	imported: boolean;
	permissionMode: PermissionMode;
	allowedTools: string[];
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
	pendingRequests: PendingRequest[];
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
	  };

export type CreateSessionInput = {
	provider: ProviderId;
	cwd: string;
	prompt?: string;
	title?: string;
	permissionMode?: PermissionMode;
	allowedTools?: string[];
};

export type SessionInputPayload = {
	prompt: string;
};

export type SessionControlPayload = {
	action: "interrupt" | "terminate";
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
