import { Check, ChevronRight, Copy, FileIcon, Loader2, X } from "lucide-react";
import { createElement, Suspense, lazy, useCallback, useState } from "react";
import type { RefCallback } from "react";
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

export type DraftAttachment = {
	name: string;
	previewUrl: string | null;
	file: File;
};

type LimitSnapshot = SessionLimit & {
	window: string;
};

const DiffCodeFile = lazy(async () => {
	const module = await import("@pierre/diffs/react");
	return { default: module.File };
});

export const LazyEditDiff = lazy(async () => {
	const { useFileDiffInstance } = await import("@pierre/diffs/react");

	function EditDiffView({
		oldPath,
		oldContents,
		newPath,
		newContents,
	}: {
		oldPath: string;
		oldContents: string;
		newPath: string;
		newContents: string;
	}) {
		const { ref } = useFileDiffInstance({
			oldFile: { name: oldPath, contents: oldContents },
			newFile: { name: newPath, contents: newContents },
			fileDiff: undefined,
			options: { theme: "github-dark" },
			lineAnnotations: undefined,
			selectedLines: undefined,
			prerenderedHTML: undefined,
			hasGutterRenderUtility: false,
		});
		return createElement("diffs-container" as "div", {
			ref: ref as RefCallback<HTMLDivElement>,
		});
	}

	return { default: EditDiffView };
});

function MarkdownMessage({ text }: { text: string }) {
	return (
		<ReactMarkdown
			remarkPlugins={[remarkGfm]}
			components={{
				h1: ({ children }) => (
					<h1 className="mt-4 mb-2 text-base font-semibold text-foreground first:mt-0">
						{children}
					</h1>
				),
				h2: ({ children }) => (
					<h2 className="mt-4 mb-2 text-sm font-semibold text-foreground first:mt-0">{children}</h2>
				),
				h3: ({ children }) => (
					<h3 className="mt-3 mb-1.5 text-sm font-medium text-foreground/92 first:mt-0">
						{children}
					</h3>
				),
				h4: ({ children }) => (
					<h4 className="mt-3 mb-1.5 text-sm font-medium text-foreground/92 first:mt-0">
						{children}
					</h4>
				),
				h5: ({ children }) => (
					<h5 className="mt-3 mb-1 text-sm font-medium text-foreground/90 first:mt-0">
						{children}
					</h5>
				),
				h6: ({ children }) => (
					<h6 className="mt-3 mb-1 text-xs font-medium uppercase tracking-[0.08em] text-foreground/76 first:mt-0">
						{children}
					</h6>
				),
				p: ({ children }) => (
					<p className="my-0 whitespace-pre-wrap text-sm leading-[1.8] text-foreground/90">
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
				ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5 text-sm">{children}</ul>,
				ol: ({ children }) => (
					<ol className="my-2 list-decimal space-y-1 pl-5 text-sm">{children}</ol>
				),
				li: ({ children }) => (
					<li className="text-foreground/90 marker:text-muted-foreground">{children}</li>
				),
				blockquote: ({ children }) => (
					<blockquote className="my-3 border-l border-foreground/14 pl-3 text-foreground/82">
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
						<code className="rounded border border-foreground/10 bg-card px-1 py-0.5 text-[0.8em] text-foreground/92">
							{children}
						</code>
					);
				},
				pre: ({ children, node }) => {
					const codeText =
						node?.children?.[0]?.type === "element" &&
						node.children[0].tagName === "code" &&
						node.children[0].children?.[0]?.type === "text"
							? node.children[0].children[0].value
							: "";
					return (
						<div className="group/pre relative my-3">
							<pre className="overflow-x-auto rounded-md border border-foreground/10 bg-card/90 px-3 py-2.5 text-xs leading-[1.7] text-foreground/86">
								{children}
							</pre>
							{codeText.length > 0 && (
								<div className="sticky bottom-2 float-right -mt-8 mr-1.5 opacity-0 transition group-hover/pre:opacity-100">
									<CopyButton text={codeText} className="size-7 bg-card/95 shadow-sm" />
								</div>
							)}
						</div>
					);
				},
				table: ({ children }) => (
					<div className="my-3 overflow-x-auto rounded-md border border-foreground/10">
						<table className="w-full min-w-[20rem] border-collapse text-left text-sm">
							{children}
						</table>
					</div>
				),
				thead: ({ children }) => (
					<thead className="bg-card/90 text-foreground/90">{children}</thead>
				),
				tbody: ({ children }) => <tbody className="divide-y divide-foreground/8">{children}</tbody>,
				tr: ({ children }) => <tr className="align-top">{children}</tr>,
				th: ({ children }) => (
					<th className="border-b border-foreground/10 px-3 py-2 font-medium">{children}</th>
				),
				td: ({ children }) => <td className="px-3 py-2 text-foreground/84">{children}</td>,
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

export async function copyToClipboard(text: string) {
	if (navigator.clipboard) {
		return navigator.clipboard.writeText(text);
	}
	const ta = document.createElement("textarea");
	ta.value = text;
	ta.style.position = "fixed";
	ta.style.opacity = "0";
	document.body.appendChild(ta);
	ta.select();
	document.execCommand("copy");
	document.body.removeChild(ta);
}

function CopyButton({ text, className }: { text: string; className?: string }) {
	const [copied, setCopied] = useState(false);

	const handleCopy = useCallback(() => {
		void copyToClipboard(text).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		});
	}, [text]);

	return (
		<button
			type="button"
			onClick={handleCopy}
			className={`flex items-center justify-center rounded border border-foreground/10 text-muted-foreground transition hover:border-foreground/18 hover:text-foreground ${className ?? "size-6"}`}
			title="Copy to clipboard"
		>
			{copied ? <Check className="size-3" /> : <Copy className="size-3" />}
		</button>
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

function formatMetricCount(value: number) {
	if (value >= 1_000_000) {
		return `${(value / 1_000_000).toFixed(1)}M`;
	}

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
	const aliases: Record<string, string> = { seven_day: "weekly" };
	const ordered: LimitSnapshot[] = [];
	const includedWindows = new Set<string>();

	for (const window of orderedWindows) {
		const limit = limits.find((candidate) => candidate.window === window);

		if (limit) {
			ordered.push(limit as LimitSnapshot);
			includedWindows.add(window);
		}
	}

	for (const limit of limits) {
		if (!limit.window || orderedWindows.includes(limit.window)) {
			continue;
		}

		const canonical = limit.window ? aliases[limit.window] : undefined;

		if (canonical && includedWindows.has(canonical)) {
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

	if (window === "weekly" || window === "seven_day") {
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
		return null;
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
								<div key={`${line}-${index}`} className="px-3 py-2 text-xs text-muted-foreground">
									{line}
								</div>
							);
						}

						const match = line.match(/^(.*?\|)(\s+\d+\s+)([+-]+)$/);

						if (!match) {
							return (
								<div key={`${line}-${index}`} className="px-3 py-2 text-xs text-foreground/84">
									{line}
								</div>
							);
						}

						const [, fileName, count, markers] = match;
						return (
							<div
								key={`${line}-${index}`}
								className="grid grid-cols-[minmax(0,1fr)_auto_minmax(4rem,9rem)] items-center gap-3 px-3 py-2 text-xs"
							>
								<span className="truncate text-foreground/90">{fileName.trim()}</span>
								<span className="text-muted-foreground">{count.trim()}</span>
								<span className="overflow-hidden rounded bg-background/60 px-2 py-1 font-mono text-xs leading-none text-foreground/82">
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
	return (
		<Suspense
			fallback={
				<pre className="overflow-x-auto px-3 py-2.5 text-xs leading-[1.7] whitespace-pre-wrap text-foreground/86">
					{truncate(content, 12_000)}
				</pre>
			}
		>
			<DiffCodeFile
				file={{
					contents: truncate(content, 50_000),
					lang: language,
					name: fileName,
				}}
				options={{
					theme: "github-dark",
				}}
			/>
		</Suspense>
	);
}

function replaceImageExtension(name: string) {
	return name.replace(/\.[A-Za-z0-9]+$/, "") || "image";
}

async function normalizeImageFile(file: File): Promise<DraftAttachment> {
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
			previewUrl: URL.createObjectURL(normalizedFile),
		};
	} finally {
		URL.revokeObjectURL(objectUrl);
	}
}

export async function normalizeDraftAttachment(file: File): Promise<DraftAttachment> {
	if (file.type.startsWith("image/")) {
		return normalizeImageFile(file);
	}

	return {
		file,
		name: file.name,
		previewUrl: null,
	};
}

const STATUS_STYLES: Record<SessionStatus, string> = {
	idle: "bg-slate-400/50",
	running: "bg-emerald-400 animate-status-pulse",
	waiting: "bg-sky-400/70 animate-status-pulse",
	retrying: "bg-amber-500 animate-status-pulse",
	failed: "bg-red-400/60",
	interrupted: "bg-orange-400/50",
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

function formatRelativeTime(now: number, time: number) {
	const deltaMs = now - time;

	if (deltaMs < 60_000) {
		return "just now";
	}

	const minutes = Math.floor(deltaMs / 60_000);

	if (minutes < 60) {
		return `${minutes}m ago`;
	}

	const hours = Math.floor(minutes / 60);

	if (hours < 24) {
		return `${hours}h ago`;
	}

	const days = Math.floor(hours / 24);
	return `${days}d ago`;
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

	if (session.status === "running") {
		return session.cwd;
	}

	return formatRelativeTime(now, session.updateTime);
}

export type SessionHeaderBadge = {
	key: string;
	label: string;
	title?: string;
	visibility: "lg" | "xl";
};

export function getSessionHeaderBadges(session: Pick<HostSession, "usage"> | null) {
	const usage = session?.usage ?? null;

	if (!usage) {
		return [];
	}

	const badges: SessionHeaderBadge[] = [];

	badges.push({
		key: `in:${usage.inputTokens}`,
		label: formatMetricCount(usage.inputTokens),
		visibility: "xl",
	});
	badges.push({
		key: `out:${usage.outputTokens}`,
		label: formatMetricCount(usage.outputTokens),
		visibility: "xl",
	});

	if (usage.cacheReadInputTokens > 0) {
		badges.push({
			key: `cache-read:${usage.cacheReadInputTokens}`,
			label: formatMetricCount(usage.cacheReadInputTokens),
			visibility: "xl",
		});
	}

	if (usage.cacheCreationInputTokens > 0) {
		badges.push({
			key: `cache-write:${usage.cacheCreationInputTokens}`,
			label: formatMetricCount(usage.cacheCreationInputTokens),
			visibility: "xl",
		});
	}

	if (usage.costUsd !== null) {
		badges.push({
			key: `cost:${usage.costUsd}`,
			label: formatCostUsd(usage.costUsd),
			visibility: "xl",
		});
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

type PendingQueue = {
	cursor: number;
	indices: number[];
};

function isAssistantTextEvent(event: HostEvent | undefined) {
	return !!event && event.kind === "text" && event.data.role === "assistant";
}

function isThinkingEvent(event: HostEvent) {
	return event.kind === "text" && event.data.role === "thinking";
}

function isRateLimitSystemEvent(event: HostEvent) {
	return event.kind === "system" && event.summary === "Rate limit update";
}

function isRunCompleteEvent(event: HostEvent) {
	return event.kind === "state" && event.summary === "Claude run complete";
}

function pushPending(queue: PendingQueue, groupIndex: number) {
	queue.indices.push(groupIndex);
}

function peekPending(queue: PendingQueue, matchedGroupIndexes: Set<number>) {
	while (
		queue.cursor < queue.indices.length &&
		matchedGroupIndexes.has(queue.indices[queue.cursor])
	) {
		queue.cursor += 1;
	}

	return queue.cursor < queue.indices.length ? queue.indices[queue.cursor] : null;
}

export function groupStream(entries: HostEvent[]): GroupedEntry[] {
	const grouped: GroupedEntry[] = [];
	const matchedGroupIndexes = new Set<number>();
	const pendingToolOrder: PendingQueue = { cursor: 0, indices: [] };
	const pendingAnonymousTools: PendingQueue = { cursor: 0, indices: [] };
	const pendingToolsById = new Map<string, PendingQueue>();

	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];

		if (entry.kind === "tool-call") {
			const toolUseId = typeof entry.data.toolUseId === "string" ? entry.data.toolUseId : null;
			const lastGroup = grouped.at(-1);

			if (
				toolUseId &&
				lastGroup?.type === "tool" &&
				lastGroup.result === null &&
				lastGroup.call.kind === "tool-call" &&
				lastGroup.call.data.toolUseId === toolUseId
			) {
				lastGroup.call = entry;
				continue;
			}

			const group: ToolGroup = {
				call: entry,
				result: null,
				type: "tool",
			};
			const groupIndex = grouped.push(group) - 1;

			pushPending(pendingToolOrder, groupIndex);

			if (toolUseId) {
				const queue = pendingToolsById.get(toolUseId) ?? { cursor: 0, indices: [] };
				pushPending(queue, groupIndex);
				pendingToolsById.set(toolUseId, queue);
			} else {
				pushPending(pendingAnonymousTools, groupIndex);
			}

			continue;
		}

		if (entry.kind === "tool-result") {
			const toolUseId = typeof entry.data.toolUseId === "string" ? entry.data.toolUseId : null;
			let groupIndex: number | null = null;

			if (toolUseId === null) {
				groupIndex = peekPending(pendingToolOrder, matchedGroupIndexes);
			} else {
				const anonymousGroupIndex = peekPending(pendingAnonymousTools, matchedGroupIndexes);
				const specificGroupIndex = peekPending(
					pendingToolsById.get(toolUseId) ?? { cursor: 0, indices: [] },
					matchedGroupIndexes,
				);

				if (anonymousGroupIndex === null) {
					groupIndex = specificGroupIndex;
				} else if (specificGroupIndex === null) {
					groupIndex = anonymousGroupIndex;
				} else {
					groupIndex = Math.min(anonymousGroupIndex, specificGroupIndex);
				}
			}

			if (groupIndex !== null) {
				const group = grouped[groupIndex];

				if (group?.type === "tool" && group.result === null) {
					group.result = entry;
					matchedGroupIndexes.add(groupIndex);
				}
			}

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

		if (isThinkingEvent(entry)) {
			const lastGroup = grouped.at(-1);

			if (
				lastGroup?.type === "single" &&
				isThinkingEvent(lastGroup.entry) &&
				lastGroup.entry.data.text === entry.data.text
			) {
				continue;
			}
		}

		if (isRateLimitSystemEvent(entry) || isRunCompleteEvent(entry)) {
			continue;
		}

		grouped.push({ entry, type: "single" });
	}

	return grouped;
}

export function streamToMarkdown(entries: HostEvent[]) {
	const grouped = groupStream(entries);
	const parts: string[] = [];

	for (const group of grouped) {
		if (group.type === "assistant-text-run") {
			const text = group.entries.map((entry) => readString(entry.data.text)).join("");

			if (text.length > 0) {
				parts.push(`## Assistant\n\n${text}`);
			}

			continue;
		}

		if (group.type === "tool") {
			const toolName =
				typeof group.call.data.toolName === "string" ? group.call.data.toolName : "Tool";
			const preview = getToolPreview(group.call);
			const result = readToolResultContent(group.result);
			const lines = [`### ${toolName}: \`${preview}\``];

			if (result.length > 0) {
				lines.push(`\n\`\`\`\n${result}\n\`\`\``);
			}

			parts.push(lines.join("\n"));
			continue;
		}

		const entry = group.entry;

		if (entry.kind === "text") {
			const role =
				entry.data.role === "user"
					? "User"
					: entry.data.role === "thinking"
						? "Thinking"
						: "Assistant";
			const text = readString(entry.data.text);

			if (text.length > 0) {
				parts.push(`## ${role}\n\n${text}`);
			}
		}
	}

	return parts.join("\n\n");
}

export type FileEditDiff = {
	added: number;
	removed: number;
	edits: Array<{ oldString: string; newString: string }>;
};

export function getStreamEditDiffs(stream: HostEvent[]): Map<string, FileEditDiff> {
	const resultsByToolUseId = new Map<string, HostEvent>();
	for (const event of stream) {
		if (event.kind === "tool-result") {
			const toolUseId = typeof event.data.toolUseId === "string" ? event.data.toolUseId : null;
			if (toolUseId) resultsByToolUseId.set(toolUseId, event);
		}
	}

	const diffs = new Map<string, FileEditDiff>();
	for (const event of stream) {
		if (event.kind !== "tool-call" || event.data.toolName !== "Edit") continue;
		const input = event.data.input as Record<string, unknown> | undefined;
		if (!input) continue;
		const filePath = typeof input.file_path === "string" ? input.file_path : null;
		const oldString = typeof input.old_string === "string" ? input.old_string : null;
		const newString = typeof input.new_string === "string" ? input.new_string : null;
		if (!filePath || oldString === null || newString === null) continue;
		const toolUseId = typeof event.data.toolUseId === "string" ? event.data.toolUseId : null;
		if (toolUseId) {
			const result = resultsByToolUseId.get(toolUseId);
			if (!result || result.data.isError) continue;
		}
		const existing = diffs.get(filePath) ?? { added: 0, removed: 0, edits: [] };
		existing.removed += oldString.split("\n").length;
		existing.added += newString.split("\n").length;
		existing.edits.push({ oldString, newString });
		diffs.set(filePath, existing);
	}
	return diffs;
}

export function readToolResultContent(result: HostEvent | null) {
	if (!result) {
		return "";
	}

	return readString(result.data.output) || readString(result.data.content);
}

export function friendlyModelLabel(modelId: unknown): string {
	if (typeof modelId !== "string") return "Claude";

	if (modelId.includes("sonnet")) return "Claude Sonnet";
	if (modelId.includes("opus")) return "Claude Opus";
	if (modelId.includes("haiku")) return "Claude Haiku";

	return `Claude (${modelId})`;
}

function getAssistantModel(group: GroupedEntry): string | null {
	if (group.type === "assistant-text-run") {
		const model = group.entries[0]?.data.model;
		return typeof model === "string" ? model : null;
	}

	if (
		group.type !== "single" ||
		group.entry.kind !== "text" ||
		group.entry.data.role !== "assistant"
	) {
		return null;
	}

	const model = group.entry.data.model;
	return typeof model === "string" ? model : null;
}

export function hasMixedAssistantModels(groups: GroupedEntry[]): boolean {
	let firstModel: string | null | undefined;

	for (const group of groups) {
		const model = getAssistantModel(group);

		if (model === null) {
			continue;
		}

		if (firstModel === undefined) {
			firstModel = model;
			continue;
		}

		if (firstModel !== model) {
			return true;
		}
	}

	return false;
}

export function GroupedEntryRenderer({
	group,
	showModelLabel = false,
}: {
	group: GroupedEntry;
	showModelLabel?: boolean;
}) {
	if (group.type === "tool") {
		return <ToolCard call={group.call} result={group.result} />;
	}

	if (group.type === "assistant-text-run") {
		return <AssistantTextRunRenderer entries={group.entries} showModelLabel={showModelLabel} />;
	}

	return <EventRenderer event={group.entry} showModelLabel={showModelLabel} />;
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
			<div className="max-w-[90%] min-w-0 md:min-w-[14rem]">
				<div className="overflow-hidden rounded-lg border border-foreground/10 bg-card/95 shadow-[inset_0_1px_0_oklch(1_0_0_/_0.03)]">
					<div className="px-4 py-3 text-sm leading-[1.8] text-foreground/92">
						<MarkdownMessage text={readString(event.data.text)} />
					</div>
					{attachments.length > 0 && (
						<div className="border-t border-foreground/12 bg-background/40 px-4 py-2">
							<div className="flex flex-wrap gap-2">
								{attachments.map((attachment) => (
									<div
										key={attachment.name}
										className="rounded-md border border-foreground/10 bg-background/70 px-2 py-1 text-xs text-muted-foreground"
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

function getWriteContent(call: HostEvent) {
	const toolName = call.data.toolName as string;

	if (toolName !== "Write" && toolName !== "Edit") {
		return null;
	}

	const input = call.data.input as Record<string, unknown> | undefined;

	if (!input) {
		return null;
	}

	const content =
		typeof input.content === "string"
			? input.content
			: typeof input.new_string === "string"
				? input.new_string
				: null;

	return content && content.length > 0 ? content : null;
}

export function getToolOutput(call: HostEvent, result: HostEvent | null) {
	const resultOutput = readToolResultContent(result);

	if (result?.data.isError) {
		return resultOutput;
	}

	return getWriteContent(call) ?? resultOutput;
}

function ToolCard({ call, result }: { call: HostEvent; result: HostEvent | null }) {
	const [shouldRenderCode, setShouldRenderCode] = useState(false);
	const output = getToolOutput(call, result);
	const hasOutput = output.length > 0;
	const isRunning = result === null;
	const fileName = getHighlightedFileName(call);
	const language = getHighlightedLanguage(call, fileName, output);
	const content = getHighlightedContent(call, output);
	const isDiffStat = hasOutput && isDiffStatText(content);
	const strippedRead = call.data.toolName === "Read" ? stripReadLineNumbers(output) : null;

	return (
		<details
			className="animate-event-enter group ml-[18px] md:ml-[22px]"
			onToggle={(event) => {
				if (event.currentTarget.open) {
					setShouldRenderCode(true);
				}
			}}
		>
			<summary className="flex cursor-pointer list-none items-center gap-2 py-1 transition hover:bg-accent/30">
				<ChevronRight className="size-2.5 shrink-0 text-muted-foreground transition group-open:rotate-90" />
				<span className="text-xs font-medium text-sky-300 shrink-0">
					{call.data.toolName as string}
				</span>
				{isRunning ? (
					<Loader2 className="size-2.5 shrink-0 animate-spin text-primary" />
				) : result?.data.isError ? (
					<X className="size-2.5 shrink-0 text-destructive" />
				) : (
					<Check className="size-2.5 shrink-0 text-emerald-400" />
				)}
				<span className="min-w-0 truncate text-xs text-muted-foreground">
					{getToolPreview(call)}
				</span>
			</summary>
			<div className="mb-1 mt-0.5 overflow-hidden rounded-md border border-foreground/10 bg-card/90">
				{hasOutput ? (
					isDiffStat ? (
						<DiffStatBlock text={content} />
					) : (
						<>
							<div className="flex items-center justify-between border-b border-foreground/10 px-3 py-1.5 text-xs text-muted-foreground">
								<span>{fileName}</span>
								<div className="flex items-center gap-2">
									{strippedRead && strippedRead.matched > 0 && (
										<span>starts at line {strippedRead.firstLineNumber}</span>
									)}
									<CopyButton text={output} className="size-5" />
								</div>
							</div>
							<div className="group/tool-code tool-code-view relative">
								{shouldRenderCode ? (
									<>
										<LazyCodeFile content={content} fileName={fileName} language={language} />
										<div className="sticky bottom-2 float-right -mt-8 mr-1.5 opacity-0 transition group-hover/tool-code:opacity-100">
											<CopyButton text={output} className="size-7 bg-card/95 shadow-sm" />
										</div>
									</>
								) : (
									<div className="px-3 py-1.5 text-xs text-muted-foreground">
										Open to load preview
									</div>
								)}
							</div>
						</>
					)
				) : (
					<p className="px-3 py-1.5 text-xs text-muted-foreground">No output</p>
				)}
			</div>
		</details>
	);
}

function AssistantTextRunRenderer({
	entries,
	showModelLabel,
}: {
	entries: HostEvent[];
	showModelLabel: boolean;
}) {
	const label = showModelLabel ? friendlyModelLabel(entries[0]?.data.model) : null;

	return (
		<div className="animate-event-enter mb-4">
			{label && (
				<div className="mb-1 px-1 text-xs uppercase tracking-[0.14em] text-muted-foreground">
					{label}
				</div>
			)}
			<div className="overflow-hidden rounded-lg bg-card/95 shadow-[inset_0_1px_0_oklch(1_0_0_/_0.03)]">
				<div className="px-4 py-3 text-sm leading-[1.8] text-foreground/92">
					<MarkdownMessage text={entries.map((entry) => readString(entry.data.text)).join("")} />
				</div>
			</div>
		</div>
	);
}

function ThinkingBlock({ text }: { text: string }) {
	return (
		<details className="animate-event-enter group mb-2 ml-[18px] md:ml-[22px]" open>
			<summary className="flex cursor-pointer list-none items-center gap-1.5 py-1 text-violet-400/60 transition hover:text-violet-400">
				<ChevronRight className="size-2.5 shrink-0 transition group-open:rotate-90" />
				<span className="text-[11px] uppercase tracking-[0.08em]">Thinking</span>
			</summary>
			<div className="mt-0.5 text-sm leading-[1.8] text-foreground/50 italic">
				<MarkdownMessage text={text} />
			</div>
		</details>
	);
}

function EventRenderer({ event, showModelLabel }: { event: HostEvent; showModelLabel: boolean }) {
	if (event.kind === "text") {
		if (event.data.role === "user") {
			return <UserMessageRenderer event={event} />;
		}

		if (event.data.role === "thinking") {
			return <ThinkingBlock text={readString(event.data.text)} />;
		}

		const label = showModelLabel ? friendlyModelLabel(event.data.model) : null;

		return (
			<div className="animate-event-enter mb-4">
				{label && (
					<div className="mb-1 px-1 text-xs uppercase tracking-[0.14em] text-muted-foreground">
						{label}
					</div>
				)}
				<div className="overflow-hidden rounded-lg bg-card/95 shadow-[inset_0_1px_0_oklch(1_0_0_/_0.03)]">
					<div className="px-4 py-3 text-sm leading-[1.8] text-foreground/92">
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
			<div className="animate-event-enter mb-4 rounded-lg border border-foreground/10 bg-card/88 px-4 py-2 text-xs text-muted-foreground">
				{readString(event.data.message) || event.summary}
			</div>
		);
	}

	if (event.kind === "system") {
		return null;
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
		<div className="border-t border-foreground/10 bg-accent/80 px-3 md:px-6 py-3.5">
			<div className="mx-auto flex max-w-[70rem] flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4">
				<span className="min-w-0 truncate text-xs text-foreground/92">{request.prompt}</span>
				<div className="flex shrink-0 gap-2">
					<button
						type="button"
						onClick={() => onRespond(request.id, { decision: "allow" })}
						className="rounded border border-foreground/20 bg-foreground px-4 py-2.5 md:px-3 md:py-1 text-xs font-medium text-background transition hover:bg-foreground/90"
					>
						Allow
					</button>
					<button
						type="button"
						onClick={() => onRespond(request.id, { decision: "deny" })}
						className="rounded border border-border px-4 py-2.5 md:px-3 md:py-1 text-xs font-medium text-muted-foreground transition hover:border-foreground/16 hover:text-foreground"
					>
						Deny
					</button>
				</div>
			</div>
		</div>
	);
}

export function DraftAttachmentPreview({
	attachment,
	onRemove,
}: {
	attachment: DraftAttachment;
	onRemove: () => void;
}) {
	if (attachment.previewUrl) {
		return (
			<div className="relative overflow-hidden rounded-md border border-foreground/10 bg-background">
				<img src={attachment.previewUrl} alt={attachment.name} className="h-20 w-20 object-cover" />
				<button
					type="button"
					onClick={onRemove}
					className="absolute top-1 right-1 flex size-8 md:size-5 items-center justify-center rounded-full bg-background/92 text-foreground/82 shadow-sm transition hover:text-foreground"
					aria-label={`Remove ${attachment.name}`}
				>
					<X className="size-3" />
				</button>
			</div>
		);
	}

	return (
		<div className="flex items-center gap-2 rounded-md border border-foreground/10 bg-background px-3 py-2">
			<FileIcon className="size-4 shrink-0 text-muted-foreground" />
			<span className="max-w-[160px] truncate text-xs text-foreground">{attachment.name}</span>
			<button
				type="button"
				onClick={onRemove}
				className="flex size-8 md:size-5 shrink-0 items-center justify-center rounded-full text-foreground/82 transition hover:text-foreground"
				aria-label={`Remove ${attachment.name}`}
			>
				<X className="size-3" />
			</button>
		</div>
	);
}
