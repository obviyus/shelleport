import { describe, expect, test } from "bun:test";
import {
	createServerFetchHandler,
	getInstallServiceHost,
	getInstallServiceUser,
	getServiceEnvironment,
	parseCliOptions,
} from "../../server";

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

	test("parses install-service user override", async () => {
		const options = await parseCliOptions(["install-service", "--service-user", "ubuntu"]);

		expect(options).toMatchObject({
			command: "install-service",
			serviceUser: "ubuntu",
		});
	});

	test("parses upgrade command", async () => {
		const options = await parseCliOptions(["upgrade"]);

		expect(options).toMatchObject({
			command: "upgrade",
		});
	});

	test("suggests closest command for typos", async () => {
		await expect(parseCliOptions(["doctro"])).rejects.toThrow(
			"Unknown command: doctro. Did you mean 'doctor'?",
		);
	});

	test("rejects unknown argument after command", async () => {
		await expect(parseCliOptions(["doctor", "upgrade"])).rejects.toThrow(
			"Unknown argument: upgrade",
		);
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

describe("getServiceEnvironment", () => {
	test("captures current PATH", async () => {
		const originalPath = process.env.PATH;
		process.env.PATH = "/tmp/bin:/usr/bin";

		try {
			expect((await getServiceEnvironment("/home/ubuntu")).path).toBe(
				"/home/ubuntu/.local/bin:/tmp/bin:/usr/bin",
			);
		} finally {
			process.env.PATH = originalPath;
		}
	});
});

describe("getInstallServiceUser", () => {
	test("prefers explicit service user", () => {
		expect(getInstallServiceUser("ubuntu")).toBe("ubuntu");
	});
});
