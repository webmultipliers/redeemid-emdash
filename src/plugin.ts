/**
 * RedeemID as an EmDash plugin: what editors and admins see.
 *
 *   emdash({
 *     authProviders: [redeemid(config)],
 *     plugins: [redeemidPlugin(config)],
 *   })
 *
 * It adds four Portable Text blocks to the editor, a Members page, a Status
 * page and a dashboard widget. Sign-in, webhooks and checkout stay on the
 * auth provider's routes.
 *
 * - "Paywall break" (`redeemid-paywall`): everything after it in the body is
 *   for members. Pick the levels that may read on ("Signed in" for any
 *   member); none picked means the entry's rule, and nothing is locked when
 *   no rule covers the entry.
 * - "Members only" (`redeemid-members`) and "Members only: end"
 *   (`redeemid-members-end`): the part between is for the levels picked on
 *   the start block; everyone else sees the wall there and reads on after.
 * - "Plan" (`redeemid-plan`): a Shopify product's title and price with a
 *   button that adds it to the cart and opens checkout.
 *
 * Render bodies with `<Content>` (components/Content.astro), which keeps the
 * part after a paywall break off the page for readers who can't read it.
 */

import type { ResolvedPlugin, RouteContext } from "emdash";
import { definePlugin } from "emdash";

import { describe, levelsFor, SIGNED_IN } from "./access.js";
import { env, ENV, storeDomain, type RedeemIDConfig } from "./config.js";
import { discover } from "./shopify.js";
import { stores, type MemberRecord } from "./storage.js";
import { PAGES, WIDGETS } from "./descriptor.js";
import { VERSION } from "./version.js";
import { adminConfigured } from "./admin-api.js";
import { accessTest, bulkResync, BULK_BATCH, deliveriesSection, memberDetail, registerWebhooks, resyncOne, tagEdit, webhooksSection } from "./staff.js";

import {
	COLLECTION_BLOCK,
	CONTRIBUTION_BLOCK,
	MEMBERS_BLOCK,
	MEMBERS_END_BLOCK,
	PAYWALL_BLOCK,
	PLAN_BLOCK,
	PREFERENCES_BLOCK,
	PRODUCT_BLOCK,
} from "./blocks-names.js";

export { COLLECTION_BLOCK, CONTRIBUTION_BLOCK, MEMBERS_BLOCK, MEMBERS_END_BLOCK, PAYWALL_BLOCK, PLAN_BLOCK, PREFERENCES_BLOCK, PRODUCT_BLOCK };

function blocks(config: RedeemIDConfig) {
	const levelOptions = [
		{ label: "Signed in (any member)", value: SIGNED_IN },
		...(config.levels ?? []).map((l) => ({ label: l.name, value: l.slug })),
	];
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
					label: "Who can read on (none = the entry's rule)",
					options: levelOptions,
				},
			],
		},
		{
			type: MEMBERS_BLOCK,
			label: "Members only",
			icon: "users",
			description: "What follows, up to \"Members only: end\", is for members",
			fields: [
				{
					type: "checkbox" as const,
					action_id: "levels",
					label: "Who can read it (none = the entry's rule, or any signed-in member)",
					options: levelOptions,
				},
			],
		},
		{
			type: MEMBERS_END_BLOCK,
			label: "Members only: end",
			icon: "users",
			description: "Ends the members-only part; everyone reads on from here",
			fields: [],
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
				{
					type: "checkbox" as const,
					action_id: "levels",
					label: "Levels this plan gives (members on them see \"You're on this plan\")",
					options: (config.levels ?? []).map((l) => ({ label: l.name, value: l.slug })),
				},
			],
		},
		{
			type: PRODUCT_BLOCK,
			label: "Product",
			icon: "tag",
			description: "A Shopify product with Add to cart and Buy now",
			placeholder: "Shopify product handle",
			fields: [{ type: "text_input" as const, action_id: "handle", label: "Shopify product handle", placeholder: "harbor-tote" }],
		},
		{
			type: COLLECTION_BLOCK,
			label: "Collection",
			icon: "grid",
			description: "A Shopify collection's products as cards",
			placeholder: "Shopify collection handle",
			fields: [
				{ type: "text_input" as const, action_id: "handle", label: "Shopify collection handle", placeholder: "shop" },
				{ type: "text_input" as const, action_id: "limit", label: "How many products (up to 50)", placeholder: "12" },
				{ type: "text_input" as const, action_id: "link", label: "Product page link, with {handle}", placeholder: "/shop/{handle}/" },
			],
		},
		{
			type: CONTRIBUTION_BLOCK,
			label: "Contribution",
			icon: "star",
			description: "Pay what you want, with a Shopify product priced at 1.00",
			placeholder: "Shopify product handle",
			fields: [
				{ type: "text_input" as const, action_id: "handle", label: "Shopify product handle (priced at 1.00)", placeholder: "support" },
				{ type: "text_input" as const, action_id: "title", label: "Title (optional, Shopify's title otherwise)" },
				{ type: "text_input" as const, action_id: "amounts", label: "Suggested amounts, comma separated", placeholder: "5, 10, 25" },
				{ type: "text_input" as const, action_id: "label", label: "Button label", placeholder: "Give" },
			],
		},
		{
			type: PREFERENCES_BLOCK,
			label: "Preferences",
			icon: "users",
			description: "The signed-in member's preferences, saved on their Shopify customer",
			placeholder: "Member preferences",
			fields: [
				{ type: "text_input" as const, action_id: "title", label: "Title", placeholder: "Your preferences" },
				{ type: "text_input" as const, action_id: "label", label: "Button label", placeholder: "Save preferences" },
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
					const i = (ctx.input ?? {}) as { type?: string; page?: string; action_id?: string; value?: unknown; values?: Record<string, unknown>; block_id?: string };
					try {
						if (i.type === "block_action" || i.type === "form_submit") return await action(config, ctx.request, i);
						if (i.type !== "page_load") return { blocks: [] };
						if (i.page === "/") return await membersPage(config);
						if (i.page === "/status") return await statusPage(config, ctx.request);
						if (i.page === "/test") return await accessTest(config);
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

// ---------------------------------------------------------------- actions

const webhookUri = (request: Request) => `${new URL(request.url).origin}/_emdash/api/auth/redeemid/webhook`;

async function action(
	config: RedeemIDConfig,
	request: Request,
	i: { action_id?: string; value?: unknown; values?: Record<string, unknown>; block_id?: string },
) {
	const s = await memberStores();
	const fail = (e: unknown) => ({ type: "error" as const, message: (e as Error).message });
	switch (i.action_id) {
		case "members_back":
			return membersPage(config);
		case "member_open": {
			const m = await s.members.get(String(i.value ?? ""));
			return m ? memberDetail(config, m) : { ...(await membersPage(config)), toast: { type: "error", message: "That member is gone." } };
		}
		case "member_resync": {
			const id = String(i.value ?? "");
			try {
				const m = await resyncOne(config, s, id, "staff resync");
				const now = m ?? (await s.members.get(id));
				if (!now) return membersPage(config);
				return memberDetail(config, now, m ? { type: "success", message: "Read again from Shopify." } : { type: "error", message: "Shopify no longer has this customer." });
			} catch (e) {
				const m = await s.members.get(id);
				return m ? memberDetail(config, m, fail(e)) : membersPage(config);
			}
		}
		case "member_tag_add":
		case "member_tag_remove": {
			const add = i.action_id === "member_tag_add";
			const v = (i.value ?? {}) as { customerId?: string; tag?: string };
			const id = add ? String(i.block_id ?? "").replace(/^tags:/, "") : String(v.customerId ?? "");
			try {
				const m = await tagEdit(config, s, id, add ? "add" : "remove", add ? i.values?.tags : [v.tag]);
				const now = m ?? (await s.members.get(id));
				return now ? memberDetail(config, now, { type: "success", message: add ? "Tags added in Shopify." : "Tag removed in Shopify." }) : membersPage(config);
			} catch (e) {
				const m = await s.members.get(id);
				return m ? memberDetail(config, m, fail(e)) : membersPage(config);
			}
		}
		case "members_resync": {
			try {
				const r = await bulkResync(config, s);
				return {
					...(await membersPage(config)),
					toast: { type: "success", message: `Read ${r.done} members again (${r.changed} changed${r.missing ? `, ${r.missing} no longer in Shopify` : ""}).` },
				};
			} catch (e) {
				return { ...(await membersPage(config)), toast: fail(e) };
			}
		}
		case "webhooks_register": {
			try {
				const added = await registerWebhooks(config, webhookUri(request));
				return { ...(await statusPage(config, request)), toast: { type: "success", message: added.length ? `Registered ${added.length} webhooks.` : "Nothing was missing." } };
			} catch (e) {
				return { ...(await statusPage(config, request)), toast: fail(e) };
			}
		}
		case "access_test":
			return accessTest(config, i.values);
	}
	return { blocks: [] };
}

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
			adminConfigured()
				? {
						type: "actions",
						elements: [
							{
								type: "button",
								action_id: "members_resync",
								label: `Resync ${BULK_BATCH} from Shopify`,
								style: "secondary",
								confirm: {
									title: "Read members again from Shopify?",
									text: `Reads the ${BULK_BATCH} members synced longest ago from Shopify and updates their tags. Click again for the next ${BULK_BATCH}.`,
									confirm: "Resync",
									deny: "Cancel",
								},
							},
						],
					}
				: { type: "context", text: "Set the Admin API app's client ID (REDEEMID_SHOPIFY_ADMIN_APP_CLIENT_ID) to resync members and edit their tags from here." },
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
							{ key: "open", label: "", format: "element" },
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
								open: { type: "button", action_id: "member_open", label: "Open", value: m.customerId },
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
	const webhooks = await webhooksSection(config, webhookUri(request));
	const deliveries = await memberStores()
		.then((s) => deliveriesSection(s))
		.catch(() => [{ type: "context", text: "Couldn't read deliveries." }]);
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
					{ label: "Admin API app client ID (staff tools)", value: yes(Boolean(env(ENV.adminClientId))) },
					{ label: "Events", value: config.events?.url ? `${config.events.url}${env(ENV.eventsSecret) ? "" : " (REDEEMID_EVENTS_SECRET missing)"}` : "Off" },
					{ label: "Storefront API access", value: c.storefront },
					{ label: "Last webhook", value: delivery ?? "None received yet" },
				],
			},
			{ type: "divider" },
			{ type: "header", text: "Webhooks" },
			...webhooks,
			{ type: "header", text: "Recent deliveries" },
			...deliveries,
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
							{ key: "extra", label: "Drip and meter" },
						],
						rows: rules.map((r) => ({
							where:
								r.taxonomy && r.term
									? `${r.collection === "*" ? "Every collection" : r.collection}, ${r.taxonomy}: ${r.term} (and its child terms)`
									: r.collection === "*"
										? "Site default (collections with no rule)"
										: `All ${r.collection}`,
							levels: r.open ? "Everyone (opens the entry)" : r.levels.length ? describe([r.levels], levels) : "Any signed-in member",
							extra: [r.drip ? `Opens ${r.drip} days into membership` : "", r.meter === false ? "Never metered" : ""].filter(Boolean).join("; "),
						})),
					}
				: { type: "context", text: "No rules. Entries are open unless their body has a paywall break." },
			{
				type: "context",
				text: config.meter?.limit
					? `Meter: signed-in readers may open ${config.meter.limit} locked ${config.meter.limit === 1 ? "entry" : "entries"} a ${config.meter.period ?? "month"}${config.meter.collections?.length ? ` (${config.meter.collections.join(", ")})` : ""}.`
					: "Meter: off.",
			},
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
