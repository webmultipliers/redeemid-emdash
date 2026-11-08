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
		{ slug: "pro", name: "Pro", tags: ["pro"] },
	],
	rules: [
		{ collection: "posts", taxonomy: "category", term: "members", levels: ["member", "pro"] },
		{ collection: "posts", taxonomy: "category", term: "pro", levels: ["pro"] },
	],
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
