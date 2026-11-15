/**
 * The Products admin page: pick which Shopify products the site keeps as
 * entries, add them all, refresh them, and turn on Shopify's product webhooks.
 * Block Kit, rendered by admin.ts like the other pages.
 */

import { adminConfigured, PRODUCT_TOPICS, registerWebhooks, topicName, webhookSubscriptions } from "./admin-api.js";
import type { RedeemIDConfig } from "./config.js";
import { record } from "./log.js";
import {
	addAllPage,
	addProducts,
	contentEntries,
	describeBatch,
	findShopProducts,
	followsAll,
	MIRROR_KEYS,
	PRODUCTS_BATCH,
	productsCollection,
	productsSchema,
	refreshOldest,
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

/** Where "Add all" stands: Shopify's cursor and what it has done so far. */
interface ImportState {
	after: string | null;
	done: number;
	finished: boolean;
	at: string;
}

const IMPORT_KEY = "products:import";
const ACTIONS = new Set(["products_find", "products_add", "products_add_one", "products_all", "products_all_restart", "products_refresh", "products_webhooks"]);

export const isProductsAction = (id: unknown): boolean => typeof id === "string" && ACTIONS.has(id);

const money = (amount: string | null, currency: string | null) => (amount && currency ? `${amount} ${currency}` : "—");

/** The Products page, with search results when there are some. */
export async function productsPage(env: ProductsEnv, toast?: Toast, found?: { query: string; items: ProductMirror[] }): Promise<Blocks> {
	const collection = productsCollection(env.config);
	const head = [
		{ type: "header", text: "Products" },
		{
			type: "context",
			text: "The Shopify products this site keeps as entries: in EmDash's search, sitemap and menus, and ready for posts to link to. Shopify's fields (title, price, image, availability) are copied from Shopify and only Shopify changes them; the story and terms are yours. Buy buttons still read Shopify live.",
		},
	];
	if (!collection) return { blocks: [...head, { type: "banner", variant: "default", title: "Product entries are off", description: "Config `products: false` turns them off." }], toast };
	const schema = await productsSchema(env.db, collection);
	if (!schema.exists || schema.missing.length) {
		return {
			blocks: [
				...head,
				{
					type: "banner",
					variant: "error",
					title: schema.exists ? `The "${collection}" collection is missing fields` : `Add a "${collection}" collection`,
					description: schema.exists
						? `RedeemID writes these fields and the collection doesn't have them yet: ${schema.missing.join(", ")}.`
						: `Product entries live in a collection the site defines. Add it to the seed (or under Content types) with these fields: ${MIRROR_KEYS.join(", ")}. The guide has the full definition.`,
				},
				{ type: "actions", elements: [{ type: "link", label: "Product entries guide", target: { kind: "external", url: "https://github.com/webmultipliers/redeemid-emdash/blob/main/docs/products.md" }, appearance: "secondary" }] },
			],
			toast,
		};
	}
	const store = contentEntries(env.db, collection);
	const [counts, entries, state, hooks] = await Promise.all([store.counts(), store.list(50), env.kv.get<ImportState>(IMPORT_KEY), productHooks(env)]);
	const blocks: unknown[] = [...head];
	if (schema.revisions) {
		blocks.push({ type: "banner", variant: "default", title: "This collection keeps revisions", description: "Shopify's fields are written to the live entry. Publishing an older draft can bring back old prices until the next refresh, so keep the products collection without revisions." });
	}
	blocks.push({
		type: "stats",
		items: [
			{ label: "Products", value: String(counts.total) },
			{ label: "On sale here", value: String(counts.listed) },
			{ label: "Off the store", value: String(counts.total - counts.listed) },
			{ label: "New Shopify products", value: followsAll(env.config) ? "Added" : "Not added" },
		],
	});
	blocks.push(hooks);
	blocks.push(
		{ type: "header", text: "Add products" },
		{
			type: "form",
			block_id: "products_find",
			fields: [{ type: "text_input", action_id: "query", label: "Search the store, or paste handles or product links (comma separated)", placeholder: "tote, harbor-mug" }],
			submit: { label: "Search", action_id: "products_find" },
		},
	);
	if (found) blocks.push(...results(found, entries));
	const importText = state?.finished
		? `Every product Shopify sells here has been added (${state.done}). Run it again to pick up new ones.`
		: state?.after
			? `Added ${state.done} so far. Each click reads the next ${PRODUCTS_BATCH}.`
			: `Adds every product Shopify sells on this site's channel, ${PRODUCTS_BATCH} per click. You can stop and carry on later.`;
	blocks.push(
		{ type: "context", text: importText },
		{
			type: "actions",
			elements: [
				{
					type: "button",
					action_id: state?.finished ? "products_all_restart" : "products_all",
					label: state?.after && !state.finished ? `Add the next ${PRODUCTS_BATCH}` : "Add all from Shopify",
					style: "secondary",
					confirm: { title: "Add products from Shopify?", text: `Reads the next ${PRODUCTS_BATCH} products from Shopify and adds each one as a published entry. Products already here are updated.`, confirm: "Add", deny: "Cancel" },
				},
				{
					type: "button",
					action_id: "products_refresh",
					label: `Refresh ${PRODUCTS_BATCH} from Shopify`,
					style: "secondary",
				},
			],
		},
		{ type: "context", text: `Refresh reads the ${PRODUCTS_BATCH} products read longest ago again. Nothing refreshes on a schedule: webhooks keep entries current, and this catches up after a missed one.` },
	);
	blocks.push({ type: "header", text: "In the catalog" });
	if (!entries.length) blocks.push({ type: "context", text: "No products yet. Search above, or add them all." });
	else
		blocks.push({
			type: "table",
			columns: [
				{ key: "title", label: "Product" },
				{ key: "handle", label: "Handle" },
				{ key: "price", label: "Price" },
				{ key: "status", label: "On sale", format: "badge" },
				{ key: "synced", label: "Read from Shopify", format: "relative_time" },
				{ key: "edit", label: "", format: "element" },
			],
			rows: entries.map((e) => ({
				title: String(e.data.title ?? ""),
				handle: String(e.data.handle ?? ""),
				price: money((e.data.price as string | null) ?? null, (e.data.currency as string | null) ?? null),
				status: e.data.listed === false ? "Off the store" : e.data.available ? "On sale" : "Sold out",
				synced: String(e.data.synced_at ?? ""),
				edit: { type: "link", label: "Edit", target: { kind: "content", collection, id: e.id }, appearance: "inline" },
			})),
		});
	if (counts.total > entries.length) blocks.push({ type: "context", text: `Showing the newest ${entries.length} of ${counts.total}. Every product is under Content.` });
	return { blocks, toast };
}

function results(found: { query: string; items: ProductMirror[] }, entries: Array<{ data: Record<string, unknown> }>): unknown[] {
	if (!found.items.length) return [{ type: "context", text: `Shopify has nothing matching "${found.query}" on this site's channel.` }];
	const have = new Set(entries.map((e) => String(e.data.shopify_id ?? "")));
	return [
		{
			type: "table",
			columns: [
				{ key: "title", label: `Found for "${found.query}"` },
				{ key: "handle", label: "Handle" },
				{ key: "price", label: "Price" },
				{ key: "add", label: "", format: "element" },
			],
			rows: found.items.map((p) => ({
				title: p.title,
				handle: p.handle,
				price: money(p.price, p.currency),
				add: have.has(p.shopify_id)
					? { type: "button", action_id: "products_add_one", label: "Refresh", value: p.handle, style: "secondary" }
					: { type: "button", action_id: "products_add_one", label: "Add", value: p.handle, style: "primary" },
			})),
		},
		{
			type: "actions",
			elements: [{ type: "button", action_id: "products_add", label: `Add all ${Math.min(found.items.length, PRODUCTS_BATCH)} shown`, value: found.items.slice(0, PRODUCTS_BATCH).map((p) => p.handle).join(","), style: "secondary" }],
		},
	];
}

/** Whether Shopify sends product changes here, with a button to turn them on. */
async function productHooks(env: ProductsEnv): Promise<unknown> {
	if (!adminConfigured()) {
		return { type: "context", text: "Without the Admin API app, entries change only when you refresh them. Set it up under Connection → App to have Shopify send product changes." };
	}
	try {
		const subs = await webhookSubscriptions(env.config, env.fetcher);
		const missing = PRODUCT_TOPICS.filter((t) => !subs.some((s) => s.topic === t && s.uri === env.webhookUri));
		if (!missing.length) return { type: "context", text: "Shopify sends product changes here (products/create, update and delete), so entries stay current." };
		return {
			type: "section",
			text: `Shopify doesn't send ${missing.map(topicName).join(", ")} here yet, so entries change only when you refresh them. The app needs the read_products scope.`,
			accessory: { type: "button", action_id: "products_webhooks", label: "Turn on product updates", style: "primary" },
		};
	} catch (e) {
		return { type: "context", text: `Couldn't check Shopify's webhooks: ${(e as Error).message}` };
	}
}

function batchToast(prefix: string, r: BatchResult): Toast {
	const failed = r.counts.failed ?? 0;
	return { type: failed ? "error" : "success", message: [`${prefix}: ${describeBatch(r)}.`, ...r.errors.slice(0, 3)].join(" ") };
}

/** The page's buttons and forms. Each answers the page as it is afterwards. */
export async function productsAction(env: ProductsEnv, i: { action_id?: string; value?: unknown; values?: Record<string, unknown> }): Promise<Blocks> {
	const collection = productsCollection(env.config);
	if (!collection) return productsPage(env);
	const store: EntryStore = contentEntries(env.db, collection);
	const opts = { fetcher: env.fetcher };
	try {
		switch (i.action_id) {
			case "products_find": {
				const query = String(i.values?.query ?? "").trim();
				if (!query) return productsPage(env, { type: "info", message: "Type a few words, or paste handles." });
				// Pasted handles or links: add them straight away.
				const parts = query.split(",").map((x) => x.trim()).filter(Boolean);
				if (parts.length > 1 || /\/products\//.test(query)) return added(env, "Added", await addProducts(env.config, store, parts, opts));
				return productsPage(env, undefined, { query, items: await findShopProducts(env.config, query, 20, opts) });
			}
			case "products_add_one":
			case "products_add": {
				const handles = String(i.value ?? "").split(",").map((x) => x.trim()).filter(Boolean);
				return added(env, i.action_id === "products_add_one" ? "Done" : "Added", await addProducts(env.config, store, handles, opts));
			}
			case "products_all_restart":
			case "products_all": {
				const before = i.action_id === "products_all_restart" ? null : await env.kv.get<ImportState>(IMPORT_KEY);
				const r = await addAllPage(env.config, store, before?.after ?? null, opts);
				const done = (before?.done ?? 0) + Object.entries(r.counts).reduce((n, [k, v]) => (k === "failed" ? n : n + (v ?? 0)), 0);
				await env.kv.set(IMPORT_KEY, { after: r.next, done, finished: !r.next, at: new Date().toISOString() } satisfies ImportState);
				await record({ event: "staff.products", label: "add all", status: describeBatch(r), level: r.counts.failed ? "warn" : "ok", origin: "staff" });
				return productsPage(env, batchToast(r.next ? "Added the next batch" : "Added the last batch", r));
			}
			case "products_refresh": {
				const r = await refreshOldest(env.config, store, opts);
				await record({ event: "staff.products", label: "refresh", status: describeBatch(r), level: r.counts.failed ? "warn" : "ok", origin: "staff" });
				return productsPage(env, batchToast("Refreshed", r));
			}
			case "products_webhooks": {
				const { added: on, failed } = await registerWebhooks(env.config, env.webhookUri, env.fetcher, PRODUCT_TOPICS);
				await record({ event: "staff.webhooks", label: "register (products)", status: failed.length ? `${failed.length} refused` : `${on.length} registered`, level: failed.length ? "warn" : "ok", origin: "staff" });
				const refused = failed.map((f) => `Shopify refused ${topicName(f.topic)}: ${f.message}`).join(" ");
				return productsPage(env, { type: failed.length ? "error" : "success", message: [on.length ? `Shopify now sends ${on.map(topicName).join(", ")}.` : "", refused].filter(Boolean).join(" ") || "Nothing was missing." });
			}
		}
	} catch (e) {
		return productsPage(env, { type: "error", message: (e as Error).message });
	}
	return productsPage(env);
}

async function added(env: ProductsEnv, prefix: string, r: BatchResult): Promise<Blocks> {
	await record({ event: "staff.products", label: "add", status: describeBatch(r), level: r.counts.failed ? "warn" : "ok", origin: "staff" });
	return productsPage(env, batchToast(prefix, r));
}
