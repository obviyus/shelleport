import { hydrateRoot } from "react-dom/client";
import { App } from "~/web/app";
import { getBootData } from "~/web/boot";
import { BrowserRouterProvider } from "~/web/router";

const root = document.getElementById("root");

if (!root) {
	throw new Error("Missing root element");
}

const boot = getBootData();

hydrateRoot(
	root,
	<BrowserRouterProvider initialRoute={boot.route}>
		<App defaultCwd={boot.defaultCwd} />
	</BrowserRouterProvider>,
);
