import type { AppRoute } from "~/web/routes";

export type AppBootData = {
	defaultCwd: string;
	route: AppRoute;
};

declare global {
	interface Window {
		__SHELLEPORT_BOOT__?: AppBootData;
	}
}

export function getBootData() {
	const boot = window.__SHELLEPORT_BOOT__;

	if (!boot) {
		throw new Error("Missing boot data");
	}

	return boot;
}
