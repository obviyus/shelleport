import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
const installRoot = join(packageRoot, ".shelleport");
const binaryPath = join(installRoot, "shelleport");
const repository = "obviyus/shelleport";

export function getSystemdServicePath() {
	return "/etc/systemd/system/shelleport.service";
}

function getTarget() {
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

export function normalizeReleaseVersion(tag) {
	return tag.startsWith("v") ? tag.slice(1) : tag;
}

export function getReleaseAssetName(version = packageJson.version) {
	return `shelleport-v${version}-${getTarget()}`;
}

function getReleaseUrl(version, fileName) {
	return `https://github.com/${repository}/releases/download/v${version}/${fileName}`;
}

function formatBytes(bytes) {
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} KB`;
	}

	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderDownloadProgress(label, downloadedBytes, totalBytes) {
	if (!process.stderr.isTTY) {
		return;
	}

	if (!totalBytes) {
		process.stderr.write(`\r${label} ${formatBytes(downloadedBytes)}`);
		return;
	}

	const width = 28;
	const ratio = Math.min(downloadedBytes / totalBytes, 1);
	const filled = Math.round(width * ratio);
	const bar = `${"=".repeat(filled)}${" ".repeat(width - filled)}`;
	const percent = String(Math.round(ratio * 100)).padStart(3, " ");

	process.stderr.write(
		`\r${label} [${bar}] ${percent}% ${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)}`,
	);
}

function finishDownloadProgress() {
	if (process.stderr.isTTY) {
		process.stderr.write("\n");
	}
}

async function downloadFile(url, destinationPath, label) {
	const response = await fetch(url, {
		headers: {
			"user-agent": "shelleport-installer",
		},
	});

	if (!response.ok || !response.body) {
		throw new Error(`Download failed: ${response.status} ${response.statusText}`);
	}

	const totalBytesHeader = response.headers.get("content-length");
	const totalBytes = totalBytesHeader ? Number(totalBytesHeader) : 0;
	const input = Readable.fromWeb(response.body);
	const output = createWriteStream(destinationPath);
	let downloadedBytes = 0;
	let lastRenderTime = 0;

	for await (const chunk of input) {
		downloadedBytes += chunk.length;
		if (!output.write(chunk)) {
			await new Promise((resolve) => output.once("drain", resolve));
		}

		const now = Date.now();
		if (now - lastRenderTime >= 100) {
			renderDownloadProgress(label, downloadedBytes, totalBytes);
			lastRenderTime = now;
		}
	}

	output.end();
	await new Promise((resolve, reject) => {
		output.once("finish", resolve);
		output.once("error", reject);
	});
	renderDownloadProgress(label, downloadedBytes, totalBytes);
	finishDownloadProgress();
}

async function verifyBinaryChecksum(downloadPath, version) {
	const checksums = await readFile(join(installRoot, "SHASUMS256.txt"), "utf8");
	const assetName = getReleaseAssetName(version);
	const expectedLine = checksums
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.endsWith(`  ${assetName}`));

	if (!expectedLine) {
		throw new Error(`Missing checksum for ${assetName}`);
	}

	const expectedChecksum = expectedLine.split(/\s+/)[0];
	const downloadBytes = await readFile(downloadPath);
	const actualChecksum = createHash("sha256").update(downloadBytes).digest("hex");

	if (actualChecksum !== expectedChecksum) {
		throw new Error(`Checksum mismatch for ${assetName}`);
	}
}

async function installBundleForVersion(version) {
	const assetName = getReleaseAssetName(version);
	const downloadPath = join(installRoot, assetName);
	const checksumsPath = join(installRoot, "SHASUMS256.txt");
	const stagingPath = join(installRoot, `.tmp-${process.pid}-${Date.now()}`);

	await rm(stagingPath, { force: true });
	await mkdir(installRoot, { recursive: true });
	await downloadFile(getReleaseUrl(version, assetName), downloadPath, `Downloading ${assetName}`);
	await downloadFile(getReleaseUrl(version, "SHASUMS256.txt"), checksumsPath, "Verifying checksum");
	await verifyBinaryChecksum(downloadPath, version);
	await rm(stagingPath, { force: true });
	await rename(downloadPath, stagingPath);
	await chmod(stagingPath, 0o755);
	await rm(binaryPath, { force: true });
	await rename(stagingPath, binaryPath);
	await rm(checksumsPath, { force: true });
}

export async function installBundle(version = packageJson.version) {
	await installBundleForVersion(version);
}

export async function fetchLatestReleaseVersion() {
	const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
		headers: {
			accept: "application/vnd.github+json",
			"user-agent": "shelleport-installer",
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

async function serviceFileExists(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

function readSystemdUser(text) {
	const match = text.match(/^User=(.+)$/m);
	return match?.[1]?.trim() ?? null;
}

function readSystemdHome(text) {
	const match = text.match(/^Environment=HOME=(.+)$/m);
	return match?.[1]?.trim() ?? null;
}

function getUserHome(user) {
	return user === "root" ? "/root" : `/home/${user}`;
}

async function findClaudeBinary(home) {
	if (process.env.SHELLEPORT_CLAUDE_BIN) {
		return process.env.SHELLEPORT_CLAUDE_BIN;
	}

	if (!home) {
		return null;
	}

	const candidate = join(home, ".local", "bin", "claude");

	try {
		await stat(candidate);
		return candidate;
	} catch {
		return null;
	}
}

export function upsertSystemdEnvironment(text, key, value) {
	const line = `Environment=${key}=${value}`;
	const pattern = new RegExp(`^Environment=${key}=.*$`, "m");

	if (pattern.test(text)) {
		return text.replace(pattern, line);
	}

	const anchor = "[Install]";
	const index = text.indexOf(anchor);

	if (index === -1) {
		return `${text.trimEnd()}\n${line}\n`;
	}

	return `${text.slice(0, index)}${line}\n${text.slice(index)}`;
}

function buildServicePath(home) {
	const pathEntries = [`${home}/.local/bin`, ...(process.env.PATH ?? "").split(":")].filter(
		Boolean,
	);
	return [...new Set(pathEntries)].join(":");
}

export async function patchInstalledSystemdService() {
	if (process.platform !== "linux") {
		return false;
	}

	const servicePath = getSystemdServicePath();

	if (!(await serviceFileExists(servicePath))) {
		return false;
	}

	let text = await readFile(servicePath, "utf8");
	const serviceUser = readSystemdUser(text);
	const serviceHome =
		readSystemdHome(text) ??
		(serviceUser ? getUserHome(serviceUser) : (process.env.HOME ?? process.cwd()));
	const path = buildServicePath(serviceHome);
	const claudeBin = await findClaudeBinary(serviceHome);

	if (path) {
		text = upsertSystemdEnvironment(text, "PATH", path);
	}

	if (claudeBin) {
		text = upsertSystemdEnvironment(text, "SHELLEPORT_CLAUDE_BIN", claudeBin);
	}

	await writeFile(servicePath, text);
	await runCommand("systemctl", ["daemon-reload"]);
	return true;
}

function runCommand(command, args) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			env: process.env,
			stdio: "inherit",
		});

		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (signal) {
				reject(new Error(`${command} exited with signal ${signal}`));
				return;
			}

			if (code !== 0) {
				reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}`));
				return;
			}

			resolve();
		});
	});
}

export async function restartInstalledService() {
	if (process.platform !== "linux") {
		return false;
	}

	if (!(await serviceFileExists(getSystemdServicePath()))) {
		return false;
	}

	await runCommand("systemctl", ["restart", "shelleport.service"]);
	return true;
}

export async function upgradeBundle() {
	const version = await fetchLatestReleaseVersion();
	await installBundleForVersion(version);
	await patchInstalledSystemdService();
	const restartedService = await restartInstalledService();
	return {
		restartedService,
		version,
	};
}

export function getInstalledBinaryPath() {
	return binaryPath;
}

export function runInstalledBinary(args) {
	const child = spawn(getInstalledBinaryPath(), args, {
		env: process.env,
		stdio: "inherit",
	});

	child.on("exit", (code, signal) => {
		if (signal) {
			process.kill(process.pid, signal);
			return;
		}

		process.exit(code ?? 1);
	});

	child.on("error", (error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
