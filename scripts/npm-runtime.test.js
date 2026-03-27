import { afterEach, describe, expect, mock, test } from "bun:test";
import {
	fetchLatestReleaseVersion,
	getReleaseAssetName,
	getSystemdServicePath,
	normalizeReleaseVersion,
	upsertSystemdEnvironment,
} from "./npm-runtime.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	mock.restore();
});

describe("npm runtime helpers", () => {
	test("normalizes release tags", () => {
		expect(normalizeReleaseVersion("v0.0.15")).toBe("0.0.15");
		expect(normalizeReleaseVersion("0.0.15")).toBe("0.0.15");
	});

	test("builds release asset names for the current target", () => {
		expect(getReleaseAssetName("0.0.15")).toBe(
			`shelleport-v0.0.15-${process.platform}-${process.arch}`,
		);
	});

	test("fetches the latest release version from GitHub", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(
					JSON.stringify({
						tag_name: "v9.9.9",
					}),
					{
						status: 200,
						headers: {
							"content-type": "application/json",
						},
					},
				),
			),
		);

		expect(await fetchLatestReleaseVersion()).toBe("9.9.9");
	});

	test("derives the systemd service path", () => {
		expect(getSystemdServicePath()).toBe("/etc/systemd/system/shelleport.service");
	});

	test("upserts systemd environment lines before install", () => {
		const service = `[Service]
Environment=HOST=0.0.0.0

[Install]
WantedBy=default.target
`;

		expect(upsertSystemdEnvironment(service, "PATH", "/root/.local/bin:/usr/bin")).toContain(
			"Environment=PATH=/root/.local/bin:/usr/bin\n[Install]",
		);
		expect(
			upsertSystemdEnvironment(
				upsertSystemdEnvironment(service, "PATH", "/usr/bin"),
				"PATH",
				"/root/.local/bin:/usr/bin",
			),
		).toContain("Environment=PATH=/root/.local/bin:/usr/bin");
	});
});
