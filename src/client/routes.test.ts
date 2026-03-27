import { describe, expect, test } from "bun:test";
import { matchAppRoute } from "~/client/routes";

describe("matchAppRoute", () => {
	test("matches home", () => {
		expect(matchAppRoute("/")).toEqual({
			kind: "home",
			pathname: "/",
			params: {},
		});
	});

	test("matches archived", () => {
		expect(matchAppRoute("/archived")).toEqual({
			kind: "archived",
			pathname: "/archived",
			params: {},
		});
	});

	test("matches session route", () => {
		expect(matchAppRoute("/sessions/test-id")).toEqual({
			kind: "session",
			pathname: "/sessions/test-id",
			params: {
				sessionId: "test-id",
			},
		});
	});

	test("decodes session params", () => {
		expect(matchAppRoute("/sessions/a%2Fb")).toEqual({
			kind: "session",
			pathname: "/sessions/a%2Fb",
			params: {
				sessionId: "a/b",
			},
		});
	});

	test("matches login", () => {
		expect(matchAppRoute("/login")).toEqual({
			kind: "login",
			pathname: "/login",
			params: {},
		});
	});

	test("matches logout", () => {
		expect(matchAppRoute("/logout")).toEqual({
			kind: "logout",
			pathname: "/logout",
			params: {},
		});
	});

	test("falls through to not found", () => {
		expect(matchAppRoute("/missing")).toEqual({
			kind: "not-found",
			pathname: "/missing",
			params: {},
		});
	});
});
