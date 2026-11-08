/**
 * RedeemID configuration.
 *
 * Levels and rules live in code (astro.config.mjs), so they are versioned with
 * the site. Secrets come from the environment and never from config.
 */

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
 *   parent's).
 * - A rule with neither covers the whole collection.
 * - `collection: "*"` is the site default, for collections with no rule.
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
	 * A term rule that opens its entries to everyone, whatever else covers them
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
	 * Extra /_emdash path prefixes signed-in members may use. Everything else
	 * under /_emdash is refused to Subscribers (see guard.ts).
	 */
	memberPaths?: string[];
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
	/** Storefront API private token, for server-side plan and checkout calls. */
	storefrontPrivateToken: "REDEEMID_SHOPIFY_STOREFRONT_PRIVATE_TOKEN",
	/** Storefront API public token, used only when the private token isn't set. */
	storefrontPublicToken: "REDEEMID_SHOPIFY_STOREFRONT_PUBLIC_TOKEN",
} as const;

export function env(name: string): string {
	const value = typeof process !== "undefined" ? process.env[name] : undefined;
	return typeof value === "string" ? value.trim() : "";
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
