import { describe, expect, it, vi } from "vitest";

vi.mock("astro:middleware", () => ({ defineMiddleware: (f: unknown) => f }));
vi.mock("virtual:emdash/config", () => ({ default: {} }));

import { memberMayUse } from "../src/guard.js";

describe("member guard", () => {
	it("refuses EmDash's content API and admin to members", () => {
		for (const p of ["/_emdash/api/content/posts", "/_emdash/api/search", "/_emdash/admin", "/_emdash/api/mcp"]) {
			expect(memberMayUse(p)).toBe(false);
		}
	});

	it("keeps site pages, sign-in, media and extra paths open", () => {
		for (const p of ["/", "/posts/a", "/_emdash/api/auth/redeemid/logout", "/_emdash/api/media/file/x.jpg", "/_emdash/api/comments/posts/1"]) {
			expect(memberMayUse(p)).toBe(true);
		}
		expect(memberMayUse("/_emdash/api/search", ["/_emdash/api/search"])).toBe(true);
		expect(memberMayUse("/_emdash/api/contentx")).toBe(false);
	});
});

describe("private pages", () => {
	function page(opts: { user?: object | null; cart?: object | null; path?: string }) {
		const calls: unknown[] = [];
		const session = { get: async (k: string) => (k === "redeemid:cart" ? (opts.cart ?? undefined) : undefined), set() {} };
		const context = {
			url: new URL(`https://site.test${opts.path ?? "/posts/a"}`),
			locals: { user: opts.user ?? null, emdash: { config: {} } },
			session,
			cache: { set: (o: unknown) => calls.push(o) },
		};
		return { context, calls };
	}
	// The page sets its cache hint while it renders, after the middleware starts.
	const render = (ctx: { cache: { set(o: unknown): void } }) => async () => {
		ctx.cache.set({ maxAge: 300, tags: ["posts"] });
		return new Response("<p>body</p>", { headers: { "content-type": "text/html" } });
	};

	it("a signed-in visitor's page is private and leaves the route cache after it renders", async () => {
		const { onRequest } = await import("../src/guard.js");
		const { context, calls } = page({ user: { id: "u1", role: 10 } });
		const res = (await (onRequest as unknown as (c: unknown, n: () => Promise<Response>) => Promise<Response>)(context, render(context))) as Response;
		expect(res.headers.get("cache-control")).toBe("private, no-store");
		expect(calls.at(-1)).toBe(false);
	});

	it("a visitor with a cart is private too", async () => {
		const { onRequest } = await import("../src/guard.js");
		const { context, calls } = page({ cart: { id: "gid://shopify/Cart/1", checkoutUrl: "x", count: 2 } });
		const res = (await (onRequest as unknown as (c: unknown, n: () => Promise<Response>) => Promise<Response>)(context, render(context))) as Response;
		expect(res.headers.get("cache-control")).toBe("private, no-store");
		expect(calls.at(-1)).toBe(false);
	});

	it("an anonymous visitor's page keeps its cache hint", async () => {
		const { onRequest } = await import("../src/guard.js");
		const { context, calls } = page({});
		const res = (await (onRequest as unknown as (c: unknown, n: () => Promise<Response>) => Promise<Response>)(context, render(context))) as Response;
		expect(res.headers.get("cache-control")).toBeNull();
		expect(calls).not.toContain(false);
	});

	it("works on a redirect's immutable headers", async () => {
		const { keepPrivate } = await import("../src/guard.js");
		const out = keepPrivate({}, Response.redirect("https://site.test/", 302));
		expect(out.status).toBe(302);
		expect(out.headers.get("cache-control")).toBe("private, no-store");
	});
});
