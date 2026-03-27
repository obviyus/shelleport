import { renderToReadableStream } from "react-dom/server";
import type { ClientAsset, ClientAssets } from "~/server/client-assets.server";
import { App } from "~/client/app";
import type { AppBootData } from "~/client/boot";
import { StaticRouterProvider } from "~/client/router";
import { matchAppRoute } from "~/client/routes";

type WebServerOptions = {
	clientAssets: ClientAssets;
	defaultCwd: string;
};

function getAssetResponse(asset: ClientAsset) {
	return new Response(Bun.file(asset.sourcePath), {
		headers: {
			"Cache-Control": asset.cacheControl,
		},
	});
}

function serializeBootData(boot: AppBootData) {
	return JSON.stringify(boot).replaceAll("<", "\\u003c");
}

function LogoutPage() {
	return (
		<html lang="en" className="dark">
			<head>
				<meta charSet="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<title>shelleport</title>
			</head>
			<body className="bg-background text-foreground">
				<script
					dangerouslySetInnerHTML={{
						__html:
							'localStorage.removeItem("shelleport_token");window.location.replace("/login");',
					}}
				/>
			</body>
		</html>
	);
}

function Document({ boot, clientAssets }: { boot: AppBootData; clientAssets: ClientAssets }) {
	return (
		<html lang="en" className="dark">
			<head>
				<meta charSet="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<title>shelleport</title>
				{clientAssets.stylePaths.map((stylePath) => (
					<link key={stylePath} rel="stylesheet" href={stylePath} />
				))}
			</head>
			<body>
				<div id="root">
					<StaticRouterProvider route={boot.route}>
						<App defaultCwd={boot.defaultCwd} />
					</StaticRouterProvider>
				</div>
				<script
					dangerouslySetInnerHTML={{
						__html: `window.__SHELLEPORT_BOOT__ = ${serializeBootData(boot)};`,
					}}
				/>
				<script type="module" src={clientAssets.entryScriptPath} />
			</body>
		</html>
	);
}

async function renderHtmlResponse(element: React.ReactNode, status: number) {
	const stream = await renderToReadableStream(element);
	return new Response(stream, {
		status,
		headers: {
			"Content-Type": "text/html; charset=utf-8",
		},
	});
}

export async function handleWebRequest(request: Request, options: WebServerOptions) {
	const url = new URL(request.url);
	const asset = options.clientAssets.files.find(
		(candidate) => candidate.publicPath === url.pathname,
	);

	if (asset) {
		return getAssetResponse(asset);
	}

	if (url.pathname === "/logout") {
		return renderHtmlResponse(<LogoutPage />, 200);
	}

	const route = matchAppRoute(url.pathname);
	const boot = {
		defaultCwd: options.defaultCwd,
		route,
	} satisfies AppBootData;

	return renderHtmlResponse(
		<Document boot={boot} clientAssets={options.clientAssets} />,
		route.kind === "not-found" ? 404 : 200,
	);
}
