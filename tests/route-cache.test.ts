import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RedeemIDConfig } from "../src/config.js";

vi.mock("astro:middleware", () => ({ defineMiddleware: (f: unknown) => f }));
vi.mock("virtual:emdash/config", () => ({ default: {} }));

let config: RedeemIDConfig | null = null;
vi.mock("../src/site-config.js", () => ({ siteConfig: async () => config, shareConfig: () => undefined, codeConfig: () => config }));

const { cacheEntry, cachePage, CACHE_TAG, noRouteCache, purgeRouteCache } = await import("../src/route-cache.js");

const base = {
	shop: "s.myshopify.com",
	levels: [{ slug: "member", name: "Member", tags: ["member"] }],
	rules: [{ collection: "posts", taxonomy: "category", term: "members", levels: ["member"] }],
} as unknown as RedeemIDConfig;

function astro(enabled = true) {
	const calls: unknown[] = [];
	const headers = new Headers();
	return { calls, headers, a: { locals: {}, response: { headers }, cache: { enabled, set: (o: unknown) => calls.push(o) } } };
}

const free = { id: "p1", data: { terms: { category: [{ slug: "news" }] }, content: [{ _type: "block", children: [{ text: "hi" }] }] } };
const locked = { id: "p2", data: { terms: { category: [{ slug: "members" }] }, content: [] } };

describe("route cache helpers", () => {
	beforeEach(() => {
		config = base;
	});

	it("caches an entry no rule covers, with the redeemid tag", async () => {
		const { a, calls, headers } = astro();
		expect(await cacheEntry(a, "posts", free, { tags: ["p1"] })).toBe(true);
		expect(calls).toEqual([{ tags: ["p1", CACHE_TAG] }]);
		expect(headers.get("cache-control")).toBeNull();
	});

	it("keeps a gated entry out of the route cache, leaving Cache-Control alone", async () => {
		const { a, calls, headers } = astro();
		expect(await cacheEntry(a, "posts", locked, { tags: ["p2"] })).toBe(false);
		expect(calls).toEqual([false]);
		expect(headers.get("cache-control")).toBeNull();
		// A later cachePage (a layout, a list on the page) can't let it back in.
		cachePage(a, { tags: ["menu"] });
		expect(calls).toEqual([false]);
	});

	it("keeps out free entries whose body reads differently for members", async () => {
		for (const type of ["redeemid-members", "redeemid-item", "redeemid-plan", "redeemid-preferences"]) {
			const { a } = astro();
			const entry = { id: "p3", data: { content: [{ _type: "block" }, { _type: type }] } };
			expect(await cacheEntry(a, "posts", entry, {}), type).toBe(false);
		}
		// A Paywall break with no rule changes nothing: still cacheable.
		const { a } = astro();
		expect(await cacheEntry(a, "posts", { id: "p4", data: { content: [{ _type: "redeemid-paywall" }] } }, {})).toBe(true);
	});

	it("takes entries typed by `emdash types` (interfaces, no index signature)", async () => {
		interface Post {
			title: string;
			content: Array<{ _type: string }>;
		}
		const post: { id: string; data: Post } = { id: "p5", data: { title: "Typed", content: [{ _type: "block" }] } };
		expect(await cacheEntry(astro().a, "posts", post, {})).toBe(true);
	});

	it("follows the entry's own rule, and never caches a free-until window", async () => {
		const soon = new Date(Date.now() + 3600_000).toISOString();
		config = { ...base, entries: { "posts:p1": { kind: "entry", collection: "posts", entryId: "p1", mode: "levels", levels: ["member"] } } } as RedeemIDConfig;
		expect(await cacheEntry(astro().a, "posts", free, {})).toBe(false);
		config = { ...base, entries: { "posts:p2": { kind: "entry", collection: "posts", entryId: "p2", mode: "open", levels: [] } } } as RedeemIDConfig;
		expect(await cacheEntry(astro().a, "posts", locked, {})).toBe(true);
		config = { ...base, entries: { "posts:p2": { kind: "entry", collection: "posts", entryId: "p2", mode: "inherit", levels: [], openUntil: soon } } } as RedeemIDConfig;
		expect(await cacheEntry(astro().a, "posts", locked, {})).toBe(false);
	});

	it("keeps everything out when the saved settings can't be read", async () => {
		config = { ...base, unavailable: true } as RedeemIDConfig;
		expect(await cacheEntry(astro().a, "posts", free, {})).toBe(false);
	});

	it("sets no hint when the route cache is off", async () => {
		const off = astro(false);
		expect(await cacheEntry(off.a, "posts", free, {})).toBe(false);
		expect(off.calls).toEqual([]);
	});

	it("noRouteCache wins over a later hint", () => {
		const { a, calls } = astro();
		noRouteCache(a);
		cachePage(a, { maxAge: 60 });
		expect(calls).toEqual([false]);
	});

	it("purges the tag, and never throws", async () => {
		const invalidate = vi.fn(async () => undefined);
		await purgeRouteCache({ enabled: true, invalidate });
		expect(invalidate).toHaveBeenCalledWith({ tags: [CACHE_TAG] });
		await expect(purgeRouteCache({ enabled: true, invalidate: async () => { throw new Error("down"); } })).resolves.toBeUndefined();
		await purgeRouteCache({ enabled: false, invalidate });
		expect(invalidate).toHaveBeenCalledTimes(1);
	});
});

describe("guard and the route cache", () => {
	beforeEach(() => {
		config = base;
	});

	const run = async (context: unknown, next: () => Promise<Response>) => {
		const { onRequest } = await import("../src/guard.js");
		return (onRequest as unknown as (c: unknown, n: () => Promise<Response>) => Promise<Response>)(context, next);
	};

	it("takes a gated page back out after a layout set a hint", async () => {
		const calls: unknown[] = [];
		const context = { url: new URL("https://site.test/posts/p2"), locals: {} as object, session: { get: async () => undefined }, cache: { enabled: true, set: (o: unknown) => calls.push(o) } };
		const res = await run(context, async () => {
			const a = { locals: context.locals, cache: context.cache, response: { headers: new Headers() } };
			await cacheEntry(a, "posts", locked, {});
			context.cache.set({ maxAge: 300, tags: ["menu"] });
			return new Response("<p>wall</p>");
		});
		expect(calls.at(-1)).toBe(false);
		expect(res.headers.get("cache-control")).toBeNull();
	});

	it("purges cached pages when a request saves access settings", async () => {
		const { touchAccess } = await import("../src/settings.js");
		const invalidate = vi.fn(async () => undefined);
		const context = { url: new URL("https://site.test/_emdash/api/plugins/redeemid/admin"), locals: { user: { id: "s", role: 50 } }, session: { get: async () => undefined }, cache: { enabled: true, set() {}, invalidate } };
		const store = { put: async () => undefined } as never;
		await run(context, async () => {
			await touchAccess(store);
			return new Response("{}");
		});
		expect(invalidate).toHaveBeenCalledWith({ tags: [CACHE_TAG] });
		invalidate.mockClear();
		await run(context, async () => new Response("{}"));
		expect(invalidate).not.toHaveBeenCalled();
	});
});
