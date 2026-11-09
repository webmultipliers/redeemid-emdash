/**
 * POST /_emdash/api/auth/redeemid/buy: add a plan to the cart and check out.
 *
 * Takes a product handle, looks its variant up again on Shopify (never
 * trusting a posted variant or price), adds it to the visitor's Shopify
 * cart and sends them to that cart's checkout. A
 * signed-in member's email is passed along so the order lands on the same
 * customer. Tags, and so access, still only change when Shopify says so.
 */

import type { APIRoute } from "astro";

import { readConfig, storeDomain } from "../config.js";
import { safeReturn } from "../access.js";
import { memberForUser, stores } from "../storage.js";
import { saveCart, readCart } from "../cart.js";
import { checkoutFor } from "../checkout.js";
import { addToCart, plan, storeContext } from "../storefront.js";
import { fail } from "./shared.js";

export const prerender = false;

export const POST: APIRoute = async ({ request, locals, session, redirect }) => {
	const form = await request.formData().catch(() => null);
	const returnTo = safeReturn(String(form?.get("return") ?? "/"));
	const handle = String(form?.get("plan") ?? "").trim();
	const emdash = (locals as { emdash?: { config?: unknown; db?: unknown } }).emdash;
	const config = readConfig(emdash?.config);
	if (!config || !storeDomain(config)) return fail(redirect, returnTo, "not_configured");
	if (!/^[a-z0-9][a-z0-9-]*$/i.test(handle)) return fail(redirect, returnTo, "plan_unavailable");

	try {
		const p = await plan(config, handle);
		if (!p?.variantId || !p.availableForSale) return fail(redirect, returnTo, "plan_unavailable");
		// Provider routes are public, so read the member from the session.
		const user = (await session?.get("user")) as { id?: string } | undefined;
		const member = user?.id && emdash?.db ? await memberForUser(stores(emdash.db), user.id) : null;
		const current = await readCart(session);
		const cart = await addToCart(
			config,
			current?.id ?? null,
			{ variantId: p.variantId, sellingPlanId: p.sellingPlanId },
			{ email: member?.email ?? null, attributes: { _redeemid_page: returnTo }, buyerIp: request.headers.get("cf-connecting-ip"), context: storeContext(config, request) },
		);
		saveCart(session, { id: cart.id, count: cart.totalQuantity });
		return redirect(await checkoutFor(config, cart, { session, request, emdashConfig: emdash?.config }), 303);
	} catch {
		return fail(redirect, returnTo, "checkout_failed");
	}
};
