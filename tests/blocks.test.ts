import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { PAYWALL_BLOCK, splitAtPaywall } from "../src/blocks-names.js";
import { VERSION } from "../src/version.js";

const p = (k: string) => ({ _type: "block", _key: k });

describe("splitAtPaywall", () => {
	it("keeps a body with no break open", () => {
		const r = splitAtPaywall([p("a"), p("b")]);
		expect(r).toEqual({ open: [p("a"), p("b")], locked: [], levels: [], paywall: false });
	});
	it("splits at the first break and reads its levels", () => {
		const r = splitAtPaywall([p("a"), { _type: PAYWALL_BLOCK, _key: "x", levels: ["gold", "", 3] }, p("b"), { _type: PAYWALL_BLOCK, _key: "y" }, p("c")]);
		expect(r.open).toEqual([p("a")]);
		expect(r.locked.map((b) => b._key)).toEqual(["b", "y", "c"]);
		expect(r.levels).toEqual(["gold"]);
		expect(r.paywall).toBe(true);
	});
	it("treats a missing body as empty", () => {
		expect(splitAtPaywall(null).open).toEqual([]);
	});
});

describe("version", () => {
	it("matches package.json", () => {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
		expect(VERSION).toBe(pkg.version);
	});
});

describe("teaser", () => {
	const block = (text: string) => ({ _type: "block", children: [{ _type: "span", text }] });
	it("keeps the whole text blocks within the word count", async () => {
		const { teaser } = await import("../src/blocks-names.js");
		const body = [block("one two three"), { _type: "image" }, block("four five"), block("six")];
		expect(teaser(body, 0)).toEqual([]);
		expect(teaser(body, 2)).toEqual([]);
		expect(teaser(body, 3)).toEqual([body[0]]);
		expect(teaser(body, 5)).toEqual([body[0], body[2]]);
		expect(teaser(body, 99)).toEqual([body[0], body[2], body[3]]);
		expect(teaser(null, 5)).toEqual([]);
	});
});
