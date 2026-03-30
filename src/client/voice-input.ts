type VoiceWorkerRequest =
	| { id: number; type: "init" }
	| { id: number; type: "transcribe"; audio: Float32Array };

type VoiceWorkerResponse =
	| { id: number; type: "ready" }
	| { id: number; type: "result"; text: string }
	| { id: number; type: "progress"; progress: number }
	| { id: number; type: "error"; message: string };

type PendingWorkerRequest = {
	onProgress?: (progress: number) => void;
	reject: (error: Error) => void;
	resolve: (value: string | void) => void;
};

let nextRequestId = 1;
let voiceWorker: Worker | null = null;
let pipelinePromise: Promise<void> | null = null;
const pendingWorkerRequests = new Map<number, PendingWorkerRequest>();

export type VoiceInputState =
	| { status: "idle" }
	| { status: "loading-model"; progress: number }
	| { status: "recording"; startTime: number }
	| { status: "transcribing" }
	| { status: "error"; message: string };

function resetVoiceWorker(error?: Error) {
	if (voiceWorker) {
		voiceWorker.terminate();
		voiceWorker = null;
	}

	if (pipelinePromise) {
		pipelinePromise = null;
	}

	if (pendingWorkerRequests.size === 0) {
		return;
	}

	for (const [id, request] of pendingWorkerRequests) {
		request.reject(error ?? new Error("Voice worker failed"));
		pendingWorkerRequests.delete(id);
	}
}

function getOrCreateVoiceWorker() {
	if (voiceWorker) {
		return voiceWorker;
	}

	const worker = new Worker(new URL("./voice-input.worker.ts", import.meta.url), {
		type: "module",
	});

	worker.addEventListener("message", (event: MessageEvent<VoiceWorkerResponse>) => {
		const message = event.data;
		const request = pendingWorkerRequests.get(message.id);

		if (!request) {
			return;
		}

		if (message.type === "progress") {
			request.onProgress?.(message.progress);
			return;
		}

		pendingWorkerRequests.delete(message.id);

		if (message.type === "error") {
			request.reject(new Error(message.message));
			return;
		}

		request.resolve(message.type === "result" ? message.text : undefined);
	});

	worker.addEventListener("error", (event) => {
		resetVoiceWorker(event.error instanceof Error ? event.error : new Error("Voice worker failed"));
	});

	voiceWorker = worker;
	return worker;
}

function postWorkerRequest(
	message: VoiceWorkerRequest,
	options?: { onProgress?: (progress: number) => void; transfer?: Transferable[] },
) {
	const worker = getOrCreateVoiceWorker();

	return new Promise<string | void>((resolve, reject) => {
		pendingWorkerRequests.set(message.id, {
			onProgress: options?.onProgress,
			reject,
			resolve,
		});
		worker.postMessage(message, options?.transfer ?? []);
	});
}

function getOrCreatePipeline(onProgress?: (progress: number) => void): Promise<void> {
	if (pipelinePromise) {
		return pipelinePromise;
	}

	const nextPipelinePromise = postWorkerRequest(
		{
			id: nextRequestId++,
			type: "init",
		},
		{ onProgress },
	).then(() => undefined);

	pipelinePromise = nextPipelinePromise;

	nextPipelinePromise.catch((error) => {
		if (pipelinePromise === nextPipelinePromise) {
			pipelinePromise = null;
		}
		resetVoiceWorker(error instanceof Error ? error : new Error("Voice worker failed"));
	});

	return nextPipelinePromise;
}

function transcribeAudio(audio: Float32Array) {
	return postWorkerRequest(
		{
			audio,
			id: nextRequestId++,
			type: "transcribe",
		},
		{ transfer: [audio.buffer] },
	).then((result) => (typeof result === "string" ? result : ""));
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

			callbacks.onStateChange({ status: "loading-model", progress: 0 });

			const pipelineReady = getOrCreatePipeline((progress) => {
				if (!cancelled) {
					callbacks.onStateChange({ status: "loading-model", progress });
				}
			});
			void pipelineReady.catch(() => {});

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

					await pipelineReady;

					if (cancelled) return "";

					callbacks.onStateChange({ status: "transcribing" });

					const audioBuffer = await blobToFloat32(blob);
					const result = await transcribeAudio(audioBuffer);

					callbacks.onStateChange({ status: "idle" });
					return result.trim();
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
