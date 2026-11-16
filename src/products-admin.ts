/**
 * The Products admin page: set up the products content type, tick which
 * Shopify products the site keeps in sync, sync or update them all, and turn
 * on Shopify's product webhooks.
 * Block Kit, rendered by admin.ts like the other pages.
 */

import { adminConfigured, PRODUCT_TOPICS, registerWebhooks, topicName, webhookSubscriptions } from "./admin-api.js";
import type { RedeemIDConfig } from "./config.js";
import { record } from "./log.js";
import { loadRun, runActions, runBlock, runText, startRun, stepRun, stopRun, type RunLabels } from "./runs.js";
import {
	addAllPage,
	browseProducts,
	contentEntries,
	describeBatch,
	followsAll,
	PRODUCTS_BATCH,
	productsCollection,
	productsSchema,
	refreshOldest,
	setupProductsCollection,
	stopSyncing,
	syncPicked,
	type BatchResult,
	type EntryStore,
	type ProductMirror,
} from "./products.js";

type Toast = { type: "success" | "error" | "info"; message: string };
type Blocks = { blocks: unknown[]; toast?: Toast };

/** What the page works with. The plugin builds it from the request. */
export interface ProductsEnv {
	config: RedeemIDConfig;
	db: unknown;
	kv: { get<T>(key: string): Promise<T | null>; set(key: string, value: unknown): Promise<void>; delete?(key: string): Promise<boolean | void> };
	/** The webhook address Shopify sends to. */
	webhookUri: string;
	fetcher?: typeof fetch;
}

/** "Sync every product" and "Update synced products": long jobs run a batch at a time (runs.ts). */
const IMPORT: RunLabels = {
	title: "Sync every product",
	about: `Syncs every product Shopify sells on this site's channel, ${PRODUCTS_BATCH} at a time with a pause between. Products already synced are updated. Leave this page open while it runs; if you leave, it pauses and Continue picks up where it stopped.`,
	noun: "products",
	start: "Sync every product",
	verb: "read",
	prefix: "products_all",
	confirm: "Every product Shopify sells on this site's channel will be synced here as a published entry. Start?",
};
const REFRESH: RunLabels = {
	title: "Update synced products",
	about: `Reads every synced product from Shopify again, ${PRODUCTS_BATCH} at a time. Use it to catch up when automatic updates are off or Shopify missed one. Nothing updates on a schedule.`,
	noun: "products",
	start: "Update synced products",
	verb: "read",
	missing: "off the store",
	prefix: "products_refresh",
};
const IMPORT_JOB = "products-import";
const REFRESH_JOB = "products-refresh";
/** What the picker last showed, so Save knows which products were unticked. */
const SHOWN_KEY = "products:shown:";
const ACTIONS = new Set(["products_setup", "products_browse", "products_pick", "products_stop", "products_webhooks", ...runActions(IMPORT.prefix), ...runActions(REFRESH.prefix)]);

export const isProductsAction = (id: unknown): boolean => typeof id === "string" && ACTIONS.has(id);

const money = (amount: string | null, currency: string | null) => (amount && currency ? `${amount} ${currency}` : "—");

/** Where the picker is: a page cursor, search words, and the cursors before it for Previous. */
export interface Browse {
	after?: string | null;
	query?: string | null;
	back?: string[];
}

/** The Products page. `browse` is the page of Shopify products the picker shows. */
export async function productsPage(env: ProductsEnv, toast?: Toast, browse: Browse = {}): Promise<Blocks> {
	const collection = productsCollection(env.config);
	const head = [
		{ type: "header", text: "Products" },
		{
			type: "context",
			text: "Choose which Shopify products this site keeps in sync. Each synced product becomes an entry that editors can write about, posts can link to, and the site's search and sitemap list. Shopify keeps its title, price, image and stock up to date, and buy buttons always read Shopify live.",
		},
	];
	if (!collection) return { blocks: [...head, { type: "banner", variant: "default", title: "Product sync is off", description: "The site's config has `products: false`." }], toast };
	const schema = await productsSchema(env.db, collection);
	if (!schema.exists || schema.missing.length) {
		return {
			blocks: [
				...head,
				{
					type: "section",
					text: schema.exists
						? `Finish setting up products. The ${collection} content type is missing fields RedeemID needs: ${schema.missing.join(", ")}.`
						: "Set up products to start syncing. RedeemID keeps synced products in a Products content type. Setting up creates it, with Shopify's fields and a Story field for your own words. You can add more fields under Content types later.",
					accessory: { type: "button", action_id: "products_setup", label: schema.exists ? "Add the missing fields" : "Set up products", style: "primary" },
				},
			],
			toast,
		};
	}
	const store = contentEntries(env.db, collection);
	const [counts, entries, imported, refreshed, hooks] = await Promise.all([store.counts(), store.list(50), loadRun(env.kv, IMPORT_JOB), loadRun(env.kv, REFRESH_JOB), productHooks(env)]);
	const blocks: unknown[] = [...head];
	if (schema.revisions) {
		blocks.push({ type: "banner", variant: "default", title: "This content type keeps revisions", description: "RedeemID writes Shopify's fields to the live entry. Publishing an older draft can bring back old prices until the next update, so turn revisions off for products." });
	}
	blocks.push({
		type: "stats",
		items: [
			{ label: "Synced", value: String(counts.total) },
			{ label: "On sale here", value: String(counts.listed) },
			{ label: "Off the store", value: String(counts.total - counts.listed) },
			{ label: "New Shopify products", value: followsAll(env.config) ? "Synced" : "You choose" },
		],
	});
	blocks.push({ type: "header", text: "Choose products to sync" }, ...(await picker(env, store, browse)));
	blocks.push({ type: "header", text: "Automatic updates" }, hooks);
	blocks.push({ type: "header", text: "Sync in bulk" }, runBlock(imported, IMPORT), runBlock(refreshed, REFRESH));
	blocks.push({ type: "header", text: "Synced products" });
	if (!entries.length) blocks.push({ type: "context", text: "Nothing synced yet. Tick products above and save, or sync every product." });
	else
		blocks.push({
			type: "table",
			columns: [
				{ key: "title", label: "Product" },
				{ key: "price", label: "Price" },
				{ key: "status", label: "In Shopify", format: "badge" },
				{ key: "synced", label: "Last read", format: "relative_time" },
				{ key: "edit", label: "", format: "element" },
				{ key: "stop", label: "", format: "element" },
			],
			rows: entries.map((e) => ({
				title: String(e.data.title ?? ""),
				price: money((e.data.price as string | null) ?? null, (e.data.currency as string | null) ?? null),
				status: e.data.listed === false ? "Off the store" : e.data.available ? "On sale" : "Sold out",
				synced: String(e.data.synced_at ?? ""),
				edit: { type: "link", label: "Edit", target: { kind: "content", collection, id: e.id }, appearance: "inline" },
				stop: {
					type: "button",
					action_id: "products_stop",
					label: "Stop syncing",
					value: e.id,
					style: "secondary",
					confirm: { title: `Stop syncing ${String(e.data.title ?? "this product")}?`, text: "Its entry moves to the trash, story and all. Tick the product again to bring it back.", confirm: "Stop syncing", deny: "Keep it" },
				},
			})),
		});
	if (counts.total > entries.length) blocks.push({ type: "context", text: `Showing the newest ${entries.length} of ${counts.total}. Every product is under Content → Products.` });
	return { blocks, toast };
}

/** The picker: a page of Shopify's products as checkboxes, ticked when synced. */
async function picker(env: ProductsEnv, store: EntryStore, browse: Browse): Promise<unknown[]> {
	const query = browse.query?.trim() || null;
	const filter = {
		type: "form",
		block_id: "products_filter",
		fields: [{ type: "text_input", action_id: "query", label: "Find products by name", placeholder: "tote", ...(query ? { initial_value: query } : {}) }],
		submit: { label: "Search", action_id: "products_browse" },
	};
	let page: { items: ProductMirror[]; next: string | null };
	try {
		page = await browseProducts(env.config, { after: browse.after, query }, PRODUCTS_BATCH, { fetcher: env.fetcher });
	} catch (e) {
		return [filter, { type: "banner", variant: "error", title: "Couldn't read the store", description: (e as Error).message }];
	}
	const showAll = query ? [{ type: "actions", elements: [{ type: "button", action_id: "products_browse", label: "Show all", value: "{}", style: "secondary" }] }] : [];
	if (!page.items.length) return [filter, { type: "context", text: query ? `Shopify has nothing matching "${query}" on this site's channel.` : "Shopify sells no products on this site's channel yet." }, ...showAll];
	const synced: string[] = [];
	for (const p of page.items) if (await store.byShopifyId(p.shopify_id)) synced.push(p.shopify_id);
	const token = Math.random().toString(36).slice(2, 10);
	await env.kv.set(SHOWN_KEY + token, { at: Date.now(), items: page.items });
	const state = (b: Browse) => JSON.stringify(b);
	const back = browse.back ?? [];
	const nav: unknown[] = [];
	if (back.length) nav.push({ type: "button", action_id: "products_browse", label: "Previous", value: state({ after: back[back.length - 1] || null, query, back: back.slice(0, -1) }), style: "secondary" });
	if (page.next) nav.push({ type: "button", action_id: "products_browse", label: "Next", value: state({ after: page.next, query, back: [...back, browse.after ?? ""] }), style: "secondary" });
	if (query) nav.push({ type: "button", action_id: "products_browse", label: "Show all", value: "{}", style: "secondary" });
	return [
		filter,
		{
			type: "form",
			block_id: "products_pick",
			fields: [
				{
					type: "checkbox",
					action_id: `pick_${token}`,
					label: `${query ? `Matching "${query}"` : "Your Shopify products, by name"}. Tick the ones to sync, untick one to stop syncing it, then save.`,
					options: page.items.map((p) => ({ label: `${p.title} · ${money(p.price, p.currency)}${p.available ? "" : " · sold out"}`, value: p.shopify_id })),
					initial_value: synced,
				},
			],
			submit: { label: "Save", action_id: "products_pick" },
		},
		...(nav.length ? [{ type: "actions", elements: nav }] : []),
	];
}

/** Whether Shopify sends product changes here, with a button to turn them on. */
async function productHooks(env: ProductsEnv): Promise<unknown> {
	if (!adminConfigured()) {
		return { type: "context", text: "Off. Without the Admin API app, synced products change only when you update them below. Set it up under Connection → Store to have Shopify send product changes." };
	}
	try {
		const subs = await webhookSubscriptions(env.config, env.fetcher);
		const missing = PRODUCT_TOPICS.filter((t) => !subs.some((s) => s.topic === t && s.uri === env.webhookUri));
		if (!missing.length) return { type: "context", text: "On. Shopify tells this site when a product changes, so synced products stay current on their own." };
		return {
			type: "section",
			text: "Off. Turn them on and Shopify tells this site whenever a synced product changes. The Admin API app needs the read_products scope.",
			accessory: { type: "button", action_id: "products_webhooks", label: "Turn on automatic updates", style: "primary" },
		};
	} catch (e) {
		return { type: "context", text: `Couldn't check with Shopify: ${(e as Error).message}` };
	}
}

function batchToast(prefix: string, r: BatchResult): Toast {
	const failed = r.counts.failed ?? 0;
	return { type: failed ? "error" : "success", message: [`${prefix}: ${describeBatch(r)}.`, ...r.errors.slice(0, 3)].join(" ") };
}

function parseBrowse(raw: unknown): Browse {
	if (typeof raw !== "string" || !raw.startsWith("{")) return {};
	try {
		const b = JSON.parse(raw) as Browse;
		return { after: typeof b.after === "string" ? b.after : null, query: typeof b.query === "string" ? b.query : null, back: Array.isArray(b.back) ? b.back.map(String).slice(-50) : [] };
	} catch {
		return {};
	}
}

/** The page's buttons and forms. Each answers the page as it is afterwards. */
export async function productsAction(env: ProductsEnv, i: { action_id?: string; value?: unknown; values?: Record<string, unknown> }): Promise<Blocks> {
	const collection = productsCollection(env.config);
	if (!collection) return productsPage(env);
	if (i.action_id === "products_setup") {
		try {
			const made = await setupProductsCollection(env.db, collection);
			await record({ event: "staff.products", label: "set up", status: made.created ? "created the content type" : `${made.fields.length} fields added`, level: "ok", origin: "staff" });
			return productsPage(env, { type: "success", message: made.created ? "Products are set up. Tick the ones to sync." : `Added ${made.fields.length} missing fields.` });
		} catch (e) {
			return productsPage(env, { type: "error", message: `Couldn't set up products: ${(e as Error).message}` });
		}
	}
	const store: EntryStore = contentEntries(env.db, collection);
	const opts = { fetcher: env.fetcher };
	try {
		switch (i.action_id) {
			case "products_browse":
				return productsPage(env, undefined, i.values && "query" in i.values ? { query: String(i.values.query ?? "") } : parseBrowse(i.value));
			case "products_pick": {
				const key = Object.keys(i.values ?? {}).find((k) => k.startsWith("pick_"));
				const token = key ? key.slice(5) : "";
				const shown = token ? await env.kv.get<{ items: ProductMirror[] }>(SHOWN_KEY + token) : null;
				if (!key || !shown) return productsPage(env, { type: "info", message: "That list was out of date, so nothing changed. Tick the products again and save." });
				const raw = i.values?.[key];
				const picked = new Set(Array.isArray(raw) ? raw.map(String) : typeof raw === "string" && raw ? [raw] : []);
				const r = await syncPicked(store, shown.items, picked);
				await env.kv.delete?.(SHOWN_KEY + token);
				const changed = (r.counts.added ?? 0) + (r.counts.removed ?? 0) + (r.counts.updated ?? 0) + (r.counts.relisted ?? 0) + (r.counts.failed ?? 0);
				if (!changed) return productsPage(env, { type: "info", message: "Nothing changed." });
				await record({ event: "staff.products", label: "pick", status: describeBatch(r), level: r.counts.failed ? "warn" : "ok", origin: "staff" });
				return productsPage(env, batchToast("Saved", r));
			}
			case "products_stop": {
				const ok = await stopSyncing(store, String(i.value ?? ""));
				if (ok) await record({ event: "staff.products", label: "stop syncing", status: "1 no longer synced", level: "ok", origin: "staff" });
				return productsPage(env, ok ? { type: "success", message: "No longer synced. Its entry is in the trash." } : { type: "info", message: "That product wasn't synced." });
			}
			case "products_all_start":
				return { blocks: [runBlock(await startRun(env.kv, IMPORT_JOB, i.value === "resume" ? "resume" : "new", async () => null), IMPORT)] };
			case "products_all_next":
				return {
					blocks: [
						runBlock(
							await stepRun(env.kv, IMPORT_JOB, async (run) => {
								const r = await addAllPage(env.config, store, (run.cursor as string | null | undefined) ?? null, opts);
								const n = Object.values(r.counts).reduce((a, b) => a + (b ?? 0), 0);
								return { read: n, changed: (r.counts.added ?? 0) + (r.counts.updated ?? 0), failed: r.counts.failed ?? 0, cursor: r.next, finished: !r.next };
							}),
							IMPORT,
						),
					],
				};
			case "products_refresh_start":
				return { blocks: [runBlock(await startRun(env.kv, REFRESH_JOB, i.value === "resume" ? "resume" : "new", async () => (await store.counts()).total), REFRESH)] };
			case "products_refresh_next":
				return {
					blocks: [
						runBlock(
							await stepRun(env.kv, REFRESH_JOB, async (run) => {
								const r = await refreshOldest(env.config, store, opts, run.startedAt);
								const n = Object.values(r.counts).reduce((a, b) => a + (b ?? 0), 0);
								return { read: n, changed: (r.counts.updated ?? 0) + (r.counts.relisted ?? 0), missing: r.counts.delisted ?? 0, failed: r.counts.failed ?? 0 };
							}),
							REFRESH,
						),
					],
				};
			case "products_all_stop":
				return { blocks: [runBlock(await stopRun(env.kv, IMPORT_JOB), IMPORT)] };
			case "products_refresh_stop":
				return { blocks: [runBlock(await stopRun(env.kv, REFRESH_JOB), REFRESH)] };
			case "products_all_done":
			case "products_refresh_done": {
				const all = i.action_id === "products_all_done";
				const run = await loadRun(env.kv, all ? IMPORT_JOB : REFRESH_JOB);
				if (run?.state === "finished") await record({ event: "staff.products", label: all ? "sync all" : "update all", status: runText(run, all ? IMPORT : REFRESH), level: run.failed ? "warn" : "ok", origin: "staff" });
				return productsPage(env, run ? { type: run.state === "finished" ? "success" : "info", message: runText(run, all ? IMPORT : REFRESH) } : undefined);
			}
			case "products_webhooks": {
				const { added: on, failed } = await registerWebhooks(env.config, env.webhookUri, env.fetcher, PRODUCT_TOPICS);
				await record({ event: "staff.webhooks", label: "register (products)", status: failed.length ? `${failed.length} refused` : `${on.length} registered`, level: failed.length ? "warn" : "ok", origin: "staff" });
				if (!failed.length) return productsPage(env, { type: "success", message: on.length ? "Automatic updates are on." : "Automatic updates were already on." });
				const scope = failed.some((f) => /read_products/.test(f.message));
				const message = scope
					? "Shopify said no: the Admin API app doesn't have the read_products scope yet. Add it to the app in Shopify, release the new version, then turn automatic updates on again."
					: failed.map((f) => `Shopify refused ${topicName(f.topic)}: ${f.message}`).join(" ");
				return productsPage(env, { type: "error", message });
			}
		}
	} catch (e) {
		return productsPage(env, { type: "error", message: (e as Error).message });
	}
	return productsPage(env);
}
