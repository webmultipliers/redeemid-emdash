/**
 * Shopify Storefront API: plan details and checkout carts.
 *
 * Server-side calls use the private token (with the buyer's IP, as Shopify
 * asks), fall back to the public token, then to tokenless access, which
 * covers products and carts. Prices and availability always come from
 * Shopify; nothing here decides who gets access.
 */

import { env, ENV, shopOrigin, type RedeemIDConfig } from "./config.js";

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
}

export async function storefront<T>(
	config: RedeemIDConfig,
	query: string,
	variables: Record<string, unknown> = {},
	opts: { buyerIp?: string | null; fetcher?: typeof fetch } = {},
): Promise<T> {
	const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
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

/** A product by handle, cached for five minutes. Null when Shopify has no such product. */
export async function plan(config: RedeemIDConfig, handle: string, fetcher?: typeof fetch): Promise<Plan | null> {
	const key = `${shopOrigin(config)}|${handle}`;
	const hit = planCache.get(key);
	if (hit && Date.now() - hit.at < PLAN_TTL_MS) return hit.value;

	const { product: p } = await storefront<PlanData>(config, PLAN_QUERY, { handle }, { fetcher });
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
