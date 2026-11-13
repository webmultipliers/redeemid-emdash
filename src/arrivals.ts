/**
 * Visitors sent over from the store's own pages.
 *
 * A store that keeps its Online Store channel usually publishes a redirect
 * theme, which sends its pages to the site with two extras:
 *
 * - `?discount=CODE`: Shopify's discount links (`/discount/CODE`) leave the
 *   code in a store cookie, and the theme passes it on. The code goes on the
 *   visitor's cart now, or is kept in their session and goes on the first
 *   cart made for them.
 * - `?logged_in=true`: the customer is signed in to the store. A visitor who
 *   isn't signed in here is signed in without a form (`prompt=none`). If the
 *   store session has ended, they come back signed out, with no notice.
 *
 * Either way the visitor then lands on the same page without those
 * parameters, so the page itself, and any cache in front of it, never sees
 * them.
 */

import { readCart, type CartRef } from "./cart.js";
import { env, ENV, type RedeemIDConfig } from "./config.js";
import { setDiscountCodes, type Cart } from "./storefront.js";

export const SESSION_DISCOUNT = "redeemid:discount";

/** Parameters the redirect theme adds, taken off before the page renders. */
export const ARRIVAL_PARAMS = ["discount", "logged_in", "company_location_id"] as const;

type Session = { get(key: string): unknown; set(key: string, value: unknown): void; delete?(key: string): void } | undefined;

/** A discount code as a link carries it, or null for anything that can't be one. */
export function discountCode(raw: string | null | undefined): string | null {
	const code = (raw ?? "").trim();
	if (!code || code.length > 255 || /[\u0000-\u001f\u007f]/.test(code)) return null;
	return code;
}

/** The login route checks `return` again (safeReturn), so this stays free of site config. */
export function quietSignInUrl(returnTo: string): string {
	return `/_emdash/api/auth/redeemid/login?quiet=1&return=${encodeURIComponent(returnTo)}`;
}

/**
 * The response for a page request that carries the theme's parameters, or
 * null when it carries none. Only GET and HEAD requests are touched.
 */
export async function arrival(
	context: { url: URL; request?: Request; session?: unknown },
	config: RedeemIDConfig | null,
	user: unknown,
	deps: { setCodes?: typeof setDiscountCodes } = {},
): Promise<Response | null> {
	const { url } = context;
	const method = context.request?.method ?? "GET";
	if (method !== "GET" && method !== "HEAD") return null;
	if (!ARRIVAL_PARAMS.some((p) => url.searchParams.has(p))) return null;

	const session = context.session as Session;
	const code = discountCode(url.searchParams.get("discount"));
	if (code && session && config) {
		const cart = await readCart(session as never).catch(() => null);
		if (cart) {
			const buyerIp = context.request?.headers.get("cf-connecting-ip") ?? null;
			await (deps.setCodes ?? setDiscountCodes)(config, cart.id, [code], { buyerIp }).catch((e: Error) => {
				console.error("[redeemid] discount link failed:", e.message);
			});
		} else {
			session.set(SESSION_DISCOUNT, code);
		}
	}

	const clean = new URL(url);
	for (const p of ARRIVAL_PARAMS) clean.searchParams.delete(p);
	// "//host" would leave the site.
	const here = /^\/[\/\\]/.test(clean.pathname) ? "/" : `${clean.pathname}${clean.search}`;

	const signIn = url.searchParams.get("logged_in") === "true" && !user && session && config && env(ENV.clientId);
	const location = signIn ? quietSignInUrl(here) : here;
	return new Response(null, { status: 302, headers: { location, "cache-control": "private, no-store" } });
}

/** The code a discount link left for the visitor's next cart, if any. */
export async function pendingDiscount(session: Session): Promise<string | null> {
	return discountCode((await session?.get(SESSION_DISCOUNT)) as string | undefined);
}

/**
 * After adding to a cart with a pending code: the code is used up. A new cart
 * got it when it was made; a cart that already existed gets it now.
 */
export async function usedDiscount(
	session: Session,
	config: RedeemIDConfig,
	code: string | null,
	cart: Cart,
	before: CartRef | null,
	opts: { buyerIp?: string | null } = {},
): Promise<void> {
	if (!code || !session) return;
	if (session.delete) session.delete(SESSION_DISCOUNT);
	else session.set(SESSION_DISCOUNT, undefined);
	if (before && before.id === cart.id) await setDiscountCodes(config, cart.id, [code], opts).catch(() => null);
}
