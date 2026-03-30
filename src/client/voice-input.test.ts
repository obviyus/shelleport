import { describe, expect, test } from "bun:test";
import { createVoiceSession } from "~/client/voice-input";
import type { VoiceInputState } from "~/client/voice-input";

function collectStates() {
	const states: VoiceInputState[] = [];
	return {
		onStateChange: (state: VoiceInputState) => {
			states.push(state);
		},
		get states() {
			return states;
		},
	};
}

type NavigatorOverride = {
	mediaDevices?: MediaDevices | undefined;
};

async function withNavigator(override: NavigatorOverride, fn: () => Promise<void>) {
	const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
	Object.defineProperty(globalThis, "navigator", {
		value: Object.assign({}, navigator, override),
		configurable: true,
		writable: true,
	});
	try {
		await fn();
	} finally {
		if (original) {
			Object.defineProperty(globalThis, "navigator", original);
		}
	}
}

describe("createVoiceSession", () => {
	test("cancelSetup emits idle without any other states", () => {
		const cb = collectStates();
		const session = createVoiceSession(cb);
		session.cancelSetup();
		expect(cb.states).toEqual([{ status: "idle" }]);
	});

	test("first state emitted by start() is loading-model with progress 0", async () => {
		await withNavigator(
			{
				mediaDevices: {
					getUserMedia: () => Promise.reject(new Error("test abort")),
				} as unknown as MediaDevices,
			},
			async () => {
				const cb = collectStates();
				const session = createVoiceSession(cb);
				await session.start();
				expect(cb.states[0]).toEqual({ status: "loading-model", progress: 0 });
			},
		);
	});

	test("error when navigator.mediaDevices.getUserMedia is unavailable", async () => {
		await withNavigator({ mediaDevices: undefined }, async () => {
			const cb = collectStates();
			const session = createVoiceSession(cb);
			const result = await session.start();
			expect(result).toBeNull();
			const err = cb.states.find((s) => s.status === "error");
			expect(err).toBeDefined();
			expect((err as Extract<VoiceInputState, { status: "error" }>).message).toBe(
				"Voice input requires HTTPS or localhost",
			);
		});
	});

	test("Microphone permission denied for NotAllowedError DOMException", async () => {
		await withNavigator(
			{
				mediaDevices: {
					getUserMedia: () =>
						Promise.reject(new DOMException("Permission denied", "NotAllowedError")),
				} as unknown as MediaDevices,
			},
			async () => {
				const cb = collectStates();
				const session = createVoiceSession(cb);
				const result = await session.start();
				expect(result).toBeNull();
				const err = cb.states.find((s) => s.status === "error");
				expect(err).toBeDefined();
				expect((err as Extract<VoiceInputState, { status: "error" }>).message).toBe(
					"Microphone permission denied",
				);
			},
		);
	});

	test("uses Error.message for generic errors from getUserMedia", async () => {
		await withNavigator(
			{
				mediaDevices: {
					getUserMedia: () => Promise.reject(new Error("Device busy")),
				} as unknown as MediaDevices,
			},
			async () => {
				const cb = collectStates();
				const session = createVoiceSession(cb);
				const result = await session.start();
				expect(result).toBeNull();
				const err = cb.states.find((s) => s.status === "error");
				expect(err).toBeDefined();
				expect((err as Extract<VoiceInputState, { status: "error" }>).message).toBe("Device busy");
			},
		);
	});

	test("'Voice input failed' for non-Error throws from getUserMedia", async () => {
		await withNavigator(
			{
				mediaDevices: {
					getUserMedia: () => Promise.reject("string error"),
				} as unknown as MediaDevices,
			},
			async () => {
				const cb = collectStates();
				const session = createVoiceSession(cb);
				const result = await session.start();
				expect(result).toBeNull();
				const err = cb.states.find((s) => s.status === "error");
				expect(err).toBeDefined();
				expect((err as Extract<VoiceInputState, { status: "error" }>).message).toBe(
					"Voice input failed",
				);
			},
		);
	});

	test("start() returns null on error", async () => {
		await withNavigator(
			{
				mediaDevices: {
					getUserMedia: () => Promise.reject(new Error("any error")),
				} as unknown as MediaDevices,
			},
			async () => {
				const cb = collectStates();
				const session = createVoiceSession(cb);
				const result = await session.start();
				expect(result).toBeNull();
			},
		);
	});
});
