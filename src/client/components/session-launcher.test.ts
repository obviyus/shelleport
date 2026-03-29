import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionLauncher } from "~/client/components/session-launcher";
import { ToastProvider } from "~/client/components/toast";

describe("SessionLauncher", () => {
	test("shows project controls on empty installs", () => {
		const html = renderToStaticMarkup(
			createElement(
				ToastProvider,
				null,
				createElement(SessionLauncher, {
					createDisabledReason: null,
					createLabel: "managed",
					createProviderId: null,
					defaultPath: "/tmp/project",
					isCreating: false,
					models: [],
					onCreate: () => {},
					onProjectCreated: () => {},
					projects: [],
				}),
			),
		);

		expect(html).toContain("Project");
		expect(html).toContain(">None<");
		expect(html).toContain(">+ New<");
		expect(html).toContain("Save as project");
	});
});
