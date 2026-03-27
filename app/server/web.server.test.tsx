import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ClientAssets } from "~/server/client-assets.server";
import { handleWebRequest } from "~/server/web.server";

let tempDir = "";
let clientAssets: ClientAssets;

beforeAll(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "shelleport-web-test-"));
	const stylePath = join(tempDir, "client.css");
	const scriptPath = join(tempDir, "client.js");

	await Bun.write(stylePath, "body{background:black}");
	await Bun.write(scriptPath, "console.log('client')");

	clientAssets = {
		entryScriptPath: "/assets/client.js",
		files: [
			{
				cacheControl: "public, max-age=31536000, immutable",
				publicPath: "/assets/client.css",
				sourcePath: stylePath,
			},
			{
				cacheControl: "public, max-age=31536000, immutable",
				publicPath: "/assets/client.js",
				sourcePath: scriptPath,
			},
		],
		stylePaths: ["/assets/client.css"],
	};
});

afterAll(async () => {
	if (tempDir) {
		await rm(tempDir, { force: true, recursive: true });
	}
});

async function request(pathname: string) {
	return handleWebRequest(new Request(`http://localhost${pathname}`), {
		clientAssets,
		defaultCwd: "/tmp/project",
	});
}

describe("handleWebRequest", () => {
	test("serves embedded assets", async () => {
		const response = await request("/assets/client.js");

		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
		expect(await response.text()).toContain("console.log");
	});

	test("renders login shell", async () => {
		const response = await request("/login");
		const body = await response.text();

		expect(response.status).toBe(200);
		expect(body).toContain("window.__SHELLEPORT_BOOT__");
		expect(body).toContain('href="/assets/client.css"');
		expect(body).toContain('src="/assets/client.js"');
		expect(body).toContain("Paste admin token");
		expect(body).toContain('"kind":"login"');
	});

	test("renders home shell without auth", async () => {
		const response = await request("/");
		const body = await response.text();

		expect(response.status).toBe(200);
		expect(body).toContain('"kind":"home"');
		expect(body).toContain('"defaultCwd":"/tmp/project"');
	});

	test("renders archived shell", async () => {
		const response = await request("/archived");
		const body = await response.text();

		expect(response.status).toBe(200);
		expect(body).toContain('"kind":"archived"');
	});

	test("renders session shell with params", async () => {
		const response = await request("/sessions/test");
		const body = await response.text();

		expect(response.status).toBe(200);
		expect(body).toContain('"kind":"session"');
		expect(body).toContain('"sessionId":"test"');
	});

	test("renders logout page", async () => {
		const response = await request("/logout");
		const body = await response.text();

		expect(response.status).toBe(200);
		expect(body).toContain('localStorage.removeItem("shelleport_token")');
		expect(body).toContain('window.location.replace("/login")');
	});

	test("renders not found page with 404", async () => {
		const response = await request("/missing");
		const body = await response.text();

		expect(response.status).toBe(404);
		expect(body).toContain("Page not found");
		expect(body).toContain('"kind":"not-found"');
	});
});
