/**
 * RedeemID for EmDash.
 *
 * Shopify runs the store and the customer account; EmDash runs the content.
 * Add to astro.config.mjs:
 *
 *   integrations: [
 *     emdash({ authProviders: [redeemid({ ... })] }),
 *     redeemidGuard(),
 *   ]
 *
 * In full:
 *
 *   emdash({
 *     authProviders: [
 *       redeemid({
 *         shop: "my-store.myshopify.com",
 *         levels: [{ slug: "member", name: "Member", tags: ["member"] }],
 *         rules: [{ collection: "posts", taxonomy: "category", term: "members", levels: ["member"] }],
 *       }),
 *     ],
 *   })
 *
 * Secrets come from the environment: REDEEMID_CLIENT_ID and
 * REDEEMID_CLIENT_SECRET (Headless customer account client) and
 * REDEEMID_WEBHOOK_SECRET (the app's client secret that signs webhooks).
 */

import type { AstroIntegration } from "astro";
import type { AuthProviderDescriptor } from "emdash";

import { PROVIDER_ID, type RedeemIDConfig } from "./config.js";
import { STORAGE_CONFIG } from "./storage.js";

export type { LevelConfig, RedeemIDConfig, RuleConfig } from "./config.js";
export type { MemberRecord } from "./storage.js";
// Page-time helpers live in "@redeemid/emdash/access": they read the site's
// build-time config module, which astro.config.mjs can't load.

const BASE = "/_emdash/api/auth/redeemid";

export function redeemid(config: RedeemIDConfig): AuthProviderDescriptor {
	if (!config?.shop) throw new Error("RedeemID: set `shop` to the store's domain.");
	return {
		id: PROVIDER_ID,
		label: config.label ?? "Sign in",
		config,
		// No adminEntry: members sign in from the site, not the EmDash login page.
		routes: [
			{ pattern: `${BASE}/login`, entrypoint: "@redeemid/emdash/routes/login.ts" },
			{ pattern: `${BASE}/callback`, entrypoint: "@redeemid/emdash/routes/callback.ts" },
			{ pattern: `${BASE}/logout`, entrypoint: "@redeemid/emdash/routes/logout.ts" },
			{ pattern: `${BASE}/webhook`, entrypoint: "@redeemid/emdash/routes/webhook.ts" },
		],
		publicRoutes: [`${BASE}/`],
		storage: STORAGE_CONFIG,
	};
}

/**
 * Astro integration that keeps members (EmDash Subscribers) out of EmDash's
 * content API and admin, so only RedeemID's checks decide who reads what.
 */
export function redeemidGuard(): AstroIntegration {
	return {
		name: "@redeemid/emdash/guard",
		hooks: {
			"astro:config:setup": ({ addMiddleware }) => {
				addMiddleware({ entrypoint: "@redeemid/emdash/guard.ts", order: "post" });
			},
		},
	};
}

export default redeemid;
