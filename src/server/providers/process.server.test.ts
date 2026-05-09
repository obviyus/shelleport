import { describe, expect, test } from "bun:test";
import { TextTail } from "~/server/providers/process.server";

describe("TextTail", () => {
	test("keeps only the most recent text", () => {
		const tail = new TextTail(10);

		tail.append("first:");
		tail.append("second");

		expect(tail.text()).toBe("rst:second");
	});

	test("decodes chunked utf-8", () => {
		const tail = new TextTail();
		const bytes = new TextEncoder().encode("ready \u2713");

		tail.append(bytes.slice(0, 7));
		tail.append(bytes.slice(7));

		expect(tail.text()).toBe("ready \u2713");
	});
});
