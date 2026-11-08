/**
 * GET /_emdash/api/auth/redeemid/callback
 *
 * Finishes Shopify customer account sign-in: checks state, exchanges the code,
 * verifies the ID token, reads the customer, links or creates an EmDash
 * Subscriber, mirrors the customer and starts the session.
 *
 * Refused: staff accounts (any role above Subscriber), disabled users, sites
 * whose setup is not finished, and customers without a verified email.
 */

import { findOrCreateOAuthUser, OAuthError, Role } from "@emdash-cms/auth";
import { createKyselyAdapter, type AuthTables } from "@emdash-cms/auth/adapters/kysely";
import type { APIRoute } from "astro";
import { OptionsRepository } from "emdash/api/route-utils";
import type { Kysely } from "kysely";

import { env, ENV, PROVIDER_ID, readConfig } from "../config.js";
import { discover, exchangeCode, identity, ShopifyError, verifyIdToken } from "../shopify.js";
import { emptyMember, stores } from "../storage.js";
import { callbackUrl, fail, FLOW_TTL_MS, SESSION_FLOW, SESSION_ID_TOKEN, type Flow } from "./shared.js";

export const prerender = false;

export const GET: APIRoute = async ({ request, locals, session, redirect }) => {
	const url = new URL(request.url);
	const emdash = (locals as { emdash?: { db?: unknown; config?: unknown } }).emdash;
	const flow = (await session?.get(SESSION_FLOW)) as Flow | undefined;
	session?.delete(SESSION_FLOW);
	const returnTo = flow?.returnTo ?? "/";

	const config = readConfig(emdash?.config);
	const clientId = env(ENV.clientId);
	if (!config || !clientId || !emdash?.db || !session) return fail(redirect, returnTo, "not_configured");

	if (url.searchParams.get("error")) return fail(redirect, returnTo, "sign_in_cancelled");

	const state = url.searchParams.get("state");
	const code = url.searchParams.get("code");
	if (!flow || !state || state !== flow.state || !code || Date.now() - flow.at > FLOW_TTL_MS) {
		return fail(redirect, returnTo, "sign_in_expired");
	}

	try {
		const options = new OptionsRepository(emdash.db as ConstructorParameters<typeof OptionsRepository>[0]);
		const setup = await options.get("emdash:setup_complete");
		// Never let a customer become the first (admin) user.
		if (setup !== true && setup !== "true") return fail(redirect, returnTo, "site_not_ready");

		const d = await discover(config);
		const tokens = await exchangeCode(d, {
			clientId,
			clientSecret: env(ENV.clientSecret),
			redirectUri: callbackUrl(url, emdash.config),
			code,
			verifier: flow.verifier,
		});
		const claims = await verifyIdToken(d, tokens.idToken, { clientId, nonce: flow.nonce });
		const who = await identity(d, tokens.accessToken);

		const email = (typeof claims.email === "string" ? claims.email : who.email)?.toLowerCase() ?? null;
		if (!email) return fail(redirect, returnTo, "email_required");
		const emailVerified = claims.email_verified === true;

		const adapter = createKyselyAdapter(emdash.db as Kysely<AuthTables>);

		// Staff accounts never sign in through the store, even with the same email.
		const linked = await adapter.getOAuthAccount(PROVIDER_ID, who.customerId);
		const existing = linked ? await adapter.getUserById(linked.userId) : await adapter.getUserByEmail(email);
		if (existing && existing.role > Role.SUBSCRIBER) return fail(redirect, returnTo, "staff_account");

		const name = [who.firstName, who.lastName].filter(Boolean).join(" ") || null;
		const user = await findOrCreateOAuthUser(
			adapter,
			PROVIDER_ID,
			{ id: who.customerId, email, name, avatarUrl: null, emailVerified },
			async () => ({ allowed: true, role: Role.SUBSCRIBER }),
			{ requireVerifiedEmail: true },
		);
		if (user.disabled) return fail(redirect, returnTo, "account_disabled");
		if (user.role > Role.SUBSCRIBER) return fail(redirect, returnTo, "staff_account");

		const s = stores(emdash.db);
		const member = (await s.members.get(who.customerId)) ?? emptyMember(who.customerId);
		await s.members.put(who.customerId, {
			...member,
			userId: user.id,
			email,
			firstName: who.firstName,
			lastName: who.lastName,
			tags: who.tags,
			syncedAt: new Date().toISOString(),
			source: "sign-in",
		});

		session.regenerate?.();
		session.set("user", { id: user.id });
		session.set(SESSION_ID_TOKEN, tokens.idToken);
		return redirect(returnTo);
	} catch (e) {
		const code = e instanceof ShopifyError ? e.code : e instanceof OAuthError ? "signup_not_allowed" : "sign_in_failed";
		console.error("[redeemid] sign-in failed:", (e as Error).message);
		return fail(redirect, returnTo, code);
	}
};
