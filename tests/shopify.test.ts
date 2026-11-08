import { afterEach, describe, expect, it } from "vitest";

import { shopOrigin } from "../src/config.js";
import { authorizeUrl, challengeFor, discover, identity, pinVersion, resetCaches } from "../src/shopify.js";

afterEach(resetCaches);

describe("store address", () => {
	it("normalises domains, handles and admin URLs", () => {
		expect(shopOrigin({ shop: "Shop.Example.com/" })).toBe("https://shop.example.com");
		expect(shopOrigin({ shop: "my-store" })).toBe("https://my-store.myshopify.com");
		expect(shopOrigin({ shop: "admin.shopify.com/store/my-store" })).toBe("https://my-store.myshopify.com");
		expect(() => shopOrigin({ shop: "http://127.0.0.1:9" })).toThrow();
		expect(shopOrigin({ shop: "http://127.0.0.1:9", allowInsecureShop: true })).toBe("http://127.0.0.1:9");
	});

	it("falls back to REDEEMID_SHOPIFY_STORE_DOMAIN", () => {
		process.env.REDEEMID_SHOPIFY_STORE_DOMAIN = "env-store.myshopify.com";
		try {
			expect(shopOrigin({})).toBe("https://env-store.myshopify.com");
			expect(shopOrigin({ shop: "config.myshopify.com" })).toBe("https://config.myshopify.com");
		} finally {
			delete process.env.REDEEMID_SHOPIFY_STORE_DOMAIN;
		}
		expect(() => shopOrigin({})).toThrow();
	});
});

describe("Customer Account API", () => {
	it("pins the discovered GraphQL version", () => {
		expect(pinVersion("https://shopify.com/1/account/customer/api/2025-07/graphql")).toBe(
			"https://shopify.com/1/account/customer/api/2026-10/graphql",
		);
	});

	it("builds a PKCE authorize URL", async () => {
		// printf <verifier> | openssl dgst -sha256 -binary | base64url
		expect(await challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW-gFWFOEjXk")).toBe("90EpwHQr_xi9uDtjYyz5mq9Z4RekugHRqg5ijpXC3FQ");
		const url = new URL(
			authorizeUrl(
				{ issuer: "i", authorizationEndpoint: "https://shopify.com/authentication/1/oauth/authorize", tokenEndpoint: "", endSessionEndpoint: "", jwksUri: "", graphqlApi: "" },
				{ clientId: "c", redirectUri: "https://site/cb", state: "s", nonce: "n", challenge: "x", locale: "fr-CA" },
			),
		);
		expect(Object.fromEntries(url.searchParams)).toMatchObject({
			client_id: "c",
			response_type: "code",
			scope: "openid email customer-account-api:full",
			code_challenge_method: "S256",
			ui_locales: "fr-CA",
		});
	});

	it("reads discovery and the customer identity", async () => {
		const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith("openid-configuration"))
				return Response.json({ issuer: "https://shopify.com/authentication/1", authorization_endpoint: "https://a", token_endpoint: "https://t", jwks_uri: "https://j" });
			if (url.endsWith("customer-account-api")) return Response.json({ graphql_api: "https://shopify.com/1/account/customer/api/unstable/graphql" });
			expect((init?.headers as Record<string, string>).Authorization).toBe("tok");
			return Response.json({ data: { customer: { id: "gid://shopify/Customer/42", firstName: "Ann", lastName: null, emailAddress: { emailAddress: "Ann@X.co" }, tags: ["member"] } } });
		}) as typeof fetch;
		const d = await discover({ shop: "s.myshopify.com" }, fetcher);
		expect(d.graphqlApi).toBe("https://shopify.com/1/account/customer/api/2026-10/graphql");
		expect(await identity(d, "tok", fetcher)).toEqual({ customerId: "42", email: "ann@x.co", firstName: "Ann", lastName: null, tags: ["member"] });
	});
});
