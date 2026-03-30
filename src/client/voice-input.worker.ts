type VoiceWorkerRequest =
	| { id: number; type: "init" }
	| { id: number; type: "transcribe"; audio: Float32Array };

type VoiceWorkerResponse =
	| { id: number; type: "ready" }
	| { id: number; type: "result"; text: string }
	| { id: number; type: "progress"; progress: number }
	| { id: number; type: "error"; message: string };

type TranscriptionPipeline = (
	audio: Float32Array,
	options?: { language?: string; task?: string },
) => Promise<{ text: string }>;

const whisperModelId = "onnx-community/whisper-tiny";

let pipelinePromise: Promise<TranscriptionPipeline> | null = null;

function postMessageToMainThread(message: VoiceWorkerResponse) {
	self.postMessage(message);
}

function getOrCreatePipeline(
	onProgress?: (progress: number) => void,
): Promise<TranscriptionPipeline> {
	if (pipelinePromise) {
		return pipelinePromise;
	}

	const nextPipelinePromise = (async () => {
		const { env, pipeline } = await import("./transformers-runtime");
		env.useBrowserCache = true;
		env.backends.onnx = {
			...env.backends.onnx,
			wasm: {
				...env.backends.onnx.wasm,
				numThreads: 1,
			},
		};

		const transcriber = await pipeline("automatic-speech-recognition", whisperModelId, {
			dtype: "q8",
			device: "wasm",
			progress_callback: (event: Record<string, unknown>) => {
				if (typeof event.progress === "number") {
					onProgress?.(event.progress);
				}
			},
		});

		return async (audio: Float32Array, options?: { language?: string; task?: string }) => {
			const result = await transcriber(audio, options);
			return Array.isArray(result) ? (result[0] ?? { text: "" }) : result;
		};
	})();

	pipelinePromise = nextPipelinePromise;

	nextPipelinePromise.catch(() => {
		if (pipelinePromise === nextPipelinePromise) {
			pipelinePromise = null;
		}
	});

	return nextPipelinePromise;
}

self.addEventListener("message", async (event: MessageEvent<VoiceWorkerRequest>) => {
	const message = event.data;

	try {
		if (message.type === "init") {
			await getOrCreatePipeline((progress) => {
				postMessageToMainThread({
					id: message.id,
					progress,
					type: "progress",
				});
			});
			postMessageToMainThread({ id: message.id, type: "ready" });
			return;
		}

		const transcriber = await getOrCreatePipeline();
		const result = await transcriber(message.audio, {
			language: "en",
			task: "transcribe",
		});

		postMessageToMainThread({
			id: message.id,
			text: result.text.trim(),
			type: "result",
		});
	} catch (error) {
		postMessageToMainThread({
			id: message.id,
			message: error instanceof Error ? error.message : "Voice input failed",
			type: "error",
		});
	}
});
