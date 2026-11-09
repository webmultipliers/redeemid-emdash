import { afterEach, describe, expect, it } from "vitest";

import { checkoutFor, customerToken } from "../src/checkout.js";
import { SESSION_CUSTOMER_TOKEN } from "../src/routes/shared.js";
import { resetCaches } from "../src/shopify.js";
import { resetStorefrontCache } from "../src/storefront.js";

afterEach(() => {
	resetCaches();
	resetStorefrontCache();
	delete process.env.REDEEMID_SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID;
});

const config = { shop: "s.myshopify.com" };

function session(values: Record<string, unknown>) {
	const map = new Map(Object.entries(values));
	return { map, get: (k: string) => map.get(k), set: (k: string, v: unknown) => void map.set(k, v), delete: (k: string) => void map.delete(k) };
}

function shop(tokenStatus = 200) {
	const calls: string[] = [];
	const fetcher = (async (url: string, init?: RequestInit) => {
		calls.push(url);
		if (url.endsWith("/.well-known/openid-configuration")) {
			return Response.json({ issuer: "https://s", authorization_endpoint: "https://s/auth", token_endpoint: "https://s/token", jwks_uri: "https://s/jwks" });
		}
		if (url.endsWith("/.well-known/customer-account-api")) return Response.json({ graphql_api: "https://s/account/customer/api/2026-10/graphql" });
		if (url === "https://s/token") {
			expect(String(init?.body)).toContain("grant_type=refresh_token");
			return tokenStatus === 200 ? Response.json({ access_token: "fresh", refresh_token: "r2", expires_in: 3600 }) : new Response("{}", { status: tokenStatus });
		}
		const body = JSON.parse(String(init?.body)) as { variables: { identity: { customerAccessToken: string } } };
		return Response.json({ data: { cartBuyerIdentityUpdate: { cart: { checkoutUrl: `https://s/checkout?as=${body.variables.identity.customerAccessToken}` }, userErrors: [] } } });
	}) as unknown as typeof fetch;
	return { calls, fetcher };
}

const url = new URL("https://site.test/");
const request = new Request("https://site.test/_emdash/api/auth/redeemid/cart");
const cart = { id: "gid://shopify/Cart/1", checkoutUrl: "https://s/checkout?guest" };

describe("checkout handoff", () => {
	it("guests keep the cart's own checkout", async () => {
		const { fetcher, calls } = shop();
		expect(await checkoutFor(config, cart, { session: session({}), request, fetcher })).toBe(cart.checkoutUrl);
		expect(calls).toHaveLength(0);
	});

	it("signs a member's cart in with their token", async () => {
		const { fetcher } = shop();
		const s = session({ user: { id: "u1" }, [SESSION_CUSTOMER_TOKEN]: { accessToken: "live", refreshToken: "r", expiresAt: Date.now() + 3_600_000 } });
		expect(await checkoutFor(config, cart, { session: s, request, fetcher })).toBe("https://s/checkout?as=live");
	});

	it("renews a token about to expire, and keeps the new one", async () => {
		process.env.REDEEMID_SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID = "client";
		const { fetcher } = shop();
		const s = session({ [SESSION_CUSTOMER_TOKEN]: { accessToken: "old", refreshToken: "r", expiresAt: Date.now() + 10_000 } });
		expect(await customerToken(config, s, { url, fetcher })).toBe("fresh");
		expect(s.map.get(SESSION_CUSTOMER_TOKEN)).toMatchObject({ accessToken: "fresh", refreshToken: "r2" });
	});

	it("falls back to a guest checkout when the store won't renew", async () => {
		process.env.REDEEMID_SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID = "client";
		const { fetcher } = shop(400);
		const s = session({ user: { id: "u1" }, [SESSION_CUSTOMER_TOKEN]: { accessToken: "old", refreshToken: "r", expiresAt: Date.now() - 1 } });
		expect(await checkoutFor(config, cart, { session: s, request, fetcher })).toBe(cart.checkoutUrl);
		expect(s.map.has(SESSION_CUSTOMER_TOKEN)).toBe(false);
	});

	it("can be turned off", async () => {
		const { fetcher, calls } = shop();
		const s = session({ user: { id: "u1" }, [SESSION_CUSTOMER_TOKEN]: { accessToken: "live", refreshToken: null, expiresAt: null } });
		expect(await checkoutFor({ ...config, checkout: { signIn: false } }, cart, { session: s, request, fetcher })).toBe(cart.checkoutUrl);
		expect(calls).toHaveLength(0);
	});
});
