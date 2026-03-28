const serverOutdir = "./build/server";

export async function getBuildPlugins() {
	const { default: tailwindPlugin } = await import("bun-plugin-tailwind");
	return [tailwindPlugin];
}

export async function buildServer() {
	const result = await Bun.build({
		entrypoints: ["./server.ts"],
		minify: true,
		outdir: serverOutdir,
		plugins: await getBuildPlugins(),
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
	await Bun.$`rm -rf ${serverOutdir}`.quiet();
	await Bun.$`mkdir -p ${serverOutdir}`.quiet();
	await buildServer();
}
