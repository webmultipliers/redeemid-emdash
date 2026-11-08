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
