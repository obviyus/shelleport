import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
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

async function downloadFile(url, destinationPath) {
	const response = await fetch(url, {
		headers: {
			"user-agent": "shelleport-installer",
		},
	});

	if (!response.ok || !response.body) {
		throw new Error(`Download failed: ${response.status} ${response.statusText}`);
	}

	await pipeline(Readable.fromWeb(response.body), createWriteStream(destinationPath));
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
	await downloadFile(getReleaseUrl(assetName), downloadPath);
	await downloadFile(getReleaseUrl("SHASUMS256.txt"), checksumsPath);
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
