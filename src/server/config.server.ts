import { join } from "node:path";

const homeDir = Bun.env.HOME ?? process.cwd();
const xdgDataHome = Bun.env.XDG_DATA_HOME ?? join(homeDir, ".local", "share");

export const config = {
	appName: "shelleport",
	get defaultPort() {
		return Number(Bun.env.PORT ?? 1206);
	},
	get defaultHost() {
		return Bun.env.HOST ?? "127.0.0.1";
	},
	get dataDir() {
		return Bun.env.SHELLEPORT_DATA_DIR ?? join(xdgDataHome, "shelleport");
	},
};

export async function ensureDataDir() {
	await Bun.$`mkdir -p ${config.dataDir}`.quiet();
}

export function getDatabasePath() {
	return join(config.dataDir, "shelleport.sqlite");
}

export function getClaudeBin() {
	return Bun.env.SHELLEPORT_CLAUDE_BIN ?? "claude";
}
