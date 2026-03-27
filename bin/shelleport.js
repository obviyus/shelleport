#!/usr/bin/env node

import { access } from "node:fs/promises";
import { constants } from "node:fs";
import {
	getInstalledBinaryPath,
	runInstalledBinary,
	upgradeBundle,
} from "../scripts/npm-runtime.js";

async function ensureInstalledBinary() {
	try {
		await access(getInstalledBinaryPath(), constants.X_OK);
	} catch {
		await installBundle();
	}
}

await ensureInstalledBinary();

const args = process.argv.slice(2);

if (args[0] === "upgrade") {
	const { restartedService, version } = await upgradeBundle();
	console.log(`Installed shelleport ${version}.`);

	if (restartedService) {
		console.log("Restarted shelleport.service.");
	} else if (process.platform === "linux") {
		console.log("No user systemd service found. Start it manually if needed.");
	}

	process.exit(0);
}

runInstalledBinary(args);
