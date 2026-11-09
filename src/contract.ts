/**
 * The developer API, as a list: what site code, other plugins and agents may
 * rely on. docs/developer-api.md is the readable version, and
 * tests/contract.test.ts fails when the code, this list and that page
 * disagree.
 *
 * - Everything here is stable: it changes only with a changelog entry and an
 *   API_VERSION bump (minor when added, major when changed or removed).
 *   Before 1.0.0 of the package a breaking change can still happen, but
 *   never silently.
 * - Anything not listed is internal, even when a module exports it.
 */

export { API_VERSION } from "./api-version.js";

/** Stable exports, by import path. */
export const MODULES = {
	"@redeemid/emdash": ["redeemid", "redeemidGuard", "redeemidPlugin"],
	"@redeemid/emdash/access": ["viewer", "canRead", "readEntry", "entryRequirement", "meterUsage", "membership", "levelsFor", "signInUrl", "signOutUrl", "accountUrl", "cartUrl", "refreshUrl", "safeReturn"],
	"@redeemid/emdash/features": ["hasFeature", "viewerFeatures", "featuresFor"],
	"@redeemid/emdash/preferences": ["readPreferences", "savePreferences", "preferenceFields"],
	"@redeemid/emdash/storefront": ["plan", "product", "collection", "money", "realOptions", "variantFor", "storeContext", "cartDetails", "addToCart", "updateLines", "removeLines", "setDiscountCodes"],
	"@redeemid/emdash/catalog": ["searchProducts", "collectionPage", "suggest", "recommendations", "browseFromUrl", "browseHref", "parseFilters", "priceFilter", "SORTS"],
	"@redeemid/emdash/events": ["signBody"],
	"@redeemid/emdash/text": ["STRINGS", "text", "textParts"],
} as const;

/** Public JSON routes under /_emdash/api/auth/redeemid/. */
export const JSON_ROUTES = ["api/state", "api/cart", "api/search", "preferences", "privacy"] as const;

/** Form routes under /_emdash/api/auth/redeemid/ (each redirects back with a notice). */
export const FORM_ROUTES = ["login", "callback", "logout", "webhook", "buy", "cart", "cart-edit", "account"] as const;

/** window.redeemid members. */
export const CLIENT = ["version", "apiVersion", "events", "subscribe", "emit", "state", "refresh", "signIn", "signOut", "cart", "openCart", "closeCart", "search", "suggest", "collection"] as const;

/** window.redeemid.cart members. */
export const CLIENT_CART = ["get", "add", "update", "remove", "discount", "checkout"] as const;

/** Browser events, in the order of window.redeemid.events. */
export const CLIENT_EVENTS = ["ready", "state", "wall_shown", "metered_view", "sign_in_click", "checkout_click", "cart_changed", "cart_opened", "search"] as const;

/** Signed outbound server events (events.ts). */
export const SERVER_EVENTS = ["member.signed_in", "member.levels_changed", "meter.used", "meter.exhausted", "preferences.saved", "member.erased"] as const;

/** MCP tools, always offered (read-only). */
export const MCP_TOOLS = ["explain_access", "list_levels", "get_rules", "get_member", "site_health", "level_changes", "find_products", "get_product", "get_collection"] as const;

/** MCP tools offered only with config agents.actions. */
export const MCP_ACTIONS = ["resync_member", "resync_batch", "edit_member_tags"] as const;
