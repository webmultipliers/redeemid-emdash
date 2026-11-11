# Getting started

From an empty EmDash site to a locked post that opens for a tagged customer.

## Requirements

- **EmDash 1.1 or later** with Astro 6 or later, on Node or Cloudflare Workers (the Workers free plan is enough). The MCP tools need an EmDash version with plugin MCP tools.
- **A Shopify store with the new customer accounts** (Settings → Customer accounts). Classic accounts have no Customer Account API.
- **The Headless sales channel**, for the sign-in client and Storefront API tokens.
- **A Shopify app on the store**, such as a Dev Dashboard app, to send webhooks. With its client ID too, it runs the staff tools and preferences.
- **HTTPS.** Shopify only accepts `https` callback URIs, so a local site needs a tunnel to sign in for real.

## 1. Set up Shopify

Follow [Connect a store](shopify-setup.md). It gives you a Customer Account API client, Storefront API tokens and a webhook app. Once the package is installed, **Plugins → RedeemID → Setup** walks through the same steps for your site, with its own callback URI filled in, and says which are done.

## 2. Install

```sh
pnpm add @redeemid/emdash
```

RedeemID is a native EmDash plugin: an npm dependency, not a registry plugin, because sign-in and page gating run in the site process.

## 3. Configure

```js title="astro.config.mjs"
import { redeemid, redeemidGuard, redeemidPlugin } from "@redeemid/emdash";
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";

const config = {
	shop: "my-store.myshopify.com",
	levels: [
		{ slug: "member", name: "Member", tags: ["member"] },
		{ slug: "pro", name: "Pro", tags: ["pro"], wall: "Pro members read every report." },
	],
	rules: [
		{ collection: "posts", taxonomy: "category", term: "members", levels: ["member", "pro"] },
		{ collection: "posts", taxonomy: "category", term: "pro", levels: ["pro"] },
	],
	join: { href: "/join/", label: "Become a member" },
};

export default defineConfig({
	integrations: [
		emdash({
			// database, storage, …
			authProviders: [redeemid(config)], // sign-in, webhooks, cart and checkout routes
			plugins: [redeemidPlugin(config)], // admin pages and editor blocks
		}),
		redeemidGuard(), // gates pages and keeps members out of EmDash's own APIs
	],
});
```

Pass the same `config` to `redeemid()` and `redeemidPlugin()`. Every option is in the [config reference](reference.md#config).

Levels, rules, the meter, features, protected folders, teasers and the join link in this config are the site's defaults. You can leave them all out and set them under **Plugins → RedeemID → Access** instead; see [access settings in the admin](access.md#access-settings-in-the-admin).

## 4. Set the secrets

Set them as runtime secrets of the site (`.env` locally, `wrangler secret put` on Workers), not as build-time variables:

```sh
REDEEMID_SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID=…       # sign-in
REDEEMID_SHOPIFY_ADMIN_APP_CLIENT_SECRET=…          # verifies webhooks
REDEEMID_SHOPIFY_STOREFRONT_PRIVATE_TOKEN=…         # only to sell on the site: plans, shop and checkout
```

The [secrets reference](reference.md#secrets) lists the rest. The Setup page prints the command for each secret its steps need.

## 5. Render content through RedeemID

```astro
---
import Account from "@redeemid/emdash/components/Account.astro";
import Cart from "@redeemid/emdash/components/Cart.astro";
import Content from "@redeemid/emdash/components/Content.astro";
import Notices from "@redeemid/emdash/components/Notices.astro";
---
<header><Account /> <Cart /></header>
<Notices />
<Content value={post.data.content} collection="posts" terms={post.data.terms} id={post.id} title={post.data.title} />
```

Use `<Content>` in place of `<PortableText>` for every body that may be locked, because plain `<PortableText>` shows everything. You don't have to find them by hand: `redeemidGuard()` scans the site's `.astro` files at build time, and the Status page names each template, with its line, that renders a gated collection's body with `<PortableText>`. While any rule is on, it also lists templates whose collection it can't tell (such as a component given the body as a prop), so you can check them.

## 6. Check it

1. Finish EmDash setup as staff first. Store customers can't create the first account.
2. Open **Plugins → RedeemID → Setup**. Work down the steps until it says RedeemID is set up (it registers the webhooks for you). **Status** lists every setting as Set or Missing.
3. Tag a test customer `member` in Shopify, open a locked post, and sign in as that customer. The post opens.
4. Remove the tag in Shopify. The post locks again once the webhook arrives.
