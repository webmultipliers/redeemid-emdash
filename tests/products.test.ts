import { describe, expect, it } from "vitest";

import { productSitemap } from "../src/catalog.js";
import {
	addAllPage,
	addProducts,
	applyProduct,
	describeBatch,
	entryCard,
	guardSave,
	handleFrom,
	MIRROR_KEYS,
	mirrorOf,
	productsCollection,
	productWebhook,
	refreshOldest,
	type EntryStore,
	type ProductEntry,
	type ProductMirror,
} from "../src/products.js";

const config = { shop: "s.myshopify.com" };
const money = (amount: string) => ({ amount, currencyCode: "USD" });

function raw(handle: string, extra: Record<string, unknown> = {}) {
	return {
		id: `gid://shopify/Product/${handle}`,
		handle,
		title: handle.toUpperCase(),
		description: "Soft",
		vendor: "Ledger",
		productType: "Bag",
		availableForSale: true,
		featuredImage: { url: `https://cdn/${handle}.jpg`, altText: null },
		priceRange: { minVariantPrice: money("10.00"), maxVariantPrice: money("14.00") },
		compareAtPriceRange: { minVariantPrice: money("12.00") },
		variants: { nodes: [{ id: `gid://shopify/ProductVariant/${handle}`, availableForSale: true }] },
		...extra,
	};
}

/** A Storefront API that answers from a product list. */
function shop(products: Array<ReturnType<typeof raw>>) {
	const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
	const fetcher = (async (_url: string, init: RequestInit) => {
		const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
		calls.push(body);
		const v = body.variables;
		let data: unknown;
		if (body.query.includes("RedeemIDProductById")) data = { product: products.find((p) => p.id === v.id) ?? null };
		else if (body.query.includes("RedeemIDProductByHandle")) data = { product: products.find((p) => p.handle === v.handle) ?? null };
		else if (body.query.includes("RedeemIDProducts(")) data = { nodes: (v.ids as string[]).map((id) => products.find((p) => p.id === id) ?? null) };
		else if (body.query.includes("RedeemIDProductPage")) {
			const start = v.after ? Number(v.after) : 0;
			const n = Number(v.first);
			const page = products.slice(start, start + n);
			const more = start + n < products.length;
			data = { products: { pageInfo: { hasNextPage: more, endCursor: more ? String(start + n) : null }, nodes: page } };
		} else data = {};
		return new Response(JSON.stringify({ data }), { status: 200 });
	}) as unknown as typeof fetch;
	return { calls, fetcher };
}

/** Entries in memory, the way contentEntries() behaves. */
function memory(): EntryStore & { rows: Map<string, ProductEntry> } {
	const rows = new Map<string, ProductEntry>();
	let n = 0;
	const find = (f: (e: ProductEntry) => boolean) => [...rows.values()].find(f) ?? null;
	return {
		rows,
		byId: async (id) => rows.get(id) ?? null,
		byShopifyId: async (id) => find((e) => e.data.shopify_id === id),
		byHandle: async (h) => find((e) => e.data.handle === h) ?? find((e) => e.slug === h),
		create: async (slug, data) => {
			if (find((e) => e.slug === slug)) throw new Error("Slug taken");
			const e = { id: `e${++n}`, slug, status: "published", data: { ...data } };
			rows.set(e.id, e);
			return e;
		},
		update: async (id, data, slug) => {
			const e = rows.get(id)!;
			e.data = { ...e.data, ...data };
			if (slug) e.slug = slug;
			return e;
		},
		publish: async (id) => {
			rows.get(id)!.status = "published";
		},
		unpublish: async (id) => {
			rows.get(id)!.status = "draft";
		},
		oldest: async (limit) => [...rows.values()].sort((a, b) => String(a.data.synced_at).localeCompare(String(b.data.synced_at))).slice(0, limit),
		list: async (limit) => [...rows.values()].slice(0, limit),
		counts: async () => ({ total: rows.size, listed: [...rows.values()].filter((e) => e.data.listed !== false).length }),
	};
}

describe("mirrorOf", () => {
	it("keeps Shopify's card fields, a sale price only when lower, and a quick-add variant only when there is one", () => {
		const m = mirrorOf(raw("tote"), new Date("2026-11-15T00:00:00Z"));
		expect(m).toMatchObject({ handle: "tote", title: "TOTE", price: "10.00", price_max: "14.00", compare_at: "12.00", currency: "USD", available: true, listed: true, quick_add: "gid://shopify/ProductVariant/tote", synced_at: "2026-11-15T00:00:00.000Z" });
		expect(Object.keys(m).sort()).toEqual([...MIRROR_KEYS].sort());
		expect(mirrorOf(raw("a", { compareAtPriceRange: { minVariantPrice: money("9.00") } })).compare_at).toBeNull();
		expect(mirrorOf(raw("b", { requiresSellingPlan: true })).quick_add).toBeNull();
		expect(mirrorOf(raw("c", { variants: { nodes: [{ id: "1", availableForSale: true }, { id: "2", availableForSale: true }] } })).quick_add).toBeNull();
	});
});

describe("config", () => {
	it("defaults to a products collection and can be turned off", () => {
		expect(productsCollection({})).toBe("products");
		expect(productsCollection({ products: { collection: "shop_items" } })).toBe("shop_items");
		expect(productsCollection({ products: false })).toBeNull();
		expect(productsCollection({ products: { collection: "Bad-Slug" } })).toBeNull();
	});
	it("reads handles and product links", () => {
		expect(handleFrom("harbor-tote")).toBe("harbor-tote");
		expect(handleFrom("https://shop.example/products/Harbor-Tote?variant=1")).toBe("harbor-tote");
		expect(handleFrom("not a handle")).toBeNull();
	});
});

describe("applyProduct", () => {
	it("adds only when asked, so a webhook never adds a product staff didn't pick", async () => {
		const store = memory();
		expect(await applyProduct(store, mirrorOf(raw("tote")), {}, false)).toBe("absent");
		expect(store.rows.size).toBe(0);
		expect(await applyProduct(store, mirrorOf(raw("tote")), {}, true)).toBe("added");
		expect([...store.rows.values()][0]).toMatchObject({ slug: "tote", status: "published" });
	});

	it("updates Shopify's fields and leaves the editor's alone", async () => {
		const store = memory();
		await applyProduct(store, mirrorOf(raw("tote")), {}, true);
		const e = [...store.rows.values()][0]!;
		e.data.content = [{ _type: "block" }];
		expect(await applyProduct(store, mirrorOf(raw("tote")), {})).toBe("unchanged");
		expect(await applyProduct(store, mirrorOf(raw("tote", { title: "Tote, new" })), {})).toBe("updated");
		expect(e.data).toMatchObject({ title: "Tote, new", content: [{ _type: "block" }] });
	});

	it("follows a renamed handle by Shopify id, and moves the slug only when staff didn't change it", async () => {
		const store = memory();
		await applyProduct(store, mirrorOf(raw("tote")), {}, true);
		const renamed = { ...mirrorOf(raw("tote")), handle: "harbor-tote" };
		await applyProduct(store, renamed, {});
		const e = [...store.rows.values()][0]!;
		expect(e).toMatchObject({ slug: "harbor-tote", data: { handle: "harbor-tote" } });
		e.slug = "our-tote";
		await applyProduct(store, { ...renamed, handle: "tote-2" }, {});
		expect(e.slug).toBe("our-tote");
	});

	it("sets a product Shopify no longer sells to draft, and brings it back", async () => {
		const store = memory();
		await applyProduct(store, mirrorOf(raw("tote")), {}, true);
		const e = [...store.rows.values()][0]!;
		expect(await applyProduct(store, null, { id: "gid://shopify/Product/tote" })).toBe("delisted");
		expect(e).toMatchObject({ status: "draft", data: { listed: false, available: false } });
		expect(await applyProduct(store, null, { id: "gid://shopify/Product/tote" })).toBe("unchanged");
		expect(await applyProduct(store, mirrorOf(raw("tote")), {})).toBe("relisted");
		expect(e).toMatchObject({ status: "published", data: { listed: true } });
	});

	it("leaves an entry staff unpublished themselves unpublished", async () => {
		const store = memory();
		await applyProduct(store, mirrorOf(raw("tote")), {}, true);
		const e = [...store.rows.values()][0]!;
		e.status = "draft";
		expect(await applyProduct(store, mirrorOf(raw("tote", { title: "New" })), {})).toBe("updated");
		expect(e.status).toBe("draft");
	});
});

describe("batches", () => {
	it("adds picked handles and reports the ones Shopify doesn't sell", async () => {
		const store = memory();
		const { fetcher } = shop([raw("tote"), raw("mug")]);
		const r = await addProducts(config, store, ["tote", "/products/mug", "gone", "bad handle!"], { fetcher });
		expect(r.counts).toEqual({ added: 2, failed: 2 });
		expect(r.errors.join(" ")).toContain("gone");
		expect(describeBatch(r)).toBe("2 added, 2 failed");
	});

	it("adds every product page by page, resuming from Shopify's cursor", async () => {
		const store = memory();
		const list = Array.from({ length: 13 }, (_, i) => raw(`p${i}`));
		const { fetcher } = shop(list);
		const first = await addAllPage(config, store, null, { fetcher });
		expect(first).toMatchObject({ counts: { added: 10 }, next: "10" });
		const second = await addAllPage(config, store, first.next, { fetcher });
		expect(second).toMatchObject({ counts: { added: 3 }, next: null });
		expect(store.rows.size).toBe(13);
	});

	it("refreshes the entries read longest ago in one Storefront read", async () => {
		const store = memory();
		const products = [raw("tote"), raw("mug")];
		const { fetcher, calls } = shop(products);
		await addProducts(config, store, ["tote", "mug"], { fetcher });
		products[0] = raw("tote", { title: "Tote 2" });
		products.pop();
		calls.length = 0;
		const r = await refreshOldest(config, store, { fetcher });
		expect(calls).toHaveLength(1);
		expect(r.counts).toEqual({ updated: 1, delisted: 1 });
	});
});

describe("webhooks", () => {
	it("updates a picked product from Shopify's own read and ignores unpicked ones", async () => {
		const store = memory();
		const products = [raw("tote"), raw("mug")];
		const { fetcher } = shop(products);
		await addProducts(config, store, ["tote"], { fetcher });
		products[0] = raw("tote", { availableForSale: false });
		const payload = { id: "tote", admin_graphql_api_id: "gid://shopify/Product/tote", handle: "tote" };
		expect(await productWebhook(config, store, "products/update", payload, { fetcher })).toBe("updated");
		expect(await productWebhook(config, store, "products/create", { admin_graphql_api_id: "gid://shopify/Product/mug", handle: "mug" }, { fetcher })).toBe("absent");
		expect(await productWebhook({ ...config, products: { follow: "all" } }, store, "products/create", { admin_graphql_api_id: "gid://shopify/Product/mug", handle: "mug" }, { fetcher })).toBe("added");
		expect(await productWebhook(config, store, "products/delete", { id: "tote" }, { fetcher })).toBe("delisted");
	});
});

describe("site", () => {
	it("makes product cards from entries", () => {
		const m = mirrorOf(raw("tote"));
		expect(entryCard({ slug: "tote", data: { ...m } })).toEqual({
			handle: "tote",
			title: "TOTE",
			availableForSale: true,
			image: { url: "https://cdn/tote.jpg", altText: null },
			price: money("10.00"),
			compareAtPrice: money("12.00"),
			quickAddVariantId: "gid://shopify/ProductVariant/tote",
		});
		expect(entryCard({ ...m, listed: false }).availableForSale).toBe(false);
	});

	it("puts Shopify's fields back on an editor's save", async () => {
		const stored = { ...mirrorOf(raw("tote")), content: [] };
		const out = await guardSave({ ...stored, title: "Edited", price: "1.00", content: ["story"] }, stored, async () => null);
		expect(out).toMatchObject({ title: "TOTE", price: "10.00", content: ["story"] });
	});

	it("fills a new entry made in the editor from Shopify, by handle", async () => {
		const out = await guardSave({ handle: "/products/tote", content: [] }, null, async (h) => (h === "tote" ? mirrorOf(raw("tote")) : null));
		expect(out).toMatchObject({ handle: "tote", shopify_id: "gid://shopify/Product/tote", listed: true });
		expect(await guardSave({ handle: "gone" }, null, async () => null)).toMatchObject({ listed: false });
		expect(await guardSave({ title: "No handle" }, null, async () => null)).toEqual({ title: "No handle" });
	});

	it("leaves products the site keeps out of the product sitemap", async () => {
		const fetcher = (async () =>
			new Response(JSON.stringify({ data: { products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ handle: "tote", updatedAt: "" }, { handle: "mug", updatedAt: "" }] } } }), { status: 200 })) as unknown as typeof fetch;
		const res = await productSitemap({ shop: "x.myshopify.com" }, new URL("https://site.example/"), { productHref: "/shop/{handle}/", fetcher, exclude: ["tote"] });
		const xml = await res.text();
		expect(xml).toContain("/shop/mug/");
		expect(xml).not.toContain("/shop/tote/");
	});
});

// Keeps the test's mirror shape honest.
export type _ = ProductMirror;
