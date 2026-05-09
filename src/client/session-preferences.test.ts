import { afterEach, describe, expect, test } from "bun:test";

import {
	readLastSessionPreferences,
	writeLastSessionPreferences,
} from "~/client/session-preferences";

const models = [
	{ id: "sonnet", label: "Sonnet" },
	{ id: "opus", label: "Opus" },
	{ id: "haiku", label: "Haiku" },
];

function installStorage(entries: Record<string, string> = {}) {
	const store = new Map(Object.entries(entries));
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: {
			localStorage: {
				getItem(key: string) {
					return store.get(key) ?? null;
				},
				setItem(key: string, value: string) {
					store.set(key, value);
				},
				removeItem(key: string) {
					store.delete(key);
				},
				clear() {
					store.clear();
				},
				key(index: number) {
					return Array.from(store.keys())[index] ?? null;
				},
				get length() {
					return store.size;
				},
			},
		},
	});
	return store;
}

afterEach(() => {
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: undefined,
	});
});

describe("session preferences", () => {
	test("normalizes stored effort against the restored model", () => {
		installStorage({
			"shelleport.last-model": "sonnet",
			"shelleport.last-effort": "max",
		});

		expect(readLastSessionPreferences(models, "sonnet")).toEqual({
			model: "sonnet",
			effort: "high",
		});
	});

	test("writes normalized preferences for mid-session updates", () => {
		const store = installStorage();

		writeLastSessionPreferences("sonnet", "max");

		expect(store.get("shelleport.last-model")).toBe("sonnet");
		expect(store.get("shelleport.last-effort")).toBe("high");
	});
});
