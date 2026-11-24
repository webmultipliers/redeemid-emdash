import { validateBlocks } from "@emdash-cms/blocks";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("emdash/api/route-utils", () => ({ getAuthProviderStorage: () => store.stores }));
vi.mock("virtual:emdash/config", () => ({ default: {} }));

import { aliasTranslations, readEntry, requirement } from "../src/access.js";
import { entryPanel, entrySave, inheritTranslationRule, opensBare, type AccessEnv } from "../src/access-admin.js";
import { readableBody } from "../src/body.js";
import type { RedeemIDConfig } from "../src/config.js";
import { forgetAccess, loadAccess } from "../src/settings.js";
import { emptyMember } from "../src/storage.js";
import { memoryStores } from "./memory-store.js";

const store = memoryStores();

const config: RedeemIDConfig = {
	shop: "s.myshopify.com",
	levels: [
		{ slug: "member", name: "Member", tags: ["member"] },
		{ slug: "pro", name: "Pro", tags: ["pro"] },
	],
	rules: [
		{ collection: "posts", taxonomy: "category", term: "investigations", levels: ["pro"] },
		{ collection: "posts", taxonomy: "category", term: "archive", levels: ["member"], drip: 30 },
	],
	teaser: { posts: 4 },
	meter: { limit: 3, collections: ["posts"] },
};

function astro(userId?: string) {
	return {
		locals: { user: userId ? { id: userId } : null, emdash: { db: {}, config: { authProviders: [{ id: "redeemid", config }] } } },
		response: { headers: new Headers() },
	};
}

const p = (text: string) => ({ _type: "block", children: [{ text }] });
const BREAK = { _type: "redeemid-paywall" };
const pro = { category: ["investigations"] };

afterEach(() => {
	forgetAccess();
	store.access.clear();
	store.members.clear();
	store.meter.clear();
});

describe("readableBody", () => {
	const body = [p("Opening."), BREAK, p("Locked part.")];

	it("gives visitors what precedes the break, and members the rest", async () => {
		const visitor = await readableBody(astro(), { value: body, collection: "posts", terms: pro, id: "1" });
		expect(visitor.blocks).toEqual([p("Opening.")]);
		expect(visitor.whole).toBe(false);
		store.members.set("1", { ...emptyMember("1"), userId: "u1", tags: ["pro"] });
		const member = await readableBody(astro("u1"), { value: body, collection: "posts", terms: pro, id: "1" });
		expect(member.blocks).toEqual([p("Opening."), p("Locked part.")]);
		expect(member.whole).toBe(true);
	});

	it("gives the teaser for a locked body with no break", async () => {
		const out = await readableBody(astro(), { value: [p("One two three."), p("Four five six.")], collection: "posts", terms: pro });
		expect(out.blocks).toEqual([p("One two three.")]);
	});

	it("drops a Members only part readers can't read", async () => {
		const value = [p("Free."), { _type: "redeemid-members", levels: ["pro"] }, p("Pro only."), { _type: "redeemid-members-end" }, p("Free again.")];
		const out = await readableBody(astro(), { value, collection: "posts" });
		expect(out.blocks).toEqual([p("Free."), p("Free again.")]);
		expect(out.whole).toBe(false);
	});

	it("never uses the meter", async () => {
		store.members.set("1", { ...emptyMember("1"), userId: "u1", tags: ["member"] });
		const out = await readableBody(astro("u1"), { value: body, collection: "posts", terms: pro, id: "1" });
		expect(out.blocks).toEqual([p("Opening.")]);
		expect(store.meter.size).toBe(0);
		// The entry's own page still counts it.
		expect((await readEntry(astro("u1"), { collection: "posts", terms: pro, id: "1" })).reason).toBe("metered");
	});

	it("applies drip", async () => {
		store.members.set("1", { ...emptyMember("1"), userId: "u1", tags: ["member"] });
		const out = await readableBody(astro("u1"), { value: body, collection: "posts", terms: { category: ["archive"] }, id: "1" });
		expect(out.verdict.reason).toBe("drip");
		expect(out.blocks).toEqual([p("Opening.")]);
	});

	it("reads an open entry whole", async () => {
		const out = await readableBody(astro(), { value: body, collection: "posts" });
		expect(out.blocks).toEqual([p("Opening."), p("Locked part.")]);
		expect(out.whole).toBe(true);
	});
});

describe("translations", () => {
	it("a term rule covers the term's translations", () => {
		const tree: Record<string, string | null> = { enquetes: null };
		aliasTranslations(tree, new Map([["g-inv", "investigations"]]), new Set(["investigations", "archive"]), [
			{ slug: "enquetes", id: "t2", translationGroup: "g-inv" },
			{ slug: "investigations", id: "g-inv", translationGroup: "g-inv" },
			{ slug: "other", id: "t3", translationGroup: "g-other" },
		]);
		expect(tree).toEqual({ enquetes: "investigations" });
		expect(requirement(config.rules, "posts", { category: ["enquetes"] }, { tree: { category: tree } })).toEqual([["pro"]]);
		expect(requirement(config.rules, "posts", { category: ["enquetes"] })).toBeNull();
	});

	it("an entry's rule is saved for every translation, and a new one takes it", async () => {
		const env: AccessEnv = {
			code: config,
			store: store.stores.access,
			saved: await loadAccess(store.stores.access),
			collections: [{ slug: "posts", label: "Posts" }],
			taxonomies: [],
			terms: async () => [],
		};
		const entry = { collection: "posts", id: "en1", slug: "big-story", terms: {}, translations: [{ id: "fr1", slug: "grande-histoire" }] };
		const saved = JSON.stringify(await entrySave(env, entry, { mode: "levels", levels: ["pro"] }));
		expect(saved).toContain("also covers the entry's other translation");
		expect(store.access.get("entry:fr1")).toMatchObject({ entryId: "fr1", slug: "grande-histoire", mode: "levels", levels: ["pro"] });

		expect(await inheritTranslationRule(store.stores.access, "posts", "de1", "grosse-geschichte", [{ id: "en1", slug: "big-story" }])).toBe(true);
		expect(store.access.get("entry:de1")).toMatchObject({ entryId: "de1", slug: "grosse-geschichte", levels: ["pro"] });
		// Its own rule stays.
		expect(await inheritTranslationRule(store.stores.access, "posts", "de1", "grosse-geschichte", [{ id: "en1", slug: "big-story" }])).toBe(false);

		await entrySave({ ...env, saved: await loadAccess(store.stores.access) }, entry, { mode: "inherit" });
		expect(store.access.has("entry:en1")).toBe(false);
		expect(store.access.has("entry:fr1")).toBe(false);
	});
});

describe("no preview warning", () => {
	it("spots a locked body with nothing before the wall", () => {
		expect(opensBare([BREAK, p("All locked.")], 0)).toBe(true);
		expect(opensBare([p("Locked, no teaser.")], 0)).toBe(true);
		expect(opensBare([p("Opening."), BREAK, p("Rest.")], 0)).toBe(false);
		expect(opensBare([p("Short teaser."), p("More.")], 10)).toBe(false);
		expect(opensBare(null, 0)).toBe(false);
	});

	it("shows on the Access panel only when the entry is locked", async () => {
		const env: AccessEnv = { code: config, store: store.stores.access, saved: await loadAccess(store.stores.access), collections: [], taxonomies: [], terms: async () => [] };
		const locked = JSON.stringify(await entryPanel(env, { collection: "posts", id: "1", slug: null, terms: pro, body: [BREAK, p("All locked.")] }));
		expect(locked).toContain("Visitors see only the wall");
		const panel = await entryPanel(env, { collection: "posts", id: "1", slug: null, terms: pro, body: [BREAK, p("All locked.")], translations: [{ id: "x", slug: null }] });
		expect(validateBlocks(panel.blocks).errors).toEqual([]);
		const open = JSON.stringify(await entryPanel(env, { collection: "posts", id: "2", slug: null, terms: {}, body: [BREAK, p("All locked.")] }));
		expect(open).not.toContain("Visitors see only the wall");
	});
});
