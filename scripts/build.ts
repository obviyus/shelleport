import { join } from "node:path";

const outdir = join(process.cwd(), "build", "client");

async function buildStyles() {
	const process = Bun.spawn(
		[
			"bunx",
			"--bun",
			"@tailwindcss/cli",
			"-i",
			"./app/app.css",
			"-o",
			join(outdir, "client.css"),
			"--minify",
		],
		{
			stderr: "inherit",
			stdout: "inherit",
		},
	);

	if ((await process.exited) !== 0) {
		throw new Error("Tailwind build failed");
	}
}

async function buildClient() {
	const result = await Bun.build({
		entrypoints: ["./app/client.tsx"],
		minify: true,
		naming: {
			asset: "[name].[ext]",
			chunk: "[name].[ext]",
			entry: "[name].[ext]",
		},
		outdir,
		splitting: false,
		target: "browser",
	});

	if (!result.success) {
		for (const log of result.logs) {
			console.error(log.message);
		}

		throw new Error("Client build failed");
	}

	const entry = result.outputs.find((output) => output.path.endsWith("/client.js"));

	if (!entry) {
		throw new Error("Missing browser entry: client.js");
	}
}

await Bun.$`rm -rf ${outdir} build/server`.quiet();
await Bun.$`mkdir -p ${outdir}`.quiet();
await buildStyles();
await buildClient();
