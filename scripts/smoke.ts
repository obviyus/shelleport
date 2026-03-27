import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const host = "127.0.0.1";
const port = 41000 + Math.floor(Math.random() * 1000);
const binaryPath = join(process.cwd(), "dist", "shelleport");
const dataDir = await mkdtemp(join(tmpdir(), "shelleport-smoke-"));
const adminToken = "smoke-token";

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

async function assertPage(pathname: string, status: number, text: string, cookie?: string) {
	const response = await fetch(
		`http://${host}:${port}${pathname}`,
		cookie
			? {
					headers: {
						Cookie: cookie,
					},
				}
			: undefined,
	);
	const body = await response.text();

	if (response.status !== status) {
		throw new Error(`Unexpected ${pathname} status: ${response.status}`);
	}

	if (!body.includes(text)) {
		throw new Error(`Missing ${pathname} marker: ${text}`);
	}

	return body;
}

await Bun.$`bun run compile`;
Bun.env.SHELLEPORT_DATA_DIR = dataDir;
(await import("~/server/auth.server")).setAdminToken(adminToken);

const child = Bun.spawn([binaryPath, "serve"], {
	env: {
		...process.env,
		HOST: host,
		PORT: String(port),
		SHELLEPORT_DATA_DIR: dataDir,
	},
	stderr: "pipe",
	stdout: "pipe",
});

try {
	await waitFor(`http://${host}:${port}/health`);
	await assertPage("/login", 200, '<div id="root"></div>');
	const loginResponse = await fetch(`http://${host}:${port}/api/auth/session`, {
		body: JSON.stringify({ token: adminToken }),
		headers: {
			"Content-Type": "application/json",
		},
		method: "POST",
	});

	if (loginResponse.status !== 200) {
		throw new Error(`Unexpected login status: ${loginResponse.status}`);
	}

	const setCookie = loginResponse.headers.get("Set-Cookie");

	if (!setCookie) {
		throw new Error("Missing auth cookie");
	}

	const cookie = setCookie.split(";")[0];
	const createResponse = await fetch(`http://${host}:${port}/api/sessions`, {
		body: JSON.stringify({
			cwd: process.cwd(),
			provider: "claude",
			title: "Smoke session",
		}),
		headers: {
			"Content-Type": "application/json",
			Cookie: cookie,
		},
		method: "POST",
	});

	if (createResponse.status !== 201) {
		throw new Error(`Unexpected create-session status: ${createResponse.status}`);
	}

	const session = (await createResponse.json()) as { session: { id: string } };
	const homepage = await assertPage("/", 200, '<div id="root"></div>', cookie);

	await assertPage(`/sessions/${session.session.id}`, 200, '<div id="root"></div>', cookie);

	const scriptPath = homepage.match(/<script[^>]+src="([^"]+)"/)?.[1];

	if (!scriptPath) {
		throw new Error("Missing client script");
	}

	await assertPage(new URL(scriptPath, `http://${host}:${port}/`).pathname, 200, "createRoot");
} finally {
	child.kill();
	await child.exited.catch(() => {});
	await rm(dataDir, { force: true, recursive: true });
}
