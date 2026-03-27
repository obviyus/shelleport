import { createHash } from "node:crypto";
import { basename, join } from "node:path";

const packageJson = await Bun.file("package.json").json();
const serverEntryPath = join(process.cwd(), "server.ts");
const clientScriptPath = join(process.cwd(), "build", "client", "client.js");
const clientStylePath = join(process.cwd(), "build", "client", "client.css");
const version = packageJson.version;

const releaseTargets = [
	{
		binaryName: `shelleport-v${version}-darwin-arm64`,
		bunTarget: "bun-darwin-arm64",
		slug: "darwin-arm64",
	},
	{
		binaryName: `shelleport-v${version}-darwin-x64`,
		bunTarget: "bun-darwin-x64",
		slug: "darwin-x64",
	},
	{
		binaryName: `shelleport-v${version}-linux-arm64`,
		bunTarget: "bun-linux-arm64",
		slug: "linux-arm64",
	},
	{
		binaryName: `shelleport-v${version}-linux-x64`,
		bunTarget: "bun-linux-x64",
		slug: "linux-x64",
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

function getCompileEntrySource() {
	return [
		`import clientScript from ${JSON.stringify(clientScriptPath)} with { type: "file" };`,
		`import clientStyle from ${JSON.stringify(clientStylePath)} with { type: "file" };`,
		`import { runServe } from ${JSON.stringify(serverEntryPath)};`,
		"",
		"await runServe({",
		'\tentryScriptPath: "/assets/client.js",',
		"\tfiles: [",
		"\t\t{",
		'\t\t\tcacheControl: "public, max-age=31536000, immutable",',
		'\t\t\tpublicPath: "/assets/client.css",',
		"\t\t\tsourcePath: clientStyle,",
		"\t\t},",
		"\t\t{",
		'\t\t\tcacheControl: "public, max-age=31536000, immutable",',
		'\t\t\tpublicPath: "/assets/client.js",',
		"\t\t\tsourcePath: clientScript,",
		"\t\t},",
		"\t],",
		'\tstylePaths: ["/assets/client.css"],',
		"});",
		"",
	].join("\n");
}

async function buildBinary(outputPath: string, bunTarget: string) {
	const stagingDir = join("dist", ".compile");
	const entryPath = join(stagingDir, `${bunTarget}.ts`);

	await Bun.$`mkdir -p ${stagingDir}`.quiet();
	await Bun.write(entryPath, getCompileEntrySource());
	await Bun.$`bun build --compile --target=${bunTarget} --outfile=${outputPath} ${entryPath}`;
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

	await Bun.$`rm -rf ${releaseDir} dist/.compile`.quiet();
	await Bun.$`mkdir -p ${releaseDir}`.quiet();
	await Bun.$`bun run build`;

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

	await Bun.$`rm -rf dist/shelleport dist/.compile`.quiet();
	await Bun.$`bun run build`;
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
