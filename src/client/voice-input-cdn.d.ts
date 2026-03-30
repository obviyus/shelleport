declare module "https://esm.sh/@huggingface/transformers@3.4.0" {
	export function pipeline(
		task: "automatic-speech-recognition",
		model: "onnx-community/whisper-tiny",
		options: {
			device: "wasm";
			dtype: "q8";
			progress_callback: (event: Record<string, unknown>) => void;
		},
	): Promise<
		(
			audio: Float32Array,
			options?: { language?: string; task?: string },
		) => Promise<{ text: string }>
	>;
}
