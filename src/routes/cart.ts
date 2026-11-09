/**
 * GET /_emdash/api/auth/redeemid/cart?return=/path
 *
 * Sends the visitor to their Shopify cart's checkout, signed in for members
 * (see checkout.ts). With no cart, or one
 * Shopify has closed (its checkout completed), they go back with the
 * `cart_empty` notice and the stored cart is cleared.
 */

import type { APIRoute } from "astro";

import { safeReturn } from "../access.js";
import { readCart, saveCart } from "../cart.js";
import { readConfig, storeDomain } from "../config.js";
import { checkoutFor } from "../checkout.js";
import { getCart } from "../storefront.js";
import { fail } from "./shared.js";

export const prerender = false;

export const GET: APIRoute = async ({ request, locals, session, redirect }) => {
	const returnTo = safeReturn(new URL(request.url).searchParams.get("return"));
	const config = readConfig((locals as { emdash?: { config?: unknown } }).emdash?.config);
	if (!config || !storeDomain(config)) return fail(redirect, returnTo, "not_configured");

	const ref = await readCart(session);
	if (!ref) return fail(redirect, returnTo, "cart_empty");
	try {
		const cart = await getCart(config, ref.id, { buyerIp: request.headers.get("cf-connecting-ip") });
		if (!cart || cart.totalQuantity < 1) {
			saveCart(session, null);
			return fail(redirect, returnTo, "cart_empty");
		}
		saveCart(session, { id: cart.id, count: cart.totalQuantity });
		return redirect(await checkoutFor(config, cart, { session, request, emdashConfig: (locals as { emdash?: { config?: unknown } }).emdash?.config }), 303);
	} catch {
		return fail(redirect, returnTo, "checkout_failed");
	}
};
