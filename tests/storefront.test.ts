import { afterEach, describe, expect, it } from "vitest";

import { checkoutUrl, plan, resetStorefrontCache } from "../src/storefront.js";

afterEach(() => {
	resetStorefrontCache();
	delete process.env.REDEEMID_SHOPIFY_STOREFRONT_PRIVATE_TOKEN;
	delete process.env.REDEEMID_SHOPIFY_STOREFRONT_PUBLIC_TOKEN;
});

const config = { shop: "s.myshopify.com" };

function fake(data: unknown) {
	const calls: Array<{ url: string; headers: Record<string, string>; body: { query: string; variables: Record<string, unknown> } }> = [];
	const fetcher = (async (url: string, init: RequestInit) => {
		calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
		return new Response(JSON.stringify({ data }), { status: 200 });
	}) as unknown as typeof fetch;
	return { calls, fetcher };
}

const product = {
	product: {
		handle: "gold",
		title: "Gold",
		description: "All of it",
		availableForSale: true,
		requiresSellingPlan: true,
		variants: { nodes: [{ id: "gid://shopify/ProductVariant/1", availableForSale: true, price: { amount: "9.0", currencyCode: "USD" } }] },
		sellingPlanGroups: { nodes: [{ sellingPlans: { nodes: [{ id: "gid://shopify/SellingPlan/7" }] } }] },
	},
};

describe("Storefront API", () => {
	it("reads a plan with the private token and caches it", async () => {
		process.env.REDEEMID_SHOPIFY_STOREFRONT_PRIVATE_TOKEN = "priv";
		process.env.REDEEMID_SHOPIFY_STOREFRONT_PUBLIC_TOKEN = "pub";
		const { calls, fetcher } = fake(product);
		const p = await plan(config, "gold", fetcher);
		expect(p).toMatchObject({ variantId: "gid://shopify/ProductVariant/1", sellingPlanId: "gid://shopify/SellingPlan/7", availableForSale: true });
		expect(calls[0]?.url).toBe("https://s.myshopify.com/api/2026-10/graphql.json");
		expect(calls[0]?.headers["Shopify-Storefront-Private-Token"]).toBe("priv");
		expect(calls[0]?.headers["X-Shopify-Storefront-Access-Token"]).toBeUndefined();
		await plan(config, "gold", fetcher);
		expect(calls).toHaveLength(1);
	});

	it("falls back to the public token, then none", async () => {
		process.env.REDEEMID_SHOPIFY_STOREFRONT_PUBLIC_TOKEN = "pub";
		const a = fake({ product: null });
		expect(await plan(config, "missing", a.fetcher)).toBeNull();
		expect(a.calls[0]?.headers["X-Shopify-Storefront-Access-Token"]).toBe("pub");
		delete process.env.REDEEMID_SHOPIFY_STOREFRONT_PUBLIC_TOKEN;
		const b = fake({ product: null });
		await plan(config, "other", b.fetcher);
		expect(Object.keys(b.calls[0]?.headers ?? {})).not.toContain("X-Shopify-Storefront-Access-Token");
	});

	it("creates a one-line cart with the member's email and buyer IP", async () => {
		process.env.REDEEMID_SHOPIFY_STOREFRONT_PRIVATE_TOKEN = "priv";
		const { calls, fetcher } = fake({ cartCreate: { cart: { checkoutUrl: "https://shop/checkout" }, userErrors: [] } });
		const url = await checkoutUrl(config, { variantId: "v1", sellingPlanId: "sp1" }, { email: "a@b.co", buyerIp: "1.2.3.4", fetcher });
		expect(url).toBe("https://shop/checkout");
		expect(calls[0]?.headers["Shopify-Storefront-Buyer-IP"]).toBe("1.2.3.4");
		expect(calls[0]?.body.variables.input).toEqual({
			lines: [{ merchandiseId: "v1", quantity: 1, sellingPlanId: "sp1" }],
			buyerIdentity: { email: "a@b.co" },
		});
	});

	it("surfaces cart errors", async () => {
		const { fetcher } = fake({ cartCreate: { cart: null, userErrors: [{ message: "Sold out" }] } });
		await expect(checkoutUrl(config, { variantId: "v1" }, { fetcher })).rejects.toThrow("Sold out");
	});
});
