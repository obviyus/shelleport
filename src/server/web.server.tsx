import { renderToReadableStream } from "react-dom/server";
import { App } from "~/client/app";
import type { AppBootData } from "~/client/boot";
import { StaticRouterProvider } from "~/client/router";
import { isAppShellRoute, matchAppRoute } from "~/client/routes";
import { clearAuthCookie, isAuthenticated } from "~/server/auth.server";
import type { ClientAsset, ClientAssets } from "~/server/client-assets.server";
import { listProviders } from "~/server/providers/registry.server";
import { sessionBroker } from "~/server/session-broker.server";

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

function redirect(location: string, headers?: HeadersInit) {
	const responseHeaders = new Headers(headers);
	responseHeaders.set("Location", location);

	return new Response(null, {
		status: 302,
		headers: responseHeaders,
	});
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
						<App boot={boot} />
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
		return redirect("/login", {
			"Set-Cookie": clearAuthCookie(),
		});
	}

	let route = matchAppRoute(url.pathname);
	const authenticated = isAuthenticated(request);
	let sessionDetail = route.kind === "session" ? sessionBroker.getSessionDetail(route.params.sessionId) : null;

	if (route.kind === "login" && authenticated) {
		return redirect("/");
	}

	if (isAppShellRoute(route) && !authenticated) {
		return redirect("/login");
	}

	if (authenticated && route.kind === "session" && !sessionDetail) {
		route = {
			kind: "not-found",
			pathname: route.pathname,
			params: {},
		};
	}

	const boot = authenticated
		? ({
				authenticated: true,
				defaultCwd: options.defaultCwd,
				providers: listProviders(),
				route,
				sessionDetail: route.kind === "session" ? sessionDetail : null,
				sessions: sessionBroker.listSessions(),
			} satisfies AppBootData)
		: ({
				authenticated: false,
				defaultCwd: options.defaultCwd,
				route,
			} satisfies AppBootData);

	return renderHtmlResponse(
		<Document boot={boot} clientAssets={options.clientAssets} />,
		route.kind === "not-found" ? 404 : 200,
	);
}
