import { basename } from "node:path";
import type { HistoricalSession, ProviderCapabilities, ProviderSummary } from "~/shared/shelleport";
import type {
	ProviderAdapter,
	ProviderAdapterEvent,
	ProviderAdapterRunInput,
} from "~/server/providers/provider.server";
import { listJsonlFiles, readHeadJsonl } from "~/server/providers/jsonl.server";

function codexNotImplementedGenerator(): AsyncGenerator<ProviderAdapterEvent> {
	return (async function* () {
		yield* [] as ProviderAdapterEvent[];
		throw new Error("Codex live control is not implemented in v1");
	})();
}

const codexCapabilities: ProviderCapabilities = {
	canCreate: false,
	canResumeHistorical: true,
	canInterrupt: false,
	canTerminate: false,
	hasStructuredEvents: true,
	supportsApprovals: false,
	supportsQuestions: false,
	supportsImages: true,
	supportsFork: true,
	supportsWorktree: true,
	liveResume: "provider-managed",
};

export async function parseCodexHistoricalSession(path: string): Promise<HistoricalSession | null> {
	const headLines = await readHeadJsonl(path);
	const meta = headLines.find((line) => line.type === "session_meta");

	if (!meta || !meta.payload || typeof meta.payload !== "object") {
		return null;
	}

	const payload = meta.payload as Record<string, unknown>;
	const cwd = typeof payload.cwd === "string" ? payload.cwd : "";

	if (cwd.length === 0) {
		return null;
	}

	const stats = await Bun.file(path).stat();
	const providerSessionRef = typeof payload.id === "string" ? payload.id : basename(path, ".jsonl");
	const previewLine = headLines.find((line) => line.type === "response_item");
	const preview =
		previewLine && previewLine.payload && typeof previewLine.payload === "object"
			? JSON.stringify(previewLine.payload).slice(0, 200)
			: "";

	return {
		provider: "codex",
		providerSessionRef,
		title:
			typeof payload.originator === "string"
				? `${payload.originator} ${providerSessionRef}`
				: providerSessionRef,
		cwd,
		sourcePath: path,
		createTime:
			typeof payload.timestamp === "string" ? Date.parse(payload.timestamp) : stats.mtimeMs,
		updateTime: stats.mtimeMs,
		preview,
	};
}

export class CodexProviderAdapter implements ProviderAdapter {
	readonly id = "codex" as const;
	readonly label = "Codex";

	capabilities() {
		return codexCapabilities;
	}

	summary(): ProviderSummary {
		return {
			id: this.id,
			label: this.label,
			status: "planned",
			capabilities: this.capabilities(),
		};
	}

	sendInput(_runInput: ProviderAdapterRunInput) {
		return codexNotImplementedGenerator();
	}

	resumeSession(_session: ProviderAdapterRunInput["session"], _runInput: ProviderAdapterRunInput) {
		return codexNotImplementedGenerator();
	}

	async listHistoricalSessions() {
		const rootPath = `${Bun.env.HOME ?? ""}/.codex/sessions`;
		const fileList = await listJsonlFiles(rootPath);
		const sessions = await Promise.all(fileList.map(parseCodexHistoricalSession));
		return sessions
			.filter((session) => session !== null)
			.sort((left, right) => right.updateTime - left.updateTime);
	}
}
