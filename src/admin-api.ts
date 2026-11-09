/**
 * Shopify Admin API, for staff tools only: resync a member, write tags to
 * Shopify, register webhooks. The token comes from the client credentials
 * grant of the Shopify app whose webhooks the site receives
 * (REDEEMID_SHOPIFY_ADMIN_APP_CLIENT_ID + _CLIENT_SECRET). Tokens last about
 * a day; this keeps one per store in memory until shortly before expiry.
 *
 * Nothing here grants access: tag edits go to Shopify, and the mirror only
 * changes from what Shopify answers.
 */

import { env, ENV, shopOrigin, type RedeemIDConfig } from "./config.js";
import { USER_AGENT } from "./shopify.js";
import { cleanTags, emptyMember, stampTags, type MemberRecord, type Stores } from "./storage.js";

export const ADMIN_API_VERSION = "2026-10";

/** Webhook topics RedeemID needs, as the Admin API names them. customers/redact is set in the app's config, not here. */
export const WEBHOOK_TOPICS = [
	"CUSTOMERS_CREATE",
	"CUSTOMERS_UPDATE",
	"CUSTOMERS_DELETE",
	"CUSTOMERS_DISABLE",
	"CUSTOMERS_ENABLE",
	"CUSTOMERS_MERGE",
	"CUSTOMER_TAGS_ADDED",
	"CUSTOMER_TAGS_REMOVED",
] as const;

const MARGIN_MS = 5 * 60 * 1000;
const tokens = new Map<string, { token: string; until: number; scope: string }>();

export function adminConfigured(): boolean {
	return Boolean(env(ENV.adminClientId) && env(ENV.webhookSecret));
}

export function resetAdminToken(): void {
	tokens.clear();
}

export class AdminError extends Error {}

async function token(config: RedeemIDConfig, fetcher: typeof fetch): Promise<{ token: string; scope: string }> {
	const origin = shopOrigin(config);
	const hit = tokens.get(origin);
	if (hit && hit.until > Date.now()) return hit;
	const clientId = env(ENV.adminClientId);
	const secret = env(ENV.webhookSecret);
	if (!clientId || !secret) throw new AdminError(`Set ${ENV.adminClientId} and ${ENV.webhookSecret} to use the staff tools.`);
	const res = await fetcher(`${origin}/admin/oauth/access_token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", "User-Agent": USER_AGENT },
		body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: secret }).toString(),
	});
	const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; scope?: string; error?: string };
	if (!res.ok || !body.access_token) {
		// shop_not_permitted: the app and the store are not in the same Shopify organization.
		throw new AdminError(`Shopify refused the Admin API token (${body.error ?? res.status}).`);
	}
	const life = (body.expires_in && body.expires_in > 0 ? body.expires_in : 3600) * 1000;
	const value = { token: body.access_token, until: Date.now() + Math.max(60_000, life - MARGIN_MS), scope: body.scope ?? "" };
	tokens.set(origin, value);
	return value;
}

/** The scopes the Admin API token carries, or an error message. */
export async function adminScopes(config: RedeemIDConfig, fetcher: typeof fetch = fetch): Promise<string> {
	return (await token(config, fetcher)).scope;
}

export async function admin<T>(config: RedeemIDConfig, query: string, variables: Record<string, unknown> = {}, fetcher: typeof fetch = fetch, retry = true): Promise<T> {
	const t = await token(config, fetcher);
	const res = await fetcher(`${shopOrigin(config)}/admin/api/${ADMIN_API_VERSION}/graphql.json`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": USER_AGENT, "X-Shopify-Access-Token": t.token },
		body: JSON.stringify({ query, variables }),
	});
	if (res.status === 401 && retry) {
		tokens.delete(shopOrigin(config));
		return admin(config, query, variables, fetcher, false);
	}
	const body = (await res.json().catch(() => ({}))) as { data?: T; errors?: Array<{ message?: string }> };
	if (!res.ok || !body.data) throw new AdminError(body.errors?.[0]?.message ?? `Admin API request failed (${res.status}).`);
	return body.data;
}

const gid = (id: string) => `gid://shopify/Customer/${id}`;

export interface AdminCustomer {
	customerId: string;
	email: string | null;
	firstName: string | null;
	lastName: string | null;
	tags: string[];
	updatedAt: number | null;
}

/** Up to 100 customers by numeric id. Customers Shopify no longer has are left out. */
export async function customers(config: RedeemIDConfig, ids: string[], fetcher: typeof fetch = fetch): Promise<AdminCustomer[]> {
	if (ids.length === 0) return [];
	type Node = { id: string; firstName: string | null; lastName: string | null; tags: string[]; updatedAt: string; defaultEmailAddress: { emailAddress: string | null } | null } | null;
	const data = await admin<{ nodes: Node[] }>(
		config,
		`query RedeemIDCustomers($ids: [ID!]!) { nodes(ids: $ids) { ... on Customer { id firstName lastName tags updatedAt defaultEmailAddress { emailAddress } } } }`,
		{ ids: ids.slice(0, 100).map(gid) },
		fetcher,
	);
	return data.nodes
		.filter((n): n is NonNullable<Node> => Boolean(n?.id))
		.map((n) => ({
			customerId: n.id.replace(/^gid:\/\/shopify\/Customer\//, ""),
			email: n.defaultEmailAddress?.emailAddress?.toLowerCase() ?? null,
			firstName: n.firstName || null,
			lastName: n.lastName || null,
			tags: cleanTags(n.tags),
			updatedAt: Number.isFinite(Date.parse(n.updatedAt)) ? Date.parse(n.updatedAt) : null,
		}));
}

/**
 * Read members from Shopify again and update the mirror: profile and tags.
 * Status stays with the enable/disable webhooks. Members Shopify no longer
 * has are reported in `missing` and left alone.
 */
export async function resync(config: RedeemIDConfig, s: Stores, ids: string[], source = "resync", fetcher: typeof fetch = fetch): Promise<{ updated: MemberRecord[]; missing: string[] }> {
	const found = await customers(config, ids, fetcher);
	// One read for the whole batch: on Workers Free one request may make only
	// 50 database queries, and each write below is one.
	const known = await s.members.getMany(found.map((c) => c.customerId));
	const updated: MemberRecord[] = [];
	for (const c of found) {
		const m = known.get(c.customerId) ?? emptyMember(c.customerId);
		m.email = c.email ?? m.email;
		m.firstName = c.firstName ?? m.firstName;
		m.lastName = c.lastName ?? m.lastName;
		m.tags = c.tags;
		m.profileUpdatedAt = c.updatedAt ?? m.profileUpdatedAt;
		m.syncedAt = new Date().toISOString();
		m.source = source;
		await s.members.put(c.customerId, stampTags(m));
		updated.push(m);
	}
	const seen = new Set(found.map((c) => c.customerId));
	return { updated, missing: ids.filter((id) => !seen.has(id)) };
}

/** Add or remove tags on the Shopify customer. Shopify then sends the tag webhook; callers resync to show it now. */
export async function editTags(config: RedeemIDConfig, customerId: string, change: "add" | "remove", tags: string[], fetcher: typeof fetch = fetch): Promise<void> {
	const clean = cleanTags(tags);
	if (clean.length === 0) return;
	const m = change === "add" ? "tagsAdd" : "tagsRemove";
	const data = await admin<Record<string, { userErrors: Array<{ message: string }> }>>(
		config,
		`mutation RedeemIDTags($id: ID!, $tags: [String!]!) { ${m}(id: $id, tags: $tags) { userErrors { field message } } }`,
		{ id: gid(customerId), tags: clean },
		fetcher,
	);
	const err = data[m]?.userErrors[0];
	if (err) throw new AdminError(err.message);
}

export interface Subscription {
	id: string;
	topic: string;
	uri: string;
}

export async function webhookSubscriptions(config: RedeemIDConfig, fetcher: typeof fetch = fetch): Promise<Subscription[]> {
	type Node = { id: string; topic: string; uri?: string | null };
	const data = await admin<{ webhookSubscriptions: { nodes: Node[] } }>(
		config,
		`query RedeemIDWebhooks { webhookSubscriptions(first: 100) { nodes { id topic uri } } }`,
		{},
		fetcher,
	);
	return data.webhookSubscriptions.nodes.map((n) => ({ id: n.id, topic: n.topic, uri: n.uri ?? "" }));
}

/** Scopes a topic needs beyond read_customers, to explain a refusal. */
const TOPIC_SCOPES: Partial<Record<(typeof WEBHOOK_TOPICS)[number], string>> = { CUSTOMERS_MERGE: "read_customer_merge" };

/**
 * Register the topics RedeemID needs that no subscription sends to `uri` yet.
 * A topic Shopify refuses doesn't stop the others: it comes back in `failed`.
 */
export async function registerWebhooks(
	config: RedeemIDConfig,
	uri: string,
	fetcher: typeof fetch = fetch,
): Promise<{ added: string[]; failed: Array<{ topic: string; message: string }> }> {
	const have = await webhookSubscriptions(config, fetcher);
	const missing = WEBHOOK_TOPICS.filter((t) => !have.some((h) => h.topic === t && h.uri === uri));
	const added: string[] = [];
	const failed: Array<{ topic: string; message: string }> = [];
	for (const topic of missing) {
		const data = await admin<{ webhookSubscriptionCreate: { userErrors: Array<{ message: string }> } }>(
			config,
			`mutation RedeemIDWebhook($topic: WebhookSubscriptionTopic!, $uri: String!) { webhookSubscriptionCreate(topic: $topic, webhookSubscription: { uri: $uri, format: JSON }) { userErrors { field message } } }`,
			{ topic, uri },
			fetcher,
		);
		const err = data.webhookSubscriptionCreate.userErrors[0];
		if (!err) added.push(topic);
		else failed.push({ topic, message: TOPIC_SCOPES[topic] ? `${err.message} (the app needs the ${TOPIC_SCOPES[topic]} scope)` : err.message });
	}
	return { added, failed };
}
