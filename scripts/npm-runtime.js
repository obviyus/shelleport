import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
const installRoot = join(packageRoot, ".shelleport");
const binaryPath = join(installRoot, "shelleport");
const repository = "obviyus/shelleport";

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

function getReleaseAssetName() {
	return `shelleport-v${packageJson.version}-${getTarget()}`;
}

function getReleaseUrl(fileName) {
	return `https://github.com/${repository}/releases/download/v${packageJson.version}/${fileName}`;
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

async function verifyBinaryChecksum(downloadPath) {
	const checksums = await readFile(join(installRoot, "SHASUMS256.txt"), "utf8");
	const assetName = getReleaseAssetName();
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

export async function installBundle() {
	const assetName = getReleaseAssetName();
	const downloadPath = join(installRoot, assetName);
	const checksumsPath = join(installRoot, "SHASUMS256.txt");
	const stagingPath = join(installRoot, `.tmp-${process.pid}-${Date.now()}`);

	await rm(stagingPath, { force: true });
	await mkdir(installRoot, { recursive: true });
	await downloadFile(getReleaseUrl(assetName), downloadPath, `Downloading ${assetName}`);
	await downloadFile(getReleaseUrl("SHASUMS256.txt"), checksumsPath, "Verifying checksum");
	await verifyBinaryChecksum(downloadPath);
	await rm(stagingPath, { force: true });
	await rename(downloadPath, stagingPath);
	await chmod(stagingPath, 0o755);
	await rm(binaryPath, { force: true });
	await rename(stagingPath, binaryPath);
	await rm(checksumsPath, { force: true });
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
