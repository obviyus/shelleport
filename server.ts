import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import devAppShell from "~/client/index.html";
import { config, ensureDataDir, getClaudeBin } from "~/server/config.server";
import { handleApiRequest } from "~/server/api.server";
import { clearAuthCookie } from "~/server/auth.server";

const serverFilePath = fileURLToPath(import.meta.url);
const usingBunRuntime =
	process.execPath.endsWith("/bun") || process.execPath.endsWith("/bun-debug");
const isDevelopment = usingBunRuntime && Bun.env.NODE_ENV !== "production";

function getCliCommand() {
	return usingBunRuntime ? ["bun", "run", serverFilePath] : [process.execPath];
}

async function getProductionShellPath() {
	if (isDevelopment) {
		return null;
	}

	return import("./src/server/client-assets.generated.js");
}

function getContentType(pathname: string) {
	if (pathname.endsWith(".css")) {
		return "text/css; charset=utf-8";
	}

	if (pathname.endsWith(".js")) {
		return "text/javascript; charset=utf-8";
	}

	if (pathname.endsWith(".html")) {
		return "text/html; charset=utf-8";
	}

	if (pathname.endsWith(".woff2")) {
		return "font/woff2";
	}

	if (pathname.endsWith(".svg")) {
		return "image/svg+xml";
	}

	if (pathname.endsWith(".png")) {
		return "image/png";
	}

	return "application/octet-stream";
}

async function runDoctor() {
	await ensureDataDir();

	const checks = [
		{
			label: "data_dir",
			command: ["test", "-d", config.dataDir],
		},
		{
			label: "claude_cli",
			command: [getClaudeBin(), "--version"],
		},
		{
			label: "codex_cli",
			command: ["codex", "--version"],
		},
	];

	for (const check of checks) {
		const process = Bun.spawn(check.command, {
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await process.exited;
		const stdout = await new Response(process.stdout).text();
		const stderr = await new Response(process.stderr).text();
		const message = stdout.trim() || stderr.trim() || "ok";

		console.log(`${check.label}: ${exitCode === 0 ? "ok" : "fail"} ${message}`);
	}

	console.log(`host: ${config.defaultHost}`);
	console.log(`port: ${config.defaultPort}`);
	console.log(`data_dir: ${config.dataDir}`);
	console.log(
		`admin_token: ${config.adminToken === "dev-token" ? "dev-token (change me)" : "configured"}`,
	);
}

async function runInstallService() {
	await ensureDataDir();
	const command = [...getCliCommand(), "serve"];
	const workingDirectory = usingBunRuntime
		? dirname(fileURLToPath(import.meta.url))
		: dirname(process.execPath);

	if (process.platform === "darwin") {
		const launchAgentsDir = join(Bun.env.HOME ?? workingDirectory, "Library", "LaunchAgents");
		await Bun.$`mkdir -p ${launchAgentsDir}`.quiet();
		const plistPath = join(launchAgentsDir, "dev.shelleport.plist");
		const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>dev.shelleport</string>
	<key>ProgramArguments</key>
	<array>
${command.map((part) => `		<string>${part}</string>`).join("\n")}
	</array>
	<key>WorkingDirectory</key>
	<string>${workingDirectory}</string>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PORT</key>
		<string>${String(config.defaultPort)}</string>
		<key>HOST</key>
		<string>${config.defaultHost}</string>
	</dict>
</dict>
</plist>
`;
		await Bun.write(plistPath, plist);
		console.log(`Wrote ${plistPath}`);
		console.log(`Run: launchctl load -w ${plistPath}`);
		return;
	}

	const systemdDir = join(Bun.env.HOME ?? workingDirectory, ".config", "systemd", "user");
	await Bun.$`mkdir -p ${systemdDir}`.quiet();
	const servicePath = join(systemdDir, "shelleport.service");
	const service = `[Unit]
Description=Shelleport host daemon
After=network.target

[Service]
Type=simple
WorkingDirectory=${workingDirectory}
ExecStart=${command.join(" ")}
Restart=always
Environment=HOST=${config.defaultHost}
Environment=PORT=${config.defaultPort}

[Install]
WantedBy=default.target
`;
	await Bun.write(servicePath, service);
	console.log(`Wrote ${servicePath}`);
	console.log("Run: systemctl --user daemon-reload");
	console.log("Run: systemctl --user enable --now shelleport.service");
}

export async function createServerFetchHandler(
	clientAssets: Record<string, string> | null = null,
	shellPath: string | null = null,
) {
	return async function fetch(request: Request) {
		const url = new URL(request.url);

		try {
			const clientAssetPath = clientAssets?.[url.pathname];
			if (clientAssetPath) {
				return new Response(Bun.file(clientAssetPath), {
					headers: {
						"Content-Type": getContentType(url.pathname),
					},
				});
			}

			if (url.pathname.startsWith("/api/")) {
				return await handleApiRequest(request);
			}

			if (url.pathname === "/health") {
				return Response.json({
					name: config.appName,
					status: "ok",
				});
			}

			if (url.pathname === "/logout") {
				return new Response(null, {
					status: 302,
					headers: {
						Location: "/login",
						"Set-Cookie": clearAuthCookie(),
					},
				});
			}

			if (
				shellPath &&
				(url.pathname === "/" ||
					url.pathname === "/archived" ||
					url.pathname === "/login" ||
					url.pathname.startsWith("/sessions/"))
			) {
				return new Response(Bun.file(shellPath), {
					headers: {
						"Content-Type": "text/html; charset=utf-8",
					},
				});
			}

			return new Response("Not Found", { status: 404 });
		} catch (error) {
			if (error instanceof Response) {
				return error;
			}

			console.error("Error processing request:", error);
			return Response.json(
				{
					error: error instanceof Error ? error.message : "Internal Server Error",
				},
				{ status: 500 },
			);
		}
	};
}

export async function runServe() {
	await ensureDataDir();
	const productionAssets = await getProductionShellPath();
	const fetch = await createServerFetchHandler(
		productionAssets?.clientAssetPaths ?? null,
		productionAssets?.clientShellPath ?? null,
	);
	const browserHost =
		config.defaultHost === "0.0.0.0" || config.defaultHost === "::"
			? "localhost"
			: config.defaultHost;

	console.log(`Server starting on http://${browserHost}:${config.defaultPort}`);

	Bun.serve({
		development: isDevelopment
			? {
					console: true,
					hmr: true,
				}
			: false,
		fetch,
		hostname: config.defaultHost,
		port: config.defaultPort,
		routes: isDevelopment
			? {
					"/": devAppShell,
					"/archived": devAppShell,
					"/login": devAppShell,
					"/sessions/:sessionId": devAppShell,
				}
			: undefined,
		error(error) {
			console.error("Server error:", error);
			return new Response("Server Error", { status: 500 });
		},
	});
}

if (import.meta.main) {
	const command = Bun.argv[2] ?? "serve";

	if (command === "doctor") {
		await runDoctor();
	} else if (command === "install-service") {
		await runInstallService();
	} else {
		await runServe();
	}
}
