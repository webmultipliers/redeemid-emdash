import { afterEach, describe, expect, it } from "vitest";

import { browseFromUrl, browseHref, collectionPage, parseFilters, priceFilter, recommendations, searchProducts, suggest } from "../src/catalog.js";
import { pickSellingPlan, pickVariant } from "../src/cart-ops.js";
import { addToCart, countryCode, product, realOptions, resetStorefrontCache, signInCart, storeContext, variantFor, withContext } from "../src/storefront.js";

afterEach(() => resetStorefrontCache());

const config = { shop: "s.myshopify.com" };

function fake(data: unknown) {
	const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
	const fetcher = (async (_url: string, init: RequestInit) => {
		calls.push(JSON.parse(String(init.body)));
		return new Response(JSON.stringify({ data }), { status: 200 });
	}) as unknown as typeof fetch;
	return { calls, fetcher };
}

const money = (amount: string) => ({ amount, currencyCode: "USD" });
const card = (handle: string, extra: Record<string, unknown> = {}) => ({
	handle,
	title: handle,
	availableForSale: true,
	featuredImage: null,
	priceRange: { minVariantPrice: money("10.0") },
	compareAtPriceRange: { minVariantPrice: money("12.0") },
	variants: { nodes: [{ id: `gid://shopify/ProductVariant/${handle}`, availableForSale: true }] },
	...extra,
});

const tee = {
	product: {
		id: "gid://shopify/Product/9",
		handle: "tee",
		title: "Tee",
		description: "Soft",
		descriptionHtml: "<p>Soft</p>",
		vendor: "Ledger",
		productType: "Shirt",
		availableForSale: true,
		requiresSellingPlan: false,
		featuredImage: { url: "https://cdn/a.jpg", altText: "Front" },
		images: { nodes: [{ url: "https://cdn/a.jpg", altText: "Front" }, { url: "https://cdn/b.jpg", altText: "Back" }] },
		options: [
			{ name: "Size", optionValues: [{ name: "S" }, { name: "M" }] },
			{ name: "Color", optionValues: [{ name: "Navy" }, { name: "Sand" }] },
		],
		variants: {
			nodes: [
				{ id: "v1", title: "S / Navy", availableForSale: false, price: money("20.0"), selectedOptions: [{ name: "Size", value: "S" }, { name: "Color", value: "Navy" }] },
				{ id: "v2", title: "M / Navy", availableForSale: true, price: money("20.0"), compareAtPrice: money("25.0"), selectedOptions: [{ name: "Size", value: "M" }, { name: "Color", value: "Navy" }] },
				{ id: "v3", title: "M / Sand", availableForSale: true, price: money("22.0"), selectedOptions: [{ name: "Size", value: "M" }, { name: "Color", value: "Sand" }] },
			],
		},
		sellingPlanGroups: { nodes: [{ name: "Subscribe", sellingPlans: { nodes: [{ id: "sp1", name: "Every month" }] } }] },
		seo: { title: null, description: null },
	},
};

describe("products", () => {
	it("reads options, images, sale prices and selling plans", async () => {
		const { fetcher } = fake(tee);
		const p = await product(config, "tee", fetcher);
		expect(p?.id).toBe("gid://shopify/Product/9");
		expect(realOptions(p!)).toEqual([
			{ name: "Size", values: ["S", "M"] },
			{ name: "Color", values: ["Navy", "Sand"] },
		]);
		expect(p?.images?.map((i) => i.url)).toEqual(["https://cdn/a.jpg", "https://cdn/b.jpg"]);
		expect(p?.sellingPlans).toEqual([{ id: "sp1", name: "Every month", group: "Subscribe" }]);
		expect(p?.sellingPlanId).toBeNull();
		expect(variantFor(p!, { Size: "M", Color: "Sand" })?.id).toBe("v3");
	});

	it("treats Shopify's Default Title as no options", async () => {
		const { fetcher } = fake({ product: { ...tee.product, options: [{ name: "Title", optionValues: [{ name: "Default Title" }] }] } });
		expect(realOptions((await product(config, "plain", fetcher))!)).toEqual([]);
	});

	it("picks the variant and selling plan an add names, and nothing else", async () => {
		const { fetcher } = fake(tee);
		const p = (await product(config, "tee", fetcher))!;
		expect(pickVariant(p, { options: { Size: "M", Color: "Navy" } })?.id).toBe("v2");
		expect(pickVariant(p, { options: { Size: "XL", Color: "Navy" } })).toBeUndefined();
		expect(pickVariant(p, { options: { Size: "M" } })).toBeUndefined();
		expect(pickVariant(p, { variant: "v3" })?.id).toBe("v3");
		expect(pickVariant(p, { variant: "elsewhere" })).toBeUndefined();
		expect(pickVariant(p, {})?.id).toBe("v2");
		expect(pickSellingPlan(p, "sp1")).toBe("sp1");
		expect(pickSellingPlan(p, "sp-other")).toBeUndefined();
		expect(pickSellingPlan(p, "")).toBeNull();
		expect(pickSellingPlan({ ...p, requiresSellingPlan: true }, null)).toBe("sp1");
	});
});

describe("markets", () => {
	it("adds @inContext only for clean codes", () => {
		expect(withContext("query Product($handle: String!) { x }", { country: "CA", language: "fr" })).toBe("query Product($handle: String!) @inContext(country: CA, language: FR) { x }");
		expect(withContext("query P { x }", { country: "ca; drop" })).toBe("query P { x }");
		expect(withContext("query P { x }", {})).toBe("query P { x }");
	});

	it("reads the visitor's country only when asked", () => {
		const req = new Request("https://site.test/", { headers: { "cf-ipcountry": "de" } });
		expect(storeContext({ market: { country: "visitor" } }, req).country).toBe("DE");
		expect(storeContext({ market: { country: "CA" } }, req).country).toBe("CA");
		expect(storeContext({}, req)).toEqual({});
		expect(countryCode("XX")).toBeNull();
	});

	it("gives a new cart the buyer's country", async () => {
		const { calls, fetcher } = fake({ cartCreate: { cart: { id: "c1", checkoutUrl: "https://s/c", totalQuantity: 1 }, userErrors: [] } });
		await addToCart(config, null, { variantId: "v2" }, { fetcher, context: { country: "CA" } });
		expect(calls[0]?.variables.input).toMatchObject({ buyerIdentity: { countryCode: "CA" } });
		expect(calls[0]?.query).toContain("@inContext(country: CA)");
	});
});

describe("browsing", () => {
	it("parses filters from the URL and drops anything else", () => {
		const params = new URLSearchParams();
		params.append("filter", JSON.stringify({ productVendor: "Ledger" }));
		params.append("filter", "not json");
		params.append("filter", JSON.stringify({ a: 1, b: 2 }));
		params.append("filter", JSON.stringify(["x"]));
		params.set("price_min", "5");
		params.set("sort", "price-desc");
		params.set("q", "  tote ");
		const b = browseFromUrl(params);
		expect(b.filters).toEqual([{ productVendor: "Ledger" }, { price: { min: 5 } }]);
		expect(b.sort).toBe("price-desc");
		expect(b.query).toBe("tote");
		expect(browseFromUrl(new URLSearchParams("sort=sideways")).sort).toBeNull();
		expect(parseFilters(Array(30).fill('{"available":true}'))).toHaveLength(20);
		expect(priceFilter("", "")).toBeNull();
		expect(priceFilter("-1", "9")).toEqual({ price: { max: 9 } });
	});

	it("searches with Shopify's sort keys and filters", async () => {
		const { calls, fetcher } = fake({
			search: {
				totalCount: 2,
				productFilters: [{ id: "f", label: "Vendor", type: "LIST", values: [{ id: "v", label: "Ledger", count: 2, input: '{"productVendor":"Ledger"}' }] }],
				pageInfo: { hasNextPage: true, hasPreviousPage: false, startCursor: "a", endCursor: "b" },
				nodes: [card("tote"), {}, card("mug", { variants: { nodes: [{ id: "1", availableForSale: true }, { id: "2", availableForSale: true }] } })],
			},
		});
		const page = await searchProducts(config, "tote", { sort: "price-asc", filters: [{ productVendor: "Ledger" }], first: 5 }, { fetcher });
		expect(calls[0]?.variables).toMatchObject({ query: "tote", first: 5, sortKey: "PRICE", reverse: false, filters: [{ productVendor: "Ledger" }] });
		expect(page.total).toBe(2);
		expect(page.products.map((p) => p.handle)).toEqual(["tote", "mug"]);
		expect(page.products[0]).toMatchObject({ compareAtPrice: money("12.0"), quickAddVariantId: "gid://shopify/ProductVariant/tote" });
		expect(page.products[1]?.quickAddVariantId).toBeNull();
		expect(page.filters[0]?.values[0]?.input).toBe('{"productVendor":"Ledger"}');
		expect(await searchProducts(config, "  ", {}, { fetcher })).toMatchObject({ products: [], total: 0 });
		expect(calls).toHaveLength(1);
	});

	it("pages a collection backwards with last/before", async () => {
		const { calls, fetcher } = fake({ collection: { handle: "shop", title: "Shop", description: "", products: { filters: [], pageInfo: { hasNextPage: true, hasPreviousPage: true, startCursor: "a", endCursor: "b" }, nodes: [card("tote")] } } });
		const page = await collectionPage(config, "shop", { before: "x", first: 3, sort: "newest" }, { fetcher });
		expect(calls[0]?.variables).toMatchObject({ handle: "shop", last: 3, before: "x", sortKey: "CREATED", reverse: true });
		expect(page?.products).toHaveLength(1);
	});

	it("suggests and recommends", async () => {
		const s = fake({ predictiveSearch: { queries: [{ text: "tote bag" }], products: [card("tote")], collections: [{ handle: "bags", title: "Bags" }] } });
		expect(await suggest(config, "tot", 4, { fetcher: s.fetcher })).toMatchObject({ queries: ["tote bag"], collections: [{ handle: "bags" }] });
		const r = fake({ productRecommendations: [card("mug")] });
		expect((await recommendations(config, "gid://shopify/Product/9", "complementary", { fetcher: r.fetcher }))[0]?.handle).toBe("mug");
		expect(r.calls[0]?.variables.intent).toBe("COMPLEMENTARY");
		expect(await recommendations(config, "nope", "related", { fetcher: r.fetcher })).toEqual([]);
	});

	it("builds browse links that keep the search and reset paging", () => {
		const url = new URL("https://site.test/shop/?q=tote&after=abc&redeemid_notice=cart_added");
		expect(browseHref(url, { sort: "newest" })).toBe("/shop/?q=tote&sort=newest");
		expect(browseHref(url, { after: "def" })).toBe("/shop/?q=tote&after=def");
	});
});

describe("signed-in checkout", () => {
	it("puts the member's token on the cart and returns the fresh checkout URL", async () => {
		const { calls, fetcher } = fake({ cartBuyerIdentityUpdate: { cart: { checkoutUrl: "https://s/c?signed" }, userErrors: [] } });
		expect(await signInCart(config, "c1", "shcat_x", { fetcher })).toBe("https://s/c?signed");
		expect(calls[0]?.variables).toEqual({ id: "c1", identity: { customerAccessToken: "shcat_x" } });
		const refused = fake({ cartBuyerIdentityUpdate: { cart: { checkoutUrl: "https://s/c" }, userErrors: [{ message: "bad token" }] } });
		expect(await signInCart(config, "c1", "shcat_x", { fetcher: refused.fetcher })).toBeNull();
	});
});
