/**
 * A fake Shopify store for end-to-end tests: OIDC discovery, an authorize
 * endpoint that signs the customer straight in, the token endpoint (RS256 ID
 * tokens), JWKS, the Customer Account API identity query and end-session.
 */
import { createServer } from "node:http";

import { exportJWK, generateKeyPair, SignJWT } from "jose";

function product(handle, title, variants, extra = {}) {
	const real = variants.length > 1;
	return {
		id: `gid://shopify/Product/${handle.length * 100 + variants.length}`,
		handle,
		title,
		description: "",
		descriptionHtml: "",
		vendor: "Ledger",
		productType: "",
		availableForSale: variants.some((v) => v[3]),
		requiresSellingPlan: false,
		featuredImage: null,
		images: { nodes: [] },
		options: real ? [{ name: "Color", optionValues: variants.map((v) => ({ name: v[1] })) }] : [{ name: "Title", optionValues: [{ name: "Default Title" }] }],
		variants: {
			nodes: variants.map(([id, t, price, ok]) => ({
				id,
				title: t,
				availableForSale: ok,
				sku: null,
				price: { amount: price.toFixed(1), currencyCode: "USD" },
				compareAtPrice: null,
				image: null,
				selectedOptions: [{ name: real ? "Color" : "Title", value: t }],
			})),
		},
		sellingPlanGroups: { nodes: [] },
		seo: { title: null, description: null },
		...extra,
	};
}

function card(p) {
	return {
		handle: p.handle,
		title: p.title,
		availableForSale: p.availableForSale,
		requiresSellingPlan: p.requiresSellingPlan,
		featuredImage: null,
		priceRange: { minVariantPrice: p.variants.nodes[0].price },
		compareAtPriceRange: { minVariantPrice: p.variants.nodes[0].compareAtPrice ?? p.variants.nodes[0].price },
		variants: { nodes: p.variants.nodes.slice(0, 2).map((v) => ({ id: v.id, availableForSale: v.availableForSale })) },
	};
}

export async function startFakeShop({ port, clientId, clientSecret, logoutUris = [], adminClientId = "admin-client", adminSecret = "" }) {
	const origin = `http://127.0.0.1:${port}`;
	const { privateKey, publicKey } = await generateKeyPair("RS256");
	const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
	const codes = new Map();
	const tokens = new Map();
	const refreshes = new Map();
	const shop = {
		origin,
		/** The customer the next sign-in returns. */
		customer: { id: 1001, email: "member@example.com", firstName: "Mia", lastName: "Member", tags: ["member"] },
		tokenRequests: [],
		identityUpdates: [],
		searches: [],
		carts: [],
		/** Live carts by id; a completed checkout removes its cart, as Shopify does. */
		cartsById: new Map(),
		blocked: [],
		lineSeq: 0,
		products: {
			"pro-plan": product("pro-plan", "Pro plan", [["gid://shopify/ProductVariant/42", "Default Title", 12, true]]),
			"harbor-tote": product("harbor-tote", "Harbor tote", [
				["gid://shopify/ProductVariant/501", "Navy", 20, true],
				["gid://shopify/ProductVariant/502", "Sand", 22, false],
			]),
			support: product("support", "Support the newsroom", [["gid://shopify/ProductVariant/601", "Default Title", 1, true]]),
			"single-story": product("single-story", "Single story", [["gid://shopify/ProductVariant/701", "Default Title", 3, true]]),
			"coffee-club": product("coffee-club", "Coffee club", [["gid://shopify/ProductVariant/801", "Default Title", 15, true]], {
				sellingPlanGroups: { nodes: [{ name: "Subscribe", sellingPlans: { nodes: [{ id: "gid://shopify/SellingPlan/91", name: "Every month" }] } }] },
			}),
		},
		/** Admin API: token requests, webhook subscriptions, tag edits, and events RedeemID sent. */
		adminTokens: 0,
		subscriptions: [],
		tagEdits: [],
		// Customer metafield definitions and the customer's values, by "namespace.key".
		definitions: [
			{ namespace: "preferences", key: "topics", name: "Topics", description: "What you want to hear about", type: { name: "list.single_line_text_field" }, validations: [{ name: "choices", value: '["Politics","Food","Travel"]' }] },
			{ namespace: "preferences", key: "newsletter", name: "Weekly newsletter", description: null, type: { name: "boolean" }, validations: [] },
			{ namespace: "preferences", key: "level", name: "Reader level", description: null, type: { name: "number_integer" }, validations: [{ name: "min", value: "1" }, { name: "max", value: "5" }] },
			{ namespace: "membership", key: "since", name: "Member since", description: null, type: { name: "date" }, validations: [] },
		],
		metafields: { "preferences.level": "3" },
		metafieldWrites: [],
		events: [],
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
				if (form.get("grant_type") === "refresh_token") {
					const known = refreshes.get(form.get("refresh_token"));
					if (!known) return json(400, { error: "invalid_grant" });
					const access = `at-${Math.random().toString(36).slice(2)}`;
					tokens.set(access, known);
					return json(200, { access_token: access, refresh_token: form.get("refresh_token"), expires_in: 3600 });
				}
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
				const refresh = `rt-${Math.random().toString(36).slice(2)}`;
				refreshes.set(refresh, { ...c });
				const idToken = await new SignJWT({ email: c.email, email_verified: true, nonce: grant.nonce })
					.setProtectedHeader({ alg: "RS256", kid: "k1" })
					.setIssuer(`${origin}/authentication/1`)
					.setAudience(clientId)
					.setSubject(`gid://shopify/Customer/${c.id}`)
					.setIssuedAt()
					.setExpirationTime("1h")
					.sign(privateKey);
				return json(200, { access_token: access, id_token: idToken, refresh_token: refresh, token_type: "Bearer", expires_in: shop.tokenSeconds ?? 3600 });
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
				const money = (n) => ({ amount: n.toFixed(1), currencyCode: "USD" });
				const variantById = (id) => {
					for (const p of Object.values(shop.products)) {
						const v = p.variants.nodes.find((x) => x.id === id);
						if (v) return { v, p };
					}
					return null;
				};
				const view = (id) => {
					const c = shop.cartsById.get(id);
					if (!c) return null;
					const nodes = c.lines.map((l) => {
						const found = variantById(l.merchandiseId);
						const price = Number(found?.v.price.amount ?? 0);
						return {
							id: l.id,
							quantity: l.quantity,
							cost: { totalAmount: money(price * l.quantity), compareAtAmountPerQuantity: null },
							sellingPlanAllocation: l.sellingPlanId ? { sellingPlan: { name: "Every month" } } : null,
							merchandise: {
								id: l.merchandiseId,
								title: found?.v.title ?? "Default Title",
								price: money(price),
								image: null,
								product: { title: found?.p.title ?? "Unknown", handle: found?.p.handle ?? "unknown", featuredImage: null },
							},
						};
					});
					const subtotal = nodes.reduce((t, n) => t + Number(n.cost.totalAmount.amount), 0);
					const applicable = c.codes.map((code) => ({ code, applicable: code.toUpperCase() === "HARBOR10" }));
					const off = applicable.some((d) => d.applicable) ? subtotal * 0.1 : 0;
					return {
						id,
						checkoutUrl: `${origin}/checkout?cart=${encodeURIComponent(id)}${c.customer ? `&customer=${c.customer}` : ""}`,
						totalQuantity: c.lines.reduce((t, l) => t + l.quantity, 0),
						cost: { subtotalAmount: money(subtotal), totalAmount: money(subtotal - off) },
						discountCodes: applicable,
						lines: { nodes },
					};
				};
				const addLines = (c, lines) => {
					for (const line of lines) {
						const same = c.lines.find((l) => l.merchandiseId === line.merchandiseId && l.sellingPlanId === line.sellingPlanId);
						if (same) same.quantity += line.quantity;
						else c.lines.push({ ...line, id: `gid://shopify/CartLine/${++shop.lineSeq}` });
					}
				};
				if (query.includes("cartCreate")) {
					shop.carts.push({ input: variables.input, privateToken: req.headers["shopify-storefront-private-token"] });
					const id = `gid://shopify/Cart/${shop.carts.length}`;
					const c = { lines: [], codes: [], attributes: variables.input.attributes ?? [] };
					addLines(c, variables.input.lines);
					shop.cartsById.set(id, c);
					return json(200, { data: { cartCreate: { cart: view(id), userErrors: [] } } });
				}
				const c = variables.id ? shop.cartsById.get(variables.id) : null;
				const errs = c ? [] : [{ message: "The specified cart does not exist." }];
				if (query.includes("cartLinesAdd")) {
					if (c) addLines(c, variables.lines);
					return json(200, { data: { cartLinesAdd: { cart: view(variables.id), userErrors: errs } } });
				}
				if (query.includes("cartLinesUpdate")) {
					if (c) for (const u of variables.lines) { const l = c.lines.find((x) => x.id === u.id); if (l) l.quantity = u.quantity; }
					if (c) c.lines = c.lines.filter((l) => l.quantity > 0);
					return json(200, { data: { cartLinesUpdate: { cart: view(variables.id), userErrors: errs } } });
				}
				if (query.includes("cartLinesRemove")) {
					if (c) c.lines = c.lines.filter((l) => !variables.lineIds.includes(l.id));
					return json(200, { data: { cartLinesRemove: { cart: view(variables.id), userErrors: errs } } });
				}
				if (query.includes("cartDiscountCodesUpdate")) {
					if (c) c.codes = variables.codes ?? [];
					return json(200, { data: { cartDiscountCodesUpdate: { cart: view(variables.id), userErrors: errs } } });
				}
				if (query.includes("cartBuyerIdentityUpdate")) {
					const who = tokens.get(variables.identity?.customerAccessToken);
					if (c && who) c.customer = who.id;
					const bad = c && !who ? [{ message: "Invalid customer access token." }] : errs;
					shop.identityUpdates.push({ cart: variables.id, ok: Boolean(c && who) });
					return json(200, { data: { cartBuyerIdentityUpdate: { cart: view(variables.id), userErrors: bad } } });
				}
				if (query.includes("cart(id")) return json(200, { data: { cart: view(variables.id) } });
				const listed = () => Object.values(shop.products).filter((p) => p.handle !== "pro-plan");
				if (query.includes("predictiveSearch(")) {
					const q = String(variables.query).toLowerCase();
					const hits = listed().filter((p) => p.title.toLowerCase().includes(q));
					return json(200, { data: { predictiveSearch: { queries: hits.length ? [{ text: q }] : [], products: hits.slice(0, variables.limit).map(card), collections: [] } } });
				}
				if (query.includes("search(")) {
					shop.searches.push(variables);
					const q = String(variables.query).toLowerCase();
					let hits = listed().filter((p) => p.title.toLowerCase().includes(q) || q === "*");
					const vendor = (variables.filters ?? []).find((f) => f.productVendor);
					if (vendor) hits = hits.filter((p) => p.vendor === vendor.productVendor);
					if (variables.sortKey === "PRICE") hits.sort((a, b) => Number(a.variants.nodes[0].price.amount) - Number(b.variants.nodes[0].price.amount) * 1);
					if (variables.reverse) hits.reverse();
					return json(200, {
						data: {
							search: {
								totalCount: hits.length,
								productFilters: [{ id: "filter.p.vendor", label: "Vendor", type: "LIST", values: [{ id: "v.ledger", label: "Ledger", count: hits.length, input: '{"productVendor":"Ledger"}' }] }],
								pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
								nodes: hits.slice(0, variables.first ?? variables.last ?? 24).map(card),
							},
						},
					});
				}
				if (query.includes("productRecommendations(")) {
					return json(200, { data: { productRecommendations: listed().filter((p) => p.id !== variables.id).slice(0, 2).map(card) } });
				}
				if (query.includes("SitemapProducts")) {
					const nodes = listed().map((p) => ({ handle: p.handle, updatedAt: "2026-11-01T00:00:00Z" }));
					return json(200, { data: { products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } });
				}
				if (query.includes("collection(handle")) {
					if (variables.handle !== "shop") return json(200, { data: { collection: null } });
					const all = listed();
					const first = variables.first ?? variables.last ?? 12;
					const start = variables.after ? Number(variables.after) : 0;
					const nodes = all.slice(start, start + first).map(card);
					const products = {
						filters: [{ id: "filter.v.availability", label: "Availability", type: "LIST", values: [{ id: "a1", label: "In stock", count: all.length, input: '{"available":true}' }] }],
						pageInfo: { hasNextPage: start + first < all.length, hasPreviousPage: start > 0, startCursor: String(start), endCursor: String(start + first) },
						nodes,
					};
					return json(200, { data: { collection: { handle: "shop", title: "Shop", description: "Ledger goods.", products } } });
				}
				return json(200, { data: { product: shop.products[variables.handle] ?? null } });
			}
			case "/admin/oauth/access_token": {
				const form = new URLSearchParams(body);
				if (form.get("grant_type") !== "client_credentials" || form.get("client_id") !== adminClientId || form.get("client_secret") !== adminSecret) {
					return json(400, { error: "invalid_client" });
				}
				shop.adminTokens++;
				return json(200, { access_token: "admin-token", scope: "read_customers,write_customers", expires_in: 86399 });
			}
			case "/admin/api/2026-10/graphql.json": {
				if (req.headers["x-shopify-access-token"] !== "admin-token") return json(401, { errors: [{ message: "Invalid API key or access token" }] });
				const { query, variables } = JSON.parse(body || "{}");
				const c = shop.customer;
				if (query.includes("nodes(ids")) {
					const nodes = variables.ids.map((id) =>
						id === `gid://shopify/Customer/${c.id}`
							? {
									id,
									firstName: c.firstName,
									lastName: c.lastName,
									tags: c.tags,
									updatedAt: new Date().toISOString(),
									defaultEmailAddress: { emailAddress: c.email, marketingState: c.emailMarketing ?? "NOT_SUBSCRIBED" },
									// The membership.* metafields Flow or a subscription app writes.
									...Object.fromEntries(Object.entries(c.dates ?? {}).map(([k, v]) => [k, v ? { value: v } : null])),
								}
							: null,
					);
					return json(200, { data: { nodes } });
				}
				for (const m of ["tagsAdd", "tagsRemove"]) {
					if (query.includes(`${m}(`)) {
						shop.tagEdits.push({ m, ...variables });
						if (variables.id === `gid://shopify/Customer/${c.id}`) {
							const low = variables.tags.map((t) => t.toLowerCase());
							c.tags = m === "tagsAdd" ? [...new Set([...c.tags, ...variables.tags])] : c.tags.filter((t) => !low.includes(t.toLowerCase()));
						}
						return json(200, { data: { [m]: { userErrors: [] } } });
					}
				}
				if (query.includes("metafieldDefinitions(")) return json(200, { data: { metafieldDefinitions: { nodes: shop.definitions } } });
				if (query.includes("customer(id")) {
					if (variables.id !== `gid://shopify/Customer/${c.id}`) return json(200, { data: { customer: null } });
					const nodes = Object.entries(shop.metafields)
						.filter(([k]) => !variables.keys || variables.keys.includes(k))
						.map(([k, value]) => ({ namespace: k.split(".")[0], key: k.split(".")[1], value }));
					return json(200, { data: { customer: { metafields: { nodes } } } });
				}
				if (query.includes("metafieldsSet(") || query.includes("metafieldsDelete(")) {
					const m = query.includes("metafieldsSet(") ? "metafieldsSet" : "metafieldsDelete";
					for (const f of variables.metafields) {
						shop.metafieldWrites.push({ m, ...f });
						if (f.ownerId !== `gid://shopify/Customer/${c.id}`) continue;
						if (m === "metafieldsSet") shop.metafields[`${f.namespace}.${f.key}`] = f.value;
						else delete shop.metafields[`${f.namespace}.${f.key}`];
					}
					return json(200, { data: { [m]: { userErrors: [] } } });
				}
				if (query.includes("webhookSubscriptionCreate")) {
					shop.subscriptions.push({ id: `gid://shopify/WebhookSubscription/${shop.subscriptions.length + 1}`, topic: variables.topic, uri: variables.uri });
					return json(200, { data: { webhookSubscriptionCreate: { userErrors: [] } } });
				}
				if (query.includes("webhookSubscriptions")) return json(200, { data: { webhookSubscriptions: { nodes: shop.subscriptions } } });
				return json(400, { errors: [{ message: "unknown query" }] });
			}
			case "/events":
				// A slow or broken receiver, for the retry and after-the-response checks.
				if (shop.eventsDelayMs) await new Promise((r) => setTimeout(r, shop.eventsDelayMs));
				if (shop.eventsDown) {
					shop.eventsRefused = (shop.eventsRefused ?? 0) + 1;
					return json(503, { error: "down" });
				}
				shop.events.push({ headers: req.headers, body });
				return json(200, { ok: true });
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
				shop.logouts = (shop.logouts ?? 0) + 1;
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
