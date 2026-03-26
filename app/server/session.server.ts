import { createCookieSessionStorage } from "react-router";

type SessionData = {
	authenticated: boolean;
};

type SessionFlashData = {
	error: string;
};

const { getSession, commitSession, destroySession } = createCookieSessionStorage<
	SessionData,
	SessionFlashData
>({
	cookie: {
		name: "__session",
		httpOnly: true,
		maxAge: 60 * 60 * 24 * 7,
		path: "/",
		sameSite: "lax",
		secrets: [Bun.env.COOKIE_SECRET ?? "dev-cookie-secret"],
		secure: Bun.env.NODE_ENV === "production",
	},
});

export { getSession, commitSession, destroySession };
