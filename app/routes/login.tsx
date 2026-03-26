import { useId } from "react";
import { data, Form, redirect, useActionData, useNavigation } from "react-router";
import { isValidAdminToken } from "~/server/auth.server";
import { commitSession, getSession } from "~/server/session.server";
import type { Route } from "./+types/login";

type ActionData = {
	fieldErrors?: FieldErrors;
};

type FieldErrors = {
	token?: string;
};

export async function loader({ request }: Route.LoaderArgs) {
	const session = await getSession(request.headers.get("Cookie"));

	if (session.get("authenticated")) {
		throw redirect("/");
	}

	const errorValue = session.get("error");
	const error = typeof errorValue === "string" ? errorValue : null;
	return data(
		{ error },
		{
			headers: {
				"Set-Cookie": await commitSession(session),
			},
		},
	);
}

export async function action({ request }: Route.ActionArgs) {
	const formData = await request.formData();
	const tokenEntry = formData.get("token");
	const tokenValue = typeof tokenEntry === "string" ? tokenEntry.trim() : "";

	const fieldErrors: FieldErrors = {};

	if (tokenValue.length === 0) {
		fieldErrors.token = "Admin token is required";
	}

	if (Object.keys(fieldErrors).length > 0) {
		return data({ fieldErrors }, 400);
	}

	const session = await getSession(request.headers.get("Cookie"));

	const invalidCredentialsResponse = async () => {
		session.flash("error", "Invalid admin token");

		return redirect("/login", {
			headers: {
				"Set-Cookie": await commitSession(session),
			},
		});
	};

	if (!isValidAdminToken(tokenValue)) {
		return invalidCredentialsResponse();
	}

	session.set("authenticated", true);

	return redirect("/", {
		headers: {
			"Set-Cookie": await commitSession(session),
		},
	});
}

export default function Login({ loaderData }: Route.ComponentProps) {
	const tokenId = useId();
	const actionData = useActionData<ActionData>();
	const navigation = useNavigation();
	const isSubmitting = navigation.state === "submitting";
	const fieldErrors = actionData?.fieldErrors ?? {};

	return (
		<main className="grid min-h-screen place-items-center bg-[radial-gradient(circle_at_top,rgba(255,214,10,0.18),transparent_38%),linear-gradient(135deg,#07131a_0%,#10232c_40%,#d5e6ec_100%)] px-4 py-10 text-white">
			<section className="w-full max-w-md rounded-[2rem] border border-white/15 bg-slate-950/70 p-10 shadow-[0_30px_120px_rgba(0,0,0,0.35)] backdrop-blur">
				<header className="mb-8">
					<p className="font-mono text-xs uppercase tracking-[0.4em] text-cyan-200/70">shelleport</p>
					<h1 className="mt-4 text-4xl font-semibold tracking-tight">Host-local agent control.</h1>
					<p className="mt-3 text-sm leading-6 text-slate-300">
						One admin token. One machine. Sessions stay on this host.
					</p>
				</header>

				{loaderData.error ? (
					<div className="mb-6 rounded-2xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
						{loaderData.error}
					</div>
				) : null}

				<Form className="space-y-6" method="post" replace>
					<div className="space-y-2.5">
						<label className="text-sm font-medium text-slate-200" htmlFor={tokenId}>
							Admin token
						</label>
						<input
							autoComplete="current-password"
							className="w-full rounded-2xl border border-white/15 bg-white/5 px-4 py-3 text-sm text-white shadow-sm transition placeholder:text-slate-500 focus-visible:border-cyan-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/20"
							id={tokenId}
							name="token"
							placeholder="Paste SHELLEPORT_ADMIN_TOKEN"
							type="password"
						/>
						{fieldErrors.token ? (
							<p className="text-sm text-rose-200">{fieldErrors.token}</p>
						) : null}
					</div>

					<button
						className="flex w-full items-center justify-center rounded-2xl bg-cyan-300 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/40 disabled:cursor-not-allowed disabled:bg-cyan-300/60"
						disabled={isSubmitting}
						type="submit"
					>
						{isSubmitting ? "Authorizing..." : "Enter machine"}
					</button>
				</Form>
			</section>
		</main>
	);
}
