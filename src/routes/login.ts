/**
 * GET /_emdash/api/auth/redeemid/login?return=/path
 *
 * Starts Shopify customer account sign-in (authorization code + PKCE).
 * With `refresh=1` it asks the store not to show a form (`prompt=none`):
 * a member whose store session is still open comes straight back with their
 * tags read again; anyone else is sent through the usual sign-in.
 */

import type { APIRoute } from "astro";

import { safeReturn } from "../access.js";
import { env, ENV, readConfig, storeDomain } from "../config.js";
import { authorizeUrl, challengeFor, discover, randomToken } from "../shopify.js";
import { callbackUrl, fail, SESSION_FLOW, type Flow } from "./shared.js";

export const prerender = false;

export const GET: APIRoute = async ({ request, locals, session, redirect }) => {
	const url = new URL(request.url);
	const returnTo = safeReturn(url.searchParams.get("return"));
	const refresh = url.searchParams.get("refresh") === "1";
	const emdash = (locals as { emdash?: { config?: unknown } }).emdash;
	const config = readConfig(emdash?.config);
	const clientId = env(ENV.clientId);

	if (!config || !storeDomain(config) || !clientId || !session) return fail(redirect, returnTo, "not_configured");

	try {
		const d = await discover(config);
		const flow: Flow = {
			state: randomToken(),
			nonce: randomToken(),
			verifier: randomToken(48),
			returnTo,
			at: Date.now(),
			...(refresh ? { refresh: true } : {}),
		};
		session.set(SESSION_FLOW, flow);
		return redirect(
			authorizeUrl(d, {
				clientId,
				redirectUri: callbackUrl(url, emdash?.config),
				state: flow.state,
				nonce: flow.nonce,
				challenge: await challengeFor(flow.verifier),
				locale: request.headers.get("accept-language")?.split(",")[0]?.trim(),
				...(refresh ? { prompt: "none" as const } : {}),
			}),
		);
	} catch (e) {
		console.error("[redeemid] sign-in start failed:", (e as Error).message);
		return fail(redirect, returnTo, "sign_in_unavailable");
	}
};
