import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ClientAssets } from "~/server/client-assets.server";
import { config, ensureDataDir, getClaudeBin } from "~/server/config.server";
import { handleApiRequest } from "~/server/api.server";
import { handleWebRequest } from "~/server/web.server";

const serverFilePath = fileURLToPath(import.meta.url);
const usingBunRuntime =
	process.execPath.endsWith("/bun") || process.execPath.endsWith("/bun-debug");

function getCliCommand() {
	return usingBunRuntime ? ["bun", "run", serverFilePath] : [process.execPath];
}

async function getDiskClientAssets(): Promise<ClientAssets> {
	const assetDir = join(process.cwd(), "build", "client");
	const clientAssets = {
		entryScriptPath: "/assets/client.js",
		files: [
			{
				cacheControl: "public, max-age=31536000, immutable",
				publicPath: "/assets/client.css",
				sourcePath: join(assetDir, "client.css"),
			},
			{
				cacheControl: "public, max-age=31536000, immutable",
				publicPath: "/assets/client.js",
				sourcePath: join(assetDir, "client.js"),
			},
		],
		stylePaths: ["/assets/client.css"],
	} satisfies ClientAssets;

	for (const asset of clientAssets.files) {
		if (!(await Bun.file(asset.sourcePath).exists())) {
			throw new Error(`Missing client asset: ${asset.sourcePath}. Run \`bun run build\`.`);
		}
	}

	return clientAssets;
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

export async function createServerFetchHandler(clientAssetsOverride?: ClientAssets) {
	const clientAssets = clientAssetsOverride ?? (await getDiskClientAssets());

	return async function fetch(request: Request) {
		const url = new URL(request.url);

		try {
			if (url.pathname.startsWith("/api/")) {
				return await handleApiRequest(request);
			}

			if (url.pathname === "/health") {
				return Response.json({
					name: config.appName,
					status: "ok",
				});
			}

			return await handleWebRequest(request, {
				clientAssets,
				defaultCwd: process.cwd(),
			});
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

export async function runServe(clientAssetsOverride?: ClientAssets) {
	await ensureDataDir();
	const fetch = await createServerFetchHandler(clientAssetsOverride);

	console.log(`Server starting on ${config.defaultHost}:${config.defaultPort}`);

	Bun.serve({
		fetch,
		hostname: config.defaultHost,
		port: config.defaultPort,
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
