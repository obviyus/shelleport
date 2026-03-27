import { join } from "node:path";
import tailwind from "bun-plugin-tailwind";

const outdir = join(process.cwd(), "build", "client");

async function buildClient() {
	const result = await Bun.build({
		entrypoints: ["./src/client/client.tsx"],
		minify: true,
		naming: {
			asset: "[name].[ext]",
			chunk: "[name].[ext]",
			entry: "[name].[ext]",
		},
		outdir,
		plugins: [tailwind],
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

	const style = result.outputs.find((output) => output.path.endsWith("/client.css"));

	if (!style) {
		throw new Error("Missing browser stylesheet: client.css");
	}
}

await Bun.$`rm -rf ${outdir} build/server`.quiet();
await Bun.$`mkdir -p ${outdir}`.quiet();
await buildClient();
