#!/usr/bin/env node

import { access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { installBundle } from "./npm-runtime.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

async function isSourceCheckout() {
	try {
		await access(join(packageRoot, "server.ts"));
		return true;
	} catch {
		return false;
	}
}

try {
	if (!(await isSourceCheckout())) {
		await installBundle();
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
