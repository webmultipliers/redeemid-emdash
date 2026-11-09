import node from "@astrojs/node";
import react from "@astrojs/react";
import { redeemid, redeemidGuard, redeemidPlugin } from "@redeemid/emdash";
import { defineConfig } from "astro/config";
import emdash, { local } from "emdash/astro";
import { sqlite } from "emdash/db";

// A local EmDash site for trying RedeemID. Point REDEEMID_SHOPIFY_STORE_DOMAIN
// at a store (or at the fake store the e2e test starts) and set the
// REDEEMID_SHOPIFY_* secrets (see ENV in src/config.ts).
const shop = process.env.REDEEMID_SHOPIFY_STORE_DOMAIN ?? "redeemid-demo.myshopify.com";

const config = {
	shop,
	allowInsecureShop: shop.startsWith("http://127.0.0.1"),
	levels: [
		{ slug: "member", name: "Member", tags: ["member"] },
		{ slug: "pro", name: "Pro", tags: ["pro"], wall: "PRO-WALL: Pro members read every report." },
	],
	join: { href: "/join", label: "Join" },
	rules: [
		{ collection: "posts", taxonomy: "category", term: "members", levels: ["member", "pro"] },
		// The meter never opens Pro posts; Reports posts it may.
		{ collection: "posts", taxonomy: "category", term: "pro", levels: ["pro"], meter: false },
		{ collection: "posts", taxonomy: "category", term: "reports", levels: ["pro"] },
		// Updates open to members 30 days after they join.
		{ collection: "posts", taxonomy: "category", term: "updates", levels: ["member", "pro"], drip: 30 },
	],
	features: [{ slug: "supporter", name: "Supporter", tags: ["supporter"] }],
	// Members change topics and the newsletter, and only see their reader level. membership.since is never offered.
	// Files in this media folder reach Pro members and staff only.
	files: [{ folder: "Pro downloads", levels: ["pro"] }, { folder: "Story files", entries: true }],
	preferences: [{ key: "preferences.topics" }, { key: "preferences.newsletter" }, { key: "preferences.level", access: "view" }, { key: "membership.since" }],
	// Agents and the CLI may also resync members and edit tags in Shopify.
	agents: { actions: true },
	// One wall string in the site's own words; the second is ignored (its original has no {name}).
	text: { "This is for members. {signIn} to read on.": "Members only. {signIn} to keep reading.", "Sign out": "Leave, {name}" },
	// Signed member events go to the fake store in the e2e test.
	events: { url: `${shop.startsWith("http://127.0.0.1") ? shop : "https://example.invalid"}/events` },
	// Signed-in readers may open one locked post a month.
	meter: { limit: 1, collections: ["posts"] },
	// Locked posts with no paywall break show the paragraphs within their first 5 words.
	teaser: { posts: 5 },
};

export default defineConfig({
	output: "server",
	adapter: node({ mode: "standalone" }),
	image: { layout: "constrained", responsiveStyles: true },
	integrations: [
		react(),
		emdash({
			database: sqlite({ url: `file:${process.env.REDEEMID_DB ?? "./data.db"}` }),
			storage: local({ directory: "./uploads", baseUrl: "/_emdash/api/media/file" }),
			authProviders: [redeemid(config)],
			// Shows RedeemID in the admin and adds the Paywall break and Plan blocks.
			plugins: [redeemidPlugin(config)],
		}),
		redeemidGuard(),
	],
	devToolbar: { enabled: false },
});
