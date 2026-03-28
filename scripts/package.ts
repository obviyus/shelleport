import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { getBuildPlugins } from "./build";

const packageJson = await Bun.file("package.json").json();
const version = packageJson.version;

const releaseTargets = [
	{
		binaryName: `shelleport-v${version}-darwin-arm64`,
		bunTarget: "bun-darwin-arm64",
	},
	{
		binaryName: `shelleport-v${version}-darwin-x64`,
		bunTarget: "bun-darwin-x64",
	},
	{
		binaryName: `shelleport-v${version}-linux-arm64`,
		bunTarget: "bun-linux-arm64",
	},
	{
		binaryName: `shelleport-v${version}-linux-x64`,
		bunTarget: "bun-linux-x64",
	},
] as const;

const currentPlatformTarget =
	process.platform === "darwin" && process.arch === "arm64"
		? releaseTargets[0]
		: process.platform === "darwin" && process.arch === "x64"
			? releaseTargets[1]
			: process.platform === "linux" && process.arch === "arm64"
				? releaseTargets[2]
				: process.platform === "linux" && process.arch === "x64"
					? releaseTargets[3]
					: null;

async function buildBinary(outputPath: string, bunTarget: Bun.Build.CompileTarget) {
	const result = await Bun.build({
		compile: {
			autoloadBunfig: false,
			autoloadDotenv: false,
			outfile: outputPath,
			target: bunTarget,
		},
		entrypoints: ["./server.ts"],
		minify: true,
		plugins: await getBuildPlugins(),
		target: "bun",
	});

	if (!result.success) {
		for (const log of result.logs) {
			console.error(log.message);
		}

		throw new Error(`Binary build failed for ${bunTarget}`);
	}
}

async function writeChecksums(files: string[], outputPath: string) {
	const lines = [];

	for (const filePath of files) {
		const bytes = await Bun.file(filePath).bytes();
		const digest = createHash("sha256").update(bytes).digest("hex");
		lines.push(`${digest}  ${basename(filePath)}`);
	}

	await Bun.write(outputPath, `${lines.join("\n")}\n`);
}

async function buildRelease() {
	const releaseDir = "dist/release";
	const binaries: string[] = [];

	await Bun.$`rm -rf ${releaseDir}`.quiet();
	await Bun.$`mkdir -p ${releaseDir}`.quiet();

	for (const target of releaseTargets) {
		const outputPath = join(releaseDir, target.binaryName);

		await buildBinary(outputPath, target.bunTarget);
		binaries.push(outputPath);
	}

	await writeChecksums(binaries, join(releaseDir, "SHASUMS256.txt"));
}

async function buildLocal() {
	if (!currentPlatformTarget) {
		throw new Error(`Unsupported local compile target: ${process.platform}-${process.arch}`);
	}

	await Bun.$`rm -rf dist/shelleport`.quiet();
	await buildBinary("dist/shelleport", currentPlatformTarget.bunTarget);
}

const mode = Bun.argv[2] ?? "release";

if (mode === "local") {
	await buildLocal();
} else if (mode === "release") {
	await buildRelease();
} else {
	throw new Error(`Unknown packaging mode: ${mode}`);
}
