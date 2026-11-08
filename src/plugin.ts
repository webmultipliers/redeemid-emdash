/**
 * RedeemID as an EmDash plugin: what editors and admins see.
 *
 *   emdash({
 *     authProviders: [redeemid(config)],
 *     plugins: [redeemidPlugin(config)],
 *   })
 *
 * It adds two Portable Text blocks to the editor, a Members page, a Status
 * page and a dashboard widget. Sign-in, webhooks and checkout stay on the
 * auth provider's routes.
 *
 * - "Paywall break" (`redeemid-paywall`): everything after it in the body is
 *   for members. Pick the levels that may read on; none picked means any
 *   signed-in member, or the entry's rule when one covers it.
 * - "Plan" (`redeemid-plan`): a Shopify product's title and price with a
 *   button that adds it to the cart and opens checkout.
 *
 * Render bodies with `<Content>` (components/Content.astro), which keeps the
 * part after a paywall break off the page for readers who can't read it.
 */

import type { ResolvedPlugin, RouteContext } from "emdash";
import { definePlugin } from "emdash";

import { levelsFor } from "./access.js";
import { env, ENV, storeDomain, type RedeemIDConfig } from "./config.js";
import { discover } from "./shopify.js";
import { stores, type MemberRecord } from "./storage.js";
import { PAGES, WIDGETS } from "./descriptor.js";
import { VERSION } from "./version.js";

import { PAYWALL_BLOCK, PLAN_BLOCK } from "./blocks-names.js";

export { PAYWALL_BLOCK, PLAN_BLOCK };

function blocks(config: RedeemIDConfig) {
	const levelOptions = (config.levels ?? []).map((l) => ({ label: l.name, value: l.slug }));
	return [
		{
			type: PAYWALL_BLOCK,
			label: "Paywall break",
			icon: "lock",
			description: "Everything after this is for members",
			fields: [
				{
					type: "checkbox" as const,
					action_id: "levels",
					label: "Who can read on (none = any signed-in member)",
					options: levelOptions,
				},
			],
		},
		{
			type: PLAN_BLOCK,
			label: "Plan",
			icon: "tag",
			description: "A Shopify product with its price and a buy button",
			placeholder: "Shopify product handle",
			fields: [
				{ type: "text_input" as const, action_id: "handle", label: "Shopify product handle", placeholder: "gold-membership" },
				{ type: "text_input" as const, action_id: "title", label: "Title (optional, Shopify's title otherwise)" },
				{ type: "text_input" as const, action_id: "label", label: "Button label", placeholder: "Join" },
			],
		},
	];
}

export function createPlugin(config: RedeemIDConfig = {}): ResolvedPlugin {
	return definePlugin({
		id: "redeemid",
		version: VERSION,
		capabilities: [],
		admin: {
			pages: PAGES,
			widgets: WIDGETS,
			portableTextBlocks: blocks(config),
		},
		routes: {
			admin: {
				handler: async (ctx: RouteContext) => {
					const i = (ctx.input ?? {}) as { type?: string; page?: string };
					if (i.type !== "page_load") return { blocks: [] };
					try {
						if (i.page === "/") return await membersPage(config);
						if (i.page === "/status") return await statusPage(config, ctx.request);
						if (i.page === "widget:status") return await statusWidget(config);
					} catch (e) {
						return { blocks: [{ type: "banner", variant: "error", title: "RedeemID couldn't load this page", description: (e as Error).message }] };
					}
					return { blocks: [] };
				},
			},
		},
	});
}

export default createPlugin;

// ---------------------------------------------------------------- pages

async function memberStores() {
	const { getDb } = await import("emdash/runtime");
	return stores(await getDb());
}

async function allMembers(): Promise<MemberRecord[]> {
	const s = await memberStores();
	const out: MemberRecord[] = [];
	let cursor: string | undefined;
	do {
		const page = await s.members.query({ limit: 100, cursor });
		out.push(...page.items.map((r) => r.data));
		cursor = page.cursor;
	} while (cursor && out.length < 1000);
	return out;
}

async function membersPage(config: RedeemIDConfig) {
	const members = await allMembers();
	const levels = config.levels ?? [];
	const counts = levels.map((l) => ({
		label: l.name,
		value: String(members.filter((m) => m.status === "enabled" && levelsFor(m.tags, levels).includes(l.slug)).length),
	}));
	const name = (m: MemberRecord) => [m.firstName, m.lastName].filter(Boolean).join(" ") || "—";
	const levelNames = (m: MemberRecord) => {
		const held = levelsFor(m.tags, levels);
		return levels.filter((l) => held.includes(l.slug)).map((l) => l.name).join(", ") || "—";
	};
	return {
		blocks: [
			{ type: "header", text: "Members" },
			{
				type: "context",
				text: "Shopify customers who have signed in or that Shopify has sent. Levels come only from their Shopify tags; change tags in Shopify (or with Flow) and access follows.",
			},
			{
				type: "stats",
				items: [
					{ label: "Members", value: String(members.length) },
					{ label: "Turned off", value: String(members.filter((m) => m.status === "disabled").length) },
					...counts,
				],
			},
			members.length === 0
				? { type: "context", text: "No members yet. They appear here after their first sign-in or a Shopify customer webhook." }
				: {
						type: "table",
						page_action_id: "members_page",
						columns: [
							{ key: "name", label: "Name" },
							{ key: "email", label: "Email" },
							{ key: "levels", label: "Levels" },
							{ key: "tags", label: "Shopify tags" },
							{ key: "status", label: "Account" },
							{ key: "synced", label: "Last synced", format: "relative_time" },
						],
						rows: members
							.sort((a, b) => b.syncedAt.localeCompare(a.syncedAt))
							.map((m) => ({
								name: name(m),
								email: m.email ?? "—",
								levels: levelNames(m),
								tags: m.tags.join(", ") || "—",
								status: m.status === "enabled" ? "On" : "Off",
								synced: m.syncedAt,
							})),
					},
		],
	};
}

async function checks(config: RedeemIDConfig) {
	const domain = storeDomain(config);
	let discovery = "Not checked";
	if (domain) {
		discovery = await discover(config)
			.then((d) => `OK (${new URL(d.authorizationEndpoint).host})`)
			.catch((e: Error) => `Failed: ${e.message}`);
	}
	return {
		domain,
		discovery,
		clientId: Boolean(env(ENV.clientId)),
		webhookSecret: Boolean(env(ENV.webhookSecret)),
		storefront: env(ENV.storefrontPrivateToken) ? "Private token" : env(ENV.storefrontPublicToken) ? "Public token" : "None (tokenless)",
	};
}

async function lastDelivery(): Promise<string | null> {
	const s = await memberStores();
	const { items } = await s.deliveries.query({ orderBy: { receivedAt: "desc" }, limit: 1 });
	const d = items[0]?.data;
	return d ? `${d.topic} at ${d.receivedAt}` : null;
}

async function statusPage(config: RedeemIDConfig, request: Request) {
	const c = await checks(config);
	const origin = new URL(request.url).origin;
	const yes = (v: boolean) => (v ? "Set" : "Missing");
	const levels = config.levels ?? [];
	const rules = config.rules ?? [];
	const delivery = await lastDelivery().catch(() => null);
	return {
		blocks: [
			{ type: "header", text: "Status" },
			c.discovery.startsWith("OK") && c.clientId
				? { type: "banner", variant: "default", title: "Sign-in is ready", description: "Members can sign in with their Shopify customer account." }
				: { type: "banner", variant: "alert", title: "Sign-in isn't ready", description: "Set the missing values below as environment secrets, then reload." },
			{
				type: "fields",
				fields: [
					{ label: "Store domain (REDEEMID_SHOPIFY_STORE_DOMAIN or shop)", value: c.domain || "Missing" },
					{ label: "Store discovery", value: c.discovery },
					{ label: "Customer Account API client ID", value: yes(c.clientId) },
					{ label: "Webhook signing secret", value: yes(c.webhookSecret) },
					{ label: "Storefront API access", value: c.storefront },
					{ label: "Last webhook", value: delivery ?? "None received yet" },
				],
			},
			{ type: "divider" },
			{ type: "header", text: "Shopify settings" },
			{
				type: "fields",
				fields: [
					{ label: "Callback URI", value: `${origin}/_emdash/api/auth/redeemid/callback` },
					{ label: "JavaScript origin", value: origin },
					{ label: "Logout URI", value: `${origin}/` },
					{ label: "Webhook URL", value: `${origin}/_emdash/api/auth/redeemid/webhook` },
				],
			},
			{ type: "divider" },
			{ type: "header", text: "Levels" },
			{ type: "context", text: "Set in astro.config.mjs." },
			levels.length
				? {
						type: "table",
						page_action_id: "levels_page",
						columns: [
							{ key: "name", label: "Level" },
							{ key: "tags", label: "Shopify tags" },
							{ key: "match", label: "Needs" },
						],
						rows: levels.map((l) => ({ name: l.name, tags: l.tags.join(", "), match: l.match === "all" ? "All tags" : "Any tag" })),
					}
				: { type: "context", text: "No levels configured." },
			{ type: "header", text: "Rules" },
			rules.length
				? {
						type: "table",
						page_action_id: "rules_page",
						columns: [
							{ key: "where", label: "Covers" },
							{ key: "levels", label: "Who can read" },
						],
						rows: rules.map((r) => ({
							where: r.taxonomy && r.term ? `${r.collection}, ${r.taxonomy}: ${r.term}` : `All ${r.collection}`,
							levels: r.levels.length
								? r.levels.map((s) => levels.find((l) => l.slug === s)?.name ?? s).join(" or ")
								: "Any signed-in member",
						})),
					}
				: { type: "context", text: "No rules. Entries are open unless their body has a paywall break." },
		],
	};
}

async function statusWidget(config: RedeemIDConfig) {
	const c = await checks(config);
	const members = await allMembers().catch(() => []);
	return {
		blocks: [
			{
				type: "fields",
				fields: [
					{ label: "Sign-in", value: c.discovery.startsWith("OK") && c.clientId ? "Ready" : "Not ready" },
					{ label: "Members", value: String(members.length) },
				],
			},
		],
	};
}
