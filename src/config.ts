/**
 * RedeemID configuration.
 *
 * Levels and rules can be set in code (astro.config.mjs) as the site's
 * defaults, and changed in the admin (Plugins → RedeemID → Access), which
 * wins for each setting it saves (see settings.ts). Secrets come from the
 * environment and never from config.
 */

import type { EntryRule } from "./settings.js";

/** A member level, held by Shopify customers with its tags. */
export interface LevelConfig {
	/** Stable slug, used in rules (e.g. "member"). */
	slug: string;
	/** Name shown to members. */
	name: string;
	/** Shopify customer tags that grant this level. Matched case-insensitively. */
	tags: string[];
	/** "any" (default): one of the tags is enough. "all": every tag is needed. */
	match?: "any" | "all";
	/** What the wall says to readers this level would let in, e.g. "Gold members read every investigation." */
	wall?: string;
	/** Where the wall's join link goes for this level. Falls back to `join.href`. */
	joinUrl?: string;
}

/**
 * Who may read entries:
 *
 * - A rule with `taxonomy` and `term` covers entries that carry that term, or
 *   a child of it in a hierarchical taxonomy (a child's own rule wins over its
 *   parent's). With `collection: "*"` it covers that term in every
 *   collection; a rule for the same term and a named collection wins there.
 * - A rule with neither covers the whole collection.
 * - `collection: "*"` with neither is the site default, for collections with
 *   no rule.
 *
 * Term rules beat the collection rule, which beats the site default. When
 * several term rules cover one entry, a reader must pass every one of them
 * (most restrictive), unless `combine` is "any".
 */
export interface RuleConfig {
	/** Collection slug, or "*" for the site default. */
	collection: string;
	/** Taxonomy slug, e.g. "category". Requires `term`. */
	taxonomy?: string;
	/** Term slug, e.g. "premium". */
	term?: string;
	/** Level slugs, any of which may read. An empty list means any signed-in member. */
	levels: string[];
	/**
	 * Opens the entries to everyone: a term rule whatever else covers them, a
	 * collection rule or the site default unless a term rule locks them.
	 * `levels` is ignored.
	 */
	open?: boolean;
	/**
	 * Drip: readers who pass the rule may read its entries only once they have
	 * been members this many days (from when they first held a level they
	 * hold now, or else when they first signed in).
	 */
	drip?: number;
	/** `false`: the meter never opens this rule's entries. */
	meter?: false;
}

/**
 * The meter: signed-in readers without access may open a few locked entries
 * free each month (or week). Guests get the wall; an entry counts once per
 * period, when its own page renders through <Content> with an `id`.
 */
/** A perk members hold through any of its levels or Shopify tags. */
export interface FeatureConfig {
	slug: string;
	name: string;
	levels?: string[];
	tags?: string[];
}

/** Where to send signed member events (see events.ts). The signing secret is REDEEMID_EVENTS_SECRET. */
/** A media folder whose files only some readers may download. Any of the given ways in is enough. */
export interface FileRule {
	/** The media folder's name in the EmDash media library. */
	folder: string;
	/** Members holding any of these levels. An empty list means any signed-in member. */
	levels?: string[];
	/** Members holding any of these features. */
	features?: string[];
	/** Whoever can read a published entry that uses the file (its rule, drip and the levels picked in its body). */
	entries?: boolean;
}

export interface PreferenceConfig {
	/** "namespace.key" of a customer metafield definition. */
	key: string;
	/** "edit" (default): members can change it. "view": members only see it. */
	access?: "view" | "edit";
}

export interface EventsConfig {
	url: string;
	/** Send only these events. All of them when left out. */
	only?: Array<"member.signed_in" | "member.levels_changed" | "meter.used" | "meter.exhausted" | "preferences.saved" | "member.erased">;
}

export interface MeterConfig {
	/** Free entries per period. */
	limit: number;
	period?: "month" | "week";
	/** Collections the meter covers. All of them when left out. */
	collections?: string[];
}

export interface RedeemIDConfig {
	/**
	 * The store's myshopify.com domain (a custom storefront or customer-account
	 * domain works too). Discovery is read from https://<shop>/.well-known/.
	 * Leave it out to read REDEEMID_SHOPIFY_STORE_DOMAIN at request time.
	 */
	shop?: string;
	/** Sign-in button label. Members never see "Shopify". */
	label?: string;
	levels?: LevelConfig[];
	rules?: RuleConfig[];
	meter?: MeterConfig;
	features?: FeatureConfig[];
	events?: EventsConfig;
	/**
	 * Customer metafields members may see or change, in this order, by
	 * "namespace.key". Define them in Shopify (Settings → Custom data →
	 * Customers). Needs the Admin API app (staff tools) for reading and saving.
	 */
	preferences?: PreferenceConfig[];
	/**
	 * AI agents (EmDash's MCP server) and the command line. Read-only tools are
	 * always declared; `actions: true` also offers resync and tag edits.
	 */
	agents?: { actions?: boolean };
	/** Protected files, by media folder. See FileRule. */
	files?: FileRule[];
	/**
	 * Replacement text, by each string's original English, e.g.
	 * { "Sign in": "Log in" }. One string at a time; see text.ts for the list.
	 */
	text?: Record<string, string>;
	/**
	 * Local prices and currency through Shopify Markets: `country` is a fixed
	 * two-letter code, or "visitor" for the country Cloudflare reports for
	 * each request (CF-IPCountry). `language` is a Shopify language code such
	 * as "FR". Prices are always Shopify's; leave this out for the store's
	 * default market.
	 */
	market?: { country?: string; language?: string };
	/**
	 * Checkout. `signIn: false` stops RedeemID passing a signed-in member's
	 * store sign-in to the cart, so they check out as a guest (their email is
	 * still filled in).
	 */
	checkout?: { signIn?: false };
	/** The wall's join link: where readers become members, e.g. { href: "/join/", label: "Become a member" }. */
	join?: { href: string; label?: string };
	/**
	 * How several term rules on one entry combine: "all" (default, the most
	 * restrictive: pass every rule) or "any" (pass one of them).
	 */
	combine?: "all" | "any";
	/**
	 * Teaser length in words, per collection, for locked entries with no paywall
	 * break: readers who can't read on see this many words of the body. Without
	 * one they see none of it.
	 */
	teaser?: Record<string, number>;
	/**
	 * Google's paywalled-content markup (isAccessibleForFree false, pointing at
	 * the wall) on the page of each locked entry, printed by <Content> when it
	 * gets `id`. Set false when an SEO plugin already adds it.
	 */
	schema?: false;
	/**
	 * Extra /_emdash path prefixes signed-in members may use. Everything else
	 * under /_emdash is refused to Subscribers (see guard.ts).
	 */
	memberPaths?: string[];
	/**
	 * Entries' own rules by "collection:id" (or "collection:slug"). Usually set
	 * in the editor's Access panel rather than here.
	 */
	entries?: Record<string, EntryRule>;
	/**
	 * Set by RedeemID, never in astro.config.mjs: the settings saved in the
	 * admin couldn't be read and none were read before, so every entry is
	 * locked until they can be (see lockdown in settings.ts).
	 */
	unavailable?: boolean;
	/**
	 * Only for local tests: lets `shop` be a full http:// origin of a fake store.
	 * Never set this on a live site.
	 */
	allowInsecureShop?: boolean;
}

export const PROVIDER_ID = "redeemid";

/**
 * Environment variable names. Values are read at request time, so on Workers
 * they can be secrets.
 */
export const ENV = {
	/** The store's myshopify.com domain, when `shop` isn't set in config. */
	storeDomain: "REDEEMID_SHOPIFY_STORE_DOMAIN",
	/** Customer Account API client ID (Headless storefront). */
	clientId: "REDEEMID_SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID",
	/** Customer Account API client secret. Confidential clients only; public clients leave it unset. */
	clientSecret: "REDEEMID_SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_SECRET",
	/** Client secret of the Shopify (Admin API) app whose webhooks the site receives. Shopify signs webhooks with it. */
	webhookSecret: "REDEEMID_SHOPIFY_ADMIN_APP_CLIENT_SECRET",
	/** Client ID of that Shopify (Admin API) app. With the secret it lets staff tools call the Admin API (client credentials). */
	adminClientId: "REDEEMID_SHOPIFY_ADMIN_APP_CLIENT_ID",
	/** Secret for signing the outbound events RedeemID sends to `events.url`. */
	eventsSecret: "REDEEMID_EVENTS_SECRET",
	/** Storefront API private token, for server-side plan and checkout calls. */
	storefrontPrivateToken: "REDEEMID_SHOPIFY_STOREFRONT_PRIVATE_TOKEN",
	/** Storefront API public token, used only when the private token isn't set. */
	storefrontPublicToken: "REDEEMID_SHOPIFY_STOREFRONT_PUBLIC_TOKEN",
} as const;

export function env(name: string): string {
	const value = typeof process !== "undefined" ? process.env[name] : undefined;
	return typeof value === "string" ? value.trim() : "";
}

/**
 * Names of REDEEMID_ variables that are set but that RedeemID doesn't read,
 * such as a misspelled secret or a WordPress plugin constant. Names only,
 * never values.
 */
export function unknownEnvNames(): string[] {
	if (typeof process === "undefined" || !process.env) return [];
	const known = new Set<string>(Object.values(ENV));
	return Object.keys(process.env)
		.filter((k) => k.startsWith("REDEEMID_") && !known.has(k))
		.sort();
}

/** The store origin, e.g. https://shop.example.com. */
export function shopOrigin(config: RedeemIDConfig): string {
	const raw = storeDomain(config).replace(/\/+$/, "");
	if (raw === "") throw new Error("RedeemID: no store domain.");
	if (/^https?:\/\//i.test(raw)) {
		const url = new URL(raw);
		if (url.protocol === "http:" && !config.allowInsecureShop) {
			throw new Error("RedeemID: the shop must use https.");
		}
		return url.origin;
	}
	const host = raw.replace(/^admin\.shopify\.com\/store\//i, "").toLowerCase();
	// A bare store handle ("my-store") means its myshopify.com domain.
	return `https://${host.includes(".") ? host : `${host}.myshopify.com`}`;
}

/** The configured store domain, from config or the environment. */
export function storeDomain(config: RedeemIDConfig): string {
	return (config.shop ?? "").trim() || env(ENV.storeDomain);
}

/** Find this provider's config among EmDash's configured auth providers. */
export function readConfig(emdashConfig: unknown): RedeemIDConfig | null {
	const providers = (emdashConfig as { authProviders?: Array<{ id: string; config?: unknown }> } | null)
		?.authProviders;
	const found = providers?.find((p) => p.id === PROVIDER_ID);
	const config = found?.config as RedeemIDConfig | undefined;
	return config && typeof config === "object" ? config : null;
}
