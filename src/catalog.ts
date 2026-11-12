/**
 * Catalog browsing through the Storefront API: product search, a
 * collection's products with Shopify's filters and sorting, paging,
 * predictive search and recommendations.
 *
 * Filters are Shopify's own (Settings in the Search & Discovery app decide
 * which a store offers). Each filter value carries Shopify's `input`, a JSON
 * string, which goes back to Shopify as it came: nothing here invents a
 * filter or a price.
 */

import { shopOrigin, type RedeemIDConfig } from "./config.js";
import { CARD_FIELDS, cachedRead, contextKey, storefront, toCard, type Money, type ProductCard, type RawCard, type StoreContext } from "./storefront.js";

export interface FilterValue {
	id: string;
	label: string;
	count: number;
	/** Shopify's filter input, as a JSON string. */
	input: string;
}

export interface Filter {
	id: string;
	label: string;
	/** LIST, PRICE_RANGE or BOOLEAN. */
	type: string;
	values: FilterValue[];
}

export interface PageInfo {
	hasNextPage: boolean;
	hasPreviousPage: boolean;
	startCursor: string | null;
	endCursor: string | null;
}

export interface ProductPage {
	products: ProductCard[];
	filters: Filter[];
	pageInfo: PageInfo;
	/** Search only: how many products match. */
	total?: number;
}

export interface CollectionPage extends ProductPage {
	handle: string;
	title: string;
	description: string;
}

/** Sort orders a visitor can pick. Search offers relevance and price only. */
export const SORTS = ["relevance", "best-selling", "newest", "price-asc", "price-desc", "title-asc", "title-desc"] as const;
export type Sort = (typeof SORTS)[number];
export const SEARCH_SORTS: readonly Sort[] = ["relevance", "price-asc", "price-desc"];

export interface Browse {
	/** Products per page, 1 to 50. */
	first?: number;
	/** Cursor of the page before (next page). */
	after?: string | null;
	/** Cursor of the page after (previous page). */
	before?: string | null;
	sort?: Sort | null;
	/** Shopify filter inputs (parsed objects), at most 20. */
	filters?: Array<Record<string, unknown>>;
}

const MAX_FILTERS = 20;
const MAX_FILTER_LENGTH = 500;

/** Parse filter inputs from strings (URL `filter` values), dropping anything that isn't a small JSON object. */
export function parseFilters(raw: Iterable<string>): Array<Record<string, unknown>> {
	const out: Array<Record<string, unknown>> = [];
	for (const s of raw) {
		if (out.length >= MAX_FILTERS) break;
		if (typeof s !== "string" || s.length > MAX_FILTER_LENGTH) continue;
		try {
			const v = JSON.parse(s) as unknown;
			if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1) out.push(v as Record<string, unknown>);
		} catch {
			// not a filter
		}
	}
	return out;
}

/** A price filter from min and max (either may be blank). */
export function priceFilter(min: unknown, max: unknown): Record<string, unknown> | null {
	const n = (v: unknown) => {
		const x = typeof v === "string" && v.trim() !== "" ? Number(v) : typeof v === "number" ? v : Number.NaN;
		return Number.isFinite(x) && x >= 0 ? x : null;
	};
	const lo = n(min);
	const hi = n(max);
	if (lo === null && hi === null) return null;
	return { price: { ...(lo !== null ? { min: lo } : {}), ...(hi !== null ? { max: hi } : {}) } };
}

/** Read browsing from a URL's search params: q, sort, after, before, filter (repeatable), price_min, price_max. */
export function browseFromUrl(params: URLSearchParams, first = 24): Browse & { query: string } {
	const filters = parseFilters(params.getAll("filter"));
	const price = priceFilter(params.get("price_min"), params.get("price_max"));
	if (price && filters.length < MAX_FILTERS) filters.push(price);
	const sort = params.get("sort");
	const cursor = (v: string | null) => (v && v.length <= 300 ? v : null);
	return {
		query: (params.get("q") ?? "").trim().slice(0, 200),
		first,
		after: cursor(params.get("after")),
		before: cursor(params.get("before")),
		sort: (SORTS as readonly string[]).includes(sort ?? "") ? (sort as Sort) : null,
		filters,
	};
}

function collectionSort(sort: Sort | null | undefined): { sortKey: string; reverse: boolean } | null {
	switch (sort) {
		case "best-selling":
			return { sortKey: "BEST_SELLING", reverse: false };
		case "newest":
			return { sortKey: "CREATED", reverse: true };
		case "price-asc":
			return { sortKey: "PRICE", reverse: false };
		case "price-desc":
			return { sortKey: "PRICE", reverse: true };
		case "title-asc":
			return { sortKey: "TITLE", reverse: false };
		case "title-desc":
			return { sortKey: "TITLE", reverse: true };
		case "relevance":
			return { sortKey: "RELEVANCE", reverse: false };
		default:
			return null;
	}
}

function searchSort(sort: Sort | null | undefined): { sortKey: string; reverse: boolean } {
	if (sort === "price-asc") return { sortKey: "PRICE", reverse: false };
	if (sort === "price-desc") return { sortKey: "PRICE", reverse: true };
	return { sortKey: "RELEVANCE", reverse: false };
}

function paging(b: Browse): Record<string, unknown> {
	const n = Math.max(1, Math.min(50, Math.floor(b.first ?? 24)));
	return b.before ? { last: n, before: b.before } : { first: n, after: b.after ?? null };
}

const FILTER_FIELDS = "id label type values { id label count input }";
const PAGE_FIELDS = "hasNextPage hasPreviousPage startCursor endCursor";

type RawPage = { filters?: Filter[]; productFilters?: Filter[]; pageInfo: PageInfo; nodes: Array<RawCard | Record<string, never>>; totalCount?: number };

function toPage(p: RawPage): ProductPage {
	return {
		products: p.nodes.filter((n): n is RawCard => typeof (n as RawCard).handle === "string").map(toCard),
		filters: p.filters ?? p.productFilters ?? [],
		pageInfo: p.pageInfo,
		...(typeof p.totalCount === "number" ? { total: p.totalCount } : {}),
	};
}

const SEARCH_QUERY = `query Search($query: String!, $first: Int, $last: Int, $after: String, $before: String, $sortKey: SearchSortKeys, $reverse: Boolean, $filters: [ProductFilter!]) {
  search(query: $query, first: $first, last: $last, after: $after, before: $before, types: [PRODUCT], sortKey: $sortKey, reverse: $reverse, productFilters: $filters, unavailableProducts: LAST) {
    totalCount
    productFilters { ${FILTER_FIELDS} }
    pageInfo { ${PAGE_FIELDS} }
    nodes { ... on Product { ${CARD_FIELDS} } }
  }
}`;

/** Products matching a search, with the filters Shopify offers for them. Cached for five minutes. */
export async function searchProducts(
	config: RedeemIDConfig,
	query: string,
	b: Browse = {},
	opts: { fetcher?: typeof fetch; context?: StoreContext } = {},
): Promise<ProductPage> {
	const q = query.trim().slice(0, 200);
	if (!q) return { products: [], filters: [], pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, total: 0 };
	const vars = { query: q, ...paging(b), ...searchSort(b.sort), filters: b.filters ?? [] };
	return cachedRead(`${shopOrigin(config)}|search|${JSON.stringify(vars)}|${contextKey(opts.context)}`, async () => {
		const data = await storefront<{ search: RawPage }>(config, SEARCH_QUERY, vars, opts);
		return toPage(data.search);
	});
}

const COLLECTION_PAGE_QUERY = `query CollectionPage($handle: String!, $first: Int, $last: Int, $after: String, $before: String, $sortKey: ProductCollectionSortKeys, $reverse: Boolean, $filters: [ProductFilter!]) {
  collection(handle: $handle) {
    handle title description
    products(first: $first, last: $last, after: $after, before: $before, sortKey: $sortKey, reverse: $reverse, filters: $filters) {
      filters { ${FILTER_FIELDS} }
      pageInfo { ${PAGE_FIELDS} }
      nodes { ${CARD_FIELDS} }
    }
  }
}`;

/** One page of a collection's products, with its filters. Null when Shopify has no such collection. Cached for five minutes. */
export async function collectionPage(
	config: RedeemIDConfig,
	handle: string,
	b: Browse = {},
	opts: { fetcher?: typeof fetch; context?: StoreContext } = {},
): Promise<CollectionPage | null> {
	const sort = collectionSort(b.sort);
	const vars = { handle, ...paging(b), ...(sort ?? {}), filters: b.filters ?? [] };
	return cachedRead(`${shopOrigin(config)}|collection-page|${JSON.stringify(vars)}|${contextKey(opts.context)}`, async () => {
		type Data = { collection: { handle: string; title: string; description: string; products: RawPage } | null };
		const { collection: c } = await storefront<Data>(config, COLLECTION_PAGE_QUERY, vars, opts);
		if (!c) return null;
		return { handle: c.handle, title: c.title, description: c.description, ...toPage(c.products) };
	});
}

export interface Suggestions {
	queries: string[];
	products: ProductCard[];
	collections: Array<{ handle: string; title: string }>;
}

const PREDICTIVE_QUERY = `query Predictive($query: String!, $limit: Int!) {
  predictiveSearch(query: $query, limit: $limit, types: [QUERY, PRODUCT, COLLECTION], unavailableProducts: LAST) {
    queries { text }
    products { ${CARD_FIELDS} }
    collections { handle title }
  }
}`;

/** Suggestions while a visitor types: search terms, products and collections. Cached for five minutes. */
export async function suggest(
	config: RedeemIDConfig,
	query: string,
	limit = 6,
	opts: { fetcher?: typeof fetch; context?: StoreContext } = {},
): Promise<Suggestions> {
	const q = query.trim().slice(0, 100);
	if (!q) return { queries: [], products: [], collections: [] };
	const n = Math.max(1, Math.min(10, Math.floor(limit)));
	return cachedRead(`${shopOrigin(config)}|suggest|${q.toLowerCase()}|${n}|${contextKey(opts.context)}`, async () => {
		type Data = { predictiveSearch: { queries: Array<{ text: string }>; products: RawCard[]; collections: Array<{ handle: string; title: string }> } | null };
		const { predictiveSearch: p } = await storefront<Data>(config, PREDICTIVE_QUERY, { query: q, limit: n }, opts);
		return { queries: (p?.queries ?? []).map((x) => x.text), products: (p?.products ?? []).map(toCard), collections: p?.collections ?? [] };
	});
}

const RECOMMENDATIONS_QUERY = `query Recommendations($id: ID!, $intent: ProductRecommendationIntent) {
  productRecommendations(productId: $id, intent: $intent) { ${CARD_FIELDS} }
}`;

/** Shopify's recommendations for a product (by its gid): "related" (You may also like) or "complementary" (Pair it with). */
export async function recommendations(
	config: RedeemIDConfig,
	productId: string,
	intent: "related" | "complementary" = "related",
	opts: { fetcher?: typeof fetch; context?: StoreContext } = {},
): Promise<ProductCard[]> {
	if (!/^gid:\/\/shopify\/Product\/\d+$/.test(productId)) return [];
	return cachedRead(`${shopOrigin(config)}|recs|${productId}|${intent}|${contextKey(opts.context)}`, async () => {
		const data = await storefront<{ productRecommendations: RawCard[] | null }>(
			config,
			RECOMMENDATIONS_QUERY,
			{ id: productId, intent: intent === "complementary" ? "COMPLEMENTARY" : "RELATED" },
			opts,
		);
		return (data.productRecommendations ?? []).map(toCard);
	});
}

/** A browse URL with one setting changed, for links and paging. Keeps everything else. */
export function browseHref(current: URL, change: Record<string, string | null>): string {
	const params = new URLSearchParams(current.search);
	params.delete("redeemid_notice");
	for (const [k, v] of Object.entries(change)) {
		if (v === null) params.delete(k);
		else params.set(k, v);
	}
	// A new sort or filter starts from the first page.
	if (!("after" in change) && !("before" in change)) {
		params.delete("after");
		params.delete("before");
	}
	const qs = params.toString();
	return `${current.pathname}${qs ? `?${qs}` : ""}`;
}

export type { Money };

const SITEMAP_QUERY = `query SitemapProducts($first: Int!, $after: String) {
  products(first: $first, after: $after, sortKey: UPDATED_AT, reverse: true) {
    pageInfo { hasNextPage endCursor }
    nodes { handle updatedAt }
  }
}`;

/** One product in the sitemap: its handle and when Shopify last changed it. */
export interface SitemapProduct {
	handle: string;
	updatedAt: string;
}

/** The most products one sitemap lists (20 Storefront API pages of 250). */
export const SITEMAP_LIMIT = 5000;

function escapeXml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/**
 * Every product the site's sales channel can sell, newest change first, up
 * to SITEMAP_LIMIT. Cached for five minutes.
 */
export async function sitemapProducts(config: RedeemIDConfig, opts: { fetcher?: typeof fetch } = {}): Promise<SitemapProduct[]> {
	return cachedRead(`${shopOrigin(config)}|sitemap`, async () => {
		const out: SitemapProduct[] = [];
		let after: string | null = null;
		while (out.length < SITEMAP_LIMIT) {
			type Data = { products: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: SitemapProduct[] } };
			const data: Data = await storefront<Data>(config, SITEMAP_QUERY, { first: 250, after }, opts);
			out.push(...data.products.nodes.filter((n) => typeof n.handle === "string" && n.handle));
			if (!data.products.pageInfo.hasNextPage || !data.products.pageInfo.endCursor) break;
			after = data.products.pageInfo.endCursor;
		}
		return out.slice(0, SITEMAP_LIMIT);
	});
}

/**
 * A sitemap of the site's product pages, for search engines. EmDash's own
 * sitemap lists content entries only, so products need this one:
 *
 *   // src/pages/sitemap-products.xml.ts
 *   export const GET: APIRoute = async ({ locals, url }) =>
 *     productSitemap(await siteConfig(locals), url, { productHref: "/shop/{handle}/" });
 *
 * `productHref` is the same pattern the product cards link with. Answers an
 * empty sitemap (not an error) when the store can't be read, so a crawler
 * never caches a broken page.
 */
export async function productSitemap(
	config: RedeemIDConfig | null,
	url: URL,
	opts: { productHref: string; fetcher?: typeof fetch },
): Promise<Response> {
	let products: SitemapProduct[] = [];
	if (config) {
		try {
			products = await sitemapProducts(config, { fetcher: opts.fetcher });
		} catch {
			products = [];
		}
	}
	const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'];
	for (const p of products) {
		const loc = new URL(opts.productHref.replace("{handle}", encodeURIComponent(p.handle)), url).href;
		lines.push("  <url>", `    <loc>${escapeXml(loc)}</loc>`);
		if (p.updatedAt) lines.push(`    <lastmod>${escapeXml(p.updatedAt)}</lastmod>`);
		lines.push("  </url>");
	}
	lines.push("</urlset>");
	return new Response(lines.join("\n"), {
		status: 200,
		headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600" },
	});
}
