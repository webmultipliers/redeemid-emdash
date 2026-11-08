/**
 * GET /_emdash/api/auth/redeemid/account
 *
 * Sends a member to their Shopify customer account (orders, profile,
 * addresses), on the store's own account domain. Visitors who aren't
 * signed in go through sign-in first; Shopify would ask them anyway.
 */

import type { APIRoute } from "astro";

import { safeReturn, signInUrl } from "../access.js";
import { readConfig, storeDomain } from "../config.js";
import { discover } from "../shopify.js";
import { fail } from "./shared.js";

export const prerender = false;

export const GET: APIRoute = async ({ request, locals, session, redirect }) => {
	const returnTo = safeReturn(new URL(request.url).searchParams.get("return"));
	const config = readConfig((locals as { emdash?: { config?: unknown } }).emdash?.config);
	if (!config || !storeDomain(config)) return fail(redirect, returnTo, "not_configured");

	const user = (await session?.get("user")) as { id?: string } | undefined;
	if (!user?.id) return redirect(signInUrl(returnTo));
	try {
		const d = await discover(config);
		return redirect(new URL("/", d.authorizationEndpoint).href);
	} catch {
		return fail(redirect, returnTo, "account_unavailable");
	}
};
