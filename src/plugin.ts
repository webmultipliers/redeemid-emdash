/**
 * RedeemID as an EmDash plugin: what editors and admins see.
 *
 *   emdash({
 *     authProviders: [redeemid(config)],
 *     plugins: [redeemidPlugin(config)],
 *   })
 *
 * It adds Portable Text blocks to the editor, an Access panel on every entry,
 * admin pages (Overview, Members, Products, Access, Reports, Events, Privacy,
 * Connection), a daily webhook health check and a dashboard
 * widget. The pages are Block Kit built here; admin.ts renders them in the
 * browser. Sign-in, webhooks and checkout stay on the auth provider's routes.
 *
 * - "Paywall break" (`redeemid-paywall`): marks where the entry's rule starts.
 *   Everything before it is for everyone; everything after it follows the
 *   entry's rule, and nothing is locked when no rule covers the entry.
 * - "Members only" (`redeemid-members`) and "Members only: end"
 *   (`redeemid-members-end`): the part between is for the levels picked on
 *   the start block; everyone else sees the wall there and reads on after.
 * - "Plan" (`redeemid-plan`): a Shopify product's title and price with a
 *   button that adds it to the cart and opens checkout.
 *
 * Render bodies with `<Content>` (components/Content.astro), which keeps the
 * part after a paywall break off the page for readers who can't read it.
 */

import type { PluginContext, ResolvedPlugin, RouteContext } from "emdash";
import { definePlugin } from "emdash";

import { levelsFor, SIGNED_IN, topLevels, type Terms } from "./access.js";
import { accessLabels, parseColumnInput } from "./access-column.js";
import { accessAction, accessPage, entryPanel, entrySave, entrySlugChanged, isAccessAction, type AccessEnv, type PanelEntry } from "./access-admin.js";
import { deleteAccess, entryKey, loadAccess, onLevels, withSaved } from "./settings.js";
import { env, ENV, shopOrigin, storeDomain, unknownEnvNames, type LevelConfig, type RedeemIDConfig } from "./config.js";
import { discover } from "./shopify.js";
import { stores, type MemberRecord, type Stores } from "./storage.js";
import { CONNECTION_TABS, EDITOR_PANELS, EVENTS_TABS, OVERVIEW, PAGES, WIDGETS } from "./descriptor.js";
import { VERSION } from "./version.js";
import { AdminError, adminConfigured } from "./admin-api.js";
import { cancelShopifyErasure, closeRequest, eraseMember, exportMember, exportRequest, recentRequests, requestShopifyErasure } from "./privacy.js";
import { loadRun, runBlock, runText, startRun, stepRun, stopRun, type RunKv, type RunLabels } from "./runs.js";
import { resourcesPage } from "./resources.js";
import { bulkResync, BULK_BATCH, memberDetail, resyncBatch, resyncTotal, privacyPage, registerWebhooks, resyncOne, staffLink, staffUnlink, tagEdit } from "./staff.js";
import { textProblems } from "./text.js";
import { cacheFindings, gatedFindings, templateFindings } from "./template-scan.js";
import { nextStep, requiredSteps, setupFacts, setupSteps, statusCards, storeTab, webhooksStep, WEBHOOK } from "./setup.js";
import { record } from "./log.js";
import { resend } from "./events.js";
import { eventRow, eventsPage, healthCheck, HEALTH_TASK, lastCheck, parseFilter, reportsPage, saveMonitor, WEBHOOK_PATH, webhookPanels, type MonitorEnv } from "./monitor.js";
import { z } from "astro/zod";
import { productMetadata, type PageForSchema } from "./product-schema.js";
import { browseProducts, contentEntries, guardSave, productOptions, productsCollection, readProduct } from "./products.js";
import { isProductsAction, productsAction, productsPage, type ProductsEnv } from "./products-admin.js";
import { AgentError, explainAccess, findProducts, getCollection, getMember, getProduct, getRules, levelChanges, listLevels, siteHealth, type ExplainInput } from "./agents.js";

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
	SEARCH_BLOCK,
} from "./blocks-names.js";

export { COLLECTION_BLOCK, CONTRIBUTION_BLOCK, ITEM_BLOCK, MEMBERS_BLOCK, MEMBERS_END_BLOCK, PAYWALL_BLOCK, PLAN_BLOCK, PREFERENCES_BLOCK, PRODUCT_BLOCK, SEARCH_BLOCK };

/**
 * The editor's level pickers. Declared once when the plugin starts, then kept
 * in step (in place) with the levels saved in the admin: EmDash builds the
 * editor's manifest from these same arrays on each request.
 */
const levelOptions: Array<{ label: string; value: string }> = [];
const planLevelOptions: Array<{ label: string; value: string }> = [];

export function setLevelOptions(levels: LevelConfig[] = []): void {
	const mine = levels.map((l) => ({ label: l.name, value: l.slug }));
	levelOptions.splice(0, levelOptions.length, { label: "Signed in (any customer)", value: SIGNED_IN }, ...mine);
	planLevelOptions.splice(0, planLevelOptions.length, ...mine);
}

function blocks(config: RedeemIDConfig) {
	setLevelOptions(config.levels);
	return [
		{
			type: PAYWALL_BLOCK,
			label: "Paywall break",
			icon: "lock",
			description: "Everyone reads up to here; the rest follows this entry's access rule",
			fields: [],
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
					label: "Who can read it (none = the entry's rule, or any signed-in customer)",
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
			fields: [
				// Filled from the site's product entries (Plugins → RedeemID → Products) on each admin load.
				{ type: "combobox" as const, action_id: "pick", label: "Product from the catalog", options: productOptions() },
				{ type: "text_input" as const, action_id: "handle", label: "Or a Shopify product handle", placeholder: "harbor-tote" },
			],
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
				{
					type: "checkbox" as const,
					action_id: "extras",
					label: "Extras",
					options: [
						{ label: "Filters, sorting and pages (the page must render on demand)", value: "browse" },
						{ label: "Add to cart on cards that need no choice", value: "quick-add" },
					],
				},
			],
		},
		{
			type: SEARCH_BLOCK,
			label: "Product search",
			icon: "search",
			description: "A search box with Shopify's matching products, filters and sorting",
			placeholder: "Product search",
			fields: [
				{ type: "text_input" as const, action_id: "link", label: "Product page link, with {handle}", placeholder: "/shop/{handle}/" },
				{ type: "text_input" as const, action_id: "label", label: "Search box label", placeholder: "Search products" },
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
		// content:write: product entries keep Shopify's fields on save (content:beforeSave).
		// email:send: the daily webhook check can warn staff by email.
		capabilities: ["content:read", "content:write", "email:send"],
		// No admin.entry here: EmDash turns off Block Kit editor panels for a
		// plugin with one. The descriptor's adminEntry alone loads admin.ts,
		// which renders the pages; the Access panel stays Block Kit.
		admin: {
			pages: PAGES,
			widgets: WIDGETS,
			editorPanels: EDITOR_PANELS,
			portableTextBlocks: blocks(code),
		},
		mcp: agentTools(code),
		hooks: {
			"plugin:activate": async (_event, ctx) => {
				await scheduleHealth(ctx);
			},
			cron: async (event, ctx) => {
				if (event.name !== HEALTH_TASK) return;
				await healthCheck(monitorEnv(await live(), await memberStores(), ctx));
			},
			// Product entries' own pages get Product structured data in <EmDashHead>, from Shopify's fields.
			"page:metadata": async (event: { page: PageForSchema & { kind: string } }) => {
				const page = event.page;
				const collection = productsCollection(code);
				if (page.kind !== "content" || !collection || page.content?.collection !== collection) return null;
				const config = await live();
				if (config.schema === false) return null;
				const { getDb } = await import("emdash/runtime");
				const entry = await contentEntries(await getDb(), collection).byId(page.content.id).catch(() => null);
				return entry && entry.status === "published" ? productMetadata(page, entry.data) : null;
			},
			"content:beforeSave": async (event) => {
				// Product entries: only Shopify changes Shopify's fields.
				if (event.collection !== productsCollection(code)) return;
				const config = await live();
				const { getDb } = await import("emdash/runtime");
				const db = await getDb();
				const existing = event.id ? await contentEntries(db, event.collection).byId(event.id).catch(() => null) : null;
				return guardSave(event.content, existing?.data ?? null, (handle) => readProduct(config, { handle }));
			},
			"content:afterSave": async (event) => {
				const id = typeof event.content.id === "string" ? event.content.id : null;
				if (!id) return;
				const slug = typeof event.content.slug === "string" ? event.content.slug : null;
				await entrySlugChanged((await memberStores()).access, event.collection, id, slug).catch(() => undefined);
			},
			"content:afterDelete": async (event) => {
				const store = (await memberStores()).access;
				// Trashed: the rule waits (by id) for a restore, without the slug.
				if (!event.permanent) return entrySlugChanged(store, null, event.id, null).catch(() => undefined);
				if (await store.get(entryKey(event.id)).catch(() => null)) await deleteAccess(store, entryKey(event.id)).catch(() => undefined);
			},
			"content:afterRestore": async (event) => {
				const id = typeof event.content.id === "string" ? event.content.id : null;
				const slug = typeof event.content.slug === "string" ? event.content.slug : null;
				if (id) await entrySlugChanged((await memberStores()).access, event.collection, id, slug).catch(() => undefined);
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
						if (i.type === "form_submit" && i.action_id === "entry_save") {
							const out = await entrySave(env, panel, i.values ?? {});
							await record({ event: "settings.saved", label: `entry rule (${entry.collection})`, status: "ok", origin: "staff" });
							return out;
						}
						return await entryPanel(env, panel);
					} catch (e) {
						return { blocks: [{ type: "banner", variant: "error", title: "RedeemID couldn't load access", description: (e as Error).message }] };
					}
				},
			},
			// The Shopify product field widget (admin.ts `fields.product`): search the store's products.
			"product-picker": {
				permission: "content:edit_own",
				request: { body: "json" as const },
				handler: async (ctx: RouteContext) => {
					const raw = (ctx.input ?? {}) as { query?: unknown; after?: unknown };
					const query = typeof raw.query === "string" ? raw.query.slice(0, 100) : "";
					const after = typeof raw.after === "string" ? raw.after.slice(0, 500) : null;
					try {
						const page = await browseProducts(await live(), { query, after }, 10);
						return { items: page.items.map((p) => ({ handle: p.handle, title: p.title, image: p.image_url, price: p.price, currency: p.currency, available: p.available })), next: page.next };
					} catch (e) {
						return { items: [], next: null, error: (e as Error).message };
					}
				},
			},
			// The Access column in content lists (admin.ts): one ask per page of rows.
			"access-list": {
				permission: "content:edit_own",
				request: { body: "json" as const },
				handler: async (ctx: RouteContext) => {
					const ask = parseColumnInput(ctx.input);
					if (!ask) return { labels: {} };
					const emdash = await import("emdash");
					const labels = await accessLabels(await live(), ask.collection, ask.ids, async (ids) => {
						const all = (await emdash.getAllTermsForEntries(ask.collection, ids)) as Map<string, Record<string, Array<{ slug: string; id: string; parentId?: string }>>>;
						return new Map([...all].map(([id, byTax]) => [id, Object.fromEntries(Object.entries(byTax).map(([tax, list]) => [tax, list.map((t) => ({ slug: t.slug, id: t.id, parentId: t.parentId ?? null }))]))]));
					});
					return { labels };
				},
			},
			admin: {
				handler: async (ctx: RouteContext) => {
					const i = (ctx.input ?? {}) as { type?: string; page?: string; action_id?: string; value?: unknown; values?: Record<string, unknown>; block_id?: string };
					try {
						const config = await live();
						if ((i.type === "block_action" || i.type === "form_submit") && isAccessAction(i.action_id)) {
							const out = await accessAction(await accessEnv(config), i);
							if (out.toast?.type === "success") await record({ event: "settings.saved", label: `access: ${String(i.action_id).replace(/_/g, " ")}`, status: "ok", origin: "staff" });
							return out;
						}
						if ((i.type === "block_action" || i.type === "form_submit") && isProductsAction(i.action_id)) return await productsAction(await productsEnv(config, ctx), i);
						if ((i.type === "block_action" || i.type === "form_submit") && isSetupAction(i.action_id)) return await setupAction(config, live, ctx, i);
						if (i.type === "block_action" || i.type === "form_submit") return await action(config, ctx, i);
						if (i.type !== "page_load") return { blocks: [] };
						if (i.page === OVERVIEW) return await overviewPage(config, ctx);
						if (i.page === "/customers") return await customersPage(config, ctx.kv);
						if (i.page === "/resources") return resourcesPage(config);
						if (i.page === "/products") return await productsPage(await productsEnv(config, ctx));
						if (i.page === "/access") return await accessPage(await accessEnv(config));
						if (i.page === "/reports") return await reportsPage(config, await memberStores());
						// Connection and Events, or one of their tabs by address (/connection/store, /events/app).
						if (i.page === "/connection" || i.page?.startsWith("/connection/")) {
							await scheduleHealth(ctx);
							return await connectionPage(config, ctx, tabOf(CONNECTION_TABS, i.page.split("/")[2]));
						}
						if (i.page === "/events" || i.page?.startsWith("/events/")) {
							await scheduleHealth(ctx);
							return await eventsAdminPage(config, ctx, tabOf(EVENTS_TABS, i.page.split("/")[2]));
						}
						if (i.page === "/privacy") return await privacyPage(await memberStores());
						if (i.page === "widget:status") return await statusWidget(config, ctx);
					} catch (e) {
						return { blocks: [{ type: "banner", variant: "error", title: "RedeemID couldn't load this page", description: (e as Error).message }] };
					}
					return { blocks: [] };
				},
			},
		},
	});
}

/** What the Products page works with. */
async function productsEnv(config: RedeemIDConfig, ctx: PluginContext): Promise<ProductsEnv> {
	const { getDb } = await import("emdash/runtime");
	return { config, db: await getDb(), kv: ctx.kv as ProductsEnv["kv"], webhookUri: ctx.url(WEBHOOK_PATH) };
}

/** What the Webhooks page and the daily check work with. */
function monitorEnv(config: RedeemIDConfig, s: Stores, ctx: PluginContext): MonitorEnv {
	return { config, s, kv: ctx.kv, uri: ctx.url(WEBHOOK_PATH), email: ctx.email };
}

/** Make sure the daily webhook check is scheduled (on Workers it runs from the site's Cron Trigger). */
async function scheduleHealth(ctx: PluginContext): Promise<void> {
	try {
		if (!ctx.cron) return;
		const tasks = await ctx.cron.list();
		if (!tasks.some((t) => t.name === HEALTH_TASK)) await ctx.cron.schedule(HEALTH_TASK, { schedule: "@daily" });
	} catch {
		// Scheduling is best effort; Check now still works.
	}
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
		holders: async () => {
			const levels = config.levels ?? [];
			const out: Record<string, number> = Object.fromEntries(levels.map((l) => [l.slug, 0]));
			for (const m of await allMembers()) if (m.status === "enabled") for (const slug of levelsFor(m.tags, levels)) out[slug] = (out[slug] ?? 0) + 1;
			return out;
		},
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
		"find-products": route(FIND, (_s, i) => findProducts(config, i as { query: string; first?: number })),
		"get-product": route(HANDLE, (_s, i) => getProduct(config, i as { handle: string })),
		"get-collection": route(COLLECTION, (_s, i) => getCollection(config, i as { handle: string; first?: number })),
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
const FIND = z.object({ query: z.string().min(1).describe("Search words, e.g. tote"), first: z.number().int().min(1).max(25).optional().describe("How many (default 10)") });
const HANDLE = z.object({ handle: z.string().min(1).describe("Shopify product handle") });
const COLLECTION = z.object({ handle: z.string().min(1).describe("Shopify collection handle"), first: z.number().int().min(1).max(50).optional().describe("How many products (default 25)") });
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
		find_products: { route: "find-products", input: FIND, description: "Search the Shopify catalog the site sells: handles, titles, prices and availability. Use the handles in Product, Plan and Collection blocks." },
		get_product: { route: "get-product", input: HANDLE, description: "One Shopify product by handle: options, variants with prices and stock, selling plans (subscriptions) and image count." },
		get_collection: { route: "get-collection", input: COLLECTION, description: "One Shopify collection by handle: its products, prices and the filters Shopify offers for it." },
	};
	if (config.agents?.actions) {
		tools.resync_member = { route: "resync-member", input: CUSTOMER, description: "Read one member from Shopify now and update the site. Changes nothing in Shopify." };
		tools.resync_batch = { route: "resync-batch", input: EMPTY, description: `Read the ${BULK_BATCH} members synced longest ago from Shopify. Run again for the next ${BULK_BATCH}.` };
		tools.edit_member_tags = { route: "edit-member-tags", input: TAGS, destructive: true, description: "Add or remove tags on a member's Shopify customer, then read back what Shopify holds. Access follows from Shopify." };
	}
	return { tools };
}

// ---------------------------------------------------------------- setup

const SETUP_ACTIONS = new Set(["setup_check", "setup_register"]);
const isSetupAction = (id: unknown) => typeof id === "string" && SETUP_ACTIONS.has(id);

/** The site's own origin, as visitors reach it. */
function siteOrigin(ctx: PluginContext): string {
	return new URL(ctx.url("/")).origin;
}

/** Connection's buttons: Check again and Register. Each answers the page as it is after the step. */
async function setupAction(
	config: RedeemIDConfig,
	live: () => Promise<RedeemIDConfig>,
	ctx: RouteContext,
	i: { action_id?: string; value?: unknown; values?: Record<string, unknown> },
) {
	const origin = siteOrigin(ctx);
	const tab: ConnectionTab = i.action_id === "setup_register" ? "webhooks" : (tabOf(CONNECTION_TABS, i.value) ?? "status");
	const page = async (toast?: { type: "success" | "error" | "info"; message: string }) => connectionPage(await live(), ctx, tab, toast);
	if (i.action_id === "setup_register") {
		try {
			const { added, failed } = await registerWebhooks(config, origin + WEBHOOK);
			await record({ event: "staff.webhooks", label: "register (setup)", status: failed.length ? `${failed.length} refused` : `${added.length} registered`, level: failed.length ? "warn" : "ok", origin: "staff" });
			const refused = failed.map((f) => `Shopify refused ${f.topic}: ${f.message}`).join(" ");
			return page({ type: failed.length ? "error" : "success", message: [added.length ? `Registered ${added.length} webhooks.` : failed.length ? "" : "Nothing was missing.", refused].filter(Boolean).join(" ") });
		} catch (e) {
			return page({ type: "error", message: (e as Error).message });
		}
	}
	return page({ type: "info", message: "Checked." });
}

// ---------------------------------------------------------------- actions

async function action(
	config: RedeemIDConfig,
	ctx: RouteContext,
	i: { action_id?: string; value?: unknown; values?: Record<string, unknown>; block_id?: string },
) {
	const s = await memberStores();
	const monitor = () => monitorEnv(config, s, ctx);
	const cursorOf = (v: unknown) => {
		const c = (v as { cursor?: unknown } | null)?.cursor;
		return typeof c === "string" && c ? c : undefined;
	};
	const backOf = (v: unknown) => {
		const b = (v as { back?: unknown } | null)?.back;
		return Array.isArray(b) ? b.filter((x): x is string => typeof x === "string").slice(0, 200) : [];
	};
	const fail = (e: unknown) => ({ type: "error" as const, message: (e as Error).message });
	switch (i.action_id) {
		case "members_back":
			return customersPage(config, ctx.kv);
		case "member_open": {
			const m = await s.members.get(String(i.value ?? ""));
			return m ? memberDetail(config, m) : { ...(await customersPage(config, ctx.kv)), toast: { type: "error", message: "That customer is gone." } };
		}
		case "member_resync": {
			const id = String(i.value ?? "");
			try {
				const m = await resyncOne(config, s, id, "staff resync");
				const now = m ?? (await s.members.get(id));
				if (!now) return customersPage(config, ctx.kv);
				return memberDetail(config, now, m ? { type: "success", message: "Read again from Shopify." } : { type: "error", message: "Shopify no longer has this customer." });
			} catch (e) {
				const m = await s.members.get(id);
				return m ? memberDetail(config, m, fail(e)) : customersPage(config, ctx.kv);
			}
		}
		case "member_link":
		case "member_unlink": {
			const id = i.action_id === "member_link" ? String(i.block_id ?? "").replace(/^link:/, "") : String(i.value ?? "");
			try {
				const { getDb } = await import("emdash/runtime");
				const { createKyselyAdapter } = await import("@emdash-cms/auth/adapters/kysely");
				const adapter = createKyselyAdapter((await getDb()) as never);
				const m = i.action_id === "member_link" ? await staffLink(adapter, s, id, i.values?.email) : await staffUnlink(adapter, s, id);
				return memberDetail(config, m, { type: "success", message: m.userId ? "Linked. Their next sign-in uses that site user." : "Unlinked." }, "account");
			} catch (e) {
				const m = await s.members.get(id);
				return m ? memberDetail(config, m, fail(e), "account") : customersPage(config, ctx.kv);
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
				return now ? memberDetail(config, now, { type: "success", message: add ? "Tags added in Shopify." : "Tag removed in Shopify." }, "tags") : customersPage(config, ctx.kv);
			} catch (e) {
				const m = await s.members.get(id);
				return m ? memberDetail(config, m, fail(e), "tags") : customersPage(config, ctx.kv);
			}
		}
		case "customers_resync_start":
			return { blocks: [runBlock(await startRun(ctx.kv as RunKv, RESYNC_JOB, i.value === "resume" ? "resume" : "new", () => resyncTotal(s)), RESYNC)] };
		case "customers_resync_next":
			return { blocks: [runBlock(await stepRun(ctx.kv as RunKv, RESYNC_JOB, (run) => resyncBatch(config, s, run)), RESYNC)] };
		case "customers_resync_stop":
			return { blocks: [runBlock(await stopRun(ctx.kv as RunKv, RESYNC_JOB), RESYNC)] };
		case "customers_resync_done": {
			const run = await loadRun(ctx.kv as RunKv, RESYNC_JOB);
			if (run?.state === "finished") await record({ event: "staff.resync", label: "all", status: `${run.done} read, ${run.changed} changed${run.missing ? `, ${run.missing} missing` : ""}`, origin: "staff" });
			return { ...(await customersPage(config, ctx.kv)), ...(run ? { toast: { type: run.state === "finished" ? ("success" as const) : ("info" as const), message: runText(run, RESYNC) } } : {}) };
		}
		case "webhooks_register": {
			try {
				const { added, failed } = await registerWebhooks(config, monitor().uri);
				const done = added.length ? `Registered ${added.length} webhooks.` : failed.length ? "" : "Nothing was missing.";
				const refused = failed.map((f) => `Shopify refused ${f.topic}: ${f.message}`).join(" ");
				await record({ event: "staff.webhooks", label: "register", status: failed.length ? `${failed.length} refused` : `${added.length} registered`, level: failed.length ? "warn" : "ok", origin: "staff" });
				return connectionPage(config, ctx, "webhooks", { type: failed.length ? "error" : "success", message: [done, refused].filter(Boolean).join(" ") });
			} catch (e) {
				return connectionPage(config, ctx, "webhooks", fail(e));
			}
		}
		case "deliveries_page":
			return eventsAdminPage(config, ctx, "webhook", { cursor: cursorOf(i.value), back: backOf(i.value) });
		case "health_check": {
			const r = await healthCheck({ ...monitor(), by: "staff" });
			const message = r.problems.length ? `Checked: ${r.problems.length === 1 ? "1 problem" : `${r.problems.length} problems`}.` : "Checked: subscriptions are in place and deliveries look healthy.";
			return eventsAdminPage(config, ctx, "health", {}, { type: r.problems.length ? "info" : "success", message });
		}
		case "monitor_save":
			return eventsAdminPage(config, ctx, "health", {}, await saveMonitor(ctx.kv, i.values));
		case "events_filter":
			return eventsAdminPage(config, ctx, "app", { events: await eventsPage(s, { event: String(i.values?.event ?? "") || undefined, problems: i.values?.problems === true }) });
		case "events_show":
			return eventsAdminPage(config, ctx, "app", { events: await eventsPage(s, { event: String(i.value ?? "") || undefined }) });
		case "events_page":
			return eventsAdminPage(config, ctx, "app", { events: await eventsPage(s, parseFilter((i.value as { filter?: unknown } | null)?.filter ?? i.block_id), cursorOf(i.value), undefined, backOf(i.value)) });
		case "failed_resend": {
			const sent = await resend(config, s, String(i.value ?? "")).catch(() => false);
			return eventsAdminPage(config, ctx, "app", {}, sent ? { type: "success", message: "Sent. It's off the failed list." } : { type: "error", message: "The receiver still didn't take it. It stays on the list." });
		}
		case "failed_clear":
			await s.failedEvents.delete(String(i.value ?? ""));
			return eventsAdminPage(config, ctx, "app", {}, { type: "success", message: "Cleared." });
		case "failed_clear_all": {
			const { items } = await s.failedEvents.query({ limit: 100 });
			await s.failedEvents.deleteMany(items.map((r) => r.id));
			return eventsAdminPage(config, ctx, "app", {}, { type: "success", message: "Failed events cleared." });
		}
		case "member_export": {
			const id = String(i.value ?? "");
			const m = await s.members.get(id);
			if (!m) return customersPage(config, ctx.kv);
			return memberDetail(config, m, { type: "success", message: "Export below." }, "privacy", await exportRequest(s, id, "staff"));
		}
		case "member_erase": {
			const id = String(i.value ?? "");
			await eraseMember(config, s, id, "staff");
			return { ...(await customersPage(config, ctx.kv)), toast: { type: "success", message: "Erased from the site." } };
		}
		case "member_shopify_erase":
		case "member_shopify_cancel": {
			const id = String(i.value ?? "");
			const m = await s.members.get(id);
			try {
				if (i.action_id === "member_shopify_erase") await requestShopifyErasure(config, s, id);
				else await cancelShopifyErasure(config, s, id);
				const message = i.action_id === "member_shopify_erase" ? "Shopify will erase the customer after its waiting period." : "The Shopify erasure is cancelled.";
				return m ? memberDetail(config, m, { type: "success", message }, "privacy") : privacyPage(s, { type: "success", message });
			} catch (e) {
				return m ? memberDetail(config, m, fail(e), "privacy") : privacyPage(s, fail(e));
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

/** "Resync all" on the Customers page (runs.ts). */
const RESYNC: RunLabels = {
	title: "Resync every customer from Shopify",
	about: `Reads every customer here from Shopify again and updates their tags and profile, ${BULK_BATCH} at a time with a pause between, so Shopify's limits are never hit. Webhooks keep customers current; this catches up after missed ones. It changes nothing in Shopify. Leave this page open while it runs; if you leave, it pauses and Continue picks up where it stopped.`,
	noun: "customers",
	start: "Resync all from Shopify",
	verb: "read",
	missing: "no longer in Shopify",
	prefix: "customers_resync",
};
const RESYNC_JOB = "customers-resync";

async function customersPage(config: RedeemIDConfig, kv?: PluginContext["kv"]) {
	const members = await allMembers();
	const levels = config.levels ?? [];
	const run = kv ? await loadRun(kv as RunKv, RESYNC_JOB).catch(() => null) : null;
	const counts = levels.map((l) => ({
		label: l.name,
		value: String(members.filter((m) => m.status === "enabled" && levelsFor(m.tags, levels).includes(l.slug)).length),
	}));
	const name = (m: MemberRecord) => [m.firstName, m.lastName].filter(Boolean).join(" ") || "No name";
	const levelNames = (m: MemberRecord) => {
		const held = topLevels(levelsFor(m.tags, levels), levels);
		return levels.filter((l) => held.includes(l.slug)).map((l) => l.name).join(", ");
	};
	return {
		blocks: [
			{ type: "header", text: "Customers" },
			{
				type: "context",
				text: "Shopify customers who have signed in here or that Shopify has sent. Levels come only from their Shopify tags; change tags in Shopify (or with Flow) and access follows.",
			},
			{
				type: "stats",
				items: [
					{ label: "Customers", value: String(members.length) },
					{ label: "Turned off", value: String(members.filter((m) => m.status === "disabled").length) },
					...counts,
				],
			},
			adminConfigured()
				? runBlock(run, RESYNC)
				: { type: "context", text: "Set the Admin API app's client ID (REDEEMID_SHOPIFY_ADMIN_APP_CLIENT_ID) to resync customers and edit their tags from here." },
			members.length === 0
				? { type: "context", text: "No customers yet. They appear here after their first sign-in or a Shopify customer webhook." }
				: {
						type: "table",
						page_action_id: "members_page",
						columns: [
							{ key: "name", label: "Name" },
							{ key: "email", label: "Email" },
							{ key: "levels", label: "Levels" },
							{ key: "tags", label: "Shopify tags" },
							{ key: "status", label: "Account", format: "badge" },
							{ key: "synced", label: "Last synced", format: "relative_time" },
							{ key: "open", label: "", format: "element" },
						],
						rows: members
							.sort((a, b) => b.syncedAt.localeCompare(a.syncedAt))
							.map((m) => ({
								name: name(m),
								email: m.email ?? "",
								levels: levelNames(m),
								tags: m.tags.join(", "),
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

type ConnectionTab = (typeof CONNECTION_TABS)[number];
type EventsTab = (typeof EVENTS_TABS)[number];
type Toast = { type: "success" | "error" | "info"; message: string };

/** A tab name from an address or a button value, if it's one of these. */
function tabOf<T extends string>(tabs: readonly T[], v: unknown): T | undefined {
	return tabs.includes(v as T) ? (v as T) : undefined;
}
const withoutHeader = (b: { blocks: unknown[] }) => b.blocks.filter((x, n) => !(n === 0 && (x as { type?: string }).type === "header"));

/**
 * How this site talks to Shopify, in four tabs: Status (every step as a
 * card), Store (the Shopify side: store, sign-in client, Admin API app and
 * its scopes, Storefront token), Environment (what the site reads from its
 * environment, and the template check) and Webhooks (registration and the
 * subscriptions). Opens on Status unless a tab is named.
 */
async function connectionPage(config: RedeemIDConfig, ctx: RouteContext, tab: ConnectionTab = "status", toast?: Toast) {
	const s = await memberStores();
	const [facts, environment, hooks] = await Promise.all([setupFacts(config, s, siteOrigin(ctx)), environmentTab(config), webhookPanels(monitorEnv(config, s, ctx))]);
	const next = nextStep(facts);
	const steps = requiredSteps(setupSteps(facts));
	const done = steps.filter((x) => x.state === "done").length;
	// The Webhooks step has its own Register button while it's to do.
	const step = webhooksStep(facts);
	const ownButton = JSON.stringify(step).includes('"setup_register"');
	const subscriptions = ownButton ? hooks.subscriptions.filter((b) => !JSON.stringify(b).includes('"webhooks_register"')) : hooks.subscriptions;
	const status = [
		next
			? { type: "banner", variant: "alert", title: `Setup: ${done} of ${steps.length} steps done`, description: `Next: ${next.title}. Each card checks the site as it is, so set a secret, redeploy or restart, and reload.` }
			: { type: "banner", variant: "default", title: "Connected", description: "Every setup step is done. Customers can sign in with their store customer account." },
		...customDomainBlocks(config),
		statusCards(facts),
		{ type: "actions", elements: [{ type: "button", action_id: "setup_check", value: "status", label: "Check again", style: "secondary" }] },
	];
	return {
		blocks: [
			{ type: "header", text: "Connection" },
			{ type: "context", text: "How this site talks to Shopify." },
			{
				type: "tab",
				default_tab: CONNECTION_TABS.indexOf(tab),
				panels: [
					{ label: "Status", blocks: status },
					{ label: "Store", blocks: storeTab(facts) },
					{ label: "Environment", blocks: environment },
					{ label: "Webhooks", blocks: [...step, { type: "divider" }, { type: "header", text: "Subscriptions" }, ...subscriptions] },
				],
			},
		],
		...(toast ? { toast } : {}),
	};
}

/**
 * What happened: webhook deliveries from Shopify, what RedeemID did (App),
 * and whether deliveries are healthy. An action passes the App panel it
 * rebuilt (a filter or a page) or a deliveries cursor.
 */
async function eventsAdminPage(config: RedeemIDConfig, ctx: RouteContext, tab: EventsTab = "webhook", given: { events?: { blocks: unknown[] }; cursor?: string; back?: string[] } = {}, toast?: Toast) {
	const s = await memberStores();
	const [hooks, events] = await Promise.all([webhookPanels(monitorEnv(config, s, ctx), given.cursor, given.back), given.events ?? eventsPage(s)]);
	return {
		blocks: [
			{ type: "header", text: "Events" },
			{ type: "context", text: "What Shopify sent, what RedeemID did with it, and whether deliveries are healthy." },
			{
				type: "tab",
				default_tab: EVENTS_TABS.indexOf(tab),
				panels: [
					{ label: "Webhook", blocks: hooks.received },
					{ label: "App", blocks: events.blocks },
					{ label: hooks.attention ? "Health (!)" : "Health", blocks: hooks.health },
				],
			},
		],
		...(toast ? { toast } : {}),
	};
}

/** Connection → Environment: what the site reads from its environment, and the template check. */
async function environmentTab(config: RedeemIDConfig): Promise<unknown[]> {
	const c = await checks(config);
	const set = (v: boolean) => (v ? "Set" : "Missing");
	const delivery = await lastDelivery().catch(() => null);
	const unknown = unknownEnvNames();
	return [
		{ type: "context", text: "What the site reads from its environment. Secrets show only whether they're set, never their values. The Store tab says where each one comes from." },
		{
			type: "redeemid_copy",
			fields: [
				{ label: "Store domain", value: c.domain || "Missing", hint: `${ENV.storeDomain} or shop`, copy: Boolean(c.domain) },
				{ label: "Store discovery", value: c.discovery, copy: false },
				{ label: "Customer Account API client ID", value: set(c.clientId), hint: ENV.clientId, copy: false },
				{ label: "Webhook signing secret", value: set(c.webhookSecret), hint: ENV.webhookSecret, copy: false },
				{ label: "Admin API app client ID (staff tools)", value: set(Boolean(env(ENV.adminClientId))), hint: ENV.adminClientId, copy: false },
				{ label: "Storefront API access", value: c.storefront, hint: `${ENV.storefrontPrivateToken} or ${ENV.storefrontPublicToken}`, copy: false },
				{ label: "Events", value: config.events?.url ? `${config.events.url}${env(ENV.eventsSecret) ? "" : " (secret missing)"}` : "Off", hint: config.events?.url ? ENV.eventsSecret : undefined, copy: Boolean(config.events?.url) },
				{ label: "Last webhook", value: delivery ?? "None received yet", copy: false },
				{ label: "Replacement text", value: textSummary(config), copy: false },
				...(unknown.length ? [{ label: "Set but not used (check the name)", value: unknown.join(", "), copy: false }] : []),
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
		{ type: "header", text: "Templates" },
		...templateBlocks(config),
	];
}

/**
 * Status: the Admin API (staff tools, webhook registration, tag reads) only
 * answers on the store's myshopify.com domain, so a custom domain in `shop`
 * breaks it while sign-in still works.
 */
export function customDomainBlocks(config: RedeemIDConfig): unknown[] {
	if (!adminConfigured() || config.allowInsecureShop) return [];
	let host = "";
	try {
		host = new URL(shopOrigin(config)).hostname;
	} catch {
		return [];
	}
	if (host.endsWith(".myshopify.com")) return [];
	return [
		{
			type: "banner",
			variant: "alert",
			title: "Use the myshopify.com domain",
			description: `The store domain is ${host}. Shopify's Admin API, which the staff tools, webhook registration and tag reads use, only answers on the store's myshopify.com domain. Set REDEEMID_SHOPIFY_STORE_DOMAIN (or shop) to it; sign-in works with it too.`,
		},
	];
}

/** Status: templates that would show a gated body in full (see template-scan.ts). */
function templateBlocks(config: RedeemIDConfig): unknown[] {
	const found = templateFindings();
	if (!found) return [{ type: "banner", variant: "alert", title: "Templates weren't checked", description: "Add redeemidGuard() to the integrations in astro.config.mjs. It gates pages and keeps customers out of EmDash's own APIs, and checks the templates." }];
	const risky = gatedFindings(found, config);
	const caching = cacheFindings(found, config);
	const cacheRows = caching.length
		? [
				{ type: "banner", variant: "alert", title: "A template caches gated pages itself", description: "These templates call Astro.cache.set() on pages of a gated collection. With the route cache on, one reader's copy then reaches everyone, and pages keep old rules after an Access save. Use cacheEntry(Astro, collection, entry, cacheHint) on entry pages and cachePage(Astro, cacheHint) on lists, from @redeemid/emdash/cache." },
				{
					type: "table",
					page_action_id: "template_cache_findings",
					columns: [
						{ key: "file", label: "Template" },
						{ key: "lines", label: "Line" },
						{ key: "collections", label: "Gated collection" },
					],
					rows: caching.map((f) => ({ file: f.file, lines: (f.cache ?? []).join(", "), collections: f.gated.join(", ") })),
				},
			]
		: [];
	if (!risky.length) return [{ type: "context", text: "Templates: none renders a gated collection's body with EmDash's PortableText. Bodies go through RedeemID's Content." }, ...cacheRows];
	const sure = risky.filter((f) => f.gated.length);
	return [
		sure.length
			? { type: "banner", variant: "error", title: "A template shows locked bodies in full", description: "These templates render a gated collection's body with EmDash's <PortableText>, which skips every rule, Paywall break and Members only part. Use RedeemID's <Content value={entry.data.content} collection=\"…\" terms={entry.data.terms} id={entry.id} /> instead." }
			: { type: "banner", variant: "alert", title: "Check these templates", description: "They render a body with EmDash's <PortableText> and RedeemID couldn't see which collection. If it's one with a rule, use RedeemID's <Content> instead." },
		{
			type: "table",
			page_action_id: "template_findings",
			columns: [
				{ key: "file", label: "Template" },
				{ key: "lines", label: "Line" },
				{ key: "collections", label: "Gated collection" },
			],
			rows: risky.map((f) => ({ file: f.file, lines: f.lines.join(", "), collections: f.gated.join(", ") || "Not found in the file" })),
		},
		...cacheRows,
	];
}

/** Counts the Overview and the dashboard card share. */
async function summary(config: RedeemIDConfig, ctx: PluginContext) {
	const [c, members, check, delivery, requests] = await Promise.all([
		checks(config),
		allMembers().catch(() => [] as MemberRecord[]),
		lastCheck(ctx.kv).catch(() => null),
		memberStores()
			.then((s) => s.deliveries.query({ orderBy: { receivedAt: "desc" }, limit: 1 }))
			.then((r) => r.items[0]?.data ?? null)
			.catch(() => null),
		memberStores()
			.then((s) => recentRequests(s))
			.catch(() => []),
	]);
	const levels = config.levels ?? [];
	return {
		signIn: c.discovery.startsWith("OK") && c.clientId,
		members,
		active: members.filter((m) => m.status === "enabled" && levelsFor(m.tags, levels).length > 0).length,
		signedIn: members.filter((m) => m.userId).length,
		check,
		delivery,
		openRequests: requests.filter((r) => r.data.status === "open").length,
		levels,
	};
}

type Summary = Awaited<ReturnType<typeof summary>>;

function webhookWord(s: Summary): { value: string; tone: "ok" | "warn" | "error" } {
	if (!s.check) return { value: "Unchecked", tone: "warn" };
	return s.check.problems.length ? { value: `${s.check.problems.length} to fix`, tone: "error" } : { value: "Healthy", tone: "ok" };
}

/** "3 h ago" for a recent time. */
function ago(iso: string | null | undefined, now = Date.now()): string {
	if (!iso) return "";
	const ms = now - Date.parse(iso);
	if (!Number.isFinite(ms)) return "";
	if (ms < 60_000) return "just now";
	if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
	if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`;
	const d = Math.floor(ms / 86_400_000);
	return d === 1 ? "yesterday" : `${d} days ago`;
}

const page = (path: string) => ({ kind: "plugin-page" as const, path });
const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The dashboard card: what needs a look, the counts, and the way in. */
async function statusWidget(config: RedeemIDConfig, ctx: PluginContext) {
	const s = await summary(config, ctx);
	const hooks = webhookWord(s);
	const alerts: unknown[] = [];
	if (!s.signIn) alerts.push({ type: "banner", variant: "error", title: "Sign-in isn't ready", description: "Customers can't sign in until the store settings are complete. See Connection." });
	if (s.check?.problems.length) alerts.push({ type: "banner", variant: "alert", title: "Webhooks need attention", description: s.check.problems[0]!.text });
	if (s.openRequests) alerts.push({ type: "banner", variant: "alert", title: `${s.openRequests} privacy ${s.openRequests === 1 ? "request is" : "requests are"} open`, description: "Staff need to finish them under Privacy." });
	return {
		blocks: [
			...alerts,
			{
				type: "stats",
				items: [
					{ label: "Customers", value: String(s.members.length), description: `${s.active} with a level` },
					{ label: "Sign-in", value: s.signIn ? "Ready" : "Not ready" },
					{ label: "Webhooks", value: hooks.value, description: s.delivery ? `Last ${ago(s.delivery.receivedAt)}` : "None yet" },
				],
			},
			{
				type: "fields",
				fields: [
					{ label: "Signed in here", value: String(s.signedIn) },
					{ label: "Levels", value: s.levels.map((l) => l.name).join(", ") || "None yet" },
				],
			},
			{
				type: "actions",
				elements: [
					{ type: "link", label: "Overview", target: page(OVERVIEW), appearance: "primary" },
					{ type: "link", label: "Customers", target: page("/customers"), appearance: "secondary" },
					{ type: "link", label: "Access", target: page("/access"), appearance: "secondary" },
					{ type: "link", label: s.signIn && !s.check?.problems.length ? "Events" : "Connection", target: page(s.signIn && !s.check?.problems.length ? "/events/webhook" : "/connection"), appearance: "secondary" },
				],
			},
		],
	};
}

/** The first page: what needs doing, the numbers, recent activity and where to go. */
async function overviewPage(config: RedeemIDConfig, ctx: PluginContext) {
	const st = await memberStores();
	const [s, facts, log] = await Promise.all([
		summary(config, ctx),
		setupFacts(config, st, siteOrigin(ctx)).catch(() => null),
		st.log.query({ orderBy: { at: "desc" }, limit: 8 }).catch(() => ({ items: [] as Array<{ data: Parameters<typeof eventRow>[0] }> })),
	]);
	const required = facts ? requiredSteps(setupSteps(facts)) : [];
	const done = required.filter((x) => x.state === "done").length;
	const hooks = webhookWord(s);
	const rules = config.rules ?? [];
	const counts = s.levels.map((l) => ({
		level: l.name,
		members: s.members.filter((m) => m.status === "enabled" && levelsFor(m.tags, s.levels).includes(l.slug)).length,
		includes: (l.includes ?? []).map((x) => s.levels.find((o) => o.slug === x)?.name ?? x).join(", "),
		features: (config.features ?? []).filter((f) => f.levels?.includes(l.slug)).map((f) => f.name).join(", "),
		rules: rules.filter((r) => r.levels.includes(l.slug)).length,
		folders: (config.files ?? []).filter((f) => f.levels?.includes(l.slug)).length,
	}));
	const domain = storeDomain(config);
	const alerts: unknown[] = [];
	if (required.length && done < required.length)
		alerts.push({ type: "banner", variant: s.signIn ? "default" : "alert", title: `Setup: ${done} of ${required.length} steps done`, description: `Next: ${required.find((x) => x.state !== "done")?.title ?? ""}.` });
	if (s.check?.problems.length) alerts.push({ type: "banner", variant: "alert", title: "Webhooks need attention", description: s.check.problems.map((p) => p.text).join(" ") });
	if (s.openRequests) alerts.push({ type: "banner", variant: "alert", title: `${s.openRequests} privacy ${s.openRequests === 1 ? "request is" : "requests are"} open`, description: "Finish them under Privacy." });
	return {
		blocks: [
			{ type: "header", text: "RedeemID" },
			{ type: "context", text: `Customers sign in with their store customer account, and their Shopify customer tags decide what they read. Version ${VERSION}.` },
			...alerts,
			{
				type: "redeemid_cards",
				items: [
					{ title: "Sign-in", value: s.signIn ? "Ready" : "Not ready", tone: s.signIn ? "ok" : "error", text: domain ? `Store: ${domain.replace(/^https?:\/\//, "")}` : "No store set", link: page("/connection/status"), label: "Status" },
					{ title: "Customers", value: String(s.members.length), text: `${s.active} with a level, ${s.signedIn} signed in here`, link: page("/customers"), label: "Customers" },
					{ title: "Webhooks", value: hooks.value, tone: hooks.tone, text: s.delivery ? `Last delivery ${ago(s.delivery.receivedAt)} (${s.delivery.topic})` : "None received yet", link: page("/events/webhook"), label: "Webhooks" },
					{ title: "Access", value: count(s.levels.length, "level"), text: [count(rules.length, "rule"), count((config.features ?? []).length, "feature"), count((config.files ?? []).length, "protected folder")].join(", "), link: page("/access"), label: "Access" },
					{ title: "Privacy", value: s.openRequests ? `${s.openRequests} open` : "Nothing open", tone: s.openRequests ? "warn" : undefined, text: "Exports and erasures from customers, staff and Shopify", link: page("/privacy"), label: "Privacy" },
					{ title: "Setup", value: required.length ? `${done} of ${required.length}` : "Unknown", tone: required.length && done === required.length ? "ok" : "warn", text: done === required.length ? "Every step is done" : `Next: ${required.find((x) => x.state !== "done")?.title ?? ""}`, link: page("/connection"), label: "Setup" },
				],
			},
			{ type: "header", text: "Levels" },
			counts.length
				? {
						type: "table",
						page_action_id: "overview_levels",
						columns: [
							{ key: "level", label: "Level" },
							{ key: "members", label: "Customers", format: "number" },
							{ key: "includes", label: "Includes" },
							{ key: "features", label: "Features" },
							{ key: "rules", label: "Rules", format: "number" },
							{ key: "folders", label: "Folders", format: "number" },
						],
						rows: counts,
					}
				: { type: "empty", title: "No levels yet", description: "Levels name the readers who hold some Shopify tags.", size: "sm", actions: [{ type: "link", label: "Add a level", target: page("/access"), appearance: "primary" }] },
			...(counts.length ? [{ type: "actions", elements: [{ type: "link", label: "Explore the access map", target: page("/access"), appearance: "secondary" }] }] : []),
			{ type: "header", text: "Recent activity" },
			{
				type: "table",
				page_action_id: "overview_events",
				empty_text: "Nothing recorded yet.",
				columns: [
					{ key: "event", label: "Event" },
					{ key: "about", label: "About" },
					{ key: "result", label: "Result", format: "badge" },
					{ key: "at", label: "When", format: "relative_time" },
				],
				rows: log.items.map((r) => {
					const { event, about, result, at } = eventRow(r.data);
					return { event, about, result, at };
				}),
			},
			{ type: "actions", elements: [{ type: "link", label: "All app events", target: page("/events/app"), appearance: "secondary" }, { type: "link", label: "Reports", target: page("/reports"), appearance: "secondary" }] },
			{ type: "divider" },
			{ type: "context", text: "Guides, references and the Shopify screens you'll use alongside RedeemID are under Resources." },
			{ type: "actions", elements: [{ type: "link", label: "Resources", target: page("/resources"), appearance: "secondary" }] },
		],
	};
}
