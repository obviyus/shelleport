import { readdir } from "node:fs/promises";

export const browserOutdir = "./src/client/.generated";
const serverOutdir = "./build/server";

async function rewriteBrowserShell(fileName: string) {
	const shellPath = `${browserOutdir}/${fileName}`;
	const shellHtml = await Bun.file(shellPath).text();
	await Bun.write(
		shellPath,
		shellHtml.replaceAll('href="./', 'href="/').replaceAll('src="./', 'src="/'),
	);
}

async function writeBrowserManifest() {
	const { files, shellFileName } = await readBrowserBuild();
	const imports: string[] = [];
	const assetEntries: string[] = [];
	let shellImportName = "";

	for (const [index, fileName] of files.entries()) {
		const importName = `asset${index}`;
		imports.push(
			`import ${importName} from "../client/.generated/${fileName}" with { type: "file" };`,
		);
		if (fileName === shellFileName) {
			shellImportName = importName;
			continue;
		}

		assetEntries.push(`\t"/${fileName}": ${importName},`);
	}

	if (!shellImportName) {
		throw new Error("Browser build did not emit an HTML shell");
	}

	const manifestSource = `${imports.join("\n")}

export const clientAssetPaths = {
${assetEntries.join("\n")}
};

export const clientShellPath = ${shellImportName};
`;

	await Bun.write("./src/server/client-assets.generated.js", manifestSource);
}

export async function readBrowserBuild() {
	const entries = await readdir(browserOutdir, { withFileTypes: true });
	const files = entries
		.filter((entry) => entry.isFile())
		.map((entry) => entry.name)
		.sort((left, right) => left.localeCompare(right));
	const shellFileName = files.find((fileName) => fileName.endsWith(".html"));

	if (!shellFileName) {
		throw new Error("Browser build did not emit an HTML shell");
	}

	await rewriteBrowserShell(shellFileName);

	return {
		files,
		shellFileName,
	};
}

export async function buildBrowser() {
	const { default: tailwindPlugin } = await import("bun-plugin-tailwind");
	const result = await Bun.build({
		entrypoints: ["./src/client/index.html"],
		minify: true,
		naming: {
			asset: "[dir]/[name]-[hash].[ext]",
			chunk: "[dir]/[name]-[hash].[ext]",
			entry: "[dir]/[name].built.[ext]",
		},
		outdir: browserOutdir,
		plugins: [tailwindPlugin],
		target: "browser",
	});

	if (!result.success) {
		for (const log of result.logs) {
			console.error(log.message);
		}

		throw new Error("Browser build failed");
	}

	await writeBrowserManifest();
}

export async function buildServer() {
	const result = await Bun.build({
		entrypoints: ["./server.ts"],
		minify: true,
		outdir: serverOutdir,
		target: "bun",
	});

	if (!result.success) {
		for (const log of result.logs) {
			console.error(log.message);
		}

		throw new Error("Server build failed");
	}
}

if (import.meta.main) {
	await Bun.$`rm -rf ${browserOutdir} ${serverOutdir}`.quiet();
	await Bun.$`mkdir -p ${browserOutdir} ${serverOutdir}`.quiet();
	await buildBrowser();
	await buildServer();
}
