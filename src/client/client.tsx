import { hydrateRoot } from "react-dom/client";
import "~/client/styles.css";
import { App } from "~/client/app";
import { getBootData } from "~/client/boot";
import { BrowserRouterProvider } from "~/client/router";

const root = document.getElementById("root");

if (!root) {
	throw new Error("Missing root element");
}

const boot = getBootData();

hydrateRoot(
	root,
	<BrowserRouterProvider initialRoute={boot.route}>
		<App boot={boot} />
	</BrowserRouterProvider>,
);
