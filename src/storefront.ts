/**
 * Shopify Storefront API: plan details and checkout carts.
 *
 * Server-side calls use the private token (with the buyer's IP, as Shopify
 * asks), fall back to the public token, then to tokenless access, which
 * covers products and carts. Prices and availability always come from
 * Shopify; nothing here decides who gets access.
 */

import { env, ENV, shopOrigin, type RedeemIDConfig } from "./config.js";
import { USER_AGENT } from "./shopify.js";

export const STOREFRONT_API_VERSION = "2026-10";

export interface Plan {
	handle: string;
	title: string;
	description: string;
	availableForSale: boolean;
	variantId: string | null;
	sellingPlanId: string | null;
	price: { amount: string; currencyCode: string } | null;
}

const PLAN_TTL_MS = 5 * 60 * 1000;
const planCache = new Map<string, { at: number; value: Plan | null }>();

export function resetStorefrontCache(): void {
	planCache.clear();
	shopCache.clear();
}

/**
 * Where the buyer is, for local prices and currency (Shopify Markets). Both
 * are optional; Shopify uses the store's defaults without them.
 */
export interface StoreContext {
	/** ISO 3166 two-letter country code, e.g. "CA". */
	country?: string | null;
	/** Shopify language code, e.g. "FR" or "PT_BR". */
	language?: string | null;
}

/** A clean country code, or null. */
export function countryCode(raw: unknown): string | null {
	const c = typeof raw === "string" ? raw.trim().toUpperCase() : "";
	return /^[A-Z]{2}$/.test(c) && c !== "XX" && c !== "T1" ? c : null;
}

function languageCode(raw: unknown): string | null {
	const l = typeof raw === "string" ? raw.trim().toUpperCase().replace("-", "_") : "";
	return /^[A-Z]{2}(_[A-Z]{2})?$/.test(l) ? l : null;
}

/**
 * The buyer's context from config `market`: a fixed country, or "visitor"
 * for the country Cloudflare reports for the request (CF-IPCountry).
 */
export function storeContext(config: RedeemIDConfig | null | undefined, request?: Request | null): StoreContext {
	const m = config?.market;
	if (!m) return {};
	const country = m.country === "visitor" ? countryCode(request?.headers.get("cf-ipcountry")) : countryCode(m.country);
	return { country, language: languageCode(m.language) };
}

function contextKey(ctx: StoreContext | undefined): string {
	return `${ctx?.country ?? ""}|${ctx?.language ?? ""}`;
}

/** Add Shopify's @inContext directive to an operation, when there is a context. */
export function withContext(query: string, ctx: StoreContext | undefined): string {
	const parts: string[] = [];
	const country = countryCode(ctx?.country);
	const language = languageCode(ctx?.language);
	if (country) parts.push(`country: ${country}`);
	if (language) parts.push(`language: ${language}`);
	if (!parts.length) return query;
	return query.replace(/^(\s*(?:query|mutation)\s+\w+(?:\([^)]*\))?)/, `$1 @inContext(${parts.join(", ")})`);
}

export async function storefront<T>(
	config: RedeemIDConfig,
	query: string,
	variables: Record<string, unknown> = {},
	opts: { buyerIp?: string | null; fetcher?: typeof fetch; context?: StoreContext } = {},
): Promise<T> {
	query = withContext(query, opts.context);
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "application/json",
		"User-Agent": USER_AGENT,
	};
	const priv = env(ENV.storefrontPrivateToken);
	const pub = env(ENV.storefrontPublicToken);
	if (priv) {
		headers["Shopify-Storefront-Private-Token"] = priv;
		if (opts.buyerIp) headers["Shopify-Storefront-Buyer-IP"] = opts.buyerIp;
	} else if (pub) {
		headers["X-Shopify-Storefront-Access-Token"] = pub;
	}
	const res = await (opts.fetcher ?? fetch)(`${shopOrigin(config)}/api/${STOREFRONT_API_VERSION}/graphql.json`, {
		method: "POST",
		headers,
		body: JSON.stringify({ query, variables }),
	});
	const body = (await res.json().catch(() => ({}))) as { data?: T; errors?: unknown };
	if (!res.ok || !body.data) throw new Error(`Storefront API request failed (${res.status}).`);
	return body.data;
}

const PLAN_QUERY = `query Plan($handle: String!) {
  product(handle: $handle) {
    handle title description availableForSale requiresSellingPlan
    variants(first: 1) { nodes { id availableForSale price { amount currencyCode } } }
    sellingPlanGroups(first: 1) { nodes { sellingPlans(first: 1) { nodes { id } } } }
  }
}`;

interface PlanData {
	product: {
		handle: string;
		title: string;
		description: string;
		availableForSale: boolean;
		requiresSellingPlan: boolean;
		variants: { nodes: Array<{ id: string; availableForSale: boolean; price: { amount: string; currencyCode: string } }> };
		sellingPlanGroups: { nodes: Array<{ sellingPlans: { nodes: Array<{ id: string }> } }> };
	} | null;
}

/**
 * A product by handle, cached for five minutes. Null when Shopify has no such
 * product. Pass `context` (storeContext) so the price is the visitor's
 * market's, the one checkout will charge.
 */
export async function plan(config: RedeemIDConfig, handle: string, fetcher?: typeof fetch, context?: StoreContext): Promise<Plan | null> {
	const key = `${shopOrigin(config)}|${handle}|${contextKey(context)}`;
	const hit = planCache.get(key);
	if (hit && Date.now() - hit.at < PLAN_TTL_MS) return hit.value;

	const { product: p } = await storefront<PlanData>(config, PLAN_QUERY, { handle }, { fetcher, context });
	const variant = p?.variants.nodes[0] ?? null;
	const value: Plan | null = p
		? {
				handle: p.handle,
				title: p.title,
				description: p.description,
				availableForSale: p.availableForSale && (variant?.availableForSale ?? false),
				variantId: variant?.id ?? null,
				// Subscription-only products need a selling plan in the cart line.
				sellingPlanId: p.requiresSellingPlan ? (p.sellingPlanGroups.nodes[0]?.sellingPlans.nodes[0]?.id ?? null) : null,
				price: variant?.price ?? null,
			}
		: null;
	planCache.set(key, { at: Date.now(), value });
	return value;
}

const CART_CREATE = `mutation Cart($input: CartInput!) {
  cartCreate(input: $input) { cart { checkoutUrl } userErrors { message } }
}`;

/** Create a one-line cart and return its checkout URL. */
export async function checkoutUrl(
	config: RedeemIDConfig,
	line: { variantId: string; sellingPlanId?: string | null },
	opts: { email?: string | null; buyerIp?: string | null; fetcher?: typeof fetch } = {},
): Promise<string> {
	const input: Record<string, unknown> = {
		lines: [{ merchandiseId: line.variantId, quantity: 1, ...(line.sellingPlanId ? { sellingPlanId: line.sellingPlanId } : {}) }],
	};
	if (opts.email) input.buyerIdentity = { email: opts.email };
	const data = await storefront<{ cartCreate: { cart: { checkoutUrl: string } | null; userErrors: Array<{ message: string }> } }>(
		config,
		CART_CREATE,
		{ input },
		opts,
	);
	const url = data.cartCreate.cart?.checkoutUrl;
	if (!url) throw new Error(data.cartCreate.userErrors[0]?.message ?? "Shopify returned no checkout.");
	return url;
}

// ---------------------------------------------------------------- cart

export interface Cart {
	id: string;
	checkoutUrl: string;
	totalQuantity: number;
}

const CART_FIELDS = "id checkoutUrl totalQuantity";

const CART_GET = `query Cart($id: ID!) { cart(id: $id) { ${CART_FIELDS} } }`;

const CART_NEW = `mutation CartNew($input: CartInput!) {
  cartCreate(input: $input) { cart { ${CART_FIELDS} } userErrors { message } }
}`;

const CART_ADD = `mutation CartAdd($id: ID!, $lines: [CartLineInput!]!) {
  cartLinesAdd(cartId: $id, lines: $lines) { cart { ${CART_FIELDS} } userErrors { message } }
}`;

type CartResult = { cart: Cart | null; userErrors: Array<{ message: string }> };

/**
 * A cart by id. Null once Shopify no longer has it, which is what happens
 * after its checkout completes.
 */
export async function getCart(
	config: RedeemIDConfig,
	id: string,
	opts: { buyerIp?: string | null; fetcher?: typeof fetch } = {},
): Promise<Cart | null> {
	const data = await storefront<{ cart: Cart | null }>(config, CART_GET, { id }, opts);
	return data.cart;
}

/**
 * Add one line to the visitor's cart, creating the cart when there is none
 * (or Shopify has dropped it). A new cart carries the member's email.
 */
export async function addToCart(
	config: RedeemIDConfig,
	cartId: string | null,
	line: { variantId: string; sellingPlanId?: string | null; quantity?: number },
	opts: {
		email?: string | null;
		/** Cart attributes for a new cart, e.g. where the buyer came from. Keys starting "_" are hidden at checkout. */
		attributes?: Record<string, string>;
		buyerIp?: string | null;
		fetcher?: typeof fetch;
		/** A new cart's country, for local prices. */
		context?: StoreContext;
		/** Discount codes for a new cart. */
		discountCodes?: string[];
	} = {},
): Promise<Cart> {
	const quantity = Math.max(1, Math.floor(line.quantity ?? 1));
	const lines = [{ merchandiseId: line.variantId, quantity, ...(line.sellingPlanId ? { sellingPlanId: line.sellingPlanId } : {}) }];
	if (cartId) {
		const data = await storefront<{ cartLinesAdd: CartResult }>(config, CART_ADD, { id: cartId, lines }, opts).catch(() => null);
		if (data?.cartLinesAdd.cart) return data.cartLinesAdd.cart;
	}
	const input: Record<string, unknown> = { lines };
	const identity: Record<string, string> = {};
	if (opts.email) identity.email = opts.email;
	const country = countryCode(opts.context?.country);
	if (country) identity.countryCode = country;
	if (Object.keys(identity).length) input.buyerIdentity = identity;
	const attributes = Object.entries(opts.attributes ?? {}).filter(([, v]) => v);
	if (attributes.length) input.attributes = attributes.map(([key, value]) => ({ key, value }));
	if (opts.discountCodes?.length) input.discountCodes = opts.discountCodes;
	const data = await storefront<{ cartCreate: CartResult }>(config, CART_NEW, { input }, opts);
	const cart = data.cartCreate.cart;
	if (!cart) throw new Error(data.cartCreate.userErrors[0]?.message ?? "Shopify returned no cart.");
	return cart;
}

// ---------------------------------------------------------------- shop

export interface Money {
	amount: string;
	currencyCode: string;
}

export interface Image {
	url: string;
	altText: string | null;
}

export interface Variant {
	id: string;
	title: string;
	availableForSale: boolean;
	price: Money;
	/** The price before a sale, when Shopify has one above `price`. */
	compareAtPrice?: Money | null;
	sku?: string | null;
	image?: Image | null;
	/** Option name and value pairs, e.g. [{ name: "Size", value: "M" }]. */
	selectedOptions?: Array<{ name: string; value: string }>;
}

export interface SellingPlan {
	id: string;
	name: string;
	/** The group's name, e.g. "Subscribe and save". */
	group: string;
}

export interface Product {
	/** Shopify's product id (gid). */
	id?: string;
	handle: string;
	title: string;
	description: string;
	/** Shopify's HTML description, as the merchant wrote it. */
	descriptionHtml?: string;
	vendor?: string;
	productType?: string;
	availableForSale: boolean;
	image: Image | null;
	/** Every image, featured first (up to 20). */
	images?: Image[];
	/** The product's options and their values, e.g. Size: S, M, L. Absent or one "Title" option means none. */
	options?: Array<{ name: string; values: string[] }>;
	variants: Variant[];
	/** The first selling plan, for subscription-only products. */
	sellingPlanId: string | null;
	/** True when the product can only be bought on a selling plan. */
	requiresSellingPlan?: boolean;
	/** Every selling plan offered (subscriptions, pre-orders), in Shopify's order. */
	sellingPlans?: SellingPlan[];
	seo?: { title: string | null; description: string | null };
}

/** Real options to choose from: none for a product with only Shopify's "Default Title". */
export function realOptions(p: Product): Array<{ name: string; values: string[] }> {
	const opts = p.options ?? [];
	if (opts.length === 1 && opts[0]?.values.length === 1 && opts[0].values[0] === "Default Title") return [];
	return opts.filter((o) => o.values.length > 0);
}

/** The variant matching the chosen option values, or undefined. */
export function variantFor(p: Product, chosen: Record<string, string>): Variant | undefined {
	return p.variants.find((v) => (v.selectedOptions ?? []).every((o) => chosen[o.name] === o.value));
}

export interface ProductCard {
	handle: string;
	title: string;
	availableForSale: boolean;
	image: Image | null;
	/** The lowest variant price. */
	price: Money | null;
	/** The lowest compare-at price, when the product is on sale. */
	compareAtPrice?: Money | null;
	/** The variant to add straight from a card: set only when the product has exactly one and needs no selling plan. */
	quickAddVariantId?: string | null;
}

export interface Collection {
	handle: string;
	title: string;
	description: string;
	products: ProductCard[];
}

const PRODUCT_QUERY = `query Product($handle: String!) {
  product(handle: $handle) {
    id handle title description descriptionHtml vendor productType availableForSale requiresSellingPlan
    featuredImage { url altText }
    images(first: 20) { nodes { url altText } }
    options { name optionValues { name } }
    variants(first: 100) { nodes { id title availableForSale sku price { amount currencyCode } compareAtPrice { amount currencyCode } image { url altText } selectedOptions { name value } } }
    sellingPlanGroups(first: 5) { nodes { name sellingPlans(first: 10) { nodes { id name } } } }
    seo { title description }
  }
}`;

/** The fields a product card needs. */
export const CARD_FIELDS = `handle title availableForSale requiresSellingPlan featuredImage { url altText }
      priceRange { minVariantPrice { amount currencyCode } }
      compareAtPriceRange { minVariantPrice { amount currencyCode } }
      variants(first: 2) { nodes { id availableForSale } }`;

export type RawCard = {
	handle: string;
	title: string;
	availableForSale: boolean;
	requiresSellingPlan?: boolean;
	featuredImage: Image | null;
	priceRange?: { minVariantPrice: Money } | null;
	compareAtPriceRange?: { minVariantPrice: Money } | null;
	variants?: { nodes: Array<{ id: string; availableForSale: boolean }> };
};

export function toCard(p: RawCard): ProductCard {
	const price = p.priceRange?.minVariantPrice ?? null;
	const compare = p.compareAtPriceRange?.minVariantPrice ?? null;
	const only = p.variants?.nodes.length === 1 ? p.variants.nodes[0] : null;
	return {
		handle: p.handle,
		title: p.title,
		availableForSale: p.availableForSale,
		image: p.featuredImage ?? null,
		price,
		compareAtPrice: compare && price && Number(compare.amount) > Number(price.amount) ? compare : null,
		quickAddVariantId: only?.availableForSale && !p.requiresSellingPlan ? only.id : null,
	};
}

const COLLECTION_QUERY = `query Collection($handle: String!, $first: Int!) {
  collection(handle: $handle) {
    handle title description
    products(first: $first) {
      nodes { ${CARD_FIELDS} }
    }
  }
}`;

const shopCache = new Map<string, { at: number; value: unknown }>();

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
	const hit = shopCache.get(key);
	if (hit && Date.now() - hit.at < PLAN_TTL_MS) return hit.value as T;
	const value = await load();
	shopCache.set(key, { at: Date.now(), value });
	return value;
}

type RawProduct = {
	id: string;
	handle: string;
	title: string;
	description: string;
	descriptionHtml?: string;
	vendor?: string;
	productType?: string;
	availableForSale: boolean;
	requiresSellingPlan: boolean;
	featuredImage: Image | null;
	images?: { nodes: Image[] };
	options?: Array<{ name: string; optionValues?: Array<{ name: string }> }>;
	variants: { nodes: Variant[] };
	sellingPlanGroups: { nodes: Array<{ name?: string; sellingPlans: { nodes: Array<{ id: string; name?: string }> } }> };
	seo?: { title: string | null; description: string | null } | null;
};

function toProduct(p: RawProduct): Product {
	const plans: SellingPlan[] = p.sellingPlanGroups.nodes.flatMap((g) => g.sellingPlans.nodes.map((sp) => ({ id: sp.id, name: sp.name ?? "", group: g.name ?? "" })));
	const images = p.images?.nodes ?? [];
	const featured = p.featuredImage ?? null;
	return {
		id: p.id,
		handle: p.handle,
		title: p.title,
		description: p.description,
		descriptionHtml: p.descriptionHtml ?? "",
		vendor: p.vendor ?? "",
		productType: p.productType ?? "",
		availableForSale: p.availableForSale,
		image: featured,
		images: featured ? [featured, ...images.filter((i) => i.url !== featured.url)] : images,
		options: (p.options ?? []).map((o) => ({ name: o.name, values: (o.optionValues ?? []).map((v) => v.name) })),
		variants: p.variants.nodes,
		sellingPlanId: p.requiresSellingPlan ? (plans[0]?.id ?? null) : null,
		requiresSellingPlan: p.requiresSellingPlan,
		sellingPlans: plans,
		seo: p.seo ?? { title: null, description: null },
	};
}

/** A product with its variants, options, images and selling plans, cached for five minutes. Null when Shopify has no such product. */
export async function product(config: RedeemIDConfig, handle: string, fetcher?: typeof fetch, context?: StoreContext): Promise<Product | null> {
	return cached(`${shopOrigin(config)}|product|${handle}|${contextKey(context)}`, async () => {
		const { product: p } = await storefront<{ product: RawProduct | null }>(config, PRODUCT_QUERY, { handle }, { fetcher, context });
		return p ? toProduct(p) : null;
	});
}

/** A collection's first `first` products, cached for five minutes. Null when Shopify has no such collection. */
export async function collection(config: RedeemIDConfig, handle: string, first = 12, fetcher?: typeof fetch, context?: StoreContext): Promise<Collection | null> {
	const n = Math.max(1, Math.min(50, Math.floor(first)));
	return cached(`${shopOrigin(config)}|collection|${handle}|${n}|${contextKey(context)}`, async () => {
		type Data = { collection: { handle: string; title: string; description: string; products: { nodes: RawCard[] } } | null };
		const { collection: c } = await storefront<Data>(config, COLLECTION_QUERY, { handle, first: n }, { fetcher, context });
		if (!c) return null;
		return { handle: c.handle, title: c.title, description: c.description, products: c.products.nodes.map(toCard) };
	});
}

/** Cache a Storefront read for five minutes, by key. Used by the catalog module. */
export function cachedRead<T>(key: string, load: () => Promise<T>): Promise<T> {
	return cached(key, load);
}

export { contextKey };

/** Format Shopify money for display. */
export function money(m: Money | null | undefined, locale = "en-US"): string | null {
	if (!m) return null;
	const n = Number(m.amount);
	if (!Number.isFinite(n)) return null;
	return new Intl.NumberFormat(locale, { style: "currency", currency: m.currencyCode }).format(n);
}

// ---------------------------------------------------------------- cart details

export interface CartLine {
	id: string;
	quantity: number;
	variantId: string;
	variantTitle: string;
	productTitle: string;
	productHandle: string;
	image: Image | null;
	price: Money | null;
	total: Money | null;
	/** The selling plan the line is bought on (a subscription), by name. */
	sellingPlan?: string | null;
	/** The line's price per item before a sale, when there is one. */
	compareAtPrice?: Money | null;
}

export interface CartDetails extends Cart {
	lines: CartLine[];
	subtotal: Money | null;
	total: Money | null;
	discountCodes: Array<{ code: string; applicable: boolean }>;
}

const CART_DETAIL_FIELDS = `${CART_FIELDS}
  cost { subtotalAmount { amount currencyCode } totalAmount { amount currencyCode } }
  discountCodes { code applicable }
  lines(first: 100) { nodes {
    id quantity
    cost { totalAmount { amount currencyCode } compareAtAmountPerQuantity { amount currencyCode } }
    sellingPlanAllocation { sellingPlan { name } }
    merchandise { ... on ProductVariant { id title price { amount currencyCode } image { url altText } product { title handle featuredImage { url altText } } } }
  } }`;

type RawCart = Cart & {
	cost?: { subtotalAmount?: Money | null; totalAmount?: Money | null } | null;
	discountCodes?: Array<{ code: string; applicable: boolean }>;
	lines?: {
		nodes: Array<{
			id: string;
			quantity: number;
			cost?: { totalAmount?: Money | null; compareAtAmountPerQuantity?: Money | null } | null;
			sellingPlanAllocation?: { sellingPlan?: { name?: string } | null } | null;
			merchandise: {
				id: string;
				title: string;
				price?: Money | null;
				image?: Image | null;
				product: { title: string; handle: string; featuredImage?: Image | null };
			};
		}>;
	};
};

function details(c: RawCart): CartDetails {
	return {
		id: c.id,
		checkoutUrl: c.checkoutUrl,
		totalQuantity: c.totalQuantity,
		subtotal: c.cost?.subtotalAmount ?? null,
		total: c.cost?.totalAmount ?? null,
		discountCodes: c.discountCodes ?? [],
		lines: (c.lines?.nodes ?? []).map((l) => ({
			id: l.id,
			quantity: l.quantity,
			variantId: l.merchandise.id,
			variantTitle: l.merchandise.title,
			productTitle: l.merchandise.product.title,
			productHandle: l.merchandise.product.handle,
			image: l.merchandise.image ?? l.merchandise.product.featuredImage ?? null,
			price: l.merchandise.price ?? null,
			total: l.cost?.totalAmount ?? null,
			sellingPlan: l.sellingPlanAllocation?.sellingPlan?.name ?? null,
			compareAtPrice: l.cost?.compareAtAmountPerQuantity ?? null,
		})),
	};
}

type DetailResult = { cart: RawCart | null; userErrors: Array<{ message: string }> };

/** The cart with its lines, costs and discount codes. Null once Shopify no longer has it. */
export async function cartDetails(
	config: RedeemIDConfig,
	id: string,
	opts: { buyerIp?: string | null; fetcher?: typeof fetch } = {},
): Promise<CartDetails | null> {
	const data = await storefront<{ cart: RawCart | null }>(config, `query Cart($id: ID!) { cart(id: $id) { ${CART_DETAIL_FIELDS} } }`, { id }, opts);
	return data.cart ? details(data.cart) : null;
}

function result(r: DetailResult): CartDetails {
	if (!r.cart) throw new Error(r.userErrors[0]?.message ?? "Shopify returned no cart.");
	return details(r.cart);
}

/** Set line quantities; a quantity of 0 removes the line. */
export async function updateLines(
	config: RedeemIDConfig,
	cartId: string,
	lines: Array<{ id: string; quantity: number }>,
	opts: { buyerIp?: string | null; fetcher?: typeof fetch } = {},
): Promise<CartDetails> {
	const data = await storefront<{ cartLinesUpdate: DetailResult }>(
		config,
		`mutation CartUpdate($id: ID!, $lines: [CartLineUpdateInput!]!) { cartLinesUpdate(cartId: $id, lines: $lines) { cart { ${CART_DETAIL_FIELDS} } userErrors { message } } }`,
		{ id: cartId, lines },
		opts,
	);
	return result(data.cartLinesUpdate);
}

export async function removeLines(
	config: RedeemIDConfig,
	cartId: string,
	lineIds: string[],
	opts: { buyerIp?: string | null; fetcher?: typeof fetch } = {},
): Promise<CartDetails> {
	const data = await storefront<{ cartLinesRemove: DetailResult }>(
		config,
		`mutation CartRemove($id: ID!, $lineIds: [ID!]!) { cartLinesRemove(cartId: $id, lineIds: $lineIds) { cart { ${CART_DETAIL_FIELDS} } userErrors { message } } }`,
		{ id: cartId, lineIds },
		opts,
	);
	return result(data.cartLinesRemove);
}

/** Replace the cart's discount codes (an empty list clears them). */
export async function setDiscountCodes(
	config: RedeemIDConfig,
	cartId: string,
	codes: string[],
	opts: { buyerIp?: string | null; fetcher?: typeof fetch } = {},
): Promise<CartDetails> {
	const data = await storefront<{ cartDiscountCodesUpdate: DetailResult }>(
		config,
		`mutation CartDiscount($id: ID!, $codes: [String!]) { cartDiscountCodesUpdate(cartId: $id, discountCodes: $codes) { cart { ${CART_DETAIL_FIELDS} } userErrors { message } } }`,
		{ id: cartId, codes },
		opts,
	);
	return result(data.cartDiscountCodesUpdate);
}

/**
 * Sign the cart in as the member, with their Customer Account API access
 * token, so Shopify's checkout opens signed in and the order lands on their
 * customer. Returns the cart's fresh checkout URL, or null when Shopify
 * refused (the visitor then checks out as a guest).
 */
export async function signInCart(
	config: RedeemIDConfig,
	cartId: string,
	customerAccessToken: string,
	opts: { buyerIp?: string | null; fetcher?: typeof fetch } = {},
): Promise<string | null> {
	const data = await storefront<{ cartBuyerIdentityUpdate: { cart: { checkoutUrl: string } | null; userErrors: Array<{ message: string }> } }>(
		config,
		`mutation CartIdentity($id: ID!, $identity: CartBuyerIdentityInput!) { cartBuyerIdentityUpdate(cartId: $id, buyerIdentity: $identity) { cart { checkoutUrl } userErrors { message } } }`,
		{ id: cartId, identity: { customerAccessToken } },
		opts,
	).catch(() => null);
	const cart = data?.cartBuyerIdentityUpdate.cart;
	return cart && !data?.cartBuyerIdentityUpdate.userErrors.length ? cart.checkoutUrl : null;
}
