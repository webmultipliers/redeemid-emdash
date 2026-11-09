/**
 * Shopify Customer Account API: discovery, PKCE, token exchange, ID token
 * checks and the identity query. Web APIs only, so it runs on Node and Workers.
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

import { shopOrigin, type RedeemIDConfig } from "./config.js";

/** Customer Account API version, pinned on the discovered GraphQL URL. */
export const API_VERSION = "2026-10";
export const SCOPES = "openid email customer-account-api:full";

export interface Discovery {
	issuer: string;
	authorizationEndpoint: string;
	tokenEndpoint: string;
	endSessionEndpoint: string;
	jwksUri: string;
	graphqlApi: string;
}

const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const discoveryCache = new Map<string, { at: number; value: Discovery }>();
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/**
 * Shopify answers 403 to requests with no User-Agent, and fetch on
 * Cloudflare Workers sends none, so every server-side call names itself.
 */
export const USER_AGENT = "@redeemid/emdash (+https://github.com/webmultipliers/redeemid-emdash)";

export class ShopifyError extends Error {
	constructor(
		public readonly code: string,
		message: string,
	) {
		super(message);
	}
}

/** Point the discovered GraphQL URL at the pinned version. */
export function pinVersion(url: string): string {
	return url.replace(/\/api\/(?:\d{4}-\d{2}|unstable)\/graphql(?:\.json)?$/, `/api/${API_VERSION}/graphql`);
}

export async function discover(config: RedeemIDConfig, fetcher: typeof fetch = fetch): Promise<Discovery> {
	const origin = shopOrigin(config);
	const hit = discoveryCache.get(origin);
	if (hit && Date.now() - hit.at < DISCOVERY_TTL_MS) return hit.value;

	const [openid, api] = await Promise.all([
		getJson(fetcher, `${origin}/.well-known/openid-configuration`),
		getJson(fetcher, `${origin}/.well-known/customer-account-api`),
	]);
	const str = (o: Record<string, unknown>, k: string) => (typeof o[k] === "string" ? (o[k] as string) : "");

	const value: Discovery = {
		issuer: str(openid, "issuer"),
		authorizationEndpoint: str(openid, "authorization_endpoint"),
		tokenEndpoint: str(openid, "token_endpoint"),
		endSessionEndpoint: str(openid, "end_session_endpoint"),
		jwksUri: str(openid, "jwks_uri"),
		graphqlApi: pinVersion(str(api, "graphql_api")),
	};
	if (!value.authorizationEndpoint || !value.tokenEndpoint || !value.issuer || !value.jwksUri) {
		throw new ShopifyError("discovery_failed", "The store did not publish customer account sign-in.");
	}
	discoveryCache.set(origin, { at: Date.now(), value });
	return value;
}

async function getJson(fetcher: typeof fetch, url: string): Promise<Record<string, unknown>> {
	const res = await fetcher(url, { headers: { Accept: "application/json", "User-Agent": USER_AGENT } });
	if (!res.ok) throw new ShopifyError("discovery_failed", `Discovery failed (${res.status}) for ${url}`);
	return (await res.json()) as Record<string, unknown>;
}

// ---------------------------------------------------------------- PKCE

export function randomToken(bytes = 32): string {
	const buf = new Uint8Array(bytes);
	crypto.getRandomValues(buf);
	return base64url(buf);
}

export async function challengeFor(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return base64url(new Uint8Array(digest));
}

export function base64url(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function authorizeUrl(
	d: Discovery,
	args: {
		clientId: string;
		redirectUri: string;
		state: string;
		nonce: string;
		challenge: string;
		locale?: string;
		/** "none": no sign-in form; the store answers with an error when the customer isn't signed in there. */
		prompt?: "none";
	},
): string {
	const url = new URL(d.authorizationEndpoint);
	url.searchParams.set("scope", SCOPES);
	url.searchParams.set("client_id", args.clientId);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("redirect_uri", args.redirectUri);
	url.searchParams.set("state", args.state);
	url.searchParams.set("nonce", args.nonce);
	url.searchParams.set("code_challenge", args.challenge);
	url.searchParams.set("code_challenge_method", "S256");
	if (args.locale) url.searchParams.set("ui_locales", args.locale);
	if (args.prompt) url.searchParams.set("prompt", args.prompt);
	return url.toString();
}

// ---------------------------------------------------------------- tokens

export interface Tokens {
	accessToken: string;
	idToken: string;
	/** Present when Shopify issued one; used to renew the access token for a signed-in checkout. */
	refreshToken?: string | null;
	/** When the access token expires (ms since epoch), when Shopify said. */
	expiresAt?: number | null;
}

function tokenTimes(data: Record<string, unknown>): { refreshToken: string | null; expiresAt: number | null } {
	const ttl = typeof data.expires_in === "number" ? data.expires_in : Number(data.expires_in);
	return {
		refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : null,
		expiresAt: Number.isFinite(ttl) && ttl > 0 ? Date.now() + ttl * 1000 : null,
	};
}

/**
 * Renew a Customer Account API access token with its refresh token. Throws
 * when Shopify refuses (the member's store session ended).
 */
export async function refreshTokens(
	d: Discovery,
	args: { clientId: string; clientSecret: string; origin?: string; refreshToken: string },
	fetcher: typeof fetch = fetch,
): Promise<{ accessToken: string; refreshToken: string | null; expiresAt: number | null }> {
	const body = new URLSearchParams({ grant_type: "refresh_token", client_id: args.clientId, refresh_token: args.refreshToken });
	const headers: Record<string, string> = {
		"Content-Type": "application/x-www-form-urlencoded",
		Accept: "application/json",
		"User-Agent": USER_AGENT,
	};
	if (args.origin) headers.Origin = args.origin;
	if (args.clientSecret) headers.Authorization = `Basic ${btoa(`${args.clientId}:${args.clientSecret}`)}`;
	const res = await fetcher(d.tokenEndpoint, { method: "POST", headers, body });
	const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
	if (!res.ok || typeof data.access_token !== "string") throw new ShopifyError("token_failed", `Token refresh failed (${res.status}).`);
	const t = tokenTimes(data);
	return { accessToken: data.access_token, refreshToken: t.refreshToken ?? args.refreshToken, expiresAt: t.expiresAt };
}

export async function exchangeCode(
	d: Discovery,
	args: { clientId: string; clientSecret: string; redirectUri: string; origin?: string; code: string; verifier: string },
	fetcher: typeof fetch = fetch,
): Promise<Tokens> {
	const body = new URLSearchParams({
		grant_type: "authorization_code",
		client_id: args.clientId,
		redirect_uri: args.redirectUri,
		code: args.code,
		code_verifier: args.verifier,
	});
	const headers: Record<string, string> = {
		"Content-Type": "application/x-www-form-urlencoded",
		Accept: "application/json",
		"User-Agent": USER_AGENT,
	};
	// Public clients are checked against their registered JavaScript origins.
	if (args.origin) headers.Origin = args.origin;
	if (args.clientSecret) headers.Authorization = `Basic ${btoa(`${args.clientId}:${args.clientSecret}`)}`;

	const res = await fetcher(d.tokenEndpoint, { method: "POST", headers, body });
	const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
	if (!res.ok || typeof data.access_token !== "string" || typeof data.id_token !== "string") {
		throw new ShopifyError("token_failed", `Token exchange failed (${res.status}).`);
	}
	return { accessToken: data.access_token, idToken: data.id_token, ...tokenTimes(data) };
}

/** Verify the ID token's signature, issuer, audience, expiry and nonce. */
export async function verifyIdToken(
	d: Discovery,
	idToken: string,
	args: { clientId: string; nonce: string },
): Promise<JWTPayload> {
	let jwks = jwksCache.get(d.jwksUri);
	if (!jwks) {
		jwks = createRemoteJWKSet(new URL(d.jwksUri), { headers: { "User-Agent": USER_AGENT } });
		jwksCache.set(d.jwksUri, jwks);
	}
	try {
		const { payload } = await jwtVerify(idToken, jwks, {
			issuer: d.issuer,
			audience: args.clientId,
			clockTolerance: 60,
		});
		if (payload.nonce !== args.nonce) throw new ShopifyError("bad_nonce", "ID token nonce mismatch.");
		return payload;
	} catch (e) {
		if (e instanceof ShopifyError) throw e;
		throw new ShopifyError("bad_id_token", `ID token rejected: ${(e as Error).message}`);
	}
}

// ---------------------------------------------------------------- identity

export interface Identity {
	customerId: string;
	email: string | null;
	firstName: string | null;
	lastName: string | null;
	tags: string[];
}

export const IDENTITY_QUERY = `query RedeemIDIdentity {
  customer {
    id
    firstName
    lastName
    emailAddress { emailAddress }
    tags
  }
}`;

export async function identity(d: Discovery, accessToken: string, fetcher: typeof fetch = fetch): Promise<Identity> {
	if (!d.graphqlApi) throw new ShopifyError("identity_failed", "The store did not publish the Customer Account API.");
	const res = await fetcher(d.graphqlApi, {
		method: "POST",
		// The Customer Account API takes the bare access token, without "Bearer".
		headers: { "Content-Type": "application/json", Authorization: accessToken, "User-Agent": USER_AGENT },
		body: JSON.stringify({ query: IDENTITY_QUERY }),
	});
	const data = (await res.json().catch(() => ({}))) as {
		data?: { customer?: Record<string, unknown> | null };
	};
	const c = data.data?.customer;
	const gid = typeof c?.id === "string" ? c.id : "";
	const m = /^gid:\/\/shopify\/Customer\/(\d+)$/.exec(gid);
	if (!res.ok || !c || !m?.[1]) throw new ShopifyError("identity_failed", "Shopify did not return a customer.");
	const s = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
	const email = (c.emailAddress as { emailAddress?: unknown } | null)?.emailAddress;
	return {
		customerId: m[1],
		email: s(email)?.toLowerCase() ?? null,
		firstName: s(c.firstName),
		lastName: s(c.lastName),
		tags: Array.isArray(c.tags) ? c.tags.filter((t): t is string => typeof t === "string") : [],
	};
}

export function logoutUrl(d: Discovery, idToken: string, after: string): string | null {
	if (!d.endSessionEndpoint) return null;
	const url = new URL(d.endSessionEndpoint);
	url.searchParams.set("id_token_hint", idToken);
	url.searchParams.set("post_logout_redirect_uri", after);
	return url.toString();
}

/** For tests: forget cached discovery and keys. */
export function resetCaches(): void {
	discoveryCache.clear();
	jwksCache.clear();
}
