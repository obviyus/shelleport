import { ChevronRight, Loader2, X } from "lucide-react";
import { type ComponentType, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
	HostEvent,
	HostSession,
	PendingRequest,
	RequestResponsePayload,
	SessionLimit,
	SessionStatus,
} from "~/shared/shelleport";

type ImagePreview = {
	name: string;
	url: string;
};

type CodeFileProps = {
	file: {
		contents: string;
		lang: string;
		name: string;
	};
	options: {
		theme: string;
	};
};

export type DraftImage = ImagePreview & {
	file: File;
};

type UsageSnapshot = {
	limit: SessionLimit | null;
};

type LimitSnapshot = SessionLimit & {
	window: string;
};

function MarkdownMessage({ text }: { text: string }) {
	return (
		<ReactMarkdown
			remarkPlugins={[remarkGfm]}
			components={{
				h1: ({ children }) => (
					<h1 className="mt-4 mb-2 text-sm font-semibold text-foreground first:mt-0">{children}</h1>
				),
				h2: ({ children }) => (
					<h2 className="mt-4 mb-2 text-xs font-semibold text-foreground first:mt-0">{children}</h2>
				),
				h3: ({ children }) => (
					<h3 className="mt-3 mb-1.5 text-xs font-medium text-foreground/92 first:mt-0">
						{children}
					</h3>
				),
				h4: ({ children }) => (
					<h4 className="mt-3 mb-1.5 text-[11px] font-medium text-foreground/88 first:mt-0">
						{children}
					</h4>
				),
				h5: ({ children }) => (
					<h5 className="mt-3 mb-1 text-[11px] font-medium text-foreground/84 first:mt-0">
						{children}
					</h5>
				),
				h6: ({ children }) => (
					<h6 className="mt-3 mb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-foreground/76 first:mt-0">
						{children}
					</h6>
				),
				p: ({ children }) => (
					<p className="my-0 whitespace-pre-wrap text-xs leading-[1.8] text-foreground/85">
						{children}
					</p>
				),
				a: ({ href, children }) => (
					<a
						href={href}
						target="_blank"
						rel="noreferrer"
						className="text-foreground underline decoration-foreground/30 underline-offset-2 transition hover:decoration-foreground/70"
					>
						{children}
					</a>
				),
				ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5 text-xs">{children}</ul>,
				ol: ({ children }) => (
					<ol className="my-2 list-decimal space-y-1 pl-5 text-xs">{children}</ol>
				),
				li: ({ children }) => (
					<li className="text-foreground/84 marker:text-muted-foreground">{children}</li>
				),
				blockquote: ({ children }) => (
					<blockquote className="my-3 border-l border-foreground/14 pl-3 text-foreground/72">
						{children}
					</blockquote>
				),
				hr: () => <hr className="my-4 border-0 border-t border-foreground/10" />,
				code: ({ className, children }) => {
					const isBlock = typeof className === "string" && className.length > 0;

					if (isBlock) {
						return <code className={className}>{children}</code>;
					}

					return (
						<code className="rounded border border-foreground/10 bg-card px-1.5 py-0.5 text-[11px] text-foreground/88">
							{children}
						</code>
					);
				},
				pre: ({ children }) => (
					<pre className="my-3 overflow-x-auto rounded-md border border-foreground/10 bg-card/90 px-3 py-2.5 text-[11px] leading-[1.7] text-foreground/80">
						{children}
					</pre>
				),
				table: ({ children }) => (
					<div className="my-3 overflow-x-auto rounded-md border border-foreground/10">
						<table className="w-full min-w-[20rem] border-collapse text-left text-[11px]">
							{children}
						</table>
					</div>
				),
				thead: ({ children }) => (
					<thead className="bg-card/90 text-foreground/84">{children}</thead>
				),
				tbody: ({ children }) => <tbody className="divide-y divide-foreground/8">{children}</tbody>,
				tr: ({ children }) => <tr className="align-top">{children}</tr>,
				th: ({ children }) => (
					<th className="border-b border-foreground/10 px-3 py-2 font-medium">{children}</th>
				),
				td: ({ children }) => <td className="px-3 py-2 text-foreground/78">{children}</td>,
				input: ({ checked }) => (
					<input
						type="checkbox"
						checked={checked}
						readOnly
						disabled
						className="mr-2 size-3 rounded border border-foreground/20 accent-white"
					/>
				),
			}}
		>
			{text}
		</ReactMarkdown>
	);
}

function getToolPreview(event: HostEvent): string {
	const input = event.data.input as Record<string, unknown> | undefined;
	const inputJson = readString(event.data.inputJson);

	if (!input) {
		if (inputJson.length > 0) {
			return inputJson.slice(0, 100);
		}

		return event.summary;
	}

	const tool = event.data.toolName as string;

	switch (tool) {
		case "Read":
		case "Write":
		case "Edit":
			return (input.file_path as string) ?? event.summary;
		case "Bash":
			return ((input.command as string) ?? "").slice(0, 100) || event.summary;
		case "Grep":
			return `/${typeof input.pattern === "string" ? input.pattern : ""}/${typeof input.path === "string" ? ` ${input.path}` : ""}`;
		case "Glob":
			return (input.pattern as string) ?? event.summary;
		case "Agent":
			return (input.description as string) ?? event.summary;
		default:
			return event.summary;
	}
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}\n… (${text.length - max} more chars)`;
}

function readString(value: unknown) {
	return typeof value === "string" ? value : "";
}

function readLimit(value: unknown): SessionLimit | null {
	if (!value || typeof value !== "object") {
		return null;
	}

	const limit = value as Record<string, unknown>;

	return {
		status: typeof limit.status === "string" ? limit.status : null,
		resetsAt: typeof limit.resetsAt === "number" ? limit.resetsAt : null,
		window: typeof limit.window === "string" ? limit.window : null,
		isUsingOverage: typeof limit.isUsingOverage === "boolean" ? limit.isUsingOverage : null,
		utilization: typeof limit.utilization === "number" ? limit.utilization : null,
	};
}

function getSessionLimitMap(entries: HostEvent[]) {
	const limits = new Map<string, LimitSnapshot>();

	for (const entry of entries) {
		const limit = readLimit(entry.data.limit);

		if (!limit?.window) {
			continue;
		}

		limits.set(limit.window, {
			...limit,
			window: limit.window,
		});
	}

	return limits;
}

function getUsageSnapshot(entries: HostEvent[]): UsageSnapshot {
	const limits = getSessionLimitMap(entries);
	let limit: SessionLimit | null = null;

	for (const candidate of limits.values()) {
		limit = candidate;
	}

	return { limit };
}

function formatMetricCount(value: number) {
	if (value >= 100_000) {
		return `${Math.round(value / 1_000)}k`;
	}

	if (value >= 10_000) {
		return `${(value / 1_000).toFixed(1)}k`;
	}

	return value.toLocaleString();
}

function formatCostUsd(value: number) {
	if (value >= 1) {
		return `$${value.toFixed(2)}`;
	}

	if (value >= 0.01) {
		return `$${value.toFixed(3)}`;
	}

	return `$${value.toFixed(4)}`;
}

function formatResetCountdown(now: number, resetTime: number) {
	const remainingMs = resetTime - now;

	if (remainingMs <= 0) {
		return "now";
	}

	const totalMinutes = Math.ceil(remainingMs / 60_000);

	if (totalMinutes < 60) {
		return `${totalMinutes}m`;
	}

	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;

	if (hours < 24) {
		return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
	}

	const days = Math.floor(hours / 24);
	const remainingHours = hours % 24;
	return remainingHours === 0 ? `${days}d` : `${days}d ${remainingHours}h`;
}

function formatLimitWindow(value: string) {
	return value.replace(/_/g, " ");
}

export function getSessionLimits(entries: HostEvent[]) {
	const limits = getSessionLimitMap(entries);
	return orderSessionLimits([...limits.values()]);
}

export function orderSessionLimits(limits: SessionLimit[]) {
	const orderedWindows = ["five_hour", "weekly"];
	const ordered: LimitSnapshot[] = [];

	for (const window of orderedWindows) {
		const limit = limits.find((candidate) => candidate.window === window);

		if (limit) {
			ordered.push(limit as LimitSnapshot);
		}
	}

	for (const limit of limits) {
		if (!limit.window || orderedWindows.includes(limit.window)) {
			continue;
		}

		ordered.push(limit as LimitSnapshot);
	}

	return ordered;
}

export function formatSessionLimitLabel(window: string) {
	if (window === "five_hour") {
		return "5 hour";
	}

	if (window === "weekly") {
		return "Weekly";
	}

	return formatLimitWindow(window);
}

export function formatSessionLimitReset(limit: SessionLimit, now: number) {
	if (limit.resetsAt === null) {
		return limit.status ?? "active";
	}

	return `resets in ${formatResetCountdown(now, limit.resetsAt)}`;
}

export function formatSessionLimitUsage(limit: SessionLimit) {
	if (limit.utilization === null) {
		return limit.status ?? "active";
	}

	return `${Math.round(limit.utilization)}% used`;
}

function getHighlightedFileName(call: HostEvent) {
	const toolName = call.data.toolName as string;
	const input = call.data.input as Record<string, unknown> | undefined;

	if (!input) {
		return `${toolName.toLowerCase()}-output.txt`;
	}

	if (toolName === "Read" || toolName === "Write" || toolName === "Edit") {
		const filePath = input.file_path;

		if (typeof filePath === "string" && filePath.length > 0) {
			return filePath.split("/").at(-1) ?? "file.txt";
		}
	}

	if (toolName === "Bash") {
		const command = typeof input.command === "string" ? input.command : "";
		return /\bgit\s+diff\b/.test(command) ? "bash-output.diff" : "bash-output.sh";
	}

	if (toolName === "Grep") {
		const path = input.path;

		if (typeof path === "string" && path.length > 0) {
			return path.split("/").at(-1) ?? "grep-output.txt";
		}
	}

	return `${toolName.toLowerCase()}-output.txt`;
}

function stripReadLineNumbers(text: string) {
	const lines = text.split("\n");
	let matched = 0;
	let firstLineNumber = 1;
	const strippedLines = lines.map((line) => {
		const match = line.match(/^(\s*)(\d+)→(.*)$/);

		if (!match) {
			return line;
		}

		matched += 1;

		if (matched === 1) {
			firstLineNumber = Number(match[2]);
		}

		const [, indent, , content] = match;
		return `${indent}${content}`;
	});

	return {
		firstLineNumber,
		matched,
		text: strippedLines.join("\n"),
	};
}

function isDiffStatLine(line: string) {
	return /^ .+\|\s+\d+\s+[+-]+$/.test(line);
}

function isDiffSummaryLine(line: string) {
	return /^\s*\d+\sfiles?\schanged/.test(line);
}

function isDiffStatText(text: string) {
	const lines = text.split("\n");
	return (
		lines.some(isDiffStatLine) &&
		lines.every((line) => line.length === 0 || isDiffStatLine(line) || isDiffSummaryLine(line))
	);
}

function DiffStatBlock({ text }: { text: string }) {
	return (
		<div className="my-2 overflow-hidden rounded-md border border-foreground/10 bg-card/90">
			<div className="divide-y divide-foreground/8">
				{text
					.split("\n")
					.filter(Boolean)
					.map((line, index) => {
						if (isDiffSummaryLine(line)) {
							return (
								<div
									key={`${line}-${index}`}
									className="px-3 py-2 text-[11px] text-muted-foreground/82"
								>
									{line}
								</div>
							);
						}

						const match = line.match(/^(.*?\|)(\s+\d+\s+)([+-]+)$/);

						if (!match) {
							return (
								<div key={`${line}-${index}`} className="px-3 py-2 text-[11px] text-foreground/78">
									{line}
								</div>
							);
						}

						const [, fileName, count, markers] = match;
						return (
							<div
								key={`${line}-${index}`}
								className="grid grid-cols-[minmax(0,1fr)_auto_minmax(4rem,9rem)] items-center gap-3 px-3 py-2 text-[11px]"
							>
								<span className="truncate text-foreground/84">{fileName.trim()}</span>
								<span className="text-muted-foreground/72">{count.trim()}</span>
								<span className="overflow-hidden rounded bg-background/60 px-2 py-1 font-mono text-[10px] leading-none text-foreground/82">
									{markers}
								</span>
							</div>
						);
					})}
			</div>
		</div>
	);
}

function looksLikeDiff(text: string) {
	return (
		/^diff --git/m.test(text) || /^@@ /m.test(text) || /^--- /m.test(text) || /^\+\+\+ /m.test(text)
	);
}

function getHighlightedContent(call: HostEvent, content: string) {
	return call.data.toolName === "Read" ? stripReadLineNumbers(content).text : content;
}

function getHighlightedLanguage(call: HostEvent, fileName: string, content: string) {
	const toolName = call.data.toolName as string;
	const input = call.data.input as Record<string, unknown> | undefined;

	if (toolName === "Bash") {
		const command = typeof input?.command === "string" ? input.command : "";
		return /\bgit\s+diff\b/.test(command) ? "diff" : "zsh";
	}

	if (looksLikeDiff(content)) {
		return "diff";
	}

	return getLanguageFromFileName(fileName);
}

function getLanguageFromFileName(fileName: string) {
	const extension = fileName.split(".").at(-1)?.toLowerCase() ?? "";

	switch (extension) {
		case "cjs":
		case "js":
		case "mjs":
			return "javascript";
		case "cts":
		case "mts":
		case "ts":
			return "typescript";
		case "tsx":
			return "tsx";
		case "jsx":
			return "jsx";
		case "md":
			return "markdown";
		case "sh":
		case "zsh":
			return "bash";
		case "yml":
			return "yaml";
		default:
			return extension || "text";
	}
}

function LazyCodeFile({
	content,
	fileName,
	language,
}: {
	content: string;
	fileName: string;
	language: string;
}) {
	const [CodeFile, setCodeFile] = useState<ComponentType<CodeFileProps> | null>(null);

	useEffect(() => {
		let cancelled = false;

		void import("@pierre/diffs/react").then((module) => {
			if (!cancelled) {
				setCodeFile(() => module.File);
			}
		});

		return () => {
			cancelled = true;
		};
	}, []);

	if (!CodeFile) {
		return (
			<pre className="overflow-x-auto px-3 py-2.5 text-[11px] leading-[1.7] whitespace-pre-wrap text-foreground/80">
				{truncate(content, 12_000)}
			</pre>
		);
	}

	return (
		<CodeFile
			file={{
				contents: truncate(content, 50_000),
				lang: language,
				name: fileName,
			}}
			options={{
				theme: "github-dark",
			}}
		/>
	);
}

function replaceImageExtension(name: string) {
	return name.replace(/\.[A-Za-z0-9]+$/, "") || "image";
}

export async function normalizeDraftImage(file: File): Promise<DraftImage> {
	const objectUrl = URL.createObjectURL(file);

	try {
		const image = await new Promise<HTMLImageElement>((resolve, reject) => {
			const element = new Image();
			element.onload = () => resolve(element);
			element.onerror = () => reject(new Error("Could not process image"));
			element.src = objectUrl;
		});
		const canvas = document.createElement("canvas");
		canvas.width = image.naturalWidth;
		canvas.height = image.naturalHeight;
		const context = canvas.getContext("2d");

		if (!context) {
			throw new Error("Could not process image");
		}

		context.drawImage(image, 0, 0);

		const blob = await new Promise<Blob>((resolve, reject) => {
			canvas.toBlob((nextBlob) => {
				if (!nextBlob) {
					reject(new Error("Could not process image"));
					return;
				}

				resolve(nextBlob);
			}, "image/png");
		});

		const normalizedName = `${replaceImageExtension(file.name)}.png`;
		const normalizedFile = new File([blob], normalizedName, {
			type: "image/png",
			lastModified: Date.now(),
		});

		return {
			file: normalizedFile,
			name: normalizedFile.name,
			url: URL.createObjectURL(normalizedFile),
		};
	} finally {
		URL.revokeObjectURL(objectUrl);
	}
}

const STATUS_STYLES: Record<SessionStatus, string> = {
	idle: "bg-foreground/20",
	running: "bg-foreground animate-status-pulse",
	waiting: "bg-foreground/50 animate-status-pulse",
	retrying: "bg-amber-500 animate-status-pulse",
	failed: "bg-foreground/40",
	interrupted: "bg-foreground/30",
};

export function formatStatus(session: HostSession, now: number) {
	if (session.status === "retrying") {
		const seconds =
			session.statusDetail.nextRetryTime === null
				? null
				: Math.max(0, Math.ceil((session.statusDetail.nextRetryTime - now) / 1000));
		return seconds === null ? "retrying" : `retrying in ${seconds}s`;
	}

	if (session.status === "waiting") {
		return session.statusDetail.waitKind === "approval" ? "waiting approval" : "waiting";
	}

	return session.status;
}

export function getStatusMessage(session: HostSession) {
	if (session.status === "retrying") {
		return session.statusDetail.message;
	}

	if (session.status === "waiting") {
		if (session.statusDetail.blockReason === "sandbox") {
			return "Request blocked by sandbox. Review the required action below.";
		}

		return session.statusDetail.waitKind === "approval"
			? "Waiting for approval to continue."
			: "Waiting for input to continue.";
	}

	if (session.status === "failed") {
		return session.statusDetail.message;
	}

	return null;
}

export function getSidebarMeta(session: HostSession, now: number) {
	if (session.status === "retrying" && session.statusDetail.nextRetryTime !== null) {
		const seconds = Math.max(0, Math.ceil((session.statusDetail.nextRetryTime - now) / 1000));
		return `retrying in ${seconds}s`;
	}

	if (session.status === "waiting") {
		return session.statusDetail.waitKind === "approval" ? "waiting approval" : "waiting";
	}

	if (session.status === "failed") {
		return session.statusDetail.message ?? "failed";
	}

	return session.cwd;
}

export function getSessionUsageBadges(
	session: Pick<HostSession, "usage"> | null,
	entries: HostEvent[],
	now: number,
) {
	const badges: string[] = [];
	const { limit } = getUsageSnapshot(entries);
	const usage = session?.usage ?? null;

	if (usage) {
		badges.push(`in ${formatMetricCount(usage.inputTokens)}`);
		badges.push(`out ${formatMetricCount(usage.outputTokens)}`);

		if (usage.cacheReadInputTokens > 0) {
			badges.push(`cache read ${formatMetricCount(usage.cacheReadInputTokens)}`);
		}

		if (usage.cacheCreationInputTokens > 0) {
			badges.push(`cache write ${formatMetricCount(usage.cacheCreationInputTokens)}`);
		}

		if (usage.costUsd !== null) {
			badges.push(formatCostUsd(usage.costUsd));
		}
	}

	if (limit?.window && limit.resetsAt !== null) {
		const prefix = limit.status && limit.status !== "allowed" ? `${limit.status} ` : "";
		badges.push(
			`${prefix}${formatLimitWindow(limit.window)} resets in ${formatResetCountdown(now, limit.resetsAt)}`,
		);
	}

	return badges;
}

export function getSidebarTitle(session: HostSession) {
	return `${session.title}\n${session.cwd}`;
}

export function StatusDot({ status }: { status: SessionStatus }) {
	return <span className={`inline-block size-1.5 rounded-full ${STATUS_STYLES[status]}`} />;
}

type ToolGroup = {
	call: HostEvent;
	result: HostEvent | null;
	type: "tool";
};

type AssistantTextRunGroup = {
	entries: HostEvent[];
	type: "assistant-text-run";
};

type PassthroughGroup = {
	entry: HostEvent;
	type: "single";
};

export type GroupedEntry = ToolGroup | AssistantTextRunGroup | PassthroughGroup;

function isAssistantTextEvent(event: HostEvent | undefined) {
	return !!event && event.kind === "text" && event.data.role === "assistant";
}

export function groupStream(entries: HostEvent[]): GroupedEntry[] {
	const grouped: GroupedEntry[] = [];

	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];

		if (entry.kind === "tool-call") {
			let call = entry;
			const toolUseId = typeof entry.data.toolUseId === "string" ? entry.data.toolUseId : null;

			while (true) {
				const nextCall = entries[index + 1];

				if (nextCall?.kind === "tool-call" && toolUseId && nextCall.data.toolUseId === toolUseId) {
					index += 1;
					call = nextCall;
					continue;
				}

				break;
			}

			const next = entries[index + 1];

			if (
				next?.kind === "tool-result" &&
				(!toolUseId || typeof next.data.toolUseId !== "string" || next.data.toolUseId === toolUseId)
			) {
				grouped.push({ call, result: next, type: "tool" });
				index += 1;
			} else {
				grouped.push({ call, result: null, type: "tool" });
			}
			continue;
		}

		if (entry.kind === "tool-result" && entries[index - 1]?.kind === "tool-call") {
			continue;
		}

		if (isAssistantTextEvent(entry)) {
			const run = [entry];

			while (isAssistantTextEvent(entries[index + 1])) {
				index += 1;
				run.push(entries[index]);
			}

			grouped.push({ entries: run, type: "assistant-text-run" });
			continue;
		}

		grouped.push({ entry, type: "single" });
	}

	return grouped;
}

export function GroupedEntryRenderer({ group }: { group: GroupedEntry }) {
	if (group.type === "tool") {
		return <ToolCard call={group.call} result={group.result} />;
	}

	if (group.type === "assistant-text-run") {
		return <AssistantTextRunRenderer entries={group.entries} />;
	}

	return <EventRenderer event={group.entry} />;
}

function UserMessageRenderer({ event }: { event: HostEvent }) {
	const attachments = Array.isArray(event.data.attachments)
		? event.data.attachments.filter(
				(attachment): attachment is { contentType: string; name: string; path?: string } =>
					typeof attachment === "object" &&
					attachment !== null &&
					typeof attachment.name === "string" &&
					typeof attachment.contentType === "string",
			)
		: [];

	return (
		<div className="animate-event-enter group mb-4 flex justify-end">
			<div className="max-w-[90%] min-w-[14rem]">
				<div className="mb-1 px-1 text-right text-[10px] uppercase tracking-[0.14em] text-muted-foreground/55">
					You
				</div>
				<div className="overflow-hidden rounded-xl rounded-tr-sm border border-foreground/10 bg-card/95 shadow-[inset_0_1px_0_oklch(1_0_0_/_0.03)]">
					<div className="px-4 py-3 text-xs leading-[1.8] text-foreground/88">
						<MarkdownMessage text={readString(event.data.text)} />
					</div>
					{attachments.length > 0 && (
						<div className="border-t border-foreground/8 bg-background/40 px-4 py-2">
							<div className="flex flex-wrap gap-2">
								{attachments.map((attachment) => (
									<div
										key={attachment.name}
										className="rounded-md border border-foreground/10 bg-background/70 px-2 py-1 text-[10px] text-muted-foreground/82"
									>
										{attachment.name}
									</div>
								))}
							</div>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

function ToolCard({ call, result }: { call: HostEvent; result: HostEvent | null }) {
	const [shouldRenderCode, setShouldRenderCode] = useState(false);
	const output = result ? readString(result.data.output) : "";
	const hasOutput = output.length > 0;
	const isRunning = result === null;
	const fileName = getHighlightedFileName(call);
	const language = getHighlightedLanguage(call, fileName, output);
	const content = getHighlightedContent(call, output);
	const isDiffStat = hasOutput && isDiffStatText(content);
	const strippedRead = call.data.toolName === "Read" ? stripReadLineNumbers(output) : null;

	return (
		<details
			className="animate-event-enter group mb-4 overflow-hidden rounded-lg border border-foreground/10 bg-card/92 shadow-[inset_0_1px_0_oklch(1_0_0_/_0.03)]"
			onToggle={(event) => {
				if (event.currentTarget.open) {
					setShouldRenderCode(true);
				}
			}}
		>
			<summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 transition hover:bg-accent/45">
				<ChevronRight className="size-3 shrink-0 text-muted-foreground transition group-open:rotate-90" />
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<span className="truncate text-[11px] font-medium text-foreground">
							{call.data.toolName as string}
						</span>
						{isRunning ? (
							<span className="inline-flex items-center gap-1 rounded border border-foreground/10 px-1.5 py-px text-[9px] uppercase tracking-[0.12em] text-muted-foreground/82">
								<Loader2 className="size-2.5 animate-spin" />
								running
							</span>
						) : result?.data.isError ? (
							<span className="rounded border border-destructive/20 px-1.5 py-px text-[9px] uppercase tracking-[0.12em] text-destructive/80">
								error
							</span>
						) : (
							<span className="rounded border border-foreground/10 px-1.5 py-px text-[9px] uppercase tracking-[0.12em] text-muted-foreground/72">
								done
							</span>
						)}
					</div>
					<p className="mt-0.5 truncate text-[10px] text-muted-foreground/75">
						{getToolPreview(call)}
					</p>
				</div>
			</summary>
			<div className="border-t border-foreground/8 bg-background/35 px-4 py-3">
				{hasOutput ? (
					isDiffStat ? (
						<DiffStatBlock text={content} />
					) : (
						<div className="overflow-hidden rounded-md border border-foreground/10 bg-card/90">
							<div className="flex items-center justify-between border-b border-foreground/8 px-3 py-2 text-[10px] text-muted-foreground/72">
								<span>{fileName}</span>
								{strippedRead && strippedRead.matched > 0 && (
									<span>starts at line {strippedRead.firstLineNumber}</span>
								)}
							</div>
							<div className="tool-code-view">
								{shouldRenderCode ? (
									<LazyCodeFile content={content} fileName={fileName} language={language} />
								) : (
									<div className="px-3 py-2 text-[11px] text-muted-foreground/72">
										Open to load preview
									</div>
								)}
							</div>
						</div>
					)
				) : (
					<p className="text-[11px] text-muted-foreground/72">No output</p>
				)}
			</div>
		</details>
	);
}

function AssistantTextRunRenderer({ entries }: { entries: HostEvent[] }) {
	return (
		<div className="animate-event-enter mb-4">
			<div className="mb-1 px-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground/55">
				Claude
			</div>
			<div className="overflow-hidden rounded-xl rounded-tl-sm border border-foreground/10 bg-card/95 shadow-[inset_0_1px_0_oklch(1_0_0_/_0.03)]">
				<div className="px-4 py-3 text-xs leading-[1.8] text-foreground/88">
					<MarkdownMessage text={entries.map((entry) => readString(entry.data.text)).join("")} />
				</div>
			</div>
		</div>
	);
}

function EventRenderer({ event }: { event: HostEvent }) {
	if (event.kind === "text") {
		return event.data.role === "user" ? (
			<UserMessageRenderer event={event} />
		) : (
			<div className="animate-event-enter mb-4">
				<div className="mb-1 px-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground/55">
					Claude
				</div>
				<div className="overflow-hidden rounded-xl rounded-tl-sm border border-foreground/10 bg-card/95 shadow-[inset_0_1px_0_oklch(1_0_0_/_0.03)]">
					<div className="px-4 py-3 text-xs leading-[1.8] text-foreground/88">
						<MarkdownMessage text={readString(event.data.text)} />
					</div>
				</div>
			</div>
		);
	}

	if (event.kind === "error") {
		return (
			<div className="animate-event-enter mb-4 rounded-lg border border-destructive/18 bg-destructive/10 px-4 py-3 text-xs text-destructive/88">
				{readString(event.data.message) || event.summary}
			</div>
		);
	}

	if (event.kind === "state") {
		return (
			<div className="animate-event-enter mb-4 rounded-lg border border-foreground/10 bg-card/88 px-4 py-2 text-[11px] text-muted-foreground/82">
				{readString(event.data.message) || event.summary}
			</div>
		);
	}

	if (event.kind === "system") {
		return (
			<div className="animate-event-enter mb-4 text-center text-[10px] uppercase tracking-[0.14em] text-muted-foreground/50">
				{event.summary}
			</div>
		);
	}

	return null;
}

export function PendingRequestBanner({
	request,
	onRespond,
}: {
	request: PendingRequest;
	onRespond: (id: string, payload: RequestResponsePayload) => void;
}) {
	return (
		<div className="border-t border-foreground/10 bg-accent/80 px-6 py-3.5">
			<div className="mx-auto flex max-w-[70rem] items-center justify-between gap-4">
				<span className="min-w-0 truncate text-xs text-foreground/88">{request.prompt}</span>
				<div className="flex shrink-0 gap-2">
					<button
						type="button"
						onClick={() => onRespond(request.id, { decision: "allow" })}
						className="rounded border border-foreground/20 bg-foreground px-3 py-1 text-[11px] font-medium text-background transition hover:bg-foreground/90"
					>
						Allow
					</button>
					<button
						type="button"
						onClick={() => onRespond(request.id, { decision: "deny" })}
						className="rounded border border-border px-3 py-1 text-[11px] font-medium text-muted-foreground transition hover:border-foreground/16 hover:text-foreground"
					>
						Deny
					</button>
				</div>
			</div>
		</div>
	);
}

export function DraftImagePreview({
	image,
	onRemove,
}: {
	image: DraftImage;
	onRemove: () => void;
}) {
	return (
		<div className="relative overflow-hidden rounded-md border border-foreground/10 bg-background">
			<img src={image.url} alt={image.name} className="h-20 w-20 object-cover" />
			<button
				type="button"
				onClick={onRemove}
				className="absolute top-1 right-1 flex size-5 items-center justify-center rounded-full bg-background/92 text-foreground/72 shadow-sm transition hover:text-foreground"
				aria-label={`Remove ${image.name}`}
			>
				<X className="size-3" />
			</button>
		</div>
	);
}
