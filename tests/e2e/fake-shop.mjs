/**
 * A fake Shopify store for end-to-end tests: OIDC discovery, an authorize
 * endpoint that signs the customer straight in, the token endpoint (RS256 ID
 * tokens), JWKS, the Customer Account API identity query and end-session.
 */
import { createServer } from "node:http";

import { exportJWK, generateKeyPair, SignJWT } from "jose";

export async function startFakeShop({ port, clientId, clientSecret, logoutUris = [] }) {
	const origin = `http://127.0.0.1:${port}`;
	const { privateKey, publicKey } = await generateKeyPair("RS256");
	const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
	const codes = new Map();
	const tokens = new Map();
	const shop = {
		origin,
		/** The customer the next sign-in returns. */
		customer: { id: 1001, email: "member@example.com", firstName: "Mia", lastName: "Member", tags: ["member"] },
		tokenRequests: [],
		carts: [],
		/** Live carts by id; a completed checkout removes its cart, as Shopify does. */
		cartsById: new Map(),
		blocked: [],
		/** Is the customer signed in at the store? `prompt=none` fails when not. */
		storeSession: true,
		authorizeRequests: [],
	};

	const server = createServer(async (req, res) => {
		const url = new URL(req.url, origin);
		const json = (code, body) => {
			res.writeHead(code, { "content-type": "application/json" });
			res.end(JSON.stringify(body));
		};
		let body = "";
		for await (const chunk of req) body += chunk;

		// Like Shopify, refuse server-side calls that don't name themselves.
		const browserPaths = ["/", "/authorize", "/checkout", "/logout"];
		if (!browserPaths.includes(url.pathname) && !String(req.headers["user-agent"] ?? "").startsWith("@redeemid/emdash")) {
			shop.blocked.push(url.pathname);
			res.writeHead(403, { "content-type": "text/html" });
			return res.end("Access denied");
		}

		switch (url.pathname) {
			case "/.well-known/openid-configuration":
				return json(200, {
					issuer: `${origin}/authentication/1`,
					authorization_endpoint: `${origin}/authorize`,
					token_endpoint: `${origin}/token`,
					end_session_endpoint: `${origin}/logout`,
					jwks_uri: `${origin}/jwks`,
				});
			case "/.well-known/customer-account-api":
				return json(200, { graphql_api: `${origin}/account/customer/api/unstable/graphql` });
			case "/jwks":
				return json(200, { keys: [jwk] });
			case "/authorize": {
				const p = url.searchParams;
				if (p.get("client_id") !== clientId || p.get("code_challenge_method") !== "S256") return json(400, { error: "bad_request" });
				shop.authorizeRequests.push(Object.fromEntries(p));
				if (p.get("prompt") === "none" && !shop.storeSession) {
					const back = new URL(p.get("redirect_uri"));
					back.searchParams.set("error", "login_required");
					back.searchParams.set("state", p.get("state"));
					res.writeHead(302, { location: back.toString() });
					return res.end();
				}
				const code = `code-${Math.random().toString(36).slice(2)}`;
				codes.set(code, { nonce: p.get("nonce"), challenge: p.get("code_challenge"), redirect: p.get("redirect_uri") });
				const back = new URL(p.get("redirect_uri"));
				back.searchParams.set("code", code);
				back.searchParams.set("state", p.get("state"));
				res.writeHead(302, { location: back.toString() });
				return res.end();
			}
			case "/token": {
				const form = new URLSearchParams(body);
				shop.tokenRequests.push({ auth: req.headers.authorization, origin: req.headers.origin, form: Object.fromEntries(form) });
				const grant = codes.get(form.get("code"));
				codes.delete(form.get("code"));
				const basic = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
				const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(form.get("code_verifier") ?? ""));
				const challenge = Buffer.from(digest).toString("base64url");
				if (!grant || req.headers.authorization !== basic || challenge !== grant.challenge || form.get("redirect_uri") !== grant.redirect) {
					return json(400, { error: "invalid_grant" });
				}
				const c = shop.customer;
				const access = `at-${Math.random().toString(36).slice(2)}`;
				tokens.set(access, { ...c });
				const idToken = await new SignJWT({ email: c.email, email_verified: true, nonce: grant.nonce })
					.setProtectedHeader({ alg: "RS256", kid: "k1" })
					.setIssuer(`${origin}/authentication/1`)
					.setAudience(clientId)
					.setSubject(`gid://shopify/Customer/${c.id}`)
					.setIssuedAt()
					.setExpirationTime("1h")
					.sign(privateKey);
				return json(200, { access_token: access, id_token: idToken, token_type: "Bearer", expires_in: 3600 });
			}
			case "/account/customer/api/2026-10/graphql": {
				const c = tokens.get(req.headers.authorization);
				if (!c) return json(401, { errors: [{ message: "unauthorized" }] });
				return json(200, {
					data: {
						customer: {
							id: `gid://shopify/Customer/${c.id}`,
							firstName: c.firstName,
							lastName: c.lastName,
							emailAddress: { emailAddress: c.email },
							tags: c.tags,
						},
					},
				});
			}
			case "/api/2026-10/graphql.json": {
				const { query, variables } = JSON.parse(body || "{}");
				const view = (id) => {
					const c = shop.cartsById.get(id);
					return c ? { id, checkoutUrl: `${origin}/checkout?cart=${encodeURIComponent(id)}`, totalQuantity: c.lines.length } : null;
				};
				if (query.includes("cartCreate")) {
					shop.carts.push({ input: variables.input, privateToken: req.headers["shopify-storefront-private-token"] });
					const id = `gid://shopify/Cart/${shop.carts.length}`;
					shop.cartsById.set(id, { lines: [...variables.input.lines] });
					return json(200, { data: { cartCreate: { cart: view(id), userErrors: [] } } });
				}
				if (query.includes("cartLinesAdd")) {
					const c = shop.cartsById.get(variables.id);
					if (c) c.lines.push(...variables.lines);
					return json(200, { data: { cartLinesAdd: { cart: view(variables.id), userErrors: c ? [] : [{ message: "The specified cart does not exist." }] } } });
				}
				if (query.includes("cart(id")) return json(200, { data: { cart: view(variables.id) } });
				const product =
					variables.handle === "pro-plan"
						? {
								handle: "pro-plan",
								title: "Pro plan",
								description: "",
								availableForSale: true,
								requiresSellingPlan: false,
								variants: { nodes: [{ id: "gid://shopify/ProductVariant/42", availableForSale: true, price: { amount: "12.0", currencyCode: "USD" } }] },
								sellingPlanGroups: { nodes: [] },
							}
						: null;
				return json(200, { data: { product } });
			}
			case "/":
				res.writeHead(200, { "content-type": "text/plain" });
				return res.end("CUSTOMER-ACCOUNT");
			case "/checkout":
				if (url.searchParams.get("complete") === "1") shop.cartsById.delete(url.searchParams.get("cart"));
				res.writeHead(200, { "content-type": "text/plain" });
				return res.end("CHECKOUT");
			case "/logout": {
				// Like Shopify: only registered logout URIs are honoured.
				const to = url.searchParams.get("post_logout_redirect_uri");
				if (!to || !logoutUris.includes(to)) return json(400, { error: "invalid_post_logout_redirect_uri" });
				res.writeHead(302, { location: to });
				return res.end();
			}
			default:
				return json(404, { error: "not_found" });
		}
	});

	await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
	shop.close = () => new Promise((resolve) => server.close(resolve));
	return shop;
}
