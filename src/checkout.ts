/**
 * The handoff to Shopify's checkout.
 *
 * A signed-in member's cart gets their Customer Account API access token
 * (cartBuyerIdentityUpdate), so checkout opens signed in and the order lands
 * on their Shopify customer, where the shop's Flow or apps tag it. The token
 * lives only in the server-side session, sealed (token-vault.ts), and is renewed with its refresh
 * token when it's about to expire. Anything that fails falls back to a guest
 * checkout: buying never breaks because sign-in couldn't be carried over.
 */

import { env, ENV, type RedeemIDConfig } from "./config.js";
import { SESSION_CUSTOMER_TOKEN, callbackUrl, type CustomerToken } from "./routes/shared.js";
import { discover, refreshTokens } from "./shopify.js";
import { signInCart } from "./storefront.js";
import { seal, unseal } from "./token-vault.js";

type Session = { get(key: string): unknown; set(key: string, value: unknown): void; delete?(key: string): void } | undefined;

/** Renew this long before the token expires. */
const RENEW_MS = 2 * 60 * 1000;

/** The member's access token, renewed when it's close to expiring. Null for guests or when it can't be renewed. */
export async function customerToken(
	config: RedeemIDConfig,
	session: Session,
	opts: { url: URL; emdashConfig?: unknown; fetcher?: typeof fetch; now?: number; db?: unknown },
): Promise<string | null> {
	const t = await unseal(await session?.get(SESSION_CUSTOMER_TOKEN), opts.db);
	if (!t?.accessToken) return null;
	const now = opts.now ?? Date.now();
	if (!t.expiresAt || t.expiresAt - now > RENEW_MS) return t.accessToken;
	const forget = () => {
		if (session?.delete) session.delete(SESSION_CUSTOMER_TOKEN);
		else session?.set(SESSION_CUSTOMER_TOKEN, undefined);
	};
	const clientId = env(ENV.clientId);
	if (!t.refreshToken || !clientId) {
		forget();
		return null;
	}
	try {
		const redirect = callbackUrl(opts.url, opts.emdashConfig);
		const next = await refreshTokens(
			await discover(config, opts.fetcher),
			{ clientId, clientSecret: env(ENV.clientSecret), origin: new URL(redirect).origin, refreshToken: t.refreshToken },
			opts.fetcher,
		);
		session?.set(SESSION_CUSTOMER_TOKEN, await seal(next satisfies CustomerToken, opts.db));
		return next.accessToken;
	} catch {
		forget();
		return null;
	}
}

/**
 * Where to send the visitor to pay for this cart: the signed-in checkout for
 * a member (when config `checkout.signIn` isn't false), else the cart's own
 * checkout URL.
 */
export async function checkoutFor(
	config: RedeemIDConfig,
	cart: { id: string; checkoutUrl: string },
	opts: { session: Session; request: Request; emdashConfig?: unknown; fetcher?: typeof fetch },
): Promise<string> {
	if (config.checkout?.signIn === false) return cart.checkoutUrl;
	const user = (await opts.session?.get("user")) as { id?: string } | undefined;
	if (!user?.id) return cart.checkoutUrl;
	const token = await customerToken(config, opts.session, { url: new URL(opts.request.url), emdashConfig: opts.emdashConfig, fetcher: opts.fetcher });
	if (!token) return cart.checkoutUrl;
	const url = await signInCart(config, cart.id, token, { buyerIp: opts.request.headers.get("cf-connecting-ip"), fetcher: opts.fetcher });
	return url ?? cart.checkoutUrl;
}
