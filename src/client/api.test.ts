import { describe, expect, test } from "bun:test";
import { login } from "~/client/api";

describe("login", () => {
	test("does not redirect on unauthorized", async () => {
		const originalFetch = globalThis.fetch;
		const originalWindow = globalThis.window;
		const location = { href: "/keep" };

		Object.defineProperty(globalThis, "fetch", {
			configurable: true,
			value: (async () =>
				new Response(JSON.stringify({ error: "Unauthorized" }), {
					headers: { "Content-Type": "application/json" },
					status: 401,
				})) satisfies typeof fetch,
		});
		Object.defineProperty(globalThis, "window", {
			configurable: true,
			value: { location },
		});

		try {
			await expect(login("bad-token")).rejects.toThrow("Unauthorized");
			expect(location.href).toBe("/keep");
		} finally {
			Object.defineProperty(globalThis, "fetch", {
				configurable: true,
				value: originalFetch,
			});
			Object.defineProperty(globalThis, "window", {
				configurable: true,
				value: originalWindow,
			});
		}
	});
});
