import { describe, expect, test } from "bun:test";
import { createServerFetchHandler, getInstallServiceHost, parseCliOptions } from "../../server";

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

describe("parseCliOptions", () => {
	test("parses doctor port override", async () => {
		const options = await parseCliOptions(["doctor", "--port", "3456"]);

		expect(options).toMatchObject({
			command: "doctor",
			help: false,
			port: 3456,
			version: false,
		});
	});

	test("parses help without a command", async () => {
		const options = await parseCliOptions(["--help"]);

		expect(options).toMatchObject({
			command: "serve",
			help: true,
			version: false,
		});
	});

	test("parses version without starting the server", async () => {
		const options = await parseCliOptions(["--version"]);

		expect(options).toMatchObject({
			command: "serve",
			help: false,
			version: true,
		});
	});
});

describe("getInstallServiceHost", () => {
	test("defaults service installs to public bind", () => {
		expect(getInstallServiceHost("127.0.0.1")).toBe("0.0.0.0");
	});

	test("preserves explicit tailscale binds", () => {
		expect(getInstallServiceHost("100.96.195.107")).toBe("100.96.195.107");
	});
});
