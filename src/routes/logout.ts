/**
 * POST /_emdash/api/auth/redeemid/logout?return=/path
 *
 * Ends the site session, then the Shopify customer session when the store
 * publishes an end-session endpoint. POST only, so a link elsewhere can't
 * sign members out.
 */

import type { APIRoute } from "astro";
import { getPublicOrigin } from "emdash/api/route-utils";

import { safeReturn } from "../access.js";
import { readConfig } from "../config.js";
import { discover, logoutUrl } from "../shopify.js";
import { SESSION_ID_TOKEN } from "./shared.js";

export const prerender = false;

export const POST: APIRoute = async ({ request, locals, session, redirect }) => {
	const url = new URL(request.url);
	const returnTo = safeReturn(url.searchParams.get("return"));
	const emdash = (locals as { emdash?: { config?: unknown } }).emdash;
	const idToken = (await session?.get(SESSION_ID_TOKEN)) as string | undefined;
	session?.destroy();

	const config = readConfig(emdash?.config);
	if (config && idToken) {
		try {
			const origin = getPublicOrigin(url, emdash?.config as Parameters<typeof getPublicOrigin>[1]);
			const to = logoutUrl(await discover(config), idToken, `${origin}${returnTo}`);
			if (to) return redirect(to);
		} catch {
			// The site session is already gone; Shopify's ends on its own.
		}
	}
	return redirect(returnTo);
};
