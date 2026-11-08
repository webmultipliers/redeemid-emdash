import { describe, expect, it, vi } from "vitest";

vi.mock("emdash/api/route-utils", () => ({ getAuthProviderStorage: () => store.stores }));
vi.mock("virtual:emdash/config", () => ({ default: {} }));

import { canRead, describe as wording, levelsFor, passes, requirement, safeReturn } from "../src/access.js";
import type { RedeemIDConfig } from "../src/config.js";
import { emptyMember } from "../src/storage.js";
import { memoryStores } from "./memory-store.js";

const store = memoryStores();

const config: RedeemIDConfig = {
	shop: "s.myshopify.com",
	levels: [
		{ slug: "member", name: "Member", tags: ["Member"] },
		{ slug: "pro", name: "Pro", tags: ["pro", "vip"] },
	],
	rules: [
		{ collection: "posts", levels: [] },
		{ collection: "posts", taxonomy: "category", term: "pro", levels: ["pro"] },
		{ collection: "posts", taxonomy: "category", term: "open-house", levels: [] },
		{ collection: "guides", taxonomy: "tag", term: "a", levels: ["member"] },
		{ collection: "guides", taxonomy: "tag", term: "b", levels: ["pro"] },
	],
};

function astro(userId?: string) {
	return {
		locals: {
			user: userId ? { id: userId } : null,
			emdash: { db: {}, config: { authProviders: [{ id: "redeemid", config }] } },
		},
		response: { headers: new Headers() },
	};
}

describe("levels and rules", () => {
	it("matches tags case-insensitively", () => {
		expect(levelsFor(["member", "VIP"], config.levels)).toEqual(["member", "pro"]);
		expect(levelsFor([], config.levels)).toEqual([]);
	});

	it("needs every tag for an all-of level", () => {
		const levels = [{ slug: "premium", name: "Gold + Silver", tags: ["gold-member", "silver-member"], match: "all" as const }];
		expect(levelsFor(["gold-member"], levels)).toEqual([]);
		expect(levelsFor(["Silver-Member", "gold-member"], levels)).toEqual(["premium"]);
		expect(levelsFor(["x"], [{ slug: "none", name: "None", tags: [], match: "all" }])).toEqual([]);
	});

	it("lets term rules beat collection rules", () => {
		expect(requirement(config.rules, "pages")).toBeNull();
		expect(requirement(config.rules, "posts")).toEqual([[]]);
		expect(requirement(config.rules, "posts", { category: [{ slug: "pro" }] })).toEqual([["pro"]]);
		expect(requirement(config.rules, "guides", { tag: ["c"] })).toBeNull();
	});

	it("needs every matching term rule by default (most restrictive), like WordPress", () => {
		expect(requirement(config.rules, "guides", { tag: ["a", "b"] })).toEqual([["member"], ["pro"]]);
		// An any-member rule adds nothing next to a level rule.
		expect(requirement(config.rules, "posts", { category: [{ slug: "pro" }, { slug: "open-house" }] })).toEqual([["pro"]]);
		expect(passes(["pro"], [["member"], ["pro"]])).toBe(false);
		expect(passes(["member", "pro"], [["member"], ["pro"]])).toBe(true);
		expect(passes([], [[]])).toBe(true);
		// Needing Pro already covers "Member or Pro".
		const both = [
			{ collection: "posts", taxonomy: "category", term: "members", levels: ["member", "pro"] },
			{ collection: "posts", taxonomy: "category", term: "pro", levels: ["pro"] },
		];
		expect(requirement(both, "posts", { category: ["members", "pro"] })).toEqual([["pro"]]);
	});

	it("passes one of them with combine: any", () => {
		const any = { combine: "any" as const };
		expect(requirement(config.rules, "guides", { tag: ["a", "b"] }, any)).toEqual([["member", "pro"]]);
		expect(requirement(config.rules, "posts", { category: ["pro", "open-house"] }, any)).toEqual([[]]);
	});

	it("walks up to the nearest parent term with a rule", () => {
		const rules = [
			{ collection: "reports", levels: ["member"] },
			{ collection: "reports", taxonomy: "series", term: "money", levels: ["pro"] },
			{ collection: "reports", taxonomy: "series", term: "pensions", levels: ["member"] },
		];
		const tree = { series: { money: null, budgets: "money", pensions: "money", deep: "budgets" } };
		expect(requirement(rules, "reports", { series: ["budgets"] }, { tree })).toEqual([["pro"]]);
		expect(requirement(rules, "reports", { series: ["deep"] }, { tree })).toEqual([["pro"]]);
		// A child's own rule beats its parent's.
		expect(requirement(rules, "reports", { series: ["pensions"] }, { tree })).toEqual([["member"]]);
		// Without the tree, only direct rules count.
		expect(requirement(rules, "reports", { series: ["budgets"] })).toEqual([["member"]]);
		// A loop in the tree ends.
		expect(requirement(rules, "reports", { series: ["x"] }, { tree: { series: { x: "y", y: "x" } } })).toEqual([["member"]]);
	});

	it("opens entries with an open term rule and falls back to the site default", () => {
		const rules = [
			{ collection: "*", levels: [] },
			{ collection: "posts", taxonomy: "category", term: "investigations", levels: ["pro"] },
			{ collection: "posts", taxonomy: "tag", term: "free-to-read", levels: [], open: true },
			{ collection: "corrections", taxonomy: "tag", term: "x", levels: ["pro"] },
		];
		expect(requirement(rules, "posts", { category: ["investigations"], tag: ["free-to-read"] })).toBeNull();
		expect(requirement(rules, "posts", { category: ["investigations"] })).toEqual([["pro"]]);
		expect(requirement(rules, "pages")).toEqual([[]]);
		expect(requirement(rules, "corrections")).toEqual([[]]);
	});

	it("words a requirement", () => {
		expect(wording(null, config.levels)).toBe("Free");
		expect(wording([[]], config.levels)).toBe("Members");
		expect(wording([["member", "pro"]], config.levels)).toBe("Member or Pro");
		expect(wording([["member"], ["pro"]], config.levels)).toBe("Member + Pro");
	});

	it("only returns same-site paths", () => {
		expect(safeReturn("/posts/a?x=1")).toBe("/posts/a?x=1");
		for (const bad of ["//evil.example", "https://evil.example", "/\\evil", "", null]) expect(safeReturn(bad)).toBe("/");
	});
});

describe("canRead", () => {
	it("leaves uncovered entries open and asks visitors to sign in", async () => {
		expect((await canRead(astro(), { collection: "pages" })).reason).toBe("open");
		expect((await canRead(astro(), { collection: "posts" })).reason).toBe("sign_in");
	});

	it("reads levels from mirrored tags only", async () => {
		store.members.clear();
		store.members.set("1", { ...emptyMember("1"), userId: "u1", tags: ["member"] });
		const a = astro("u1");
		expect((await canRead(a, { collection: "posts" })).allowed).toBe(true);
		expect(a.response.headers.get("cache-control")).toBe("private, no-store");
		const pro = await canRead(a, { collection: "posts", terms: { category: [{ slug: "pro" }] } });
		expect(pro).toMatchObject({ allowed: false, reason: "upgrade", required: [["pro"]] });
	});

	it("treats a signed-in user with no linked customer as having no levels", async () => {
		store.members.clear();
		const v = await canRead(astro("u9"), { collection: "posts", terms: { category: ["pro"] } });
		expect(v).toMatchObject({ allowed: false, reason: "upgrade" });
	});

	it("locks out disabled Shopify accounts whatever their tags", async () => {
		store.members.clear();
		store.members.set("2", { ...emptyMember("2"), userId: "u2", tags: ["pro"], status: "disabled" });
		const v = await canRead(astro("u2"), { collection: "posts", terms: { category: ["pro"] } });
		expect(v).toMatchObject({ allowed: false, reason: "disabled" });
		expect(v.viewer.levels).toEqual([]);
	});
});
