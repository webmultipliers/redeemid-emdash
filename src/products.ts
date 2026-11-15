/**
 * Product entries: a local, synced copy of the Shopify products staff pick.
 *
 * Each product staff add (Plugins → RedeemID → Products, or "Add all") becomes
 * an entry in an EmDash collection the site defines, "products" by default.
 * That puts products in EmDash's own search, sitemap, menus and taxonomies, lets
 * posts point at them, and lets editors write a story around one.
 *
 * Shopify stays the source of truth. The fields Shopify owns (MIRROR_KEYS) are
 * only ever written from Shopify: when staff add or refresh a product, and when
 * Shopify sends products/create, products/update or products/delete. An editor's
 * change to one of them is put back on save (see guardSave). The fields
 * editors own (the story, extra images, terms) are never touched here.
 *
 * A product Shopify no longer sells on the site's channel (deleted, archived,
 * or taken off the Headless channel) is set to draft with `listed` false, and
 * comes back when Shopify sells it again. Shopify sends no webhook when a
 * product leaves the Headless channel, so the entry follows at the next
 * webhook for the product or a refresh. Until then its page still can't sell
 * it: the buy box reads Shopify live and shows it as not for sale.
 *
 * The copy is for cards, lists, search and links. Anything a buyer acts on
 * (variants, the price in their market, selling plans, stock) is read from
 * Shopify live by <Product>, and checkout is always Shopify's.
 *
 * Nothing is synced on a schedule: staff refresh by hand, in batches small
 * enough for the Workers Free plan's 50 database queries per request.
 */

import { ContentRepository } from "emdash";

import type { RedeemIDConfig } from "./config.js";
import { storefront, type Image, type Money, type ProductCard } from "./storefront.js";

/** Products read and written per click (each one is a few database queries). */
export const PRODUCTS_BATCH = 10;

/** The fields Shopify owns, written only from Shopify. */
export const MIRROR_KEYS = [
	"title",
	"handle",
	"shopify_id",
	"summary",
	"image_url",
	"image_alt",
	"price",
	"price_max",
	"compare_at",
	"currency",
	"available",
	"quick_add",
	"vendor",
	"product_type",
	"listed",
	"synced_at",
] as const;

export type MirrorKey = (typeof MIRROR_KEYS)[number];

/** What an entry holds of its Shopify product. */
export interface ProductMirror {
	title: string;
	handle: string;
	/** Shopify's product gid. */
	shopify_id: string;
	/** Shopify's plain-text description. */
	summary: string;
	image_url: string | null;
	image_alt: string | null;
	/** The lowest variant price, e.g. "19.00". */
	price: string | null;
	/** The highest variant price. */
	price_max: string | null;
	/** The lowest compare-at price, only when it is above `price` (on sale). */
	compare_at: string | null;
	currency: string | null;
	available: boolean;
	/** The one variant a card may add straight to the cart, or null. */
	quick_add: string | null;
	vendor: string | null;
	product_type: string | null;
	/** False once Shopify no longer sells the product on the site's channel. */
	listed: boolean;
	/** When Shopify was last read for it, ISO. */
	synced_at: string;
}

/** The collection product entries live in, or null when they are turned off. */
export function productsCollection(config: RedeemIDConfig | null | undefined): string | null {
	if (config?.products === false) return null;
	const slug = (config?.products && config.products.collection) || "products";
	return /^[a-z][a-z0-9_]*$/.test(slug) ? slug : null;
}

/** Whether products Shopify creates are added on their own. */
export function followsAll(config: RedeemIDConfig | null | undefined): boolean {
	return Boolean(config?.products && config.products.follow === "all");
}

// ---------------------------------------------------------------- Shopify

const MIRROR_FIELDS = `id handle title description vendor productType availableForSale requiresSellingPlan
      featuredImage { url altText }
      priceRange { minVariantPrice { amount currencyCode } maxVariantPrice { amount currencyCode } }
      compareAtPriceRange { minVariantPrice { amount currencyCode } }
      variants(first: 2) { nodes { id availableForSale } }`;

type RawMirror = {
	id: string;
	handle: string;
	title: string;
	description?: string;
	vendor?: string;
	productType?: string;
	availableForSale: boolean;
	requiresSellingPlan?: boolean;
	featuredImage?: Image | null;
	priceRange?: { minVariantPrice?: Money | null; maxVariantPrice?: Money | null } | null;
	compareAtPriceRange?: { minVariantPrice?: Money | null } | null;
	variants?: { nodes: Array<{ id: string; availableForSale: boolean }> };
};

/** What an entry stores for a Shopify product. */
export function mirrorOf(p: RawMirror, now = new Date()): ProductMirror {
	const min = p.priceRange?.minVariantPrice ?? null;
	const max = p.priceRange?.maxVariantPrice ?? null;
	const compare = p.compareAtPriceRange?.minVariantPrice ?? null;
	const only = p.variants?.nodes.length === 1 ? p.variants.nodes[0] : null;
	return {
		title: p.title,
		handle: p.handle,
		shopify_id: p.id,
		summary: p.description ?? "",
		image_url: p.featuredImage?.url ?? null,
		image_alt: p.featuredImage?.altText ?? null,
		price: min?.amount ?? null,
		price_max: max?.amount ?? null,
		compare_at: compare && min && Number(compare.amount) > Number(min.amount) ? compare.amount : null,
		currency: min?.currencyCode ?? null,
		available: p.availableForSale,
		quick_add: only?.availableForSale && !p.requiresSellingPlan ? only.id : null,
		vendor: p.vendor || null,
		product_type: p.productType || null,
		listed: true,
		synced_at: now.toISOString(),
	};
}

type Fetch = { fetcher?: typeof fetch };

/** One product as Shopify sells it on the site's channel now (never cached), or null. */
export async function readProduct(config: RedeemIDConfig, ref: { handle?: string | null; id?: string | null }, opts: Fetch = {}): Promise<ProductMirror | null> {
	if (ref.id) {
		const q = `query RedeemIDProductById($id: ID!) { product(id: $id) { ${MIRROR_FIELDS} } }`;
		const { product } = await storefront<{ product: RawMirror | null }>(config, q, { id: ref.id }, opts);
		if (product) return mirrorOf(product);
		if (!ref.handle) return null;
	}
	if (!ref.handle) return null;
	const q = `query RedeemIDProductByHandle($handle: String!) { product(handle: $handle) { ${MIRROR_FIELDS} } }`;
	const { product } = await storefront<{ product: RawMirror | null }>(config, q, { handle: ref.handle }, opts);
	return product ? mirrorOf(product) : null;
}

/** Several products by gid, in one read. A gid Shopify no longer sells maps to null. */
export async function readProducts(config: RedeemIDConfig, ids: string[], opts: Fetch = {}): Promise<Map<string, ProductMirror | null>> {
	const out = new Map<string, ProductMirror | null>(ids.map((id) => [id, null]));
	if (!ids.length) return out;
	const q = `query RedeemIDProducts($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { ${MIRROR_FIELDS} } } }`;
	const { nodes } = await storefront<{ nodes: Array<RawMirror | null> }>(config, q, { ids }, opts);
	for (const n of nodes) if (n?.id && out.has(n.id)) out.set(n.id, mirrorOf(n));
	return out;
}

/** A page of every product the channel sells, in Shopify's id order (stable, so "Add all" can resume). */
export async function productPage(config: RedeemIDConfig, after: string | null, first = PRODUCTS_BATCH, opts: Fetch = {}): Promise<{ items: ProductMirror[]; next: string | null }> {
	const q = `query RedeemIDProductPage($first: Int!, $after: String) {
  products(first: $first, after: $after, sortKey: ID) { pageInfo { hasNextPage endCursor } nodes { ${MIRROR_FIELDS} } }
}`;
	type Data = { products: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: RawMirror[] } };
	const { products } = await storefront<Data>(config, q, { first, after }, opts);
	return { items: products.nodes.map((n) => mirrorOf(n)), next: products.pageInfo.hasNextPage ? products.pageInfo.endCursor : null };
}

/** Products matching staff's search words, for the picker. */
export async function findShopProducts(config: RedeemIDConfig, query: string, first = 20, opts: Fetch = {}): Promise<ProductMirror[]> {
	const q = `query RedeemIDProductFind($first: Int!, $query: String!) { products(first: $first, query: $query) { nodes { ${MIRROR_FIELDS} } } }`;
	const { products } = await storefront<{ products: { nodes: RawMirror[] } }>(config, q, { first, query }, opts);
	return products.nodes.map((n) => mirrorOf(n));
}

/** "harbor-tote", "/products/harbor-tote" or a full product link → "harbor-tote". Null when it isn't one. */
export function handleFrom(raw: string): string | null {
	const t = raw.trim();
	const m = /\/products\/([^/?#]+)/.exec(t);
	const h = decodeURIComponent(m ? m[1]! : t).toLowerCase();
	return /^[a-z0-9][a-z0-9-]*$/.test(h) ? h : null;
}

// ---------------------------------------------------------------- entries

export interface ProductEntry {
	id: string;
	slug: string | null;
	status: string;
	data: Record<string, unknown>;
}

/** Where product entries are read and written. contentEntries() is the real one; tests use their own. */
export interface EntryStore {
	byId(id: string): Promise<ProductEntry | null>;
	byShopifyId(id: string): Promise<ProductEntry | null>;
	byHandle(handle: string): Promise<ProductEntry | null>;
	create(slug: string, data: ProductMirror): Promise<ProductEntry>;
	update(id: string, data: Partial<ProductMirror>, slug?: string): Promise<ProductEntry>;
	publish(id: string): Promise<void>;
	unpublish(id: string): Promise<void>;
	/** The entries Shopify was read for longest ago. */
	oldest(limit: number): Promise<ProductEntry[]>;
	/** Every entry's Shopify-owned fields, newest first, up to `limit`. */
	list(limit: number): Promise<ProductEntry[]>;
	counts(): Promise<{ total: number; listed: number }>;
}

type Db = ConstructorParameters<typeof ContentRepository>[0];

/** Product entries in an EmDash collection. Writes go straight to the live row: keep the collection without revisions. */
export function contentEntries(db: unknown, collection: string): EntryStore {
	const repo = new ContentRepository(db as Db);
	const k = db as Db;
	const table = `ec_${collection}`;
	const map = (item: { id: string; slug: string | null; status: string; data: Record<string, unknown> } | null): ProductEntry | null =>
		item ? { id: item.id, slug: item.slug, status: item.status, data: item.data ?? {} } : null;
	const byColumn = async (column: "shopify_id" | "handle", value: string) => {
		const row = await (k as unknown as { selectFrom(t: string): any })
			.selectFrom(table)
			.select(["id"])
			.where(column, "=", value)
			.where("deleted_at", "is", null)
			.executeTakeFirst();
		return row ? map((await repo.findById(collection, row.id)) as never) : null;
	};
	const rows = async (order: "asc" | "desc", column: string, limit: number) => {
		const list = (await (k as unknown as { selectFrom(t: string): any })
			.selectFrom(table)
			.selectAll()
			.where("deleted_at", "is", null)
			.orderBy(column, order)
			.limit(limit)
			.execute()) as Array<Record<string, unknown>>;
		return list.map((r) => ({
			id: String(r.id),
			slug: (r.slug as string | null) ?? null,
			status: String(r.status),
			data: Object.fromEntries(MIRROR_KEYS.map((key) => [key, key === "available" || key === "listed" ? Boolean(r[key]) : r[key]])),
		}));
	};
	return {
		byId: async (id) => map((await repo.findById(collection, id)) as never),
		byShopifyId: (id) => byColumn("shopify_id", id),
		byHandle: async (handle) => (await byColumn("handle", handle)) ?? map((await repo.findBySlug(collection, handle)) as never),
		// Status is set on the row itself: the collection keeps no revisions, and
		// EmDash's publish/unpublish would rewrite the row from a stale live copy.
		create: async (slug, data) => {
			const item = (await repo.create({ type: collection, slug, data: { ...data }, status: "published", publishedAt: new Date().toISOString() } as never)) as { id: string };
			return map((await repo.findById(collection, item.id)) as never)!;
		},
		update: async (id, data, slug) => map((await repo.update(collection, id, { data, ...(slug ? { slug } : {}) } as never)) as never)!,
		publish: async (id) => {
			await repo.update(collection, id, { status: "published", publishedAt: new Date().toISOString() } as never);
		},
		unpublish: async (id) => {
			await repo.update(collection, id, { status: "draft" } as never);
		},
		oldest: (limit) => rows("asc", "synced_at", limit),
		list: (limit) => rows("desc", "created_at", limit),
		counts: async () => {
			const q = (k as unknown as { selectFrom(t: string): any }).selectFrom(table).where("deleted_at", "is", null);
			const total = await q.select((eb: any) => eb.fn.countAll().as("n")).executeTakeFirst();
			const listed = await q.where("listed", "=", 1).select((eb: any) => eb.fn.countAll().as("n")).executeTakeFirst();
			return { total: Number(total?.n ?? 0), listed: Number(listed?.n ?? 0) };
		},
	};
}

/** The products collection as the site defines it: whether it exists, the Shopify fields it lacks, and whether it keeps revisions. */
export async function productsSchema(db: unknown, collection: string | null): Promise<{ exists: boolean; missing: string[]; revisions: boolean }> {
	if (!collection) return { exists: false, missing: [...MIRROR_KEYS], revisions: false };
	try {
		const { SchemaRegistry } = await import("emdash");
		const found = (await new SchemaRegistry(db as never).getCollectionWithFields(collection)) as { fields?: Array<{ slug: string }>; supports?: string[] } | null;
		if (!found) return { exists: false, missing: [...MIRROR_KEYS], revisions: false };
		const have = new Set((found.fields ?? []).map((f) => f.slug));
		return { exists: true, missing: MIRROR_KEYS.filter((k) => !have.has(k)), revisions: (found.supports ?? []).includes("revisions") };
	} catch {
		return { exists: false, missing: [...MIRROR_KEYS], revisions: false };
	}
}

/** Whether product entries can be written: the collection exists with every Shopify field. */
export async function hasProductsCollection(db: unknown, collection: string | null): Promise<boolean> {
	const s = await productsSchema(db, collection);
	return s.exists && s.missing.length === 0;
}

// ---------------------------------------------------------------- sync

export type SyncOutcome = "added" | "updated" | "unchanged" | "delisted" | "relisted" | "absent";

const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null) || (typeof a === "number" && typeof b === "boolean" && Boolean(a) === b);

/** Whether Shopify changed anything an entry shows. */
export function mirrorChanged(entry: Record<string, unknown>, mirror: ProductMirror): boolean {
	return MIRROR_KEYS.some((k) => k !== "synced_at" && !same(entry[k], mirror[k]));
}

/**
 * Bring one entry in step with what Shopify says now.
 *
 * - `mirror` null: Shopify doesn't sell it on the channel. A listed entry is
 *   marked unlisted and set to draft.
 * - No entry yet: added (published) only when `add` is true, so a webhook
 *   never adds a product staff didn't pick (unless config follows all).
 * - An entry staff unpublished themselves stays unpublished; only one RedeemID
 *   set to draft comes back.
 */
export async function applyProduct(store: EntryStore, mirror: ProductMirror | null, ref: { id?: string | null; handle?: string | null }, add = false): Promise<SyncOutcome> {
	const existing =
		(ref.id ? await store.byShopifyId(ref.id) : null) ??
		(mirror ? await store.byShopifyId(mirror.shopify_id) : null) ??
		(ref.handle ? await store.byHandle(ref.handle) : null) ??
		(mirror ? await store.byHandle(mirror.handle) : null);
	if (!mirror) {
		if (!existing) return "absent";
		if (existing.data.listed === false || existing.data.listed === 0) return "unchanged";
		if (existing.status === "published") await store.unpublish(existing.id);
		await store.update(existing.id, { listed: false, available: false, quick_add: null, synced_at: new Date().toISOString() });
		return "delisted";
	}
	if (!existing) {
		if (!add) return "absent";
		await store.create(mirror.handle, mirror);
		return "added";
	}
	const wasDelisted = existing.data.listed === false || existing.data.listed === 0;
	const changed = mirrorChanged(existing.data, mirror);
	// The slug follows a renamed handle, unless staff gave the entry its own.
	const slug = mirror.handle !== existing.data.handle && existing.slug === existing.data.handle ? mirror.handle : undefined;
	const relist = wasDelisted && existing.status === "draft";
	if (relist) await store.publish(existing.id);
	await store.update(existing.id, changed ? mirror : { synced_at: mirror.synced_at }, slug);
	if (relist) return "relisted";
	return changed ? "updated" : "unchanged";
}

export interface BatchResult {
	counts: Partial<Record<SyncOutcome | "failed", number>>;
	/** The cursor to continue from, or null when done. */
	next: string | null;
	errors: string[];
}

function tally(r: BatchResult, o: SyncOutcome | "failed") {
	r.counts[o] = (r.counts[o] ?? 0) + 1;
}

/** Add (or update) the products staff picked, by handle or link. */
export async function addProducts(config: RedeemIDConfig, store: EntryStore, handles: string[], opts: Fetch = {}): Promise<BatchResult> {
	const r: BatchResult = { counts: {}, next: null, errors: [] };
	for (const raw of handles.slice(0, PRODUCTS_BATCH)) {
		const handle = handleFrom(raw);
		if (!handle) {
			tally(r, "failed");
			r.errors.push(`"${raw}" isn't a product handle or link.`);
			continue;
		}
		try {
			const mirror = await readProduct(config, { handle }, opts);
			if (!mirror) {
				tally(r, "failed");
				r.errors.push(`Shopify doesn't sell "${handle}" on this site's channel.`);
				continue;
			}
			tally(r, await applyProduct(store, mirror, { handle }, true));
		} catch (e) {
			tally(r, "failed");
			r.errors.push(`${handle}: ${(e as Error).message}`);
		}
	}
	return r;
}

/** "Add all": the next page of Shopify's products, from `after`. Run again with `next` until it is null. */
export async function addAllPage(config: RedeemIDConfig, store: EntryStore, after: string | null, opts: Fetch = {}): Promise<BatchResult> {
	const r: BatchResult = { counts: {}, next: null, errors: [] };
	const page = await productPage(config, after, PRODUCTS_BATCH, opts);
	for (const mirror of page.items) {
		try {
			tally(r, await applyProduct(store, mirror, {}, true));
		} catch (e) {
			tally(r, "failed");
			r.errors.push(`${mirror.handle}: ${(e as Error).message}`);
		}
	}
	r.next = page.next;
	return r;
}

/** Refresh: read the entries synced longest ago from Shopify, in one Storefront read. */
export async function refreshOldest(config: RedeemIDConfig, store: EntryStore, opts: Fetch = {}): Promise<BatchResult> {
	const r: BatchResult = { counts: {}, next: null, errors: [] };
	const entries = await store.oldest(PRODUCTS_BATCH);
	const ids = entries.map((e) => String(e.data.shopify_id ?? "")).filter(Boolean);
	const fresh = await readProducts(config, ids, opts);
	for (const e of entries) {
		const id = String(e.data.shopify_id ?? "");
		try {
			// An entry with no Shopify id yet (made in the editor) is looked up by handle.
			const mirror = id ? (fresh.get(id) ?? null) : await readProduct(config, { handle: String(e.data.handle ?? e.slug ?? "") }, opts);
			const outcome = await applyProduct(store, mirror, { id: id || null, handle: String(e.data.handle ?? "") || null });
			if (outcome === "absent") {
				// Nothing to match it to in Shopify: stamp it so the next refresh moves on.
				await store.update(e.id, { synced_at: new Date().toISOString() });
				tally(r, "unchanged");
			} else tally(r, outcome);
		} catch (err) {
			tally(r, "failed");
			r.errors.push(`${String(e.data.handle ?? e.id)}: ${(err as Error).message}`);
		}
	}
	return r;
}

/** One webhook: products/create, products/update or products/delete. */
export async function productWebhook(config: RedeemIDConfig, store: EntryStore, topic: string, payload: Record<string, unknown>, opts: Fetch = {}): Promise<SyncOutcome> {
	const gid = typeof payload.admin_graphql_api_id === "string" ? payload.admin_graphql_api_id : payload.id != null ? `gid://shopify/Product/${String(payload.id)}` : null;
	const handle = typeof payload.handle === "string" ? payload.handle : null;
	if (topic === "products/delete") return applyProduct(store, null, { id: gid, handle });
	const mirror = await readProduct(config, { id: gid, handle }, opts);
	return applyProduct(store, mirror, { id: gid, handle }, followsAll(config));
}

/** Short words for a batch's counts: "3 added, 1 updated". */
export function describeBatch(r: BatchResult): string {
	const words: Record<string, string> = { added: "added", updated: "updated", relisted: "back on sale", delisted: "taken off sale", unchanged: "unchanged", absent: "not in the catalog", failed: "failed" };
	const parts = Object.entries(r.counts).filter(([, n]) => n).map(([k, n]) => `${n} ${words[k] ?? k}`);
	return parts.length ? parts.join(", ") : "Nothing to do";
}

// ---------------------------------------------------------------- site

/** A product card from an entry, for <ProductGrid>: `entries.map(entryCard)`. */
export function entryCard(entry: { slug?: string | null; data?: Record<string, unknown> } | Record<string, unknown>): ProductCard {
	const d = ("data" in entry && entry.data && typeof entry.data === "object" ? entry.data : entry) as Record<string, unknown>;
	const currency = typeof d.currency === "string" ? d.currency : null;
	const money = (v: unknown): Money | null => (typeof v === "string" && v && currency ? { amount: v, currencyCode: currency } : null);
	const url = typeof d.image_url === "string" && d.image_url ? d.image_url : null;
	return {
		handle: String(d.handle ?? ("slug" in entry ? entry.slug : "") ?? ""),
		title: String(d.title ?? ""),
		availableForSale: Boolean(d.available) && d.listed !== false && d.listed !== 0,
		image: url ? { url, altText: typeof d.image_alt === "string" ? d.image_alt : null } : null,
		price: money(d.price),
		compareAtPrice: money(d.compare_at),
		quickAddVariantId: typeof d.quick_add === "string" && d.quick_add ? d.quick_add : null,
	};
}

/**
 * Put Shopify's fields back on an editor's save, so only Shopify changes them.
 * `existing` is the stored entry (null on a create). A new entry made in the
 * editor with a handle gets Shopify's fields from `lookup`.
 */
export async function guardSave(
	content: Record<string, unknown>,
	existing: Record<string, unknown> | null,
	lookup: (handle: string) => Promise<ProductMirror | null>,
): Promise<Record<string, unknown>> {
	if (existing && existing.shopify_id) {
		const out = { ...content };
		for (const k of MIRROR_KEYS) if (k in existing || k in out) out[k] = existing[k] ?? null;
		return out;
	}
	const handle = handleFrom(String(content.handle ?? ""));
	if (!handle) return content;
	const mirror = await lookup(handle).catch(() => null);
	if (!mirror) return { ...content, handle, listed: false, available: false };
	return { ...content, ...mirror };
}

// ---------------------------------------------------------------- editor picker

const OPTIONS = Symbol.for("redeemid.productOptions");

/**
 * The Product block's catalog picker. EmDash builds the editor's manifest from
 * this array on each admin request, so it is refilled in place (by the guard,
 * on the manifest request) rather than replaced.
 */
export function productOptions(): Array<{ label: string; value: string }> {
	const g = globalThis as unknown as Record<symbol, Array<{ label: string; value: string }> | undefined>;
	return (g[OPTIONS] ??= []);
}

/** Refill the picker from the catalog: every listed entry, by title. */
export async function refreshProductOptions(db: unknown, config: RedeemIDConfig | null): Promise<void> {
	const collection = productsCollection(config);
	if (!collection || !(await hasProductsCollection(db, collection))) return;
	const entries = await contentEntries(db, collection).list(500);
	const opts = entries
		.filter((e) => e.data.listed !== false && e.data.handle)
		.map((e) => ({ label: `${String(e.data.title ?? e.data.handle)} (${String(e.data.handle)})`, value: String(e.data.handle) }))
		.sort((a, b) => a.label.localeCompare(b.label));
	const list = productOptions();
	list.splice(0, list.length, ...opts);
}

// ---------------------------------------------------------------- page helpers

/**
 * The handles of the products the site keeps as entries (any status), for
 * `productSitemap(..., { exclude })`. Empty without product entries.
 */
export async function catalogHandles(locals: unknown): Promise<Set<string>> {
	const { siteConfig } = await import("./site-config.js");
	const config = await siteConfig(locals);
	const collection = productsCollection(config);
	const db = (locals as { emdash?: { db?: unknown } } | null)?.emdash?.db;
	if (!collection || !db || !(await hasProductsCollection(db, collection))) return new Set();
	const entries = await contentEntries(db, collection).list(5000);
	return new Set(entries.map((e) => String(e.data.handle ?? "")).filter(Boolean));
}
