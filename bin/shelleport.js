#!/usr/bin/env node

import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { getInstalledBinaryPath, runInstalledBinary } from "../scripts/npm-runtime.js";

try {
	await access(getInstalledBinaryPath(), constants.X_OK);
} catch {
	console.error("Shelleport runtime missing. Reinstall the package.");
	process.exit(1);
}

runInstalledBinary(process.argv.slice(2));
