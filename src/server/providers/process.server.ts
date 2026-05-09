const STDERR_TAIL_LIMIT = 64 * 1024;
const CLOSE_GRACE_MS = 1_500;
const KILL_GRACE_MS = 500;

export type ProviderSubprocess = Bun.Subprocess<"pipe", "pipe", "pipe">;

export class TextTail {
	readonly #decoder = new TextDecoder();
	#text = "";

	constructor(readonly limit = STDERR_TAIL_LIMIT) {}

	append(value: Uint8Array | string) {
		this.#text += typeof value === "string" ? value : this.#decoder.decode(value, { stream: true });

		if (this.#text.length > this.limit) {
			this.#text = this.#text.slice(-this.limit);
		}
	}

	text() {
		this.#text += this.#decoder.decode();
		return this.#text.trim();
	}
}

export async function readStderrTail(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	tail: TextTail,
) {
	for (;;) {
		const { done, value } = await reader.read();

		if (done) {
			return;
		}

		tail.append(value);
	}
}

export function closeProviderSubprocess(subprocess: ProviderSubprocess) {
	try {
		void subprocess.stdin.end();
	} catch {}

	let killTimer: ReturnType<typeof setTimeout> | null = null;
	const terminateTimer = setTimeout(() => {
		try {
			subprocess.kill("SIGTERM");
		} catch {}

		killTimer = setTimeout(() => {
			try {
				subprocess.kill("SIGKILL");
			} catch {}
		}, KILL_GRACE_MS);
	}, CLOSE_GRACE_MS);

	void subprocess.exited.finally(() => {
		clearTimeout(terminateTimer);

		if (killTimer) {
			clearTimeout(killTimer);
		}
	});
}
