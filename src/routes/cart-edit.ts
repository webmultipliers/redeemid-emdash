/**
 * POST /_emdash/api/auth/redeemid/cart-edit: change the visitor's Shopify cart.
 *
 * Fields: `action` (add | update | remove | discount), `return`, and
 * - add: `product` (handle), optional `variant` (must be one of that
 *   product's variants, read again from Shopify), `quantity` (1 to 1000),
 *   `then` = "checkout" to go straight to checkout;
 * - update: `line` and `quantity` (0 removes the line);
 * - remove: `line`;
 * - discount: `code` (empty clears the codes).
 *
 * Prices, discounts and availability come from Shopify; nothing posted is
 * trusted beyond the ids it names. Back to `return` with a notice:
 * cart_added, cart_updated, discount_applied, discount_not_applicable,
 * plan_unavailable, cart_empty or checkout_failed.
 */

import type { APIRoute } from "astro";

import { safeReturn } from "../access.js";
import { readCart, saveCart } from "../cart.js";
import { readConfig, storeDomain } from "../config.js";
import { memberForUser, stores } from "../storage.js";
import { addToCart, cartDetails, product, removeLines, setDiscountCodes, updateLines } from "../storefront.js";
import { fail } from "./shared.js";

export const prerender = false;

const MAX_QUANTITY = 1000;

export const POST: APIRoute = async ({ request, locals, session, redirect }) => {
	const form = await request.formData().catch(() => null);
	const field = (k: string) => String(form?.get(k) ?? "").trim();
	const returnTo = safeReturn(field("return") || "/");
	const emdash = (locals as { emdash?: { config?: unknown; db?: unknown } }).emdash;
	const config = readConfig(emdash?.config);
	if (!config || !storeDomain(config)) return fail(redirect, returnTo, "not_configured");
	const buyerIp = request.headers.get("cf-connecting-ip");
	const action = field("action");

	try {
		if (action === "add") {
			const handle = field("product");
			const quantity = Number.parseInt(field("quantity") || "1", 10);
			if (!/^[a-z0-9][a-z0-9-]*$/i.test(handle) || !Number.isFinite(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
				return fail(redirect, returnTo, "plan_unavailable");
			}
			const p = await product(config, handle);
			const wanted = field("variant");
			const variant = wanted ? p?.variants.find((v) => v.id === wanted) : p?.variants.find((v) => v.availableForSale);
			if (!p || !variant?.availableForSale) return fail(redirect, returnTo, "plan_unavailable");
			const user = (await session?.get("user")) as { id?: string } | undefined;
			const member = user?.id && emdash?.db ? await memberForUser(stores(emdash.db), user.id) : null;
			const current = await readCart(session);
			const cart = await addToCart(
				config,
				current?.id ?? null,
				{ variantId: variant.id, sellingPlanId: p.sellingPlanId, quantity },
				{ email: member?.email ?? null, attributes: { _redeemid_page: returnTo }, buyerIp },
			);
			saveCart(session, { id: cart.id, count: cart.totalQuantity });
			return field("then") === "checkout" ? redirect(cart.checkoutUrl, 303) : fail(redirect, returnTo, "cart_added");
		}

		const ref = await readCart(session);
		if (!ref) return fail(redirect, returnTo, "cart_empty");
		const cart = await cartDetails(config, ref.id, { buyerIp });
		if (!cart) {
			saveCart(session, null);
			return fail(redirect, returnTo, "cart_empty");
		}
		const line = field("line");
		const owns = cart.lines.some((l) => l.id === line);

		if (action === "update" || action === "remove") {
			if (!owns) return fail(redirect, returnTo, "cart_updated");
			const quantity = action === "remove" ? 0 : Number.parseInt(field("quantity"), 10);
			if (!Number.isFinite(quantity) || quantity < 0 || quantity > MAX_QUANTITY) return fail(redirect, returnTo, "cart_updated");
			const next = quantity === 0 ? await removeLines(config, cart.id, [line], { buyerIp }) : await updateLines(config, cart.id, [{ id: line, quantity }], { buyerIp });
			saveCart(session, { id: next.id, count: next.totalQuantity });
			return fail(redirect, returnTo, "cart_updated");
		}

		if (action === "discount") {
			const code = field("code").slice(0, 100);
			const next = await setDiscountCodes(config, cart.id, code ? [code] : [], { buyerIp });
			saveCart(session, { id: next.id, count: next.totalQuantity });
			if (!code) return fail(redirect, returnTo, "cart_updated");
			const applied = next.discountCodes.find((d) => d.code.toLowerCase() === code.toLowerCase());
			return fail(redirect, returnTo, applied?.applicable ? "discount_applied" : "discount_not_applicable");
		}

		return fail(redirect, returnTo, "cart_updated");
	} catch {
		return fail(redirect, returnTo, "checkout_failed");
	}
};
