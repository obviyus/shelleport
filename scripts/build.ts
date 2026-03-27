const outdir = "./build/server";

async function buildServer() {
	const { default: tailwindPlugin } = await import("bun-plugin-tailwind");
	const result = await Bun.build({
		entrypoints: ["./server.ts"],
		minify: true,
		outdir,
		plugins: [tailwindPlugin],
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
	await Bun.$`rm -rf ${outdir}`.quiet();
	await Bun.$`mkdir -p ${outdir}`.quiet();
	await buildServer();
}
