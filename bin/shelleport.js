#!/usr/bin/env node

import { access } from "node:fs/promises";
import { constants } from "node:fs";
import {
	getInstalledBinaryPath,
	installBundle,
	runInstalledBinary,
} from "../scripts/npm-runtime.js";

async function ensureInstalledBinary() {
	try {
		await access(getInstalledBinaryPath(), constants.X_OK);
	} catch {
		await installBundle();
	}
}

await ensureInstalledBinary();
runInstalledBinary(process.argv.slice(2));
