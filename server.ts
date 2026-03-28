import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { config, ensureDataDir, getClaudeBin } from "~/server/config.server";
import { browserOutdir, buildBrowser, readBrowserBuild } from "./scripts/build";
import packageJson from "./package.json";

const serverFilePath = fileURLToPath(import.meta.url);
const projectRoot = dirname(serverFilePath);
const usingBunRuntime =
	process.execPath.endsWith("/bun") || process.execPath.endsWith("/bun-debug");
const isDevelopment = usingBunRuntime && Bun.env.NODE_ENV !== "production";
const commandNames = ["serve", "doctor", "token", "install-service", "upgrade"] as const;
const repository = "obviyus/shelleport";
const linuxInstallDir = "/usr/local/lib/shelleport";
const linuxBinaryPath = `${linuxInstallDir}/shelleport`;
const linuxCliPath = "/usr/local/bin/shelleport";
const systemdServicePath = "/etc/systemd/system/shelleport.service";

type CommandName = "serve" | "doctor" | "token" | "install-service" | "upgrade";

type CliOptions = {
	command: CommandName;
	help: boolean;
	host: string;
	port: number;
	serviceUser: string | null;
	version: boolean;
};

export async function getServiceEnvironment(home = Bun.env.HOME ?? process.cwd()) {
	const pathEntries = [`${home}/.local/bin`, ...(process.env.PATH ?? "").split(":")].filter(
		Boolean,
	);
	const path = [...new Set(pathEntries)].join(":");
	const claudeBinCandidate = `${home}/.local/bin/claude`;
	const claudeBin =
		process.env.SHELLEPORT_CLAUDE_BIN ??
		((await Bun.file(claudeBinCandidate)
			.stat()
			.catch(() => null))
			? claudeBinCandidate
			: Bun.which(getClaudeBin())
				? getClaudeBin()
				: null);

	return {
		claudeBin,
		path,
	};
}

export function getInstallServiceUser(serviceUser: string | null) {
	if (serviceUser && serviceUser.trim().length > 0) {
		return serviceUser.trim();
	}

	if (process.env.SUDO_USER && process.env.SUDO_USER !== "root") {
		return process.env.SUDO_USER;
	}

	if (process.env.USER && process.env.USER !== "root") {
		return process.env.USER;
	}

	throw new Error("install-service requires --service-user when run as root directly");
}

async function getUserHomeDirectory(user: string) {
	const passwd = await Bun.file("/etc/passwd").text();
	const record =
		passwd
			.split("\n")
			.map((line) => line.trim())
			.find((line) => line.startsWith(`${user}:`)) ?? null;

	if (!record) {
		throw new Error(`Unknown service user: ${user}`);
	}

	const home = record.split(":")[5];

	if (!home) {
		throw new Error(`User ${user} is missing a home directory`);
	}

	return home;
}

async function getLinuxServiceCommand() {
	await Bun.$`mkdir -p ${linuxInstallDir}`.quiet();

	if (usingBunRuntime) {
		const compile = Bun.spawn(["bun", "run", "./scripts/package.ts", "local"], {
			cwd: projectRoot,
			stderr: "inherit",
			stdout: "inherit",
		});
		const exitCode = await compile.exited;

		if (exitCode !== 0) {
			throw new Error("Failed to build native binary for install-service");
		}

		await Bun.write(linuxBinaryPath, Bun.file(join(projectRoot, "dist", "shelleport")));
	} else {
		await Bun.write(linuxBinaryPath, Bun.file(process.execPath));
	}

	await Bun.$`chmod 755 ${linuxBinaryPath}`.quiet();
	await Bun.$`ln -sf ${linuxBinaryPath} ${linuxCliPath}`.quiet();

	return [linuxBinaryPath, "serve"];
}

function getCliCommand() {
	return usingBunRuntime ? ["bun", "run", serverFilePath] : [process.execPath];
}

async function loadAuthModule() {
	return import("~/server/auth.server");
}

async function loadApiModule() {
	return import("~/server/api.server");
}

function parsePort(value: string) {
	const port = Number(value);

	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error(`Invalid port: ${value}`);
	}

	return port;
}

export function getInstallServiceHost(host: string) {
	return host === config.defaultHost ? "0.0.0.0" : host;
}

function getReleaseTarget() {
	if (process.platform === "darwin" && process.arch === "arm64") {
		return "darwin-arm64";
	}

	if (process.platform === "darwin" && process.arch === "x64") {
		return "darwin-x64";
	}

	if (process.platform === "linux" && process.arch === "arm64") {
		return "linux-arm64";
	}

	if (process.platform === "linux" && process.arch === "x64") {
		return "linux-x64";
	}

	throw new Error(`Unsupported platform: ${process.platform}-${process.arch}`);
}

function normalizeReleaseVersion(tag: string) {
	return tag.startsWith("v") ? tag.slice(1) : tag;
}

function getReleaseAssetName(version: string) {
	return `shelleport-v${version}-${getReleaseTarget()}`;
}

function getReleaseUrl(version: string, fileName: string) {
	return `https://github.com/${repository}/releases/download/v${version}/${fileName}`;
}

async function fetchLatestReleaseVersion() {
	const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
		headers: {
			accept: "application/vnd.github+json",
			"user-agent": "shelleport-upgrade",
		},
	});

	if (!response.ok) {
		throw new Error(`Failed to fetch latest release: ${response.status} ${response.statusText}`);
	}

	const payload = await response.json();

	if (!payload || typeof payload.tag_name !== "string" || payload.tag_name.length === 0) {
		throw new Error("Latest release is missing tag_name");
	}

	return normalizeReleaseVersion(payload.tag_name);
}

async function pathExists(path: string) {
	return (await Bun.file(path).exists()) || false;
}

async function getUpgradeBinaryPath() {
	if (process.platform === "linux" && (await pathExists(linuxBinaryPath))) {
		return linuxBinaryPath;
	}

	if (!usingBunRuntime) {
		return process.execPath;
	}

	throw new Error("upgrade requires an installed shelleport binary");
}

async function installReleaseBinary(version: string, targetPath: string) {
	const assetName = getReleaseAssetName(version);
	const tmpDir = await Bun.$`mktemp -d`.text();
	const normalizedTmpDir = tmpDir.trim();
	const downloadPath = join(normalizedTmpDir, assetName);
	const checksumsPath = join(normalizedTmpDir, "SHASUMS256.txt");

	try {
		const binaryResponse = await fetch(getReleaseUrl(version, assetName), {
			headers: {
				"user-agent": "shelleport-upgrade",
			},
		});

		if (!binaryResponse.ok || !binaryResponse.body) {
			throw new Error(`Download failed: ${binaryResponse.status} ${binaryResponse.statusText}`);
		}

		await Bun.write(downloadPath, binaryResponse);

		const checksumsResponse = await fetch(getReleaseUrl(version, "SHASUMS256.txt"), {
			headers: {
				"user-agent": "shelleport-upgrade",
			},
		});

		if (!checksumsResponse.ok) {
			throw new Error(
				`Checksum download failed: ${checksumsResponse.status} ${checksumsResponse.statusText}`,
			);
		}

		await Bun.write(checksumsPath, await checksumsResponse.text());

		const expectedLine =
			(await Bun.file(checksumsPath).text())
				.split("\n")
				.map((line) => line.trim())
				.find((line) => line.endsWith(`  ${assetName}`)) ?? null;

		if (!expectedLine) {
			throw new Error(`Missing checksum for ${assetName}`);
		}

		const expectedChecksum = expectedLine.split(/\s+/)[0];
		const actualChecksum = createHash("sha256")
			.update(await Bun.file(downloadPath).bytes())
			.digest("hex");

		if (expectedChecksum !== actualChecksum) {
			throw new Error(`Checksum mismatch for ${assetName}`);
		}

		await Bun.$`mkdir -p ${dirname(targetPath)}`.quiet();
		await Bun.write(targetPath, Bun.file(downloadPath));
		await Bun.$`chmod 755 ${targetPath}`.quiet();
	} finally {
		if (normalizedTmpDir) {
			await Bun.$`rm -rf ${normalizedTmpDir}`.quiet();
		}
	}
}

function readServiceValue(text: string, key: string) {
	return text.match(new RegExp(`^${key}=(.+)$`, "m"))?.[1]?.trim() ?? null;
}

function buildLinuxSystemdService(
	serviceUser: string,
	serviceHome: string,
	host: string,
	port: number,
	serviceEnvironment: Awaited<ReturnType<typeof getServiceEnvironment>>,
) {
	return `[Unit]
Description=Shelleport host daemon
After=network.target

[Service]
Type=simple
User=${serviceUser}
WorkingDirectory=${serviceHome}
ExecStart=${linuxBinaryPath} serve --host=${host} --port=${port}
Restart=always
Environment=HOME=${serviceHome}
${serviceEnvironment.path ? `Environment=PATH=${serviceEnvironment.path}\n` : ""}${serviceEnvironment.claudeBin ? `Environment=SHELLEPORT_CLAUDE_BIN=${serviceEnvironment.claudeBin}\n` : ""}

[Install]
WantedBy=multi-user.target
`;
}

async function repairInstalledSystemdService() {
	if (process.platform !== "linux" || !(await pathExists(systemdServicePath))) {
		return false;
	}

	const serviceText = await Bun.file(systemdServicePath).text();
	const serviceUser = readServiceValue(serviceText, "User") ?? "root";
	const serviceHome =
		readServiceValue(serviceText, "Environment=HOME") ??
		(serviceUser === "root" ? "/root" : `/home/${serviceUser}`);
	const host =
		readServiceValue(serviceText, "Environment=HOST") ??
		readServiceValue(serviceText, "ExecStart")?.match(/--host=([^\s]+)/)?.[1] ??
		config.defaultHost;
	const portValue =
		readServiceValue(serviceText, "Environment=PORT") ??
		readServiceValue(serviceText, "ExecStart")?.match(/--port=(\d+)/)?.[1] ??
		String(config.defaultPort);
	const port = parsePort(portValue);
	const serviceEnvironment = await getServiceEnvironment(serviceHome);

	await Bun.write(
		systemdServicePath,
		buildLinuxSystemdService(serviceUser, serviceHome, host, port, serviceEnvironment),
	);
	await runCheckedCommand(["systemctl", "daemon-reload"]);
	return true;
}

function getEditDistance(left: string, right: string) {
	const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	const current = new Array<number>(right.length + 1).fill(0);

	for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
		current[0] = leftIndex;

		for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
			const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
			current[rightIndex] = Math.min(
				current[rightIndex - 1] + 1,
				previous[rightIndex] + 1,
				previous[rightIndex - 1] + substitutionCost,
			);
		}

		for (let rightIndex = 0; rightIndex <= right.length; rightIndex += 1) {
			previous[rightIndex] = current[rightIndex]!;
		}
	}

	return previous[right.length]!;
}

function getUnknownCommandError(argument: string) {
	const suggestion = commandNames
		.map((command) => ({
			command,
			distance: getEditDistance(argument, command),
		}))
		.sort((left, right) => left.distance - right.distance)[0];

	if (suggestion && suggestion.distance <= 3) {
		return `Unknown command: ${argument}. Did you mean '${suggestion.command}'?`;
	}

	return `Unknown command: ${argument}. Run 'shelleport --help'.`;
}

async function runCheckedCommand(command: string[]) {
	const process = Bun.spawn(command, {
		stdout: "pipe",
		stderr: "pipe",
	});
	const exitCode = await process.exited;
	const stdout = await new Response(process.stdout).text();
	const stderr = await new Response(process.stderr).text();

	if (exitCode !== 0) {
		throw new Error(stderr.trim() || stdout.trim() || `Command failed: ${command.join(" ")}`);
	}
}

async function getTailscaleIPv4() {
	const process = Bun.spawn(["tailscale", "ip", "-4"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const exitCode = await process.exited;
	const stdout = await new Response(process.stdout).text();
	const stderr = await new Response(process.stderr).text();

	if (exitCode !== 0) {
		throw new Error(stderr.trim() || "tailscale ip -4 failed");
	}

	const addresses = stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);

	if (addresses.length !== 1) {
		throw new Error(
			addresses.length === 0
				? "tailscale ip -4 returned no IPv4 address"
				: "tailscale ip -4 returned multiple IPv4 addresses; pass --host explicitly",
		);
	}

	return addresses[0];
}

export async function parseCliOptions(argv = Bun.argv.slice(2)): Promise<CliOptions> {
	let command: CommandName = "serve";
	let help = false;
	let host = config.defaultHost;
	let port = config.defaultPort;
	let hostSource: "default" | "explicit" = "default";
	let serviceUser: string | null = null;
	let version = false;

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];

		if (!argument) {
			continue;
		}

		const matchedCommand = commandNames.find((candidate) => candidate === argument);

		if (matchedCommand && command === "serve") {
			command = matchedCommand;
			continue;
		}

		if (argument === "--help" || argument === "-h") {
			help = true;
			continue;
		}

		if (argument === "--version" || argument === "-v") {
			version = true;
			continue;
		}

		if (argument === "--host") {
			const value = argv[index + 1];

			if (!value) {
				throw new Error("--host requires a value");
			}

			host = value;
			hostSource = "explicit";
			index += 1;
			continue;
		}

		if (argument.startsWith("--host=")) {
			host = argument.slice("--host=".length);
			hostSource = "explicit";
			continue;
		}

		if (argument === "--port") {
			const value = argv[index + 1];

			if (!value) {
				throw new Error("--port requires a value");
			}

			port = parsePort(value);
			index += 1;
			continue;
		}

		if (argument.startsWith("--port=")) {
			port = parsePort(argument.slice("--port=".length));
			continue;
		}

		if (argument === "--service-user") {
			const value = argv[index + 1];

			if (!value) {
				throw new Error("--service-user requires a value");
			}

			serviceUser = value;
			index += 1;
			continue;
		}

		if (argument.startsWith("--service-user=")) {
			serviceUser = argument.slice("--service-user=".length);
			continue;
		}

		if (argument === "--public") {
			if (hostSource === "explicit") {
				throw new Error("Choose one host option");
			}

			host = "0.0.0.0";
			hostSource = "explicit";
			continue;
		}

		if (argument === "--tailscale") {
			if (hostSource === "explicit") {
				throw new Error("Choose one host option");
			}

			host = await getTailscaleIPv4();
			hostSource = "explicit";
			continue;
		}

		if (!argument.startsWith("-") && command === "serve") {
			throw new Error(getUnknownCommandError(argument));
		}

		throw new Error(`Unknown argument: ${argument}`);
	}

	return {
		command,
		help,
		host,
		port,
		serviceUser,
		version,
	};
}

function printHelp() {
	console.log("Usage: shelleport [command] [options]");
	console.log("");
	console.log("Commands:");
	console.log("  serve              Start the web server");
	console.log("  doctor             Check local setup");
	console.log("  token              Rotate the admin token");
	console.log("  install-service    Write a launchd/systemd service");
	console.log("  upgrade            Download and install the latest release");
	console.log("");
	console.log("Options:");
	console.log("  --host <address>   Bind one address");
	console.log("  --port <port>      Bind one port");
	console.log("  --public           Bind 0.0.0.0");
	console.log("  --tailscale        Bind the Tailscale IPv4");
	console.log("  --service-user     Linux systemd service user (install-service only)");
	console.log("  -h, --help         Show this help");
	console.log("  -v, --version      Show version");
}

function printVersion() {
	console.log(packageJson.version);
}

async function getReachableHosts(host: string) {
	if (host === "127.0.0.1" || host === "::1" || host === "localhost") {
		return [host];
	}

	if (host === "0.0.0.0" || host === "::") {
		const hosts = ["127.0.0.1"];

		try {
			hosts.push(await getTailscaleIPv4());
		} catch {}

		return hosts;
	}

	return [host];
}

async function getProductionShellPath() {
	if (isDevelopment) {
		await Bun.$`rm -rf ${browserOutdir}`.quiet();
		await Bun.$`mkdir -p ${browserOutdir}`.quiet();
		await buildBrowser();

		const { files, shellFileName } = await readBrowserBuild();
		const clientAssetPaths = Object.fromEntries(
			files
				.filter((fileName) => fileName !== shellFileName)
				.map((fileName) => [`/${fileName}`, `${browserOutdir}/${fileName}`]),
		);

		return {
			clientAssetPaths,
			clientShellPath: `${browserOutdir}/${shellFileName}`,
		};
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

async function runDoctor(options: CliOptions) {
	await ensureDataDir();
	const { getAuthStatus } = await loadAuthModule();
	const authStatus = getAuthStatus();

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

	console.log(`host: ${options.host}`);
	console.log(`port: ${options.port}`);
	console.log(`data_dir: ${config.dataDir}`);
	console.log(`admin_token: ${authStatus.hasStoredTokenHash ? "stored-hash" : "uninitialized"}`);
}

async function runInstallService(options: CliOptions) {
	await ensureDataDir();
	const host = getInstallServiceHost(options.host);
	const workingDirectory = usingBunRuntime
		? dirname(fileURLToPath(import.meta.url))
		: dirname(process.execPath);

	if (process.platform === "darwin") {
		const command = [...getCliCommand(), "serve"];
		const serviceEnvironment = await getServiceEnvironment();
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
		<string>${String(options.port)}</string>
		<key>HOST</key>
		<string>${host}</string>
		${serviceEnvironment.path ? `<key>PATH</key>\n\t\t<string>${serviceEnvironment.path}</string>` : ""}
		${serviceEnvironment.claudeBin ? `<key>SHELLEPORT_CLAUDE_BIN</key>\n\t\t<string>${serviceEnvironment.claudeBin}</string>` : ""}
	</dict>
</dict>
</plist>
`;
		await Bun.write(plistPath, plist);
		await runCheckedCommand(["launchctl", "load", "-w", plistPath]);
		console.log(`Wrote ${plistPath}`);
		console.log("Installed and started dev.shelleport");
		return;
	}

	if (typeof process.getuid === "function" && process.getuid() !== 0) {
		throw new Error("Linux install-service now writes a system unit; rerun as root");
	}

	const serviceUser = getInstallServiceUser(options.serviceUser);
	const serviceHome = await getUserHomeDirectory(serviceUser);
	await getLinuxServiceCommand();
	const serviceEnvironment = await getServiceEnvironment(serviceHome);
	await Bun.write(
		systemdServicePath,
		buildLinuxSystemdService(serviceUser, serviceHome, host, options.port, serviceEnvironment),
	);
	await runCheckedCommand(["systemctl", "daemon-reload"]);
	await runCheckedCommand(["systemctl", "enable", "--now", "shelleport.service"]);
	console.log(`Wrote ${systemdServicePath}`);
	console.log(`Installed and started shelleport.service as ${serviceUser}`);
	console.log(`CLI available at ${linuxCliPath}`);
}

async function runToken() {
	await ensureDataDir();
	const { rotateAdminToken } = await loadAuthModule();
	const token = rotateAdminToken();
	console.log("Save this admin token now. It will not be shown again.");
	console.log(token);
	console.log("");
	console.log("Existing sessions were signed out.");
}

async function runUpgrade() {
	const version = await fetchLatestReleaseVersion();
	const targetPath = await getUpgradeBinaryPath();

	if (process.platform === "linux" && targetPath === linuxBinaryPath) {
		const hasService = await repairInstalledSystemdService();
		await installReleaseBinary(version, targetPath);
		await Bun.$`ln -sf ${linuxBinaryPath} ${linuxCliPath}`.quiet();

		if (hasService) {
			await runCheckedCommand(["systemctl", "restart", "shelleport.service"]);
			console.log(`Installed shelleport ${version}.`);
			console.log("Restarted shelleport.service.");
			return;
		}

		console.log(`Installed shelleport ${version}.`);
		return;
	}

	await installReleaseBinary(version, targetPath);
	console.log(`Installed shelleport ${version}.`);
}

export async function createServerFetchHandler(
	clientAssets: Record<string, string> | null = null,
	shellPath: string | null = null,
) {
	const { sessionBroker } = await import("~/server/session-broker.server");
	sessionBroker.recoverInterruptedRuns();

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
				const { handleApiRequest } = await loadApiModule();
				return await handleApiRequest(request);
			}

			if (url.pathname === "/health") {
				return Response.json({
					name: config.appName,
					status: "ok",
				});
			}

			if (url.pathname === "/logout") {
				const { clearAuthCookie } = await loadAuthModule();
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

export async function runServe(options: CliOptions) {
	await ensureDataDir();
	const { ensureAuthSetup } = await loadAuthModule();
	const authSetup = ensureAuthSetup();
	const productionAssets = await getProductionShellPath();
	const fetch = await createServerFetchHandler(
		productionAssets?.clientAssetPaths ?? null,
		productionAssets?.clientShellPath ?? null,
	);
	console.log(`Server binding on ${options.host}:${options.port}`);
	for (const host of await getReachableHosts(options.host)) {
		console.log(`Open: http://${host}:${options.port}`);
	}
	if (options.host === "127.0.0.1" || options.host === "::1" || options.host === "localhost") {
		console.log("Remote access disabled; use --host, --public, or --tailscale");
	}
	if (authSetup.generatedToken) {
		console.log("");
		console.log("Save this admin token now. It will not be shown again.");
		console.log(authSetup.generatedToken);
		console.log("");
	}

	Bun.serve({
		development: isDevelopment
			? {
					console: true,
					hmr: true,
				}
			: false,
		fetch,
		hostname: options.host,
		port: options.port,
		error(error) {
			console.error("Server error:", error);
			return new Response("Server Error", { status: 500 });
		},
	});
}

if (import.meta.main) {
	try {
		const options = await parseCliOptions();
		const { command, help, version } = options;

		if (help) {
			printHelp();
			process.exit(0);
		}

		if (version) {
			printVersion();
			process.exit(0);
		}

		if (command === "doctor") {
			await runDoctor(options);
		} else if (command === "token") {
			await runToken();
		} else if (command === "install-service") {
			await runInstallService(options);
		} else if (command === "upgrade") {
			await runUpgrade();
		} else {
			await runServe(options);
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
