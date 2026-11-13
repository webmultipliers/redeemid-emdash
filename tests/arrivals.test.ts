import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("virtual:emdash/config", () => ({ default: {} }));

import { arrival, discountCode, pendingDiscount, SESSION_DISCOUNT } from "../src/arrivals.js";
import type { RedeemIDConfig } from "../src/config.js";

const config = { shop: "shop.test", levels: [], rules: [] } as unknown as RedeemIDConfig;

function session(values: Record<string, unknown> = {}) {
	const store = new Map(Object.entries(values));
	return { store, get: async (k: string) => store.get(k), set: (k: string, v: unknown) => void store.set(k, v), delete: (k: string) => void store.delete(k) };
}

const at = (path: string, s = session(), method = "GET") => ({ url: new URL(`https://site.test${path}`), request: new Request(`https://site.test${path}`, { method }), session: s });

afterEach(() => vi.unstubAllEnvs());

describe("arrivals from the store's redirect theme", () => {
	it("leaves pages without the theme's parameters alone", async () => {
		expect(await arrival(at("/shop/gold/?q=1"), config, null)).toBeNull();
		expect(await arrival(at("/shop/?discount=X", session(), "POST"), config, null)).toBeNull();
	});

	it("keeps a discount code for the next cart and lands on the clean page", async () => {
		const s = session();
		const res = (await arrival(at("/shop/gold/?variant=2&discount=SAVE10", s), config, null))!;
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/shop/gold/?variant=2");
		expect(res.headers.get("cache-control")).toBe("private, no-store");
		expect(await pendingDiscount(s)).toBe("SAVE10");
	});

	it("puts the code on a cart the visitor already has", async () => {
		const s = session({ "redeemid:cart": { id: "gid://shopify/Cart/1", count: 1 } });
		const setCodes = vi.fn(async () => ({}) as never);
		await arrival(at("/?discount=SAVE10", s), config, null, { setCodes });
		expect(setCodes).toHaveBeenCalledWith(config, "gid://shopify/Cart/1", ["SAVE10"], { buyerIp: null });
		expect(s.store.has(SESSION_DISCOUNT)).toBe(false);
	});

	it("never lands off the site", async () => {
		const res = (await arrival(at("//evil.test/x?discount=A"), config, null))!;
		expect(res.headers.get("location")).toBe("/");
	});

	it("refuses codes no link could carry", () => {
		expect(discountCode("  SAVE10 ")).toBe("SAVE10");
		expect(discountCode("")).toBeNull();
		expect(discountCode("a\nb")).toBeNull();
		expect(discountCode("x".repeat(256))).toBeNull();
	});

	it("signs a store-signed-in visitor in quietly", async () => {
		vi.stubEnv("REDEEMID_SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID", "client");
		const res = (await arrival(at("/posts/a/?logged_in=true&company_location_id=9"), config, null))!;
		expect(res.headers.get("location")).toBe(`/_emdash/api/auth/redeemid/login?quiet=1&return=${encodeURIComponent("/posts/a/")}`);
	});

	it("only cleans the URL for someone already signed in, or when sign-in isn't set up", async () => {
		vi.stubEnv("REDEEMID_SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID", "client");
		const signedIn = (await arrival(at("/posts/a/?logged_in=true"), config, { id: "u1" }))!;
		expect(signedIn.headers.get("location")).toBe("/posts/a/");
		vi.stubEnv("REDEEMID_SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID", "");
		const unset = (await arrival(at("/posts/a/?logged_in=true"), config, null))!;
		expect(unset.headers.get("location")).toBe("/posts/a/");
	});
});
