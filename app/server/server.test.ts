import { describe, expect, test } from "bun:test";
import type { ClientAssets } from "~/server/client-assets.server";
import { createServerFetchHandler } from "../../server";

const clientAssets: ClientAssets = {
	entryScriptPath: "/assets/client.js",
	files: [
		{
			cacheControl: "public, max-age=31536000, immutable",
			publicPath: "/assets/client.css",
			sourcePath: import.meta.path,
		},
		{
			cacheControl: "public, max-age=31536000, immutable",
			publicPath: "/assets/client.js",
			sourcePath: import.meta.path,
		},
	],
	stylePaths: ["/assets/client.css"],
};

describe("createServerFetchHandler", () => {
	test("serves health", async () => {
		const fetch = await createServerFetchHandler(clientAssets);
		const response = await fetch(new Request("http://localhost/health"));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			name: "shelleport",
			status: "ok",
		});
	});

	test("rejects api requests without bearer auth", async () => {
		const fetch = await createServerFetchHandler(clientAssets);
		const response = await fetch(new Request("http://localhost/api/providers"));

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({
			code: "unauthorized",
			error: "Unauthorized",
		});
	});
});
