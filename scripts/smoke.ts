import { mkdtemp, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const host = "127.0.0.1";
const port = 41000 + Math.floor(Math.random() * 1000);
const binaryPath = join(process.cwd(), "dist", "shelleport");
const buildPath = join(process.cwd(), "build");
const hiddenBuildPath = join(process.cwd(), `build.smoke-${process.pid}-${Date.now()}`);
const dataDir = await mkdtemp(join(tmpdir(), "shelleport-smoke-"));

async function waitFor(url: string) {
	const deadline = Date.now() + 15_000;

	while (Date.now() < deadline) {
		try {
			const response = await fetch(url);

			if (response.ok) {
				return;
			}
		} catch {}

		await Bun.sleep(200);
	}

	throw new Error(`Timed out waiting for ${url}`);
}

async function assertPage(pathname: string, status: number, text: string) {
	const response = await fetch(`http://${host}:${port}${pathname}`);
	const body = await response.text();

	if (response.status !== status) {
		throw new Error(`Unexpected ${pathname} status: ${response.status}`);
	}

	if (!body.includes(text)) {
		throw new Error(`Missing ${pathname} marker: ${text}`);
	}
}

await Bun.$`bun run build`;
await Bun.$`bun run compile`;
await rename(buildPath, hiddenBuildPath);

const child = Bun.spawn([binaryPath, "serve"], {
	env: {
		...process.env,
		HOST: host,
		PORT: String(port),
		SHELLEPORT_ADMIN_TOKEN: "smoke-token",
		SHELLEPORT_DATA_DIR: dataDir,
	},
	stderr: "pipe",
	stdout: "pipe",
});

try {
	await waitFor(`http://${host}:${port}/health`);
	await assertPage("/login", 200, "Paste admin token");
	await assertPage("/", 200, "window.__SHELLEPORT_BOOT__");
	await assertPage("/sessions/test", 200, '"sessionId":"test"');
	await assertPage("/assets/client.js", 200, "hydrateRoot");
} finally {
	child.kill();
	await child.exited.catch(() => {});
	await rename(hiddenBuildPath, buildPath);
	await rm(dataDir, { force: true, recursive: true });
}
