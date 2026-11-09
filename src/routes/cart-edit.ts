/**
 * POST /_emdash/api/auth/redeemid/cart-edit: change the visitor's Shopify cart.
 *
 * Fields: `action` (add | update | remove | discount), `return`, and
 * - add: `product` (handle); the variant by `variant` (an id of that
 *   product's, read again from Shopify) or by one `option.<Name>` field per
 *   option (e.g. option.Size=M); `selling_plan` (one of the product's
 *   selling plans, or empty for one-time); `quantity` (1 to 1000);
 *   `then` = "checkout" to go straight to checkout;
 * - update: `line` and `quantity` (0 removes the line);
 * - remove: `line`;
 * - discount: `code` (empty clears the codes).
 *
 * Back to `return` with a notice: cart_added, cart_updated,
 * discount_applied, discount_not_applicable, plan_unavailable, cart_empty or
 * checkout_failed. The JSON twin is api/cart.
 */

import type { APIRoute } from "astro";

import { safeReturn } from "../access.js";
import { cartInputFromForm, editCart } from "../cart-ops.js";
import { checkoutFor } from "../checkout.js";
import { readConfig, storeDomain } from "../config.js";
import { fail } from "./shared.js";

export const prerender = false;

export const POST: APIRoute = async ({ request, locals, session, redirect }) => {
	const form = await request.formData().catch(() => null);
	const returnTo = safeReturn(String(form?.get("return") ?? "").trim() || "/");
	const emdash = (locals as { emdash?: { config?: unknown; db?: unknown } }).emdash;
	const config = readConfig(emdash?.config);
	if (!config || !storeDomain(config)) return fail(redirect, returnTo, "not_configured");

	try {
		const input = { ...cartInputFromForm(form), page: returnTo };
		const out = await editCart(input, { config, session, request, db: emdash?.db });
		if (out.base && String(form?.get("then") ?? "") === "checkout") {
			return redirect(await checkoutFor(config, out.base, { session, request, emdashConfig: emdash?.config }), 303);
		}
		return fail(redirect, returnTo, out.notice);
	} catch {
		return fail(redirect, returnTo, "checkout_failed");
	}
};
