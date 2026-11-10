import { describe, expect, it, vi } from "vitest";

vi.mock("emdash/api/route-utils", () => ({ getAuthProviderStorage: () => store.stores }));
vi.mock("virtual:emdash/config", () => ({ default: {} }));

import {
	badgeColor,
	closure,
	memberHome,
	describe as wording,
	directLevels,
	entryRequirement,
	levelsFor,
	levelStarts,
	membership,
	memberSince,
	passes,
	simplify,
	topLevels,
} from "../src/access.js";
import { parseGroups } from "../src/access-admin.js";
import type { LevelConfig, RedeemIDConfig } from "../src/config.js";
import { emptyMember } from "../src/storage.js";
import { memoryStores } from "./memory-store.js";

const store = memoryStores();

const levels: LevelConfig[] = [
	{ slug: "members", name: "Members", tags: ["member"] },
	{ slug: "silver", name: "Silver", tags: ["silver"], groups: [{ tags: ["trial", "annual"], match: "all" }], includes: ["members"] },
	{ slug: "gold", name: "Gold", tags: ["gold"], groups: [{ tags: ["silver", "annual"], match: "all" }], includes: ["silver"] },
];

describe("tag groups", () => {
	it("grants a level through any one of its groups", () => {
		expect(directLevels(["gold"], levels)).toEqual(["gold"]);
		expect(directLevels(["silver"], levels)).toEqual(["silver"]);
		expect(directLevels(["Silver", "ANNUAL"], levels)).toEqual(["silver", "gold"]);
		expect(directLevels(["trial"], levels)).toEqual([]);
		expect(directLevels(["trial", "annual"], levels)).toEqual(["silver"]);
	});

	it("works with groups alone, and with no tags at all", () => {
		const only: LevelConfig[] = [{ slug: "x", name: "X", groups: [{ tags: ["a"] }, { tags: ["b", "c"], match: "all" }] }, { slug: "none", name: "None" }];
		expect(levelsFor(["a"], only)).toEqual(["x"]);
		expect(levelsFor(["b"], only)).toEqual([]);
		expect(levelsFor(["b", "c"], only)).toEqual(["x"]);
	});
});

describe("includes", () => {
	it("holds every included level, transitively, in config order", () => {
		expect(levelsFor(["gold"], levels)).toEqual(["members", "silver", "gold"]);
		expect(levelsFor(["silver"], levels)).toEqual(["members", "silver"]);
		expect(levelsFor(["member"], levels)).toEqual(["members"]);
		expect(closure("gold", levels)).toEqual(["gold", "silver", "members"]);
	});

	it("stops on loops and skips unknown levels", () => {
		const loop: LevelConfig[] = [
			{ slug: "a", name: "A", tags: ["a"], includes: ["b", "ghost"] },
			{ slug: "b", name: "B", tags: ["b"], includes: ["a"] },
		];
		expect(levelsFor(["a"], loop)).toEqual(["a", "b"]);
		expect(topLevels(["a", "b"], loop)).toEqual(["a", "b"]);
	});

	it("lets a Gold member pass what needs Silver, not the other way round", () => {
		expect(passes(levelsFor(["gold"], levels), [["silver"]])).toBe(true);
		expect(passes(levelsFor(["silver"], levels), [["gold"]])).toBe(false);
	});

	it("shows the top level only", () => {
		expect(topLevels(levelsFor(["gold"], levels), levels)).toEqual(["gold"]);
		expect(topLevels(levelsFor(["member", "silver"], levels), levels)).toEqual(["silver"]);
	});

	it("simplifies requirements with inclusion", () => {
		expect(simplify([["silver"], ["gold"]], levels)).toEqual([["gold"]]);
		expect(simplify([["gold", "silver"]], levels)).toEqual([["silver"]]);
		expect(simplify([["members"], ["silver"], []], levels)).toEqual([["silver"]]);
		expect(wording([["silver"], ["gold"]], levels)).toBe("Gold");
		expect(wording([["silver", "gold"]], levels)).toBe("Silver");
		expect(simplify(null, levels)).toBeNull();
	});

	it("simplifies an entry's requirement from the site config", async () => {
		const config: RedeemIDConfig = {
			levels,
			rules: [
				{ collection: "posts", taxonomy: "category", term: "silver", levels: ["silver"] },
				{ collection: "posts", taxonomy: "category", term: "gold", levels: ["gold"] },
			],
		};
		expect(await entryRequirement(config, "posts", { category: ["silver", "gold"] })).toEqual([["gold"]]);
	});
});

describe("level dates", () => {
	const m = {
		...emptyMember("1"),
		tags: ["gold", "member"],
		tagsSince: { gold: "2026-03-01", member: "2026-01-01" },
		linkedAt: "2025-12-01",
	};

	it("dates an included level from the level that includes it, or its own tag", () => {
		const starts = levelStarts(m, levels);
		expect(starts.get("gold")).toBe("2026-03-01");
		expect(starts.get("silver")).toBe("2026-03-01");
		expect(starts.get("members")).toBe("2026-01-01");
		expect(memberSince(m, levels)).toBe("2026-01-01");
	});

	it("dates an all-group from its last tag", () => {
		const both = { ...emptyMember("2"), tags: ["silver", "annual"], tagsSince: { silver: "2026-01-01", annual: "2026-04-01" } };
		// Gold through silver + annual (April); Silver through its own tag (January).
		expect(levelStarts(both, levels).get("gold")).toBe("2026-04-01");
		expect(levelStarts(both, levels).get("silver")).toBe("2026-01-01");
		const g = { ...emptyMember("3"), tags: ["trial", "annual"], tagsSince: { trial: "2026-01-01", annual: "2026-04-01" } };
		expect(levelStarts(g, levels).get("silver")).toBe("2026-04-01");
	});

	it("marks included levels in membership()", () => {
		const { current } = membership(m, levels);
		expect(current.map((l) => [l.slug, l.via ?? null])).toEqual([
			["members", null],
			["silver", "gold"],
			["gold", null],
		]);
	});

	it("finds past levels from any group's tags", () => {
		const past = membership({ ...emptyMember("4"), pastTags: [{ tag: "annual", from: "2025-01-01", to: "2025-12-31" }] }, levels).past;
		expect(past.map((p) => p.slug)).toEqual(["silver", "gold"]);
	});
});

describe("the levels form", () => {
	it("reads one group per line, all: for every tag", () => {
		expect(parseGroups("gold\nall: silver, annual")).toEqual([{ tags: ["gold"] }, { tags: ["silver", "annual"], match: "all" }]);
		expect(parseGroups("a, b", "all")).toEqual([{ tags: ["a", "b"], match: "all" }]);
		expect(parseGroups("all: solo")).toEqual([{ tags: ["solo"] }]);
		expect(parseGroups("\n  \nx\nx")).toEqual([{ tags: ["x"] }]);
		expect(parseGroups(["a", "b"])).toEqual([{ tags: ["a", "b"] }]);
	});
});

describe("members' home and badge colours", () => {
	const homes: LevelConfig[] = [
		{ slug: "members", name: "Members", tags: ["member"], home: "/members/" },
		{ slug: "gold", name: "Gold", tags: ["gold"], includes: ["members"], home: "/members/gold/", badge: "#C9A227" },
		{ slug: "odd", name: "Odd", tags: ["odd"], home: "https://evil.example/", badge: "gold; color: red" },
	];

	it("sends a member to their top level's home, same-site only", () => {
		expect(memberHome(["gold", "member"], homes)).toBe("/members/gold/");
		expect(memberHome(["member"], homes)).toBe("/members/");
		expect(memberHome(["odd"], homes)).toBeNull();
		expect(memberHome([], homes)).toBeNull();
	});

	it("takes only hex badge colours", () => {
		expect(badgeColor(homes[1])).toBe("#C9A227");
		expect(badgeColor(homes[2])).toBeNull();
		expect(badgeColor(undefined)).toBeNull();
	});
});
