import { describe, expect, test } from "bun:test";
import { createServerFetchHandler } from "../../server";

describe("createServerFetchHandler", () => {
	test("serves health", async () => {
		const fetch = await createServerFetchHandler();
		const response = await fetch(new Request("http://localhost/health"));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			name: "shelleport",
			status: "ok",
		});
	});

	test("rejects api requests without bearer auth", async () => {
		const fetch = await createServerFetchHandler();
		const response = await fetch(new Request("http://localhost/api/providers"));

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({
			code: "unauthorized",
			error: "Unauthorized",
		});
	});
});
