/**
 * RedeemID → Resources: a curated directory of guides, references and the
 * Shopify screens staff use alongside RedeemID. The list is plain data
 * (RESOURCES), grouped into sections, so adding one is one line.
 *
 * Links into the store's own admin appear only once the store domain is set.
 */

import { storeDomain, type RedeemIDConfig } from "./config.js";

export interface Resource {
	title: string;
	text: string;
	/** A full URL, or a path in the store's Shopify admin ("/admin/customers"). */
	url: string;
	/** The link's words; "Open" when left out. */
	label?: string;
}

export interface ResourceSection {
	title: string;
	about: string;
	items: Resource[];
}

const SITE = "https://www.redeemid.com/docs";
const REPO = "https://github.com/webmultipliers/redeemid-emdash";
const GUIDE = `${REPO}/blob/main/docs`;

export const RESOURCES: ResourceSection[] = [
	{
		title: "Get started",
		about: "Setting up RedeemID on an EmDash site, from the store connection to the first locked post.",
		items: [
			{ title: "RedeemID for EmDash", text: "What it does, how the parts fit, and where to go next.", url: `${SITE}/emdash/`, label: "Read" },
			{ title: "Install on EmDash", text: "Add the package, connect the store, set the secrets.", url: `${SITE}/emdash-install/`, label: "Read" },
			{ title: "Shopify setup", text: "The Headless storefront, the sign-in client and the Admin API app, step by step.", url: `${GUIDE}/shopify-setup.md`, label: "Read" },
			{ title: "Starter site", text: "A ready EmDash site with RedeemID, to deploy to Cloudflare or copy from.", url: "https://github.com/webmultipliers/redeemid-emdash-starter", label: "Open on GitHub" },
		],
	},
	{
		title: "Access and content",
		about: "Levels, rules, the paywall blocks and what each reader sees.",
		items: [
			{ title: "Paywall, levels and rules", text: "Lock content to levels, meter reads, drip and protected files.", url: `${SITE}/emdash-access/`, label: "Read" },
			{ title: "Content and blocks", text: "Paywall break, Members only parts, plan cards and gated templates.", url: `${GUIDE}/content.md`, label: "Read" },
			{ title: "Shopify Flow recipes", text: "Add and remove customer tags when orders, subscriptions or dates change.", url: `${GUIDE}/shopify-flow.md`, label: "Read" },
		],
	},
	{
		title: "Selling on the site",
		about: "Products, plans, the cart and checkout, all run by Shopify.",
		items: [
			{ title: "Products, plans and cart", text: "Product pages, the cart drawer, signed-in checkout and plan cards.", url: `${SITE}/emdash-shop/`, label: "Read" },
			{ title: "Product entries", text: "Keep picked Shopify products as EmDash entries for search, menus and links.", url: `${GUIDE}/products.md`, label: "Read" },
		],
	},
	{
		title: "Staff and operations",
		about: "Running the site day to day, and moving it to production.",
		items: [
			{ title: "Staff tools, webhooks and privacy", text: "Every admin page, what it shows and what each button does.", url: `${SITE}/emdash-admin/`, label: "Read" },
			{ title: "Going to production", text: "Secrets, Cron Triggers, caching and the checks before launch.", url: `${GUIDE}/production.md`, label: "Read" },
		],
	},
	{
		title: "Developers",
		about: "Using RedeemID from the site's own code, agents and other systems.",
		items: [
			{ title: "Developer API", text: "viewer(), membership(), hasFeature(), components, events and the browser API.", url: `${GUIDE}/developer-api.md`, label: "Read" },
			{ title: "EmDash reference", text: "Every config option, setting name and route.", url: `${SITE}/emdash-reference/`, label: "Read" },
			{ title: "Releases", text: "What changed in each version.", url: `${REPO}/releases`, label: "Open on GitHub" },
			{ title: "npm package", text: "@redeemid/emdash on npm.", url: "https://www.npmjs.com/package/@redeemid/emdash", label: "Open on npm" },
			{ title: "EmDash", text: "The CMS itself: its docs, plugins and source.", url: "https://github.com/emdash-cms/emdash", label: "Open on GitHub" },
		],
	},
	{
		title: "In your Shopify admin",
		about: "The store screens RedeemID mirrors. Customers, tags and orders live there.",
		items: [
			{ title: "Customers", text: "Tags, subscriptions and orders live on the Shopify customer.", url: "/admin/customers", label: "Open Shopify" },
			{ title: "Shopify Flow", text: "Automate customer tags from orders, subscriptions and dates.", url: "/admin/apps/flow", label: "Open Flow" },
			{ title: "Customer accounts", text: "Sign-in uses the store's new customer accounts.", url: "/admin/settings/customer_accounts", label: "Open settings" },
			{ title: "Shopify Dev Dashboard", text: "The Admin API app: scopes, versions and its client secret.", url: "https://dev.shopify.com/dashboard", label: "Open" },
		],
	},
	{
		title: "Help",
		about: "Questions, problems and supporting the project.",
		items: [
			{ title: "Report a problem", text: "Bugs and questions about RedeemID for EmDash.", url: `${REPO}/issues`, label: "Open an issue" },
			{ title: "Sponsor RedeemID", text: "RedeemID is free. Sponsorship keeps it that way.", url: "https://github.com/sponsors/vinnysgreen", label: "Sponsor on GitHub" },
		],
	},
];

/** The store's admin origin, or null until the domain is set. */
function shopAdmin(config: RedeemIDConfig): string | null {
	const domain = storeDomain(config);
	return domain ? `https://${domain.replace(/^https?:\/\//, "").replace(/\/+$/, "")}` : null;
}

/** The Resources page. Pure. */
export function resourcesPage(config: RedeemIDConfig, sections: ResourceSection[] = RESOURCES): { blocks: unknown[] } {
	const shop = shopAdmin(config);
	const blocks: unknown[] = [
		{ type: "header", text: "Resources" },
		{ type: "context", text: "Guides, references and the Shopify screens you'll use alongside RedeemID." },
	];
	for (const section of sections) {
		const items = section.items
			.filter((r) => !r.url.startsWith("/") || shop)
			.map((r) => ({ title: r.title, text: r.text, link: { kind: "external", url: r.url.startsWith("/") ? `${shop}${r.url}` : r.url }, label: r.label ?? "Open" }));
		if (!items.length) continue;
		blocks.push({ type: "header", text: section.title }, { type: "context", text: section.about }, { type: "redeemid_cards", items });
	}
	return { blocks };
}
