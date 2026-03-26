import { join } from "node:path";

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue };

export async function listJsonlFiles(rootPath: string) {
	const fileList: string[] = [];
	const glob = new Bun.Glob("**/*.jsonl");

	for await (const relativePath of glob.scan({ cwd: rootPath, onlyFiles: true })) {
		fileList.push(join(rootPath, relativePath));
	}

	fileList.sort();
	return fileList;
}

export async function readHeadJsonl(path: string, byteLimit = 131072) {
	const head = await Bun.file(path).slice(0, byteLimit).text();
	const parsedLines: JsonObject[] = [];

	for (const line of head.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) {
			continue;
		}

		try {
			const parsed = JSON.parse(trimmed) as JsonObject;
			parsedLines.push(parsed);
		} catch {
			break;
		}
	}

	return parsedLines;
}
