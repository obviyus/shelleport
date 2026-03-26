import type {
	HistoricalSession,
	HostEventKind,
	HostSession,
	PendingRequest,
	ProviderCapabilities,
	ProviderId,
	ProviderSummary,
} from "~/lib/shelleport";

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
	  };

export type ProviderAdapterRunInput = {
	session: HostSession;
	prompt: string;
	signal: AbortSignal;
};

export interface ProviderAdapter {
	readonly id: ProviderId;
	readonly label: string;
	capabilities(): ProviderCapabilities;
	summary(): ProviderSummary;
	sendInput(input: ProviderAdapterRunInput): AsyncGenerator<ProviderAdapterEvent>;
	resumeSession(session: HostSession, input: ProviderAdapterRunInput): AsyncGenerator<ProviderAdapterEvent>;
	listHistoricalSessions(): Promise<HistoricalSession[]>;
}
