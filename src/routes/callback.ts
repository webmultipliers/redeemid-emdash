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
import type { Kysely } from "kysely";

import { env, ENV, PROVIDER_ID, storeDomain } from "../config.js";
import { siteConfig } from "../site-config.js";
import { emit, levelChange } from "../events.js";
import { record } from "../log.js";
import { levelsFor } from "../access.js";
import { discover, exchangeCode, identity, logoutUrl, ShopifyError, verifyIdToken, type Discovery } from "../shopify.js";
import { emptyMember, stampTags, stores } from "../storage.js";
import { adminConfigured, resync } from "../admin-api.js";
import { seal } from "../token-vault.js";
import { getPublicOrigin, OptionsRepository } from "emdash/api/route-utils";

import { afterLogoutCookie, callbackUrl, fail, FLOW_TTL_MS, SESSION_FLOW, SESSION_CUSTOMER_TOKEN, SESSION_ID_TOKEN, type CustomerToken, type Flow } from "./shared.js";

export const prerender = false;

export const GET: APIRoute = async ({ request, locals, session, redirect }) => {
	const url = new URL(request.url);
	const emdash = (locals as { emdash?: { db?: unknown; config?: unknown } }).emdash;
	const flow = (await session?.get(SESSION_FLOW)) as Flow | undefined;
	session?.delete(SESSION_FLOW);
	const returnTo = flow?.returnTo ?? "/";

	const config = await siteConfig(locals);
	const clientId = env(ENV.clientId);
	if (!config || !storeDomain(config) || !clientId || !emdash?.db || !session) return fail(redirect, returnTo, "not_configured");

	if (url.searchParams.get("error")) {
		// Refresh found no open store session: sign in as usual.
		if (flow?.refresh) return redirect(`/_emdash/api/auth/redeemid/login?return=${encodeURIComponent(returnTo)}`);
		await refused("sign_in_cancelled", "ok");
		return fail(redirect, returnTo, "sign_in_cancelled");
	}

	const state = url.searchParams.get("state");
	const code = url.searchParams.get("code");
	if (!flow || !state || state !== flow.state || !code || Date.now() - flow.at > FLOW_TTL_MS) {
		// A request with no sign-in behind it (a crawler, a probe) isn't worth an entry.
		if (flow) await refused("sign_in_expired", "warn");
		return fail(redirect, returnTo, "sign_in_expired");
	}

	try {
		const options = new OptionsRepository(emdash.db as ConstructorParameters<typeof OptionsRepository>[0]);
		const setup = await options.get("emdash:setup_complete");
		// Never let a customer become the first (admin) user.
		if (setup !== true && setup !== "true") {
			await refused("site_not_ready", "warn");
			return fail(redirect, returnTo, "site_not_ready");
		}

		const d = await discover(config);
		const tokens = await exchangeCode(d, {
			clientId,
			clientSecret: env(ENV.clientSecret),
			redirectUri: callbackUrl(url, emdash.config),
			origin: new URL(callbackUrl(url, emdash.config)).origin,
			code,
			verifier: flow.verifier,
		});
		const claims = await verifyIdToken(d, tokens.idToken, { clientId, nonce: flow.nonce });
		// Refusals from here on also end the store session, so the next Sign in
		// asks for an email again instead of reusing this account.
		const who = await identity(d, tokens.accessToken);
		const refuse = async (code: string) => {
			await refused(code, "warn", who.customerId);
			return signedOut(d, tokens.idToken, url, emdash.config, returnTo, code) ?? fail(redirect, returnTo, code);
		};

		const email = (typeof claims.email === "string" ? claims.email : who.email)?.toLowerCase() ?? null;
		if (!email) return refuse("email_required");
		const emailVerified = claims.email_verified === true;

		const adapter = createKyselyAdapter(emdash.db as Kysely<AuthTables>);

		// Staff accounts never sign in through the store, even with the same email.
		const linked = await adapter.getOAuthAccount(PROVIDER_ID, who.customerId);
		const existing = linked ? await adapter.getUserById(linked.userId) : await adapter.getUserByEmail(email);
		if (existing && existing.role > Role.SUBSCRIBER) return refuse("staff_account");

		const name = [who.firstName, who.lastName].filter(Boolean).join(" ") || null;
		const user = await findOrCreateOAuthUser(
			adapter,
			PROVIDER_ID,
			{ id: who.customerId, email, name, avatarUrl: null, emailVerified },
			async () => ({ allowed: true, role: Role.SUBSCRIBER }),
			{ requireVerifiedEmail: true },
		);
		if (user.disabled) return refuse("account_disabled");
		if (user.role > Role.SUBSCRIBER) return refuse("staff_account");

		const s = stores(emdash.db);
		const found = await s.members.get(who.customerId);
		const member = found ?? emptyMember(who.customerId);
		const now = new Date().toISOString();
		await s.members.put(
			who.customerId,
			stampTags(
				{
					...member,
					userId: user.id,
					email,
					firstName: who.firstName,
					lastName: who.lastName,
					tags: who.tags,
					syncedAt: now,
					source: "sign-in",
					linkedAt: member.linkedAt ?? now,
					emailVerified,
				},
				now,
			),
		);
		// With the Admin API app, signing in is a full sync: the membership
		// dates and marketing consent too. A failure never blocks sign-in.
		if (adminConfigured()) {
			await resync(config, s, [who.customerId], "sign-in").catch(async (e: Error) => {
				await record({ event: "staff.resync", label: "sign-in", status: "error", level: "warn", origin: "member", customerId: who.customerId, note: String(e.message).slice(0, 200) });
			});
		}

		const levels = levelsFor(who.tags, config.levels);
		await record({ event: "member.signed_in", label: flow.refresh ? "refresh" : member.linkedAt ? "sign-in" : "first sign-in", status: "ok", origin: "member", customerId: who.customerId });
		await emit(config, "member.signed_in", { customerId: who.customerId, levels, first: !member.linkedAt, refresh: Boolean(flow.refresh) });
		await levelChange(config, found ? found.tags : null, { customerId: who.customerId, tags: who.tags, status: member.status }, "sign-in");

		// A new session id for the signed-in session (it keeps the data so far).
		await session.regenerate?.();
		session.set("user", { id: user.id });
		session.set(SESSION_ID_TOKEN, tokens.idToken);
		// Kept only for signed-in checkout, and sealed (see token-vault.ts).
		if (config.checkout?.signIn !== false) {
			const sealed = await seal({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken ?? null, expiresAt: tokens.expiresAt ?? null } satisfies CustomerToken, emdash.db).catch(() => null);
			if (sealed) session.set(SESSION_CUSTOMER_TOKEN, sealed);
			else session.delete?.(SESSION_CUSTOMER_TOKEN);
		} else session.delete?.(SESSION_CUSTOMER_TOKEN);
		return flow.refresh ? fail(redirect, returnTo, "refreshed") : redirect(returnTo);
	} catch (e) {
		const code = e instanceof ShopifyError ? e.code : e instanceof OAuthError ? "signup_not_allowed" : "sign_in_failed";
		console.error("[redeemid] sign-in failed:", (e as Error).message);
		await refused(code, "error", null, String((e as Error).message).slice(0, 200));
		return fail(redirect, returnTo, code);
	}
};

/** A sign-in that didn't finish, for App events: the reason code, never the email. */
function refused(code: string, level: "ok" | "warn" | "error", customerId: string | null = null, note?: string): Promise<void> {
	return record({ event: "member.refused", label: code, status: "refused", level, origin: "member", customerId, ...(note ? { note } : {}) });
}

/** Ends the store session, then shows `code` on `returnTo` (see AFTER_LOGOUT_COOKIE). */
function signedOut(d: Discovery, idToken: string, url: URL, emdashConfig: unknown, returnTo: string, code: string): Response | null {
	const origin = getPublicOrigin(url, emdashConfig as Parameters<typeof getPublicOrigin>[1]);
	const to = logoutUrl(d, idToken, `${origin}/`);
	if (!to) return null;
	return new Response(null, { status: 302, headers: { location: to, "set-cookie": afterLogoutCookie(code, returnTo), "cache-control": "private, no-store" } });
}
