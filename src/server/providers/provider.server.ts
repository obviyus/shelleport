import type {
	HistoricalSession,
	HostEventKind,
	HostSession,
	PendingRequest,
	RequestResponsePayload,
	SessionAttachment,
	SessionControlPayload,
	SessionStatus,
	SessionStatusDetail,
	ProviderCapabilities,
	ProviderId,
	ProviderSummary,
} from "~/shared/shelleport";

export type ProviderAdapterEvent =
	| {
			type: "provider-session";
			providerSessionRef: string;
	  }
	| {
			type: "host-event";
			kind: HostEventKind;
			summary: string;
			data: Record<string, unknown>;
			rawProviderEvent: Record<string, unknown> | null;
	  }
	| {
			type: "pending-request";
			kind: PendingRequest["kind"];
			blockReason: PendingRequest["blockReason"];
			prompt: string;
			data: Record<string, unknown>;
	  }
	| {
			type: "session-status";
			status: SessionStatus;
			detail: Partial<SessionStatusDetail>;
	  };

export type ProviderAdapterRunInput = {
	session: HostSession;
	prompt: string;
	attachments: SessionAttachment[];
	signal: AbortSignal;
};

export interface ProviderAdapter {
	readonly id: ProviderId;
	readonly label: string;
	capabilities(): ProviderCapabilities;
	summary(): ProviderSummary;
	sendInput(input: ProviderAdapterRunInput): AsyncGenerator<ProviderAdapterEvent>;
	resumeSession(
		session: HostSession,
		input: ProviderAdapterRunInput,
	): AsyncGenerator<ProviderAdapterEvent>;
	listHistoricalSessions(): Promise<HistoricalSession[]>;
	canHandleRequestResponse?(session: HostSession, request: PendingRequest): boolean;
	respondToRequest?(
		session: HostSession,
		request: PendingRequest,
		input: RequestResponsePayload,
	): Promise<void>;
	canHandleControl?(session: HostSession, input: SessionControlPayload): boolean;
	controlSession?(session: HostSession, input: SessionControlPayload): Promise<void>;
	deleteSession?(session: HostSession): Promise<void>;
}
