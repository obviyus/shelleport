/**
 * Browser-local voice input using Whisper tiny via @huggingface/transformers.
 * Loaded lazily from our own bundle.
 * Model (~40MB) downloads lazily on first use and is cached by the browser.
 */

type TranscriptionPipeline = (
	audio: Float32Array,
	options?: { language?: string; task?: string },
) => Promise<{ text: string }>;

let pipelinePromise: Promise<TranscriptionPipeline> | null = null;
const whisperModelId = "onnx-community/whisper-tiny";
const ortWasmUrls = {
	wasm: new URL("./ort-wasm-simd-threaded.jsep.wasm", import.meta.resolve("@huggingface/transformers")).href,
};

export type VoiceInputState =
	| { status: "idle" }
	| { status: "loading-model"; progress: number }
	| { status: "recording"; startTime: number }
	| { status: "transcribing" }
	| { status: "error"; message: string };

/**
 * Lazily load the Whisper tiny pipeline. Only downloads the model on first call.
 */
function getOrCreatePipeline(
	onProgress?: (progress: number) => void,
): Promise<TranscriptionPipeline> {
	if (pipelinePromise) return pipelinePromise;

	const nextPipelinePromise = (async () => {
		const { env, pipeline } = await import("@huggingface/transformers");
		env.backends.onnx = {
			...env.backends.onnx,
			wasm: {
				...env.backends.onnx.wasm,
				numThreads: 1,
				wasmPaths: ortWasmUrls,
			},
		};
		const transcriber = await pipeline("automatic-speech-recognition", whisperModelId, {
			dtype: "q8",
			device: "wasm",
			progress_callback: (event: Record<string, unknown>) => {
				if (typeof event.progress === "number" && onProgress) {
					onProgress(event.progress);
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

/**
 * Record audio from the microphone, transcribe locally, return text.
 */
export function createVoiceSession(callbacks: { onStateChange: (state: VoiceInputState) => void }) {
	let mediaRecorder: MediaRecorder | null = null;
	let cancelled = false;

async function start() {
		try {
			if (!navigator.mediaDevices?.getUserMedia) {
				throw new Error("Voice input requires HTTPS or localhost");
			}

			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

			if (cancelled) {
				for (const track of stream.getTracks()) track.stop();
				return null;
			}

			callbacks.onStateChange({ status: "loading-model", progress: 0 });

			const pipelineReady = getOrCreatePipeline((progress) => {
				if (!cancelled) {
					callbacks.onStateChange({ status: "loading-model", progress });
				}
			});
			const transcriber = await pipelineReady;

			if (cancelled) {
				for (const track of stream.getTracks()) track.stop();
				return null;
			}

			const audioCtx = new AudioContext();
			const source = audioCtx.createMediaStreamSource(stream);
			const analyser = audioCtx.createAnalyser();
			analyser.fftSize = 256;
			source.connect(analyser);

			const chunks: Blob[] = [];
			mediaRecorder = new MediaRecorder(stream);

			mediaRecorder.ondataavailable = (event) => {
				if (event.data.size > 0) chunks.push(event.data);
			};

			const recordingDone = new Promise<Blob>((resolve) => {
				mediaRecorder!.onstop = () => {
					for (const track of stream.getTracks()) track.stop();
					resolve(new Blob(chunks, { type: mediaRecorder!.mimeType }));
				};
			});

			mediaRecorder.start();
			callbacks.onStateChange({ status: "recording", startTime: Date.now() });

			return {
				analyser,
				stop: async (): Promise<string> => {
					if (!mediaRecorder || mediaRecorder.state === "inactive") return "";

					mediaRecorder.stop();
					const blob = await recordingDone;

					void audioCtx.close();

					if (cancelled) return "";

					callbacks.onStateChange({ status: "transcribing" });

					const audioBuffer = await blobToFloat32(blob);
					const result = await transcriber(audioBuffer, {
						language: "en",
						task: "transcribe",
					});

					callbacks.onStateChange({ status: "idle" });
					return result.text.trim();
				},
				cancel: () => {
					cancelled = true;
					if (mediaRecorder && mediaRecorder.state !== "inactive") {
						mediaRecorder.stop();
					}
					void audioCtx.close();
					for (const track of stream.getTracks()) track.stop();
					callbacks.onStateChange({ status: "idle" });
				},
			};
		} catch (error) {
			if (cancelled) {
				return null;
			}
			const message =
				error instanceof DOMException && error.name === "NotAllowedError"
					? "Microphone permission denied"
					: error instanceof Error
						? error.message
						: "Voice input failed";
			callbacks.onStateChange({ status: "error", message });
			return null;
		}
	}

	return {
		start,
		cancelSetup: () => {
			cancelled = true;
			callbacks.onStateChange({ status: "idle" });
		},
	};
}

async function blobToFloat32(blob: Blob): Promise<Float32Array> {
	const arrayBuffer = await blob.arrayBuffer();
	const audioContext = new AudioContext({ sampleRate: 16000 });
	const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
	const float32 = audioBuffer.getChannelData(0);
	await audioContext.close();
	return float32;
}
