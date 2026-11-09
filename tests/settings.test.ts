import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("emdash/api/route-utils", () => ({ getAuthProviderStorage: () => store.stores }));
vi.mock("virtual:emdash/config", () => ({ default: {} }));

import { accessAction, accessPage, entryPanel, entrySave, type AccessEnv } from "../src/access-admin.js";
import { applyEntryRule, canRead, dripDays, meterable, requirement, ruleSource } from "../src/access.js";
import type { RedeemIDConfig } from "../src/config.js";
import { announceLevels, loadAccess, mergeAccess, onLevels, type EntryRule } from "../src/settings.js";
import { siteConfig } from "../src/site-config.js";
import { emptyMember } from "../src/storage.js";
import { memoryStores } from "./memory-store.js";

const store = memoryStores();

const code: RedeemIDConfig = {
	shop: "s.myshopify.com",
	levels: [{ slug: "member", name: "Member", tags: ["member"] }],
	rules: [{ collection: "posts", taxonomy: "category", term: "members", levels: ["member"] }],
	meter: { limit: 3 },
};

async function env(config: RedeemIDConfig = code): Promise<AccessEnv> {
	return {
		code: config,
		store: store.stores.access,
		saved: await loadAccess(store.stores.access),
		collections: [
			{ slug: "posts", label: "Posts" },
			{ slug: "recipes", label: "Recipes" },
		],
		taxonomies: [{ name: "category", label: "Categories", collections: ["posts", "recipes"] }],
		terms: async () => [
			{ slug: "members", label: "Members" },
			{ slug: "free", label: "Free" },
		],
	};
}

const live = async () => mergeAccess(code, await loadAccess(store.stores.access))!;
const toastOf = (r: { toast?: { type: string; message: string } }) => r.toast;

afterEach(() => {
	store.access.clear();
	store.members.clear();
});

describe("saved settings over code", () => {
	it("keeps the code's settings until the admin saves one", async () => {
		expect(await live()).toMatchObject({ levels: code.levels, rules: code.rules, meter: code.meter });
	});

	it("replaces only the settings the admin saved, and null turns one off", () => {
		const merged = mergeAccess(code, { site: { kind: "site", levels: [{ slug: "gilded", name: "Gilded", tags: ["g"] }], meter: null }, entries: [] })!;
		expect(merged.levels).toEqual([{ slug: "gilded", name: "Gilded", tags: ["g"] }]);
		expect(merged.rules).toEqual(code.rules);
		expect(merged.meter).toBeUndefined();
	});

	it("names levels whatever the creator wants, and copies the code's levels first", async () => {
		const r = await accessAction(await env(), { action_id: "level_save", block_id: "level:new", values: { name: "Patrons of the Arts", tags: "patron, arts-patron", match: "any" } });
		expect(toastOf(r)).toMatchObject({ type: "success" });
		const now = await live();
		expect(now.levels?.map((l) => l.slug)).toEqual(["member", "patrons-of-the-arts"]);
		expect(now.levels?.[1]).toMatchObject({ name: "Patrons of the Arts", tags: ["patron", "arts-patron"] });
	});

	it("refuses a duplicate or built-in slug, and a level without tags", async () => {
		expect(toastOf(await accessAction(await env(), { action_id: "level_save", block_id: "level:new", values: { name: "Member", tags: "x" } }))).toMatchObject({ type: "error" });
		expect(toastOf(await accessAction(await env(), { action_id: "level_save", block_id: "level:new", values: { name: "Signed in", tags: "x" } }))).toMatchObject({ type: "error" });
		expect(toastOf(await accessAction(await env(), { action_id: "level_save", block_id: "level:new", values: { name: "Gold" } }))).toMatchObject({ type: "error" });
	});

	it("won't remove a level a rule still uses", async () => {
		const r = await accessAction(await env(), { action_id: "level_menu", value: "remove:member" });
		expect(toastOf(r)).toMatchObject({ type: "error" });
		expect((await live()).levels).toHaveLength(1);
	});

	it("saves a rule for any content type, including ones added after the code was written", async () => {
		await accessAction(await env(), { action_id: "type_save", block_id: "type:recipes", values: { who: "levels", levels: ["member"], drip: 7, no_meter: true, teaser: 40 } });
		const now = await live();
		expect(now.rules).toContainEqual({ collection: "recipes", levels: ["member"], drip: 7, meter: false });
		expect(now.rules).toContainEqual(code.rules![0]);
		expect(now.teaser).toEqual({ recipes: 40 });
		expect(requirement(now.rules, "recipes")).toEqual([["member"]]);
	});

	it("saves term rules for every content type, and a type's own term rule wins there", async () => {
		await accessAction(await env(), { action_id: "term_save", block_id: "term:category", values: { term: "free", scope: "*", who: "open" } });
		await accessAction(await env(), { action_id: "type_save", block_id: "type:recipes", values: { who: "signed-in" } });
		const now = await live();
		expect(requirement(now.rules, "recipes", { category: ["free"] })).toBeNull();
		expect(requirement(now.rules, "recipes")).toEqual([[]]);
		const rules = [...now.rules!, { collection: "posts", taxonomy: "category", term: "free", levels: ["member"] }];
		expect(requirement(rules, "posts", { category: ["free"] })).toEqual([["member"]]);
		expect(requirement(rules, "recipes", { category: ["free"] })).toBeNull();
	});

	it("lets a collection rule or the site default open entries", () => {
		expect(requirement([{ collection: "*", levels: ["member"] }, { collection: "pages", levels: [], open: true }], "pages")).toBeNull();
		expect(requirement([{ collection: "*", levels: [], open: true }], "pages")).toBeNull();
	});

	it("saves site rules, the meter and the join link, and goes back to the code's setting", async () => {
		await accessAction(await env(), { action_id: "site_save", values: { who: "signed-in", combine: "any", meter_limit: 0, join_href: "/join/", join_label: "Join us" } });
		let now = await live();
		expect(now.meter).toBeUndefined();
		expect(now.combine).toBe("any");
		expect(now.join).toEqual({ href: "/join/", label: "Join us" });
		expect(requirement(now.rules, "pages")).toEqual([[]]);
		await accessAction(await env(), { action_id: "reset", value: "meter" });
		now = await live();
		expect(now.meter).toEqual(code.meter);
	});

	it("protects folders and adds features from the admin", async () => {
		await accessAction(await env(), { action_id: "feature_save", block_id: "feature:new", values: { name: "Ad-free", levels: ["member"] } });
		await accessAction(await env(), { action_id: "file_save", block_id: "file", values: { folder: "Member downloads", members: true, levels: ["member"], features: ["ad-free"] } });
		const now = await live();
		expect(now.features).toEqual([{ slug: "ad-free", name: "Ad-free", levels: ["member"] }]);
		expect(now.files).toEqual([{ folder: "Member downloads", levels: ["member"], features: ["ad-free"] }]);
	});

	it("renders every tab, with new content types and taxonomies listed", async () => {
		const page = JSON.stringify(await accessPage(await env()));
		for (const text of ["Levels", "Rules", "Terms", "Files", "Features", "Content types", "Recipes: follows the site default", "Categories: 1 rule"]) {
			expect(page).toContain(text);
		}
	});

	it("tells the editor's level pickers about saved levels", () => {
		const seen: string[][] = [];
		onLevels((levels) => seen.push(levels.map((l) => l.slug)));
		announceLevels([{ slug: "x", name: "X", tags: ["x"] }]);
		expect(seen.at(-1)).toEqual(["x"]);
	});
});

describe("an entry's own rule", () => {
	const rule = (r: Partial<EntryRule>): EntryRule => ({ kind: "entry", collection: "posts", entryId: "01A", mode: "inherit", levels: [], ...r });

	it("opens, replaces or adds to the site's requirement", () => {
		expect(applyEntryRule([["member"]], rule({ mode: "open" }))).toBeNull();
		expect(applyEntryRule(null, rule({ mode: "levels", levels: ["pro"] }))).toEqual([["pro"]]);
		expect(applyEntryRule(null, rule({ mode: "levels" }))).toEqual([[]]);
		expect(applyEntryRule([["member"]], rule({ mode: "add", levels: ["pro"] }))).toEqual([["member"], ["pro"]]);
		expect(applyEntryRule([["member"]], rule({}))).toEqual([["member"]]);
	});

	it("follows its date windows", () => {
		const past = "2020-01-01T00:00:00.000Z";
		const future = "2999-01-01T00:00:00.000Z";
		expect(applyEntryRule([["member"]], rule({ lockedUntil: past }))).toBeNull();
		expect(applyEntryRule([["member"]], rule({ lockedUntil: future }))).toEqual([["member"]]);
		expect(applyEntryRule([["member"]], rule({ openUntil: future }))).toBeNull();
		expect(applyEntryRule([["member"]], rule({ openUntil: past }))).toEqual([["member"]]);
	});

	it("sets drip and the meter for the entry", () => {
		expect(dripDays(code.rules, "posts", {}, undefined, rule({ drip: 14 }))).toBe(14);
		expect(meterable(code.rules, "posts", {}, undefined, rule({ meter: false }))).toBe(false);
	});

	it("is saved from the editor panel and applies on the site by id or slug", async () => {
		const entry = { collection: "posts", id: "01ABC", slug: "big-story", terms: {} };
		const before = JSON.stringify(await entryPanel(await env(), entry));
		expect(before).toContain("Right now: free to everyone.");
		expect(before).toContain("No rule covers it");
		const saved = JSON.stringify(await entrySave(await env(), entry, { mode: "levels", levels: ["member"], drip: 0, no_meter: false }));
		expect(saved).toContain("Right now: readers need Member.");
		expect(saved).toContain("this entry's own rule");

		store.members.set("1", { ...emptyMember("1"), userId: "u1", tags: ["member"] });
		const astro = (userId?: string) => ({
			locals: { user: userId ? { id: userId } : null, emdash: { db: {}, config: { authProviders: [{ id: "redeemid", config: code }] } } },
			response: { headers: new Headers() },
		});
		expect((await canRead(astro(), { collection: "posts", id: "big-story" })).reason).toBe("sign_in");
		expect((await canRead(astro(), { collection: "posts", id: "01ABC" })).reason).toBe("sign_in");
		expect((await canRead(astro("u1"), { collection: "posts", id: "big-story" })).allowed).toBe(true);
		expect((await canRead(astro(), { collection: "posts", id: "another" })).allowed).toBe(true);

		await entrySave(await env(), entry, { mode: "inherit" });
		expect(store.access.has("entry:01ABC")).toBe(false);
	});

	it("says where the site's rule comes from", () => {
		expect(ruleSource(code.rules, "posts", { category: ["members"] })).toBe("Terms: category: members");
		expect(ruleSource([{ collection: "posts", levels: [] }], "posts")).toBe("The rule for posts");
		expect(ruleSource([{ collection: "*", levels: [] }], "posts")).toBe("The site default");
	});
});

describe("site config", () => {
	it("reads saved settings once per request", async () => {
		await accessAction(await env(), { action_id: "level_save", block_id: "level:new", values: { name: "Patron", tags: "patron" } });
		const locals = { emdash: { db: {}, config: { authProviders: [{ id: "redeemid", config: code }] } } };
		const spy = vi.spyOn(store.stores.access, "query");
		const a = await siteConfig(locals);
		const b = await siteConfig(locals);
		expect(a).toBe(b);
		expect(spy).toHaveBeenCalledTimes(1);
		expect(a?.levels?.map((l) => l.slug)).toEqual(["member", "patron"]);
	});
});
