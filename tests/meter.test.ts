import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("emdash/api/route-utils", () => ({ getAuthProviderStorage: () => store.stores }));
vi.mock("virtual:emdash/config", () => ({ default: {} }));

import { consume, dripDays, dripOpensAt, memberSince, membership, meterable, periodKey, readEntry } from "../src/access.js";
import type { RedeemIDConfig } from "../src/config.js";
import { emptyMember, stampTags } from "../src/storage.js";
import { memoryStores } from "./memory-store.js";

const store = memoryStores();

const config: RedeemIDConfig = {
	shop: "s.myshopify.com",
	levels: [
		{ slug: "member", name: "Member", tags: ["member"] },
		{ slug: "pro", name: "Pro", tags: ["pro"] },
		{ slug: "both", name: "Both", tags: ["a", "b"], match: "all" },
	],
	rules: [
		{ collection: "posts", taxonomy: "category", term: "reports", levels: ["pro"] },
		{ collection: "posts", taxonomy: "category", term: "vault", levels: ["pro"], meter: false },
		{ collection: "posts", taxonomy: "category", term: "archive", levels: ["member", "pro"], drip: 30 },
		{ collection: "posts", taxonomy: "category", term: "deep", levels: ["member"], drip: 90 },
	],
	meter: { limit: 2, collections: ["posts"] },
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

const days = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

afterEach(() => {
	store.members.clear();
	store.meter.clear();
});

describe("meter helpers", () => {
	it("keys months and ISO weeks in UTC", () => {
		expect(periodKey(new Date("2026-11-08T12:00:00Z"))).toBe("2026-11");
		expect(periodKey(new Date("2026-11-08T12:00:00Z"), "week")).toBe("2026-W45");
		expect(periodKey(new Date("2027-01-01T00:00:00Z"), "week")).toBe("2026-W53");
	});

	it("counts an item once and stops at the limit", () => {
		const a = consume([], "posts:1", 2);
		expect(a).toEqual({ allowed: true, items: ["posts:1"], left: 1 });
		expect(consume(a.items, "posts:1", 2)).toMatchObject({ allowed: true, left: 1 });
		const b = consume(a.items, "posts:2", 2);
		expect(b).toEqual({ allowed: true, items: ["posts:1", "posts:2"], left: 0 });
		expect(consume(b.items, "posts:3", 2)).toEqual({ allowed: false, items: b.items, left: 0 });
		expect(consume(b.items, "posts:2", 2).allowed).toBe(true);
	});

	it("skips rules marked meter: false", () => {
		expect(meterable(config.rules, "posts", { category: ["reports"] })).toBe(true);
		expect(meterable(config.rules, "posts", { category: ["reports", "vault"] })).toBe(false);
	});
});

describe("drip helpers", () => {
	it("takes the largest drip among the deciding rules", () => {
		expect(dripDays(config.rules, "posts", { category: ["archive"] })).toBe(30);
		expect(dripDays(config.rules, "posts", { category: ["archive", "deep"] })).toBe(90);
		expect(dripDays(config.rules, "posts", { category: ["reports"] })).toBe(0);
	});

	it("stamps new tags and forgets removed ones", () => {
		const m = stampTags({ ...emptyMember("1"), tags: ["Member"] }, "2026-01-01T00:00:00Z");
		expect(m.tagsSince).toEqual({ member: "2026-01-01T00:00:00Z" });
		const later = stampTags({ ...m, tags: ["member", "pro"] }, "2026-02-01T00:00:00Z");
		expect(later.tagsSince).toEqual({ member: "2026-01-01T00:00:00Z", pro: "2026-02-01T00:00:00Z" });
		expect(stampTags({ ...later, tags: ["pro"] }, "2026-03-01T00:00:00Z").tagsSince).toEqual({ pro: "2026-02-01T00:00:00Z" });
	});

	it("starts membership at the earliest level held, an all-tags level at its last tag", () => {
		const m = { ...emptyMember("1"), tags: ["pro", "a", "b"], tagsSince: { pro: "2026-03-01", a: "2026-01-01", b: "2026-02-01" } };
		expect(memberSince(m, config.levels)).toBe("2026-02-01");
		expect(memberSince({ ...m, tags: [], tagsSince: {}, linkedAt: "2026-05-05" }, config.levels)).toBe("2026-05-05");
		expect(memberSince({ ...emptyMember("2") }, config.levels)).toBeNull();
		expect(dripOpensAt("2026-01-01T00:00:00Z", 30)?.toISOString()).toBe("2026-01-31T00:00:00.000Z");
		expect(dripOpensAt(null, 30)).toBeNull();
	});
});

describe("readEntry", () => {
	it("holds a drip entry until the member has been in long enough", async () => {
		store.members.set("1", { ...emptyMember("1"), userId: "u1", tags: ["member"], tagsSince: { member: days(10) } });
		const v = await readEntry(astro("u1"), { collection: "posts", terms: { category: ["archive"] }, id: "e1" });
		expect(v).toMatchObject({ allowed: false, reason: "drip" });
		expect(Math.round((v.opensAt!.getTime() - Date.now()) / 86_400_000)).toBe(20);
		store.members.set("1", { ...emptyMember("1"), userId: "u1", tags: ["member"], tagsSince: { member: days(31) } });
		expect((await readEntry(astro("u1"), { collection: "posts", terms: { category: ["archive"] }, id: "e1" })).reason).toBe("allowed");
	});

	it("opens locked entries for a signed-in reader until the meter runs out", async () => {
		store.members.set("1", { ...emptyMember("1"), userId: "u1", tags: ["member"] });
		const read = (id: string, category = "reports") => readEntry(astro("u1"), { collection: "posts", terms: { category: [category] }, id });
		expect(await read("1")).toMatchObject({ allowed: true, reason: "metered", meterLeft: 1 });
		expect(await read("1")).toMatchObject({ allowed: true, reason: "metered", meterLeft: 1 });
		expect(await read("2")).toMatchObject({ allowed: true, reason: "metered", meterLeft: 0 });
		expect(await read("3")).toMatchObject({ allowed: false, reason: "upgrade", meterLeft: 0 });
		expect(await read("1")).toMatchObject({ allowed: true, reason: "metered" });
		expect([...store.meter.values()][0]?.items).toEqual(["posts:1", "posts:2"]);
	});

	it("never meters guests, meter: false rules, other collections, drip, or entries without an id", async () => {
		store.members.set("1", { ...emptyMember("1"), userId: "u1", tags: ["member"], tagsSince: { member: days(1) } });
		expect((await readEntry(astro(), { collection: "posts", terms: { category: ["reports"] }, id: "1" })).reason).toBe("sign_in");
		expect((await readEntry(astro("u1"), { collection: "posts", terms: { category: ["vault"] }, id: "1" })).reason).toBe("upgrade");
		expect((await readEntry(astro("u1"), { collection: "posts", terms: { category: ["reports"] } })).reason).toBe("upgrade");
		expect((await readEntry(astro("u1"), { collection: "posts", terms: { category: ["archive"] }, id: "1" })).reason).toBe("drip");
		expect(store.meter.size).toBe(0);
	});
});

describe("membership", () => {
	it("moves removed tags to pastTags with their dates", () => {
		const m = stampTags({ ...emptyMember("1"), tags: ["member", "pro"] }, "2026-01-01T00:00:00Z");
		const later = stampTags({ ...m, tags: ["member"] }, "2026-04-01T00:00:00Z");
		expect(later.pastTags).toEqual([{ tag: "pro", from: "2026-01-01T00:00:00Z", to: "2026-04-01T00:00:00Z" }]);
	});

	it("lists current levels with start dates and past levels newest first", () => {
		const m = {
			...emptyMember("1"),
			tags: ["member"],
			tagsSince: { member: "2026-02-01" },
			pastTags: [
				{ tag: "pro", from: "2025-01-01", to: "2025-06-01" },
				{ tag: "a", from: null, to: "2026-03-01" },
			],
		};
		const { current, past } = membership(m, config.levels);
		expect(current).toEqual([{ slug: "member", name: "Member", since: "2026-02-01" }]);
		expect(past).toEqual([
			{ slug: "both", name: "Both", from: null, to: "2026-03-01" },
			{ slug: "pro", name: "Pro", from: "2025-01-01", to: "2025-06-01" },
		]);
	});
});
