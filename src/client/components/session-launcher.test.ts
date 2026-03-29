import { describe, expect, test } from "bun:test";
import {
	shouldShowProjectSection,
	shouldShowSaveAsProject,
} from "~/client/components/session-launcher";

describe("shouldShowProjectSection", () => {
	test("shows the project section even when no projects exist", () => {
		expect(shouldShowProjectSection({ length: 0 })).toBe(true);
	});

	test("shows the project section when projects exist", () => {
		expect(shouldShowProjectSection({ length: 3 })).toBe(true);
	});
});

describe("shouldShowSaveAsProject", () => {
	test("shows save-as-project when no project is selected and not creating new", () => {
		expect(shouldShowSaveAsProject(null, false)).toBe(true);
	});

	test("hides save-as-project when a project is selected", () => {
		expect(shouldShowSaveAsProject("project-1", false)).toBe(false);
	});

	test("hides save-as-project when creating a new project", () => {
		expect(shouldShowSaveAsProject(null, true)).toBe(false);
	});
});
