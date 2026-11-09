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

import { describe, levelsFor, SIGNED_IN, type Terms } from "./access.js";
import { accessAction, accessPage, entryPanel, entrySave, entrySlugChanged, isAccessAction, type AccessEnv, type PanelEntry } from "./access-admin.js";
import { entryKey, loadAccess, onLevels, withSaved } from "./settings.js";
import { env, ENV, storeDomain, unknownEnvNames, type LevelConfig, type RedeemIDConfig } from "./config.js";
import { discover } from "./shopify.js";
import { stores, type MemberRecord, type Stores } from "./storage.js";
import { EDITOR_PANELS, PAGES, WIDGETS } from "./descriptor.js";
import { VERSION } from "./version.js";
import { AdminError, adminConfigured } from "./admin-api.js";
import { cancelShopifyErasure, closeRequest, eraseMember, exportMember, exportRequest, requestShopifyErasure } from "./privacy.js";
import { accessTest, bulkResync, BULK_BATCH, deliveriesSection, exportBlocks, memberDetail, privacyPage, registerWebhooks, resyncOne, tagEdit, webhooksSection } from "./staff.js";
import { textProblems } from "./text.js";
import { z } from "astro/zod";
import { AgentError, explainAccess, getMember, getRules, levelChanges, listLevels, siteHealth, type ExplainInput } from "./agents.js";

import {
	COLLECTION_BLOCK,
	CONTRIBUTION_BLOCK,
	ITEM_BLOCK,
	MEMBERS_BLOCK,
	MEMBERS_END_BLOCK,
	PAYWALL_BLOCK,
	PLAN_BLOCK,
	PREFERENCES_BLOCK,
	PRODUCT_BLOCK,
} from "./blocks-names.js";

export { COLLECTION_BLOCK, CONTRIBUTION_BLOCK, ITEM_BLOCK, MEMBERS_BLOCK, MEMBERS_END_BLOCK, PAYWALL_BLOCK, PLAN_BLOCK, PREFERENCES_BLOCK, PRODUCT_BLOCK };

/**
 * The editor's level pickers. Declared once when the plugin starts, then kept
 * in step (in place) with the levels saved in the admin: EmDash builds the
 * editor's manifest from these same arrays on each request.
 */
const levelOptions: Array<{ label: string; value: string }> = [];
const planLevelOptions: Array<{ label: string; value: string }> = [];

export function setLevelOptions(levels: LevelConfig[] = []): void {
	const mine = levels.map((l) => ({ label: l.name, value: l.slug }));
	levelOptions.splice(0, levelOptions.length, { label: "Signed in (any member)", value: SIGNED_IN }, ...mine);
	planLevelOptions.splice(0, planLevelOptions.length, ...mine);
}

function blocks(config: RedeemIDConfig) {
	setLevelOptions(config.levels);
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
			type: ITEM_BLOCK,
			label: "Sold on its own",
			icon: "tag",
			description: "Buyers of this entry read all of it, whatever its levels say",
			fields: [
				{ type: "text_input" as const, action_id: "tag", label: "Shopify customer tag buyers get", placeholder: "item-big-story" },
				{ type: "text_input" as const, action_id: "product", label: "Shopify product that sells it (handle or link)", placeholder: "the-big-story" },
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
				{
					type: "checkbox" as const,
					action_id: "levels",
					label: "Levels this plan gives (members on them see \"You're on this plan\")",
					options: planLevelOptions,
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

export function createPlugin(code: RedeemIDConfig = {}): ResolvedPlugin {
	onLevels(setLevelOptions);
	const live = () => liveConfig(code);
	return definePlugin({
		id: "redeemid",
		version: VERSION,
		// content:read: the editor's Access panel reads the entry, and its
		// rule follows the entry's slug and goes with the entry.
		capabilities: ["content:read"],
		admin: {
			pages: PAGES,
			widgets: WIDGETS,
			editorPanels: EDITOR_PANELS,
			portableTextBlocks: blocks(code),
		},
		mcp: agentTools(code),
		hooks: {
			"content:afterSave": async (event) => {
				const id = typeof event.content.id === "string" ? event.content.id : null;
				if (!id) return;
				const slug = typeof event.content.slug === "string" ? event.content.slug : null;
				await entrySlugChanged((await memberStores()).access, event.collection, id, slug).catch(() => undefined);
			},
			"content:afterDelete": async (event) => {
				if (!event.permanent) return;
				await (await memberStores()).access.delete(entryKey(event.id)).catch(() => undefined);
			},
		},
		routes: {
			...agentRoutes(code),
			"access-panel": {
				permission: "content:edit_own",
				request: { body: "json" as const },
				handler: async (ctx: RouteContext) => {
					const i = (ctx.input ?? {}) as { type?: string; action_id?: string; values?: Record<string, unknown> };
					const entry = ctx.ui && "entry" in ctx.ui ? ctx.ui.entry : undefined;
					if (!entry) return { blocks: [{ type: "context", text: "Save the entry first." }] };
					try {
						const env = await accessEnv(await live());
						const panel = await panelEntry(ctx, entry.collection, entry.id);
						if (i.type === "form_submit" && i.action_id === "entry_save") return await entrySave(env, panel, i.values ?? {});
						return await entryPanel(env, panel);
					} catch (e) {
						return { blocks: [{ type: "banner", variant: "error", title: "RedeemID couldn't load access", description: (e as Error).message }] };
					}
				},
			},
			admin: {
				handler: async (ctx: RouteContext) => {
					const i = (ctx.input ?? {}) as { type?: string; page?: string; action_id?: string; value?: unknown; values?: Record<string, unknown>; block_id?: string };
					try {
						const config = await live();
						if ((i.type === "block_action" || i.type === "form_submit") && isAccessAction(i.action_id)) return await accessAction(await accessEnv(config), i);
						if (i.type === "block_action" || i.type === "form_submit") return await action(config, ctx.request, i);
						if (i.type !== "page_load") return { blocks: [] };
						if (i.page === "/") return await membersPage(config);
						if (i.page === "/access") return await accessPage(await accessEnv(config));
						if (i.page === "/status") return await statusPage(config, ctx.request);
						if (i.page === "/test") return await accessTest(config);
						if (i.page === "/privacy") return await privacyPage(await memberStores());
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

/** The code's config with what the admin saved. */
async function liveConfig(code: RedeemIDConfig): Promise<RedeemIDConfig> {
	const { getDb } = await import("emdash/runtime");
	return (await withSaved(code, await getDb())) ?? code;
}

/** Everything the Access screens read: saved settings and the site's content types and taxonomies, as they are now. */
async function accessEnv(config: RedeemIDConfig): Promise<AccessEnv> {
	const { getDb } = await import("emdash/runtime");
	const db = await getDb();
	const store = stores(db).access;
	const emdash = await import("emdash");
	const collections = (await new emdash.SchemaRegistry(db as never).listCollections()) as Array<{ slug: string; label: string }>;
	const taxonomies = (await emdash.getTaxonomyDefs()) as Array<{ name: string; label: string; collections: string[] }>;
	return {
		code: config,
		store,
		saved: await loadAccess(store),
		collections: collections.map((c) => ({ slug: c.slug, label: c.label || c.slug })),
		taxonomies: taxonomies.map((t) => ({ name: t.name, label: t.label || t.name, collections: t.collections ?? [] })),
		terms: async (taxonomy) => {
			type Node = { slug: string; label?: string; name?: string; children?: Node[] };
			const out: Array<{ slug: string; label: string }> = [];
			const walk = (list: Node[], path: string) =>
				list.forEach((n) => {
					const label = `${path}${n.label || n.slug}`;
					out.push({ slug: n.slug, label });
					walk(n.children ?? [], `${label} › `);
				});
			walk((await emdash.getTaxonomyTerms(taxonomy)) as Node[], "");
			return out;
		},
	};
}

/** The saved entry the editor's panel is on: its slug and terms. */
async function panelEntry(ctx: RouteContext, collection: string, id: string): Promise<PanelEntry> {
	const item = await ctx.content?.get(collection, id).catch(() => null);
	const emdash = await import("emdash");
	const terms: Terms = {};
	for (const t of (await emdash.getTaxonomyDefs()) as Array<{ name: string; collections: string[] }>) {
		if (!(t.collections ?? []).includes(collection)) continue;
		const list = (await emdash.getEntryTerms(collection, id, t.name)) as Array<{ slug: string; id: string; parentId?: string }>;
		if (list.length) terms[t.name] = list.map((x) => ({ slug: x.slug, id: x.id, parentId: x.parentId ?? null }));
	}
	return { collection, id, slug: item?.slug ?? null, terms };
}

export default createPlugin;

// ---------------------------------------------------------------- agents and CLI

const STAFF = "users:read" as const;

/** Staff-only JSON routes, also offered as MCP tools. */
function agentRoutes(code: RedeemIDConfig) {
	let config = code;
	const run = (fn: (s: Stores, input: Record<string, unknown>) => Promise<unknown> | unknown) => async (ctx: RouteContext) => {
		try {
			config = await liveConfig(code);
			return { ok: true, result: await fn(await memberStores(), (ctx.input ?? {}) as Record<string, unknown>) };
		} catch (e) {
			if (e instanceof AgentError || e instanceof AdminError) return { ok: false, error: e.message };
			throw e;
		}
	};
	const route = (input: z.ZodType, fn: Parameters<typeof run>[0]) => ({ permission: STAFF, input, request: { body: "json" as const }, handler: run(fn) });
	const read = {
		"explain-access": route(EXPLAIN, (s, i) => explainAccess(config, s, i as unknown as ExplainInput)),
		"list-levels": route(EMPTY, () => listLevels(config)),
		"get-rules": route(EMPTY, () => getRules(config)),
		"get-member": route(MEMBER, (s, i) => getMember(config, s, i as { customerId?: string; email?: string })),
		"site-health": route(EMPTY, (s) => siteHealth(config, s)),
		"level-changes": route(CHANGES, (s, i) => levelChanges(config, s, i as { since: string; level?: string })),
	};
	if (!code.agents?.actions) return read;
	return {
		...read,
		"resync-member": route(CUSTOMER, async (s, i) => {
			const m = await resyncOne(config, s, String(i.customerId), "agent resync");
			if (!m) throw new AgentError("Shopify no longer has this customer");
			return getMember(config, s, { customerId: m.customerId });
		}),
		"resync-batch": route(EMPTY, (s) => bulkResync(config, s)),
		"edit-member-tags": route(TAGS, async (s, i) => {
			const id = String(i.customerId);
			const add = (i.add as string[] | undefined) ?? [];
			const remove = (i.remove as string[] | undefined) ?? [];
			if (add.length) await tagEdit(config, s, id, "add", add);
			if (remove.length) await tagEdit(config, s, id, "remove", remove);
			return getMember(config, s, { customerId: id });
		}),
	};
}

const EMPTY = z.object({});
const EXPLAIN = z.object({
	collection: z.string().min(1).describe("Collection slug, e.g. posts"),
	id: z.string().optional().describe("An entry's id or slug; its terms and body are read from the site"),
	terms: z.record(z.string(), z.array(z.string())).optional().describe('Terms by taxonomy when no id is given, e.g. {"category":["investigations"]}'),
	tags: z.array(z.string()).optional().describe("The reader's Shopify customer tags"),
	customerId: z.string().optional().describe("A real member's Shopify customer id, in place of tags"),
	signedIn: z.boolean().optional().describe("false for a signed-out visitor (default true)"),
});
const MEMBER = z.object({ customerId: z.string().optional(), email: z.string().optional() });
const CUSTOMER = z.object({ customerId: z.string().min(1).describe("Shopify customer id") });
const CHANGES = z.object({ since: z.string().describe("A date, e.g. 2026-11-01"), level: z.string().optional().describe("Only this level slug") });
const TAGS = z.object({
	customerId: z.string().min(1).describe("Shopify customer id"),
	add: z.array(z.string()).optional().describe("Tags to add in Shopify"),
	remove: z.array(z.string()).optional().describe("Tags to remove in Shopify"),
});

/** MCP tools for the routes above. Staff turn them on for RedeemID under Plugins. */
function agentTools(config: RedeemIDConfig) {
	const tools: Record<string, { description: string; route: string; input: z.ZodType; destructive?: boolean }> = {
		explain_access: { route: "explain-access", input: EXPLAIN, description: "Can this reader read this entry, and why? Give the entry by collection and id (or terms), and the reader by Shopify tags, a member's customer id, or signedIn:false. Answers what the entry needs, the reader's levels, the result, the level a locked reader is offered, and each members-only part." },
		list_levels: { route: "list-levels", input: EMPTY, description: "Every membership level: slug, name, the Shopify tags that grant it (any or all), wall text and join link." },
		get_rules: { route: "get-rules", input: EMPTY, description: "The paywall rules: how they combine, each rule (collection, term, levels, drip, open), the meter, teasers, features and protected-file rules." },
		get_member: { route: "get-member", input: MEMBER, description: "One synced member by Shopify customer id or email: status, tags, current levels with start dates, past levels, features and last sync." },
		site_health: { route: "site-health", input: EMPTY, description: "Whether each setting is in place (never the values), the last webhook, open privacy requests and ignored text replacements." },
		level_changes: { route: "level-changes", input: CHANGES, description: "Who joined or left a level since a date, from each member's tag dates." },
	};
	if (config.agents?.actions) {
		tools.resync_member = { route: "resync-member", input: CUSTOMER, description: "Read one member from Shopify now and update the site. Changes nothing in Shopify." };
		tools.resync_batch = { route: "resync-batch", input: EMPTY, description: `Read the ${BULK_BATCH} members synced longest ago from Shopify. Run again for the next ${BULK_BATCH}.` };
		tools.edit_member_tags = { route: "edit-member-tags", input: TAGS, destructive: true, description: "Add or remove tags on a member's Shopify customer, then read back what Shopify holds. Access follows from Shopify." };
	}
	return { tools };
}

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
				const { added, failed } = await registerWebhooks(config, webhookUri(request));
				const done = added.length ? `Registered ${added.length} webhooks.` : failed.length ? "" : "Nothing was missing.";
				const refused = failed.map((f) => `Shopify refused ${f.topic}: ${f.message}`).join(" ");
				return { ...(await statusPage(config, request)), toast: { type: failed.length ? "error" : "success", message: [done, refused].filter(Boolean).join(" ") } };
			} catch (e) {
				return { ...(await statusPage(config, request)), toast: fail(e) };
			}
		}
		case "access_test":
			return accessTest(config, i.values);
		case "member_export": {
			const id = String(i.value ?? "");
			const m = await s.members.get(id);
			if (!m) return membersPage(config);
			return exportBlocks(memberDetail(config, m, { type: "success", message: "Export below." }), await exportRequest(s, id, "staff"));
		}
		case "member_erase": {
			const id = String(i.value ?? "");
			await eraseMember(config, s, id, "staff");
			return { ...(await membersPage(config)), toast: { type: "success", message: "Erased from the site." } };
		}
		case "member_shopify_erase":
		case "member_shopify_cancel": {
			const id = String(i.value ?? "");
			const m = await s.members.get(id);
			try {
				if (i.action_id === "member_shopify_erase") await requestShopifyErasure(config, s, id);
				else await cancelShopifyErasure(config, s, id);
				const message = i.action_id === "member_shopify_erase" ? "Shopify will erase the customer after its waiting period." : "The Shopify erasure is cancelled.";
				return m ? memberDetail(config, m, { type: "success", message }) : privacyPage(s, { type: "success", message });
			} catch (e) {
				return m ? memberDetail(config, m, fail(e)) : privacyPage(s, fail(e));
			}
		}
		case "privacy_done": {
			const r = await closeRequest(s, String(i.value ?? ""));
			if (r?.kind === "export" && r.customerId) {
				const data = await exportMember(s, r.customerId);
				return privacyPage(s, { type: "success", message: "Marked done. Send the export below to the store owner." }, [
					{ type: "header", text: `Export for customer ${r.customerId}` },
					{ type: "code", language: "jsonc", code: JSON.stringify(data, null, 2) },
				]);
			}
			return privacyPage(s, { type: "success", message: "Marked done." });
		}
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

function textSummary(config: RedeemIDConfig): string {
	const all = Object.keys(config.text ?? {}).length;
	const ignored = textProblems(config).length;
	if (!all) return "None";
	return ignored ? `${all - ignored} in use, ${ignored} ignored` : `${all} in use`;
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
					{ label: "Replacement text", value: textSummary(config) },
					...(unknownEnvNames().length ? [{ label: "Set but not used (check the name)", value: unknownEnvNames().join(", ") }] : []),
				],
			},
			...(textProblems(config).length
				? [
						{
							type: "table",
							page_action_id: "text_problems",
							columns: [
								{ key: "original", label: "Ignored replacement for" },
								{ key: "problem", label: "Why" },
							],
							rows: textProblems(config),
						},
					]
				: []),
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
			{ type: "context", text: "Change levels and rules under Access." },
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
