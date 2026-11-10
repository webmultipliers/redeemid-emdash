import { afterEach, describe, expect, it } from "vitest";

import { checkoutFor, customerToken } from "../src/checkout.js";
import { SESSION_CUSTOMER_TOKEN } from "../src/routes/shared.js";
import { resetCaches } from "../src/shopify.js";
import { resetStorefrontCache } from "../src/storefront.js";
import { seal, unseal, useVaultKey } from "../src/token-vault.js";

useVaultKey(btoa(String.fromCharCode(...new Uint8Array(32).fill(7))));

afterEach(() => {
	resetCaches();
	resetStorefrontCache();
	delete process.env.REDEEMID_SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID;
});

const config = { shop: "s.myshopify.com" };

async function session(values: Record<string, unknown>) {
	const v = { ...values };
	const t = v[SESSION_CUSTOMER_TOKEN];
	if (t) v[SESSION_CUSTOMER_TOKEN] = await seal(t as never);
	const map = new Map(Object.entries(v));
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
		expect(await checkoutFor(config, cart, { session: await session({}), request, fetcher })).toBe(cart.checkoutUrl);
		expect(calls).toHaveLength(0);
	});

	it("signs a member's cart in with their token", async () => {
		const { fetcher } = shop();
		const s = await session({ user: { id: "u1" }, [SESSION_CUSTOMER_TOKEN]: { accessToken: "live", refreshToken: "r", expiresAt: Date.now() + 3_600_000 } });
		expect(await checkoutFor(config, cart, { session: s, request, fetcher })).toBe("https://s/checkout?as=live");
	});

	it("renews a token about to expire, and keeps the new one", async () => {
		process.env.REDEEMID_SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID = "client";
		const { fetcher } = shop();
		const s = await session({ [SESSION_CUSTOMER_TOKEN]: { accessToken: "old", refreshToken: "r", expiresAt: Date.now() + 10_000 } });
		expect(await customerToken(config, s, { url, fetcher })).toBe("fresh");
		expect(await unseal(s.map.get(SESSION_CUSTOMER_TOKEN))).toMatchObject({ accessToken: "fresh", refreshToken: "r2" });
		expect(JSON.stringify(s.map.get(SESSION_CUSTOMER_TOKEN))).not.toContain("fresh");
	});

	it("falls back to a guest checkout when the store won't renew", async () => {
		process.env.REDEEMID_SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID = "client";
		const { fetcher } = shop(400);
		const s = await session({ user: { id: "u1" }, [SESSION_CUSTOMER_TOKEN]: { accessToken: "old", refreshToken: "r", expiresAt: Date.now() - 1 } });
		expect(await checkoutFor(config, cart, { session: s, request, fetcher })).toBe(cart.checkoutUrl);
		expect(s.map.has(SESSION_CUSTOMER_TOKEN)).toBe(false);
	});

	it("can be turned off", async () => {
		const { fetcher, calls } = shop();
		const s = await session({ user: { id: "u1" }, [SESSION_CUSTOMER_TOKEN]: { accessToken: "live", refreshToken: null, expiresAt: null } });
		expect(await checkoutFor({ ...config, checkout: { signIn: false } }, cart, { session: s, request, fetcher })).toBe(cart.checkoutUrl);
		expect(calls).toHaveLength(0);
	});
});

describe("sealed tokens", () => {
	it("never hold the token in the clear, and a plain or tampered value opens as none", async () => {
		const sealed = await seal({ accessToken: "secret-token", refreshToken: "r", expiresAt: null });
		expect(JSON.stringify(sealed)).not.toContain("secret-token");
		expect(await unseal(sealed)).toMatchObject({ accessToken: "secret-token" });
		expect(await unseal({ accessToken: "plain", refreshToken: null, expiresAt: null })).toBeNull();
		expect(await unseal({ sealed: sealed.sealed.replace(/.$/, (c) => (c === "A" ? "B" : "A")) })).toBeNull();
	});
});
