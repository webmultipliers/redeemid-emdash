import { describe, expect, it } from "vitest";

import { filterResults, titleMatches, words } from "../src/search-guard.js";

describe("site search filter", () => {
	it("splits the query into lowercase words", () => {
		expect(words("Harbor  DREDGING, 2026")).toEqual(["harbor", "dredging", "2026"]);
		expect(words("  ")).toEqual([]);
	});

	it("matches a title holding every word, as a word or its start", () => {
		expect(titleMatches("The Harbor Dredging Files", "harbor dredg")).toBe(true);
		expect(titleMatches("The Harbor Files", "harbor dredging")).toBe(false);
		expect(titleMatches("Harbor", "")).toBe(false);
		expect(titleMatches(null, "harbor")).toBe(false);
	});

	it("keeps readable results whole and locked ones only by title, without a snippet", async () => {
		const items = [
			{ collection: "posts", id: "open", title: "Open post", snippet: "open <mark>secret</mark>" },
			{ collection: "posts", id: "locked", title: "Gold story", snippet: "the <mark>secret</mark> source" },
			{ collection: "posts", id: "titled", title: "The secret list", snippet: "inside <mark>secret</mark>" },
			{ collection: "posts", id: "broken", title: "Broken", snippet: "<mark>secret</mark>" },
			{ title: "No id", snippet: "<mark>secret</mark>" },
		];
		const readable = async (_c: string, id: string) => {
			if (id === "broken") throw new Error("db");
			return id === "open";
		};
		const out = await filterResults(items, "secret", readable);
		expect(out).toEqual([
			{ collection: "posts", id: "open", title: "Open post", snippet: "open <mark>secret</mark>" },
			{ collection: "posts", id: "titled", title: "The secret list" },
		]);
	});
});
