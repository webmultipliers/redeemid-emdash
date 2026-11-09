/**
 * Cart changes, shared by the form route (cart-edit, which redirects back
 * with a notice) and the JSON route (api/cart, for the browser client and
 * the cart drawer).
 *
 * Prices, discounts and availability come from Shopify; nothing posted is
 * trusted beyond the ids it names, and each is checked against what Shopify
 * says the product or cart holds.
 */

import { readCart, saveCart } from "./cart.js";
import type { RedeemIDConfig } from "./config.js";
import { memberForUser, stores } from "./storage.js";
import { addToCart, cartDetails, product, realOptions, removeLines, setDiscountCodes, storeContext, updateLines, variantFor, type Cart, type CartDetails, type Product, type Variant } from "./storefront.js";

export const MAX_QUANTITY = 1000;

export type CartNotice =
	| "cart_added"
	| "cart_updated"
	| "discount_applied"
	| "discount_not_applicable"
	| "plan_unavailable"
	| "cart_empty"
	| "checkout_failed";

export interface CartInput {
	action: string;
	/** add: product handle. */
	product?: string;
	/** add: a variant id of that product. */
	variant?: string;
	/** add: chosen option values by option name, when no variant is given. */
	options?: Record<string, string>;
	/** add: a selling plan id of that product, or "" for one-time. */
	sellingPlan?: string | null;
	quantity?: number | string;
	/** update / remove: the cart line id. */
	line?: string;
	/** discount: the code ("" clears). */
	code?: string;
	/** add: the page the buyer was on, kept as a hidden cart attribute. */
	page?: string;
}

export interface CartContext {
	config: RedeemIDConfig;
	session: { get(key: string): unknown; set(key: string, value: unknown): void; delete?(key: string): void } | undefined;
	request: Request;
	db?: unknown;
}

export interface CartOutcome {
	notice: CartNotice;
	/** The cart after the change, when it could be read. */
	cart: CartDetails | null;
	/** The cart's id, checkout URL and count after an add (lines aren't read back). */
	base?: Cart;
	/** add: the line's variant, for analytics. */
	added?: { product: string; variant: string; quantity: number; sellingPlan: boolean };
}

const HANDLE = /^[a-z0-9][a-z0-9-]*$/i;

/** Pick the variant an add names: by id, by option values, or the first one for sale. */
export function pickVariant(p: Product, input: Pick<CartInput, "variant" | "options">): Variant | undefined {
	if (input.variant) return p.variants.find((v) => v.id === input.variant);
	const opts = realOptions(p);
	if (opts.length && input.options && Object.keys(input.options).length) {
		const chosen: Record<string, string> = {};
		for (const o of opts) {
			const v = input.options[o.name];
			if (typeof v === "string" && o.values.includes(v)) chosen[o.name] = v;
		}
		if (Object.keys(chosen).length !== opts.length) return undefined;
		return variantFor(p, chosen);
	}
	return p.variants.find((v) => v.availableForSale);
}

/** The selling plan an add uses: one the product offers, the first one when it can only be bought on a plan, or none. */
export function pickSellingPlan(p: Product, wanted: string | null | undefined): string | null | undefined {
	const plans = p.sellingPlans ?? [];
	if (wanted) return plans.some((sp) => sp.id === wanted) ? wanted : undefined;
	if (p.requiresSellingPlan) return plans[0]?.id ?? p.sellingPlanId ?? undefined;
	return null;
}

export async function editCart(input: CartInput, ctx: CartContext): Promise<CartOutcome> {
	const { config, session, request } = ctx;
	const buyerIp = request.headers.get("cf-connecting-ip");
	const context = storeContext(config, request);
	const save = (c: { id: string; totalQuantity: number }) => saveCart(session, { id: c.id, count: c.totalQuantity });

	if (input.action === "add") {
		const handle = String(input.product ?? "").trim();
		const quantity = Number.parseInt(String(input.quantity ?? "1"), 10);
		if (!HANDLE.test(handle) || !Number.isFinite(quantity) || quantity < 1 || quantity > MAX_QUANTITY) return { notice: "plan_unavailable", cart: null };
		const p = await product(config, handle, undefined, context);
		const variant = p ? pickVariant(p, input) : undefined;
		const plan = p ? pickSellingPlan(p, input.sellingPlan) : undefined;
		if (!p || !variant?.availableForSale || plan === undefined) return { notice: "plan_unavailable", cart: null };
		const user = (await session?.get("user")) as { id?: string } | undefined;
		const member = user?.id && ctx.db ? await memberForUser(stores(ctx.db), user.id) : null;
		const current = await readCart(session);
		const cart = await addToCart(
			config,
			current?.id ?? null,
			{ variantId: variant.id, sellingPlanId: plan, quantity },
			{ email: member?.email ?? null, attributes: input.page ? { _redeemid_page: input.page } : {}, buyerIp, context },
		);
		save(cart);
		return { notice: "cart_added", cart: null, base: cart, added: { product: p.handle, variant: variant.id, quantity, sellingPlan: Boolean(plan) } };
	}

	const ref = await readCart(session);
	if (!ref) return { notice: "cart_empty", cart: null };
	const cart = await cartDetails(config, ref.id, { buyerIp });
	if (!cart) {
		saveCart(session, null);
		return { notice: "cart_empty", cart: null };
	}
	const line = String(input.line ?? "");
	const owns = cart.lines.some((l) => l.id === line);

	if (input.action === "update" || input.action === "remove") {
		if (!owns) return { notice: "cart_updated", cart };
		const quantity = input.action === "remove" ? 0 : Number.parseInt(String(input.quantity ?? ""), 10);
		if (!Number.isFinite(quantity) || quantity < 0 || quantity > MAX_QUANTITY) return { notice: "cart_updated", cart };
		const next = quantity === 0 ? await removeLines(config, cart.id, [line], { buyerIp }) : await updateLines(config, cart.id, [{ id: line, quantity }], { buyerIp });
		save(next);
		return { notice: "cart_updated", cart: next };
	}

	if (input.action === "discount") {
		const code = String(input.code ?? "").trim().slice(0, 100);
		const next = await setDiscountCodes(config, cart.id, code ? [code] : [], { buyerIp });
		save(next);
		if (!code) return { notice: "cart_updated", cart: next };
		const applied = next.discountCodes.find((d) => d.code.toLowerCase() === code.toLowerCase());
		return { notice: applied?.applicable ? "discount_applied" : "discount_not_applicable", cart: next };
	}

	return { notice: "cart_updated", cart };
}

/** Read the add fields from a posted form: option.<Name> fields become `options`. */
export function cartInputFromForm(form: FormData | null): CartInput {
	const field = (k: string) => String(form?.get(k) ?? "").trim();
	const options: Record<string, string> = {};
	form?.forEach((value, key) => {
		if (key.startsWith("option.") && typeof value === "string") options[key.slice(7)] = value;
	});
	return {
		action: field("action"),
		product: field("product"),
		variant: field("variant"),
		options,
		sellingPlan: form?.has("selling_plan") ? field("selling_plan") : null,
		quantity: field("quantity") || "1",
		line: field("line"),
		code: field("code"),
	};
}
