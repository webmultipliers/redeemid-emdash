# RedeemID for EmDash

[![npm](https://img.shields.io/npm/v/@redeemid/emdash)](https://www.npmjs.com/package/@redeemid/emdash)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Memberships and paywalls for [EmDash](https://github.com/emdash-cms/emdash) sites, run by Shopify.

Readers sign in with the store's own customer account. Their Shopify customer tags decide what they can read. Shopify keeps the store, checkout, orders and subscriptions, and EmDash keeps the content. Nothing on the site grants access by itself, so there is one source of truth for who paid for what.

**Status: 0.0.21, early.** Runs on Node and Cloudflare Workers. Unit tests and an end-to-end test that boots a real EmDash site against a fake Shopify store cover the features below. Expect changes before 1.0.

## Contents

- [How it works](#how-it-works)
- [What you get](#what-you-get)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Content and templates](#content-and-templates)
- [Guides](#guides): [rules](#rules), [access settings in the admin](#access-settings-in-the-admin), [meter and drip](#meter-and-drip), [selling one entry](#selling-one-entry-on-its-own), [features](#features), [shop](#shop), [preferences](#preferences), [protected files](#protected-files), [privacy requests](#privacy-requests), [staff tools](#staff-tools), [webhooks, app events and reports](#webhooks-app-events-and-reports), [AI agents and the command line](#ai-agents-and-the-command-line), [replacement text](#replacement-text), [events](#events), [caching](#caching), [rate limits](#rate-limits)
- [Reference](#reference): [config](#config), [secrets](#secrets), [components](#components), [editor blocks](#editor-blocks), [modules](#modules), [routes](#routes), [notices](#notices)
- [Guarantees](#guarantees)
- [Troubleshooting](#troubleshooting)
- [Develop](#develop)

## How it works

1. **Sign in.** A reader clicks "Sign in", signs in on the store's customer account page, and comes back signed in as an EmDash Subscriber. That role only means "signed in". It never opens content.
2. **Mirror.** RedeemID keeps a copy of the customer: email, name, tags and whether the account is enabled. Signed Shopify webhooks keep it current.
3. **Levels.** You map tags to levels and name them whatever you like, such as `gold-member` to Gold. Tags come from Shopify Flow, a subscription app or staff, never from the site.
4. **Rules.** You say which content types or terms need which levels, in the admin (Plugins → RedeemID → Access) or in code. Each entry can have its own rule in the editor's Access panel, and editors can drop a Paywall break or a Members only block into any body.
5. **Render.** Templates render bodies with `<Content>`. Readers who pass see everything. Everyone else gets a teaser and the wall, and the locked part never reaches the page.

Selling a membership is ordinary Shopify: a product, a checkout, and a Flow workflow that tags the customer when the order is paid. RedeemID shows the product and starts checkout, and access follows the tag. [docs/shopify-flow.md](docs/shopify-flow.md) has the workflows: paid order, refund, cancelled subscription, and a pass that ends.

## What you get

**For members**
- Sign in, Account (orders, profile and addresses on the store) and Sign out, which ends the store session too. Members never see the word "Shopify".
- A member card with their levels and when each started, when the membership renews or ends and any gift membership (from Shopify), past levels, the meter, and Refresh membership to read their tags again after a purchase.
- Preferences they can change, such as topics or a newsletter choice, saved on the Shopify customer.
- Download or delete what the site keeps about them.

**For editors**
- Paywall break, Members only, Sold on its own, Plan, Product, Collection, Product search, Contribution and Preferences blocks in the EmDash editor.
- An Access panel on every entry: follow the site rules, free to everyone, only some levels, or the site rules plus a level, with drip, meter and date windows.
- Rules by content type, term (with child terms) or site default, plus terms that open entries to everyone.
- Teasers, a monthly or weekly meter, drip by days of membership, and badges that show what an entry needs.
- Protected files: downloads in chosen media folders check the reader's access.

**For staff, in the EmDash admin**
- Access page: levels, site rules, the meter, every content type and taxonomy (new ones appear on their own), features and protected folders. No code change needed.
- Members page, member detail (resync, add and remove tags in Shopify), a bulk resync you start yourself.
- Webhooks page: what Shopify sent and what became of it, delivery health with a daily check and email warnings, and the subscriptions with a Register button.
- App events: webhooks, sign-ins and refusals, Admin API calls, staff actions and settings saves, filterable, kept 30 days.
- Reports: members by level, who joined and left by week, sign-ins and metered reads.
- Setup page: connecting a store step by step, with the exact values to paste into Shopify, the command for each secret, a Register button for the webhooks and a form for the first level. Each step checks the site as it is.
- Status page: every setting, store discovery, levels and rules, and any template that would show a locked body in full.
- Access test, Privacy page, and a dashboard widget.

**For developers**
- Astro components for every piece, plus `canRead()`, `readEntry()` and `hasFeature()` for your own code.
- A storefront from the Storefront API: product pages with options, subscriptions and galleries, collection grids with Shopify's filters, sorting and pages, product search, recommendations, a cart page and a cart drawer, pay-what-you-want, local prices, and a checkout that opens signed in for members.
- A browser client, `window.redeemid`, with `subscribe()` events for any analytics or CRM tool, cart methods and search, plus JSON routes for state, the cart and the catalog. See [docs/developer-api.md](docs/developer-api.md).
- Signed outbound events for a CRM or email tool, MCP tools for AI agents (members, access and the catalog), and a `redeemid-emdash` command.
- Replacement text for every string readers see, Google's paywalled-content markup, cache safety and optional rate limits.

## Requirements

- **EmDash 1.1 or later** with Astro 6 or later, on Node or Cloudflare Workers (the Workers free plan is enough). The MCP tools need an EmDash version with plugin MCP tools.
- **A Shopify store with the new customer accounts** (Settings → Customer accounts). Classic accounts have no Customer Account API.
- **The Headless sales channel**, for the sign-in client and Storefront API tokens.
- **A Shopify app on the store**, such as a Dev Dashboard app, to send webhooks. With its client ID too, it runs the staff tools and preferences.
- **HTTPS.** Shopify only accepts `https` callback URIs, so a local site needs a tunnel to sign in for real.

## Quick start

### 1. Set up Shopify

Follow [docs/shopify-setup.md](docs/shopify-setup.md). It gives you a Customer Account API client, Storefront API tokens and a webhook app. Once the package is installed, **Plugins → RedeemID → Setup** walks through the same steps for your site, with its own callback URI filled in, and says which are done.

### 2. Install

```sh
pnpm add @redeemid/emdash
```

RedeemID is a native EmDash plugin: an npm dependency, not a registry plugin, because sign-in and page gating run in the site process.

### 3. Configure

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

Pass the same `config` to `redeemid()` and `redeemidPlugin()`. Every option is in the [config reference](#config).

Levels, rules, the meter, features, protected folders, teasers and the join link in this config are the site's defaults. You can leave them all out and set them under **Plugins → RedeemID → Access** instead; see [access settings in the admin](#access-settings-in-the-admin).

### 4. Set the secrets

Set them as runtime secrets of the site (`.env` locally, `wrangler secret put` on Workers), not as build-time variables:

```sh
REDEEMID_SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID=…       # sign-in
REDEEMID_SHOPIFY_ADMIN_APP_CLIENT_SECRET=…          # verifies webhooks
REDEEMID_SHOPIFY_STOREFRONT_PRIVATE_TOKEN=…         # only to sell on the site: plans, shop and checkout
```

The [secrets reference](#secrets) lists the rest, and the Setup page prints the command for each one.

### 5. Render content through RedeemID

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

### 6. Check it

1. Finish EmDash setup as staff first. Store customers can't create the first account.
2. Open **Plugins → RedeemID → Setup**. Work down the steps until it says RedeemID is set up (it registers the webhooks for you). **Status** lists every setting as Set or Missing.
3. Tag a test customer `member` in Shopify, open a locked post, and sign in as that customer. The post opens.
4. Remove the tag in Shopify. The post locks again once the webhook arrives.

## Content and templates

EmDash has no content filter hook, so templates decide what to render.

**`<Content>`** renders an entry body. Everything before the first Paywall break block is shown to everyone. What follows reaches the page only for readers the break allows: the levels picked on it ("Signed in" for any member) or, with none picked, the entry's rule. With none picked and no rule covering the entry, the break changes nothing. A body with no break follows the entry's rule as a whole, and readers it keeps out see the collection's `teaser` if one is set (whole paragraphs, never half of one).

```astro
<Content value={post.data.content} collection="posts" terms={post.data.terms} id={post.id} title={post.data.title}>
	<a slot="locked" href="/join/">Become a member</a>
</Content>
```

Pass `id` on the entry's own page. It lets the meter count the read, and a locked entry gets Google's paywalled-content markup: JSON-LD with `isAccessibleForFree: false` and the wall (`.redeemid-locked`) as the part that isn't free, so search engines can tell a paywall from cloaking. `title` is its headline. Set `schema: false` if an SEO plugin already adds this markup.

**Members only.** A "Members only" block starts a part for the levels picked on it (none picked: the entry's rule, or any signed-in member) that runs to the next "Members only: end" block. Readers who can't read it see the wall in its place and read on after it.

**The wall** is `<LockedPanel>`. It says why the reader is kept out and offers sign-in or the join link, with the wall text of the first level they're missing. `<Content>` and `<Gate>` show it, and their `locked` slot goes on top.

**`<Gate>`** locks any part of a template that isn't the body:

```astro
<Gate levels={["pro"]}><a href="/reports/archive.zip">Download the archive</a></Gate>
```

**`<AccessBadge>`** shows what an entry needs, on cards and on the entry. It shows "Free" for open entries (`free=""` hides it), adds `is-locked` and a lock for readers it keeps out, and puts the level slugs in `data-redeemid-level` for colours:

```astro
<AccessBadge collection="posts" terms={post.data.terms} content={post.data.content} />
```

**`<Notices />`** goes near the top of the layout. It shows the message for a `?redeemid_notice=` code (see [notices](#notices)) and nothing otherwise.

**`<MemberCard />`** is for an account page: levels with start dates, the renewal or end date and any gift membership that Shopify keeps (see [membership dates](#membership-dates)), past levels, the meter, and links to the store account, Refresh membership and Sign out. Refresh membership sends a member to the store with no sign-in form; one still signed in there comes straight back with their tags read again. Add `<Preferences />` and `<YourData />` beside it.

**`<Plan>`** sells a membership: a Shopify product's title and price with a button that starts checkout (members check out with their email). With `levels`, members who already hold one see "You're on this plan." in place of the button, and a member who held one before (Shopify has since removed its tag) gets **Renew** (`renewLabel`) instead of `label`. The wall does the same: a lapsed member reads "Your Pro membership has ended." with **Renew Pro** and **Already renewed? Refresh**, not the newcomer's join link.

```astro
<Plan handle="gold-membership" label="Join Gold" levels={["gold"]}>
	<p>Shown if the product can't be loaded.</p>
</Plan>
```

**In your own code** (`@redeemid/emdash/access`):

```ts
import { canRead, entryRequirement, readEntry, siteConfig } from "@redeemid/emdash/access";

const verdict = await canRead(Astro, { collection: "posts", terms: post.data.terms, id: post.id });
// verdict.allowed; verdict.reason: open | allowed | sign_in | upgrade | disabled | unconfigured
const read = await readEntry(Astro, { collection: "posts", terms: post.data.terms, id: post.id });
// adds drip (read.opensAt) and the meter (read.meterLeft), and counts a metered read

const config = await siteConfig(Astro.locals);
const needs = await entryRequirement(config, "posts", post.data.terms, post.id);
// e.g. [["gold", "pro"]]: readers pass every clause, each with any one of its levels; null when open
```

`siteConfig(Astro.locals)` is the config for this request: your code's config with the Access page's saved settings laid over it. Pass it to the functions that take a `config`, such as `entryRequirement()`, `readPreferences()` and the storefront and catalog calls.

## Guides

### Rules

Each rule names a collection and the levels, any of which may read. An empty `levels` list, or the built-in `signed-in` level, means any signed-in member.

| Rule | Covers |
| --- | --- |
| `{ collection: "reports", levels: ["gold"] }` | Every entry in the collection |
| `{ collection: "posts", taxonomy: "category", term: "investigations", levels: ["gold"] }` | Entries with that term, or a child of it in a hierarchical taxonomy. A child's own rule wins over its parent's. |
| `{ collection: "posts", taxonomy: "tag", term: "free-to-read", levels: [], open: true }` | Opens entries with that term to everyone, whatever else covers them |
| `{ collection: "pages", levels: [], open: true }` | Opens a whole collection to everyone, unless a term rule locks an entry |
| `{ collection: "*", taxonomy: "category", term: "members", levels: ["member"] }` | That term in every collection, new ones included. A rule for the same term and a named collection wins there. |
| `{ collection: "*", levels: [] }` | The site default, for collections with no rule of their own |
| `{ collection: "posts", taxonomy: "category", term: "archive", levels: ["member"], drip: 30 }` | Drip: members read these entries 30 days after their level started |
| `{ collection: "posts", taxonomy: "category", term: "exclusive", levels: ["pro"], meter: false }` | The meter never opens these entries |

Term rules beat the collection's rule, which beats the site default. When several term rules cover one entry (a story in Investigations, which needs Gold, and Culture, which needs Silver), readers must pass every one of them, so only members with both read it. Set `combine: "any"` to let one be enough.

Levels can need several tags: `{ slug: "both", name: "Member + Pro", tags: ["member", "pro"], match: "all" }`. A level's `wall` is what the wall says to readers it would let in, and its `joinUrl` overrides `join.href`.

### Access settings in the admin

Everything about who reads what can be set in the EmDash admin, so a new content type, taxonomy or level never needs a code change. Under **Plugins → RedeemID → Access**:

- **Levels.** Add, rename and remove levels and the Shopify tags that grant them. Name them anything; the slug is made from the name. A level that rules, features or folders still use can't be removed.
- **Site rules.** The site default, how term rules combine, the meter and the wall's join link.
- **Content types.** Who can read each collection, with drip, the meter and the teaser. Every collection on the site is listed, including ones made after RedeemID was set up.
- **Taxonomies.** Rules for terms in every taxonomy, for one collection or every collection the taxonomy is on.
- **Features** and **Protected files.**

The first save of a setting copies its value from your code config, so nothing is lost, and from then on the admin's value is used. **Use the code's setting** removes the admin's copy. Saved settings are kept in the site's database. Each server keeps the last ones it read and checks one small record per request to see whether anyone saved since, so the whole set is read again only after a save. If the database can't be read, the settings last read stand; a server that has read none yet locks every entry (and refuses files in any media folder) until it can, rather than falling back to the code's settings and opening what the admin locked.

Each saved entry also gets an **Access** panel in the editor. It shows who can read the entry right now and which rule says so, and sets the entry's own rule:

| Choice | Readers need |
| --- | --- |
| Follow the site rules | What the rules say (the default) |
| Free to everyone | Nothing |
| Only some levels | One of the levels ticked (none ticked: any signed-in member) |
| Site rules plus a level | What the rules say and one of the levels ticked |

The panel can also hold the entry back for some days of membership, keep the meter off it, lock it until a date and then open it, or keep it free until a date and then lock it. Pass the entry's `id` (or slug) to `<Content>`, `<AccessBadge>` and `<Gate>` so its own rule applies there.

Moving an entry to the trash keeps its rule for a restore but frees its slug, so a new entry that takes the slug doesn't inherit the rule.

### Meter and drip

```ts
meter: { limit: 3, period: "month", collections: ["posts"] },
teaser: { posts: 40 },
```

The meter lets a signed-in reader open a locked entry anyway, `limit` entries per `period` (`"month"`, the default, or `"week"`, in UTC). Each entry counts once per period, when its own page renders through `<Content>` with an `id`. Lists, feeds, search and the content API never count. Visitors get the wall and a nudge to sign in. While it runs, `<Content>` says how many free reads are left, and when it runs out the wall says so. Rules with `meter: false` are never metered, and the meter never opens an entry a member is waiting on by drip.

Drip holds a rule's entries back from members who pass it until they've held their level for `drip` days. A level starts when the customer first had its tag (for a `match: "all"` level, the last of its tags). With several levels the earliest counts, and with none known, the first sign-in. RedeemID notes when each tag first arrives and forgets it when Shopify removes it. The wall shows the date the entry opens.

### Selling one entry on its own

Add the **Sold on its own** block anywhere in an entry's body. Give it the Shopify customer tag buyers get, such as `item-big-story`, and the product that sells it (its handle, or a link to it). Then:

- A reader holding that tag reads the whole entry. Its rule, Paywall break, Members only parts and drip don't apply, and the meter isn't used.
- Locked readers see **Buy just this** on the wall with the product's price, beside the level's offer.
- `<AccessBadge>` drops the lock for buyers, and protected files in an `entries: true` folder that the entry uses reach them too.

Shopify adds the tag when the order is paid, usually with a Flow workflow (Order paid → the line item is that product → add the customer tag). A refund workflow that removes the tag takes the entry away again.

### Features

```ts
features: [
	{ slug: "ad-free", name: "Ad-free", levels: ["gold", "premium"] },
	{ slug: "supporter", name: "Supporter", tags: ["supporter"] },
],
```

A member holds a feature through any of its levels or tags. `<MemberCard>` lists them under the member's levels.

```astro
---
import Feature from "@redeemid/emdash/components/Feature.astro";
import { hasFeature } from "@redeemid/emdash/features";
---
<Feature slug="supporter"><p>Thanks for your support.</p><p slot="else">Become a supporter.</p></Feature>
{!(await hasFeature(Astro, "ad-free")) && <aside class="ad">…</aside>}
```

### Shop

Products, collections, search and the cart come from the Storefront API. Shopify works out prices, discounts, taxes and stock, and runs checkout. EmDash has no Shopify plugin underneath, so these components are the storefront.

```astro
<!-- layout, once -->
<Cart drawer />
<CartDrawer />
<RedeemIDClient />
<!-- /shop/ (rendered on demand for filters and pages) -->
<Collection handle="shop" productHref="/shop/{handle}/" showTitle browse quickAdd />
<!-- /shop/[handle]/ -->
<Product handle={Astro.params.handle} heading="h1"><p>No such product.</p></Product>
<Recommendations handle={Astro.params.handle} productHref="/shop/{handle}/" />
<!-- /search/ -->
<ProductSearch productHref="/shop/{handle}/" />
<!-- /cart/ -->
<CartView productHref="/shop/{handle}/" />
<!-- anywhere -->
<Contribution handle="support" amounts={[5, 10, 25]} />
```

- `<Product>`: images (with thumbnails), title, price and sale price, description (`html` for Shopify's formatted one), a picker per option (Size, Color…), one-time or subscription when the product has selling plans, quantity, Add to cart and Buy now. On a product's own page (`heading="h1"`) it prints Product structured data.
- `<Collection>`: up to 50 products as cards linking to `productHref`. `browse` adds Shopify's filters (set up in the Search & Discovery app), sort orders and pages, read from the page URL. `quickAdd` adds Add to cart on cards that need no choice.
- `<ProductSearch>`: a search box with Shopify's matches, filters, sorting and pages. `boxOnly` gives just the box, for a header, sending searches to `action`.
- `<Recommendations>`: Shopify's "You may also like" (`intent="related"`) or "Pair it with" (`intent="complementary"`) for a product.
- `<CartView>`: each line with a quantity to change (0 removes it) and Remove, a discount code field, the totals and Checkout.
- `<CartDrawer>`: the same cart in a modal dialog that slides in. With `<RedeemIDClient />` on the page, Add to cart opens it in place and `<Cart drawer />` opens it instead of going to checkout.
- `<Contribution>`: pay what you want. Price a product at 1.00, and the amount the reader picks becomes the quantity.
- `<Cart>`: the item count, linking to checkout, or to `href` (a cart page), or opening the drawer with `drawer`.

Everything works without JavaScript: the forms post to `/_emdash/api/auth/redeemid/cart-edit`, which reads every product, variant, option and selling plan from Shopify again and only changes the visitor's own cart. `<RedeemIDClient />` adds the drawer, option pickers that follow the choice, and search suggestions. A new cart carries the `_redeemid_page` attribute (the page the first item was added on), which shows on the order in Shopify admin. Editors get the same with the Product, Collection, Product search and Contribution blocks.

**Signed-in checkout.** When a signed-in member checks out, RedeemID puts their store sign-in (the Customer Account API access token, kept only in the server-side session, encrypted with a key kept in the site's database, and renewed when it's about to expire) on the cart, so Shopify's checkout opens signed in and the order lands on their customer record, where your Flow or apps tag it. If that can't be done, they check out as a guest with their email filled in. Set `checkout: { signIn: false }` to always use a guest checkout; then the tokens aren't kept at all.

**Local prices.** Set `market: { country: "visitor" }` to show each visitor prices in their own market (from Cloudflare's `CF-IPCountry`), or a fixed `country` and `language`. Markets are set up in Shopify.

**Shoppers' agents.** Shopify runs a Storefront MCP server for every store at `https://<store domain>/api/mcp`, for AI agents that browse, build a cart and check out. Point shopping agents there; RedeemID's own tools are for staff.

### Preferences

```ts
preferences: [
	{ key: "preferences.topics" },                  // members can change it
	{ key: "preferences.level", access: "view" },   // members only see it
],
```

Define each field in Shopify (**Settings → Custom data → Customers**); the definition sets its name, type and limits. List the ones members get, in the order to show them. Reading and saving use the Admin API app (`REDEEMID_SHOPIFY_ADMIN_APP_CLIENT_ID` with `read_customers` and `write_customers`), always on the signed-in member's own customer. Fields in the `membership` namespace are never offered, and preferences never open content.

`<Preferences>` (or its block) is a form that works without JavaScript. Visitors see its `signed-out` slot.

| Shopify type | Value |
| --- | --- |
| Single line text | A string; with choices, one of them |
| Multi-line text | A string |
| List of single line text | A list of strings; with choices, each one of them |
| True or false | `true` or `false` |
| Integer | A whole number |
| Decimal | A number, as a string |
| Date | `YYYY-MM-DD` |

Every value is checked against the definition first. One refusal saves nothing, and an empty value clears the field. Scripts can `GET` `/_emdash/api/auth/redeemid/preferences` for `{ fields }`, or `POST` JSON `{ values: { "namespace.key": value } }`. A refused save answers `400` with `fields` mapping each key to `unknown_field`, `read_only`, `invalid_type`, `invalid_choice`, `invalid_length` or `invalid_range`. Saves are limited to 10 a minute per member (`429`). From your own code, `readPreferences(config, customerId)` and `savePreferences(config, customerId, values)` in `@redeemid/emdash/preferences` do the same (no rate limit there; `config` comes from `siteConfig()`).

### Protected files

```ts
files: [
	{ folder: "Gold downloads", levels: ["gold"] },
	{ folder: "Member downloads", levels: [] },             // any signed-in member
	{ folder: "Supporter extras", features: ["supporter"] },
	{ folder: "Story files", entries: true },               // whoever can read an entry that uses it
],
```

Upload files into a folder in the EmDash media library (names match without regard to case). Every request for one at `/_emdash/api/media/file/…` is checked before EmDash serves it:

- **Allowed:** the file, with `Cache-Control: private, no-store`.
- **Signed out:** a 401 page with a sign-in link that comes back to the file.
- **Signed in without access:** a 403 page.

A rule lets in members who hold any of its `levels` or `features`. With `entries: true` it also lets in whoever can read a published entry that uses the file. Staff can always download, disabled members can't, and a file that can't be checked isn't served.

Limits: only EmDash's file route is checked, so don't give the storage bucket a public URL. Image services that fetch without the reader's cookies, such as a CDN resizer, are refused. Moving a file out of the folder makes it public again.

### Privacy requests

What RedeemID keeps about a member: the synced record (Shopify customer ID, email, name, tags and when each started, account status, first sign-in, last sync, whether the email was verified, email and SMS marketing consent, and the membership dates) and their meter. Preference answers stay on the Shopify customer, and webhook deliveries keep only a topic and a time. Erasing on the site never erases Shopify data; it can only ask Shopify to.

| Started by | What happens |
| --- | --- |
| A member, with `<YourData>` | **Download my data** returns their record and meter as JSON. **Delete my data** needs a ticked box, erases both, and signs them out. |
| Staff, on a member's page | **Export data**, **Erase site data**, and **Also request erasure in Shopify** (orders included, after Shopify's wait; **Cancel the Shopify erasure** withdraws it). The Shopify request needs the `write_customer_data_erasure` scope. |
| Shopify `customers/data_request` | An open request on the **Privacy** page. Press **Export and mark done**, then send the export to the store owner. |
| Shopify `customers/redact` | The member's record and meter are erased. |
| Shopify `shop/redact` | Every member record and meter is erased. |

The Privacy page shows each request's source and Shopify customer ID, never an email or a name. The daily check deletes finished requests after a year; open ones stay until staff mark them done. An erase sends the `member.erased` event so a CRM can delete its copy too. The site's own user account stays; delete it under Users if the person asks. The JSON route is `/_emdash/api/auth/redeemid/privacy`: `GET` downloads, `POST` with `confirm=yes` erases, only for the signed-in member and only from the site's own origin.

### Staff tools

With `REDEEMID_SHOPIFY_ADMIN_APP_CLIENT_ID` set, RedeemID gets an Admin API token for the webhook app with the client credentials grant. The app must be in the same Shopify organization as the store, as Dev Dashboard apps are, and needs `read_customers` and `write_customers`. Then, under **Plugins → RedeemID**:

- **Member detail.** Levels, tags and features; resync from Shopify; add and remove tags. Tag edits are made in Shopify and read back. Nothing is granted on the site.
- **Bulk resync.** Reads the 25 members synced longest ago, few enough for the Workers free limit of 50 database queries a request. Press it again for the next 25. It never runs on its own.
- **Webhook subscriptions.** Webhooks → Setup lists the store's subscriptions to this site and registers any that are missing. A topic Shopify refuses, such as `customers/merge` without `read_customer_merge`, is named with the reason and doesn't stop the others. `customers/redact` stays in the app's own settings.
- **Access test.** A collection, an entry, terms and a reader's tags in; the verdict out.

Resync updates email, name, tags, email marketing consent and the membership dates. Enabled or disabled status comes only from the enable and disable webhooks. With the app set up, two more things read the customer from the Admin API as it is now: every sign-in (and Refresh membership), and every `customer.tags_added` or `customer.tags_removed` webhook. Those topics carry only the change and can arrive out of order, so reading the current tags keeps the mirror right. Without the app, or when the read fails, the webhook's change is applied as sent.

#### Membership dates

A subscription app or Shopify Flow can keep these customer metafields, as dates (`YYYY-MM-DD`):

| Metafield | Shown |
| --- | --- |
| `membership.member_since` | As the start date on the member card, in place of when the tag arrived |
| `membership.renews_on` | "Renews on ..." |
| `membership.ends_on` | "Ends on ...", for a pass that doesn't renew |
| `membership.gift_until` | "Gift membership until ...", while it's in the future |

RedeemID reads them with the Admin API (resync, sign-in, tag webhooks), so they need the Admin API app. They're for display only: access still comes from tags alone, and nothing on the site ends access on these dates. Time-boxed access is a Flow that waits and removes the tag (see [Shopify Flow recipes](docs/shopify-flow.md)).

### Webhooks, app events and reports

Members gain and lose access only when Shopify sends tag changes, so RedeemID shows what arrived and warns when deliveries stop.

- **Webhooks → Received.** Each delivery's topic, what became of it (processed, skipped, older than what's stored, not used) and the customer ID, with counts of deliveries turned away (bad signature) and failed (storage errors; Shopify sends those again).
- **Webhooks → Health.** Once a day RedeemID registers again any subscription Shopify dropped (with the Admin API app), and warns when no webhook has come in for a number of days (3 by default, 0 turns it off), or when deliveries were turned away or failed in the last day. **Check now** runs it at once. Warnings show on the page and the dashboard widget. If you enter an address on the Health tab and the site has an EmDash email provider, they also go by email: once when problems start or change, then once a week while they last.
- **Webhooks → Setup.** The endpoint, whether signatures can be checked, and the subscriptions.
- **App events.** What RedeemID did and what came of it: webhooks received, turned away and failed, sign-ins and refusals (by reason), Admin API calls (by operation, with timings), resyncs, tag edits, webhook registrations, settings saves, outbound events that failed, metered reads and the health checks. Filter by event or show problems only. Entries hold ids, labels and outcomes, never bodies, tokens or emails. Failed outbound events also keep the event body (ids and levels, never an email or a name) so they can be sent again.
- **Reports.** Members on each level, who joined and left in the last 30 days and by week for 12 weeks (from each member's tag dates), sign-ins and metered reads.

App events and delivery records are kept 30 days. The daily check runs from EmDash's scheduler: on Node it runs by itself; on Cloudflare Workers, add a Cron Trigger to the site's Worker as EmDash's deployment guide describes. The plugin asks for `email:send` only to send these warnings.

### AI agents and the command line

Staff questions as data, for AI agents and scripts. Every one needs an administrator, reads what the site has synced, and never grants access, edits a rule or returns a secret.

| MCP tool | Command | What it answers |
| --- | --- | --- |
| `explain_access` | `access <collection>` | Can this reader read this entry, and why. Give the entry by `id` or `terms`, and the reader by `tags`, `customerId` or `signedIn: false`. |
| `list_levels` | `levels` | Every level, its tags, wall text and join link |
| `get_rules` | `rules` | How rules combine, every rule, the meter, teasers, features and file rules |
| `get_member` | `member <id or email>` | One member: status, tags, levels with start dates, past levels, features, last sync |
| `site_health` | `health` | Each setting (set or not, never a value), the last webhook, open privacy requests, ignored text replacements |
| `level_changes` | `changes --since <date>` | Who joined or left a level since a date |
| `find_products` | `products <words>` | Search the Shopify catalog: handles, titles, prices, stock |
| `get_product` | `product <handle>` | One product: options, variants, prices, selling plans |
| `get_collection` | `collection <handle>` | One collection: its products and the filters Shopify offers |

With `agents: { actions: true }`, three actions are offered too: `resync_member` (`resync <customer id>`), `resync_batch` (`resync-batch`, 25 members) and `edit_member_tags` (`tags <customer id> --add a,b --remove c`, marked destructive for agents).

**Agents** use EmDash's MCP server at `/_emdash/api/mcp` with an API token that has the `mcp:tools` or `mcp:tools:redeemid` scope. The tools stay off until an administrator turns them on for RedeemID under **Plugins**, and a release that changes the list needs approving again. Names carry the prefix, such as `redeemid__explain_access`.

**The command line** signs in the way EmDash's CLI does: `--token`, `EMDASH_TOKEN`, or the token `emdash login` saved. The site comes from `--url` or `EMDASH_URL`. Output is JSON.

```sh
npx -p @redeemid/emdash redeemid-emdash access posts --id my-story --tags gold-member --url https://example.com
npx -p @redeemid/emdash redeemid-emdash member jane@example.com
```

Each command POSTs JSON to a staff-only route under `/_emdash/api/plugins/redeemid/`, named after its tool with hyphens (`explain_access` is `explain-access`). Scripts can call those routes directly.

### Replacement text

```ts
text: {
	"Sign in": "Log in",
	"This is for members. {signIn} to read on.": "Members only. {signIn} to keep reading.",
	"This is for {level} members.": "{level} members only.",
},
```

Each key is a string's original English and its value is the new text. Only the strings you name change: there is no find-and-replace, so replacing "Sign in" leaves "Sign in to download this file." alone. `STRINGS` in `@redeemid/emdash/text` lists every string, grouped by where it shows.

A replacement may use its original's placeholders (such as `{level}`, or `{signIn}` for a link) in any order, or not at all, but no others. Text is plain, so HTML shows as typed. A replacement with an unknown placeholder, or for a string RedeemID doesn't show, is ignored and listed on the Status page with the reason. Props you pass (`label`, `title`, Notices `messages`) win over `text`. Staff screens in the admin aren't covered.

### Events

```ts
events: { url: "https://hooks.example.com/redeemid", only: ["member.signed_in", "member.levels_changed"] },
```

With `REDEEMID_EVENTS_SECRET` set, RedeemID POSTs `{ id, event, at, data }` to the URL with the headers `X-RedeemID-Event`, `X-RedeemID-Delivery` (the `id`) and `X-RedeemID-Signature: sha256=<hex HMAC-SHA256 of the raw body>`. Check the signature before you trust a body. Events go out after the response (with `waitUntil` on Workers), so sign-in, webhooks and pages never wait for your receiver. Each try waits at most 3 seconds; a send that fails is tried again after 1 second and after 5 seconds. One that fails all three tries is kept under **App events → Failed events**, where staff can **Send again** (same `id`, so drop duplicates by it) or **Clear** it; failed events are deleted after 30 days.

| Event | `data` |
| --- | --- |
| `member.signed_in` | `customerId`, `levels`, `first` (first sign-in), `refresh` |
| `member.levels_changed` | `customerId`, `levels`, `added`, `removed`, `source` (`sign-in`, the webhook topic, or a staff resync or tag edit) |
| `meter.used` | `userId` (EmDash), `entry` (`collection:id`), `used`, `limit`, `period` (`2026-11`, or `2026-W45` by week) |
| `meter.exhausted` | The same, sent with the last free read |
| `preferences.saved` | `customerId`, `fields` (the names changed, never the answers) |
| `member.erased` | `customerId`, `source` (`member`, `staff` or `shopify`) |

No event carries an email address or a name; match people by `customerId`. Leave `only` out to send every event.

### Caching

`redeemidGuard()` keeps every page private for a signed-in visitor or a visitor with a cart: `Cache-Control: private, no-store`, and out of Astro's route cache (it calls `cache.set(false)` after the page sets its own hint). Other visitors all get the same page, so their pages stay cacheable.

A route cache keys pages by URL alone and serves stored pages without running any code. If you turn on Astro's route cache, don't cache pages that render `<Content>` or `<Gate>` for locked entries, or a member would get the visitor's copy, wall included. Call `Astro.cache.set(hint)` only on pages whose entries no rule covers. Saving on the Access page or an entry's Access panel doesn't purge the route cache either, so a page cached before the change keeps its old copy until it expires.

### Rate limits

On Cloudflare Workers, `redeemidGuard({ rateLimit: true })` limits how often one visitor can start Sign in, Buy, a cart change or a catalog search (`api/search`), the routes that call Shopify. Add a [Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) named `REDEEMID_RATE_LIMIT`, which sets the limit and period:

```jsonc
"ratelimits": [{ "name": "REDEEMID_RATE_LIMIT", "namespace_id": "1001", "simple": { "limit": 20, "period": 60 } }]
```

Each action counts separately per visitor (by `CF-Connecting-IP`), and Cloudflare's count is approximate. A visitor over the limit goes back to their page with the `too_many_requests` notice; the JSON routes answer `429` with `{ "error": "too_many_requests" }`. If the binding is missing or fails, nothing is limited. Off by default; leave it off on Node.

## Reference

### Config

Pass one object to both `redeemid(config)` and `redeemidPlugin(config)`. `levels`, `rules`, `meter`, `features`, `files`, `combine`, `teaser` and `join` are defaults that the Access page can replace.

| Option | Type | What it does |
| --- | --- | --- |
| `shop` | `string` | The store's `*.myshopify.com` domain (a custom customer-account domain works too). Leave it out to read `REDEEMID_SHOPIFY_STORE_DOMAIN`. |
| `label` | `string` | The sign-in button's label. Default "Sign in". |
| `levels` | `{ slug, name, tags, match?, wall?, joinUrl? }[]` | Levels from customer tags. `match: "all"` needs every tag. |
| `rules` | `{ collection, taxonomy?, term?, levels, open?, drip?, meter? }[]` | What needs which levels. See [rules](#rules). |
| `combine` | `"all"` \| `"any"` | How several term rules on one entry combine. Default `"all"`. |
| `join` | `{ href, label? }` | The wall's join link. |
| `teaser` | `{ [collection]: words }` | Teaser length for locked entries with no paywall break. |
| `meter` | `{ limit, period?, collections? }` | Free reads for signed-in readers. |
| `features` | `{ slug, name, levels?, tags? }[]` | Perks held through levels or tags. |
| `preferences` | `{ key, access? }[]` | Customer metafields members see (`access: "view"`) or change. |
| `files` | `{ folder, levels?, features?, entries? }[]` | Protected media folders. |
| `text` | `{ [original]: replacement }` | Replacement text, one string at a time. |
| `events` | `{ url, only? }` | Signed outbound events. |
| `agents` | `{ actions?: boolean }` | Also offer resync and tag edits to agents and the command line. |
| `market` | `{ country?, language? }` | Local prices: a fixed two-letter `country`, or `"visitor"` for each visitor's own. |
| `checkout` | `{ signIn?: false }` | `signIn: false` stops passing a member's store sign-in to checkout. |
| `schema` | `false` | Turn off the paywalled-content JSON-LD. |
| `memberPaths` | `string[]` | Extra `/_emdash` path prefixes signed-in members may use. Everything else there is refused to them. |
| `entries` | `{ ["collection:id"]: EntryRule }` | Entries' own rules. Usually set in the editor's Access panel. |
| `allowInsecureShop` | `boolean` | Local tests only: lets `shop` be an `http://` fake store. Never set it on a live site. |

`redeemidGuard(options)` takes `{ rateLimit?: boolean }`.

### Secrets

| Variable | Needed for | What it is |
| --- | --- | --- |
| `REDEEMID_SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID` | Sign-in | Client ID of the Headless storefront's Customer Account API client |
| `REDEEMID_SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_SECRET` | Sign-in, confidential clients | Its client secret. Leave unset for a public client. |
| `REDEEMID_SHOPIFY_ADMIN_APP_CLIENT_SECRET` | Webhooks | Client secret of the app that sends the webhooks. Shopify signs each webhook with it. |
| `REDEEMID_SHOPIFY_ADMIN_APP_CLIENT_ID` | Webhook registration, staff tools, preferences, membership dates, Shopify erasure requests | Client ID of that same app. Optional, but most of the admin needs it. |
| `REDEEMID_SHOPIFY_STOREFRONT_PRIVATE_TOKEN` | Plans, shop, checkout | Storefront API private access token, used server-side. Optional if the site sells nothing. |
| `REDEEMID_SHOPIFY_STOREFRONT_PUBLIC_TOKEN` | Plans, shop, checkout | Public access token, only used without the private one |
| `REDEEMID_SHOPIFY_STORE_DOMAIN` | Discovery | The store's domain, only when `shop` isn't in the config |
| `REDEEMID_EVENTS_SECRET` | Events | Signs outbound events. Set it with `events.url`. |

The Status page shows each one as Set or Missing, and lists any `REDEEMID_` variable that is set but not read, by name only, so a misspelt name stands out. Authorization, token and logout endpoints need no setting: RedeemID reads them from the store's discovery documents.

### Components

Import each from `@redeemid/emdash/components/<Name>.astro`.

| Component | Props | Use |
| --- | --- | --- |
| `Content` | `value`, `collection`, `terms`, `id`, `title`; slot `locked` | An entry body with breaks, Members only parts, teaser, meter and wall |
| `Gate` | `collection`, `terms`, `id`, `levels`; slot `locked` | Locks any part of a template |
| `LockedPanel` | `reason`, `required`, … | The wall on its own |
| `AccessBadge` | `collection`, `terms`, `content`, `id`, `free`, `class` | What an entry needs, with a lock for readers kept out |
| `Account` | | Sign in, or the member's name, levels, Account and Sign out |
| `MemberCard` | `title` | Levels, renewal, end and gift dates, past levels, meter, features, Refresh membership |
| `Preferences` | `title`, `heading`, `label`; slot `signed-out` | The member's preference form |
| `YourData` | `title`, `heading` | Download or delete my data |
| `Feature` | `slug`; slot `else` | Shows its content to members holding the feature |
| `Notices` | `messages` | The message for `?redeemid_notice=` |
| `Plan` | `handle`, `label`, `title`, `levels`, `heldLabel`, `renewLabel` | A product with a buy button |
| `Product` | `handle`, `heading`, `compact`, `html`, `schema`, `addLabel`, `buyLabel` | A product page |
| `Collection` | `handle`, `limit`, `productHref`, `showTitle`, `browse`, `quickAdd` | A grid of products, with filters and pages |
| `ProductSearch` | `productHref`, `limit`, `boxOnly`, `action`, `label`, `quickAdd` | Product search |
| `Recommendations` | `handle`, `intent`, `limit`, `productHref`, `title`, `quickAdd` | Shopify's recommendations |
| `ProductGrid` | `products`, `productHref`, `heading`, `quickAdd` | Product cards, for your own lists |
| `BrowseControls` | `filters`, `pageInfo`, `id`, `search`, `query` | Sort, filter and page controls, for your own lists from `collectionPage()` or `searchProducts()` |
| `Cart` | `label`, `href`, `drawer` | The cart count, linking to checkout or opening the drawer |
| `CartView` | `productHref`, `empty` | A cart page |
| `CartDrawer` | `title` | The cart in a slide-in dialog |
| `RedeemIDClient` | | The browser client, `window.redeemid` |
| `Contribution` | `handle`, `amounts`, `initial`, `label`, `title` | Pay what you want |

### Editor blocks

`redeemidPlugin()` adds these Portable Text blocks to the EmDash editor. `<Content>` renders them.

| Block | Type | Does |
| --- | --- | --- |
| Paywall break | `redeemid-paywall` | Members-only content starts here, for the levels picked or the entry's rule |
| Members only / Members only: end | `redeemid-members`, `redeemid-members-end` | A members-only part in the middle of a body |
| Sold on its own | `redeemid-item` | Sells the entry by itself to holders of a tag |
| Plan | `redeemid-plan` | A product with a buy button |
| Product | `redeemid-product` | A product with variants and Add to cart |
| Collection | `redeemid-collection` | A grid of products, optionally with filters, pages and Add to cart |
| Product search | `redeemid-search` | A search box with Shopify's results |
| Contribution | `redeemid-contribution` | Pay what you want |
| Preferences | `redeemid-preferences` | The member's preference form |

### Modules

| Import | Gives |
| --- | --- |
| `@redeemid/emdash` | `redeemid()`, `redeemidPlugin()`, `redeemidGuard()`, config types |
| `@redeemid/emdash/access` | `siteConfig()`, `canRead()`, `readEntry()`, `entryRequirement()`, `viewer()`, and links: `signInUrl()`, `signOutUrl()`, `accountUrl()`, `cartUrl()`, `refreshUrl()` |
| `@redeemid/emdash/features` | `hasFeature()`, `viewerFeatures()` |
| `@redeemid/emdash/preferences` | `readPreferences()`, `savePreferences()` |
| `@redeemid/emdash/storefront` | `product()`, `collection()`, `plan()`, `money()` and the cart calls |
| `@redeemid/emdash/catalog` | `searchProducts()`, `collectionPage()`, `suggest()`, `recommendations()` |
| `@redeemid/emdash/events` | `signBody(body, secret)`, the signature a receiver checks against `X-RedeemID-Signature` |
| `@redeemid/emdash/text` | `STRINGS`, the list of every replaceable string |
| `@redeemid/emdash/contract` | The stable API as a list, and `API_VERSION` |

The full developer API (stable exports, JSON routes, the browser client and its events, MCP tools) is in [docs/developer-api.md](docs/developer-api.md).

### Routes

Under `/_emdash/api/auth/redeemid/`: `login`, `callback`, `logout`, `webhook`, `buy`, `cart`, `cart-edit`, `account`, `preferences` and `privacy`, and the JSON routes `api/state`, `api/cart` and `api/search`. Staff-only routes for the admin, agents and the command line are under `/_emdash/api/plugins/redeemid/`.

In the Customer Account API client, set the callback URI to `https://<site>/_emdash/api/auth/redeemid/callback`, the logout URI to `https://<site>/`, and (public clients) the JavaScript origin to `https://<site>`. Point webhooks at `https://<site>/_emdash/api/auth/redeemid/webhook`: `customers/create`, `customers/update`, `customers/delete`, `customers/disable`, `customers/enable`, `customers/merge`, `customer.tags_added` and `customer.tags_removed` (the Setup page registers these for you). The compliance topics `customers/data_request`, `customers/redact` and `shop/redact` go to the same URL, set in the app's own configuration.

### Notices

Routes send readers back with `?redeemid_notice=<code>`, and `<Notices />` shows the message.

| From | Codes |
| --- | --- |
| Sign in | `not_configured`, `sign_in_unavailable`, `sign_in_expired`, `staff_account`, `account_disabled`, `site_not_ready`, `email_required`, `token_failed`, `bad_id_token`, `identity_failed` |
| Buy and cart | `plan_unavailable`, `checkout_failed`, `cart_empty`, `cart_added`, `cart_updated`, `discount_applied`, `discount_not_applicable` |
| Account | `account_unavailable`, `refreshed` |
| Preferences | `preferences_saved`, `preferences_refused`, `preferences_unavailable` |
| Privacy | `data_erased`, `erase_unconfirmed` |
| Rate limits | `too_many_requests` |

Reword one with `messages={{ cart_empty: "…" }}`, or for every page with `text`.

## Guarantees

- Shopify is the only source of entitlements. Nothing on the site grants access.
- Levels read the mirrored tags as they are, however old. They change only when Shopify sends new ones.
- Enabled or disabled status comes only from the `customers/enable` and `customers/disable` webhooks.
- Locked content never reaches the content API, search, feeds or the sitemap for readers kept out, nor a page that renders bodies with `<Content>` (the Status page flags templates that use `<PortableText>` for a gated collection). The end-to-end test checks each of these. Members are refused EmDash's own APIs except what they need.
- Staff accounts (any EmDash role above Subscriber) can't sign in through the store, even with a matching email. When that happens, the store session ends too, so the next sign-in attempt starts fresh.
- Customers can't create the first (admin) account on a new site.
- Webhooks are checked against the app's signature before anything changes.
- Access fails closed: when the saved access settings can't be read, a server keeps the ones it last read, and with none it locks every entry.

## Troubleshooting

- **A setting shows Missing on the Status page.** Check the name: the Status page lists any `REDEEMID_` variable it doesn't read. Set it as a runtime secret, not a build variable. On Workers, a deploy can remove plain-text dashboard variables, so use encrypted secrets.
- **Sign-in comes back with a notice.** The code says why; see [notices](#notices). `sign_in_unavailable` means store discovery failed, usually a wrong `shop`. `not_configured` means the client ID or `shop` is missing.
- **Register webhooks names a refused topic.** The app lacks a scope, such as `read_customer_merge` for `customers/merge`. Add it to the app, have the store accept the new version, and press Register again.
- **Tags changed in Shopify but the site didn't follow.** Check Webhooks → Received and Health, and App events with Problems only. Resync the member from their page, or ask them to press Refresh membership.
- **A member sees the visitor's page.** A cache is serving it. See [caching](#caching).

## Develop

```sh
pnpm install
pnpm test        # unit tests
pnpm typecheck
pnpm e2e         # boots the playground site against a fake Shopify store
```

`playground/` is the EmDash starter template with RedeemID wired in and locked posts in its seed. The package ships TypeScript source; there is no build step.

**Releases.** Bump `version` in package.json and merge to main. The Release workflow runs the tests, stages that version on npm with a stage-only token and cuts a matching GitHub release, `v<version>`, with the exact tarball and a `.sha256`. A maintainer approves the npm stage (2FA) before it's public.

## License

MIT, the same as EmDash.
