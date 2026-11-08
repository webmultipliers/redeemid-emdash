/**
 * POST /_emdash/api/auth/redeemid/buy: start a Shopify checkout for one plan.
 *
 * Takes a product handle, looks its variant up again on Shopify (never
 * trusting a posted variant or price) and sends the buyer to checkout. A
 * signed-in member's email is passed along so the order lands on the same
 * customer. Tags, and so access, still only change when Shopify says so.
 */

import type { APIRoute } from "astro";

import { readConfig, storeDomain } from "../config.js";
import { safeReturn } from "../access.js";
import { memberForUser, stores } from "../storage.js";
import { checkoutUrl, plan } from "../storefront.js";
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
		const to = await checkoutUrl(
			config,
			{ variantId: p.variantId, sellingPlanId: p.sellingPlanId },
			{ email: member?.email ?? null, buyerIp: request.headers.get("cf-connecting-ip") },
		);
		return redirect(to, 303);
	} catch {
		return fail(redirect, returnTo, "checkout_failed");
	}
};
