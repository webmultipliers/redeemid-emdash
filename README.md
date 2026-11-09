# RedeemID for EmDash

Shopify customer accounts, member levels and paywalls for [EmDash](https://github.com/emdash-cms/emdash) sites. Shopify runs the store and the customer account; EmDash runs the content.

**Status: 0.0.10, early.** Runs on Node and Cloudflare Workers. Sign-in, the member mirror, webhooks, levels, rules, the meter and drip, teasers, badges, the page gate, the Shopify cart and checkout, the staff tools, preferences and outbound events are covered by an end-to-end test against a fake store.

## What it does

- **Sign in with the store's customer account.** Members click "Sign in" on your site, sign in on the store's account page and come back signed in. They become EmDash Subscribers. That role only means "signed in"; it never grants content.
- **Mirrors the customer.** Email, name, tags and enabled/disabled status, kept current by signed Shopify webhooks.
- **Levels from tags.** You map Shopify customer tags to levels. Set tags in Shopify Flow or any app; RedeemID only reads them.
- **Rules.** Lock a collection, entries with a term (and its child terms), or set a site default; a term can also open its entries to everyone. When several term rules cover an entry, readers must pass all of them.
- **Meter and drip.** Signed-in readers may open a few locked entries free each month or week. A rule can also drip: members read its entries once they've held their level for so many days.
- **Teasers and badges.** Locked entries can show their first paragraphs, up to a word count. `<AccessBadge>` names the level an entry needs and shows a lock to readers it keeps out.
- **Plans, cart and checkout.** `<Plan>` shows a Shopify product's price and adds it to the visitor's Shopify cart; `<Cart>` shows the count and opens Shopify checkout.
- **Member account card.** `<MemberCard>` shows members their levels with when each started, the levels they held before, the meter, and Refresh membership, which reads their tags from the store again.
- **Account.** Members get an Account link to their Shopify customer account (orders, profile, addresses) and Sign out, which also ends the Shopify session.
- **Paywall break block.** Editors write one body and drop a "Paywall break" block where members-only content starts, picking which levels may read on, or leaving it to the entry's rule. `<Content>` renders the body and leaves the rest off the page for everyone else.
- **Members only block.** For a members part in the middle of a body: "Members only" (pick the levels) and "Members only: end". Everyone else sees the wall in its place and reads on after it.
- **The wall.** Readers kept out see why and what to do next: sign in, or join, with each level's own wall text. `<Notices>` shows the messages sign-in, Buy, Cart and Account send readers back with.
- **Plan block.** Editors add a Shopify product to any page with the "Plan" block: title, price and a buy button.
- **Shop.** `<Product>`, `<Collection>` and `<CartView>` (with the Product and Collection blocks) give the site product pages, collection grids and a cart page with quantities and discount codes. `<Contribution>` (and its block) takes pay-what-you-want amounts. Carts note the page each sale started on.
- **Features.** Name perks members hold through levels or tags (ad-free, a supporter thank-you) and show them with `<Feature>` or `hasFeature()`.
- **In the admin.** RedeemID shows under Plugins with a Members page (Shopify customers, tags, levels; open a member to resync them or add and remove tags, which are written to Shopify), a bulk resync you start yourself, a Status page (secrets, store discovery, webhook subscriptions with a Register button, recent deliveries, levels and rules), an Access test and a dashboard widget.
- **Member preferences.** Members see and change customer fields you define in Shopify, such as topics or a newsletter choice, with `<Preferences>` or its block. Answers are saved on the Shopify customer, ready for Flow, segments and email; the site keeps no copy.
- **Outbound events.** Signed JSON POSTs to a URL of yours when a member signs in, their levels change, or they use the meter, for a CRM, an email tool or your own code.
- **Keeps members out of EmDash's own APIs**, so the gate is the only way to read locked content.

## Install

The package is a native EmDash plugin (an npm dependency, not a registry plugin), because sign-in and page gating run in the site process.

```sh
pnpm add @redeemid/emdash
```

```js title="astro.config.mjs"
import { redeemid, redeemidGuard, redeemidPlugin } from "@redeemid/emdash";
import emdash from "emdash/astro";

const config = {
	shop: "my-store.myshopify.com",
	levels: [
		{ slug: "member", name: "Member", tags: ["member"] },
		// wall: what the wall says to readers this level would let in; joinUrl overrides join.href.
		{ slug: "pro", name: "Pro", tags: ["pro"], wall: "Pro members read every report." },
		// match: "all" needs every tag, e.g. both memberships:
		{ slug: "both", name: "Member + Pro", tags: ["member", "pro"], match: "all" },
	],
	rules: [
		{ collection: "posts", taxonomy: "category", term: "members", levels: ["member", "pro"] },
		{ collection: "posts", taxonomy: "category", term: "pro", levels: ["pro"] },
	],
	// Optional: where the wall's join link goes.
	join: { href: "/join/", label: "Become a member" },
	// Optional: locked posts with no paywall break show the paragraphs within their first 40 words.
	teaser: { posts: 40 },
	// Optional: signed-in readers may open 3 locked posts a month.
	meter: { limit: 3, period: "month", collections: ["posts"] },
};

export default defineConfig({
	integrations: [
		emdash({
			// database, storage, …
			authProviders: [redeemid(config)], // sign-in, webhooks, cart and checkout routes
			plugins: [redeemidPlugin(config)], // admin pages and the editor blocks
		}),
		redeemidGuard(),
	],
});
```

Set these secrets in the environment (`.env` locally, `wrangler secret put` on Workers). [docs/shopify-setup.md](docs/shopify-setup.md) walks through the Shopify side:

| Variable | Shopify API | What it is |
| --- | --- | --- |
| `REDEEMID_SHOPIFY_STORE_DOMAIN` | Customer Account API discovery | The store's `*.myshopify.com` domain. Only needed when `shop` isn't set in the config. |
| `REDEEMID_SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID` | Customer Account API | Client ID of the Headless storefront's Customer Account API client |
| `REDEEMID_SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_SECRET` | Customer Account API | Its client secret. Confidential clients only; leave unset for a public client. |
| `REDEEMID_SHOPIFY_ADMIN_APP_CLIENT_SECRET` | Webhooks (Admin API app) | Client secret of the Shopify app that sends the webhooks. Shopify signs each webhook with it. |
| `REDEEMID_SHOPIFY_ADMIN_APP_CLIENT_ID` | Admin API (staff tools) | Client ID of that same app. Optional; with it, staff can resync members, edit tags in Shopify and register webhooks. |
| `REDEEMID_EVENTS_SECRET` | None | Optional. Signs outbound events; set it with `events.url`. |
| `REDEEMID_SHOPIFY_STOREFRONT_PRIVATE_TOKEN` | Storefront API | Private access token, for the plan cards and checkout (server-side). |
| `REDEEMID_SHOPIFY_STOREFRONT_PUBLIC_TOKEN` | Storefront API | Public access token. Only used when the private token isn't set. |

RedeemID finds the authorization, token and logout endpoints itself from the store's discovery documents, so they need no setting.

In Shopify, give the Customer Account API client these settings:

- Callback URI: `https://your-site.example/_emdash/api/auth/redeemid/callback`
- JavaScript origin (public clients): `https://your-site.example`
- Logout URI: `https://your-site.example/`

Point webhooks (`customers/create`, `customers/update`, `customers/delete`, `customers/disable`, `customers/enable`, `customers/merge`, `customer.tags_added`, `customer.tags_removed`, `customers/redact`) at `https://your-site.example/_emdash/api/auth/redeemid/webhook`.

### Rules

Each rule names a collection and the levels, any of which may read. An empty `levels` list, or the built-in `signed-in` level, means any signed-in member.

| Rule | Covers |
| --- | --- |
| `{ collection: "reports", levels: ["gold"] }` | Every entry in the collection |
| `{ collection: "posts", taxonomy: "category", term: "investigations", levels: ["gold"] }` | Entries with that term, or with a child of it in a hierarchical taxonomy. A child's own rule wins over its parent's. |
| `{ collection: "posts", taxonomy: "tag", term: "free-to-read", levels: [], open: true }` | Opens entries with that term to everyone, whatever else covers them |
| `{ collection: "*", levels: [] }` | The site default, for collections with no rule of their own |

| `{ collection: "posts", taxonomy: "category", term: "archive", levels: ["member"], drip: 30 }` | Drip: members read these entries 30 days after their level started |
| `{ collection: "posts", taxonomy: "category", term: "exclusive", levels: ["pro"], meter: false }` | The meter never opens these entries |

Term rules beat the collection's rule, which beats the site default. When several term rules cover one entry (a story in Investigations, Gold, and Culture, Silver), readers must pass every one of them, so only Gold + Silver members read it. Set `combine: "any"` to let one of them be enough.

### Meter and drip

The meter lets a signed-in reader who can't read an entry open it anyway, `limit` entries per `period` (`"month"`, the default, or `"week"`, in UTC). Each entry counts once per period, when its own page renders through `<Content>` with an `id`; lists, feeds, search and the content API never count. Visitors get the wall and a nudge to sign in. While it runs, `<Content>` says how many free reads are left; when it runs out, the wall says so. Rules with `meter: false` are never metered, and the meter never opens an entry a member is waiting on by drip.

Drip holds a rule's entries back from members who pass it until they've held their level for `drip` days. A level starts when the customer first had its tag (for a `match: "all"` level, the last of its tags); with several levels the earliest counts, and with none known, the first sign-in. RedeemID notes when each tag first arrives from sign-in and webhooks, and forgets a tag when Shopify removes it. The wall shows the date the entry opens.

### Features

```ts
features: [
	{ slug: "ad-free", name: "Ad-free", levels: ["gold", "premium"] },
	{ slug: "supporter", name: "Supporter", tags: ["supporter"] },
],
```

A member holds a feature through any of its levels or tags; like levels, features come only from the mirrored tags. `<MemberCard>` lists them under the member's levels.

```astro
---
import Feature from "@redeemid/emdash/components/Feature.astro";
import { hasFeature } from "@redeemid/emdash/features";
---
<Feature slug="supporter"><p>Thanks for your support.</p><p slot="else">Become a supporter.</p></Feature>
{!(await hasFeature(Astro, "ad-free")) && <aside class="ad">…</aside>}
```

### Preferences

```ts
preferences: [
	{ key: "preferences.topics" },                  // members can change it
	{ key: "preferences.level", access: "view" },   // members only see it
],
```

Define each field in Shopify (**Settings → Custom data → Customers**). The definition sets its name, type and limits, such as allowed choices or a minimum and maximum. List the ones members get in `preferences`, in the order to show them. Reading and saving use the Admin API app (`REDEEMID_SHOPIFY_ADMIN_APP_CLIENT_ID`, with `read_customers` and `write_customers`), always on the signed-in member's own customer. Fields in the `membership` namespace are never offered. Preferences never open content.

`<Preferences>` (or the Preferences block) is a form with a control for each field. It works without JavaScript and comes back with the `preferences_saved`, `preferences_refused` or `preferences_unavailable` notice. Visitors see its `signed-out` slot.

| Shopify type | Value |
| --- | --- |
| Single line text | A string; with choices, one of them |
| Multi-line text | A string |
| List of single line text | A list of strings; with choices, each one of them |
| True or false | `true` or `false` |
| Integer | A whole number |
| Decimal | A number, as a string |
| Date | `YYYY-MM-DD` |

Every value is checked against the definition before it goes to Shopify; one refusal saves nothing, and an empty value clears the field. Scripts can use `/_emdash/api/auth/redeemid/preferences` too: `GET` returns `{ fields }` with values, `POST` with JSON `{ values: { "namespace.key": value } }` saves. A refused save answers `400` with `fields` mapping each key to `unknown_field`, `read_only`, `invalid_type`, `invalid_choice`, `invalid_length` or `invalid_range`. Saves are limited to 10 a minute per member (`429`). From your own code, `readPreferences()` and `savePreferences()` in `@redeemid/emdash/preferences` do the same.

A save sends the `preferences.saved` event with the field names changed, never the answers.

### Events

```ts
events: { url: "https://hooks.example.com/redeemid", only: ["member.signed_in", "member.levels_changed"] },
```

With `REDEEMID_EVENTS_SECRET` set, RedeemID POSTs `{ id, event, at, data }` to the URL. Headers: `X-RedeemID-Event`, `X-RedeemID-Delivery` (the `id`) and `X-RedeemID-Signature: sha256=<hex HMAC-SHA256 of the raw body with the secret>`. Check the signature before you trust a body. Sending waits at most 3 seconds and never breaks the page; a failed send is logged and dropped, not retried.

| Event | `data` |
| --- | --- |
| `member.signed_in` | `customerId`, `levels`, `first` (first sign-in), `refresh` |
| `member.levels_changed` | `customerId`, `levels`, `added`, `removed`, `source` (`sign-in`, the webhook topic, or a staff resync or tag edit) |
| `meter.used` | `userId` (EmDash), `entry` (`collection:id`), `used`, `limit`, `period` (`2026-11`, or `2026-W45` by week) |
| `meter.exhausted` | the same, sent with the last free read |
| `preferences.saved` | `customerId`, `fields` (the `namespace.key` names changed) |

No event carries an email address or a name: match people by the Shopify `customerId`. `only` limits which events are sent; leave it out for all of them.

### Staff tools

With `REDEEMID_SHOPIFY_ADMIN_APP_CLIENT_ID` set (it also runs member preferences), RedeemID gets an Admin API token for the webhook app with the client credentials grant (the app must belong to the same Shopify organization as the store, as Dev Dashboard apps do) and needs the `read_customers` and `write_customers` scopes. Then, in the admin:

- **Member detail.** Open a member from the Members page to see their levels, tags and features, resync them from Shopify, or add and remove tags. Tag edits are made in Shopify, then read back; nothing is granted on the EmDash side.
- **Bulk resync.** Reads the 50 members synced longest ago from Shopify in one request. Run it again for the next 50. It never runs on its own.
- **Webhooks.** The Status page lists the store's subscriptions to this site and registers any that are missing (`customers/redact` stays in the app's own settings).
- **Recent deliveries.** The last webhooks the site took, with their topics and times.
- **Access test.** Enter a collection, terms and a reader's tags to see what the entry needs and whether that reader gets in.

Resync updates email, name and tags. Status stays with the enable and disable webhooks.

## Use it in templates

EmDash has no content filter hook, so templates decide what to render. Render the entry body with `<Content>` instead of `<PortableText>`:

```astro
---
import Content from "@redeemid/emdash/components/Content.astro";
---
<Content value={post.data.content} collection="posts" terms={post.data.terms} id={post.id}>
	<a slot="locked" href="/join/">Become a member</a>
</Content>
```

Everything before the first Paywall break block is shown to everyone. What follows reaches the page only for readers the break allows: the levels picked on it ("Signed in" for any member), or when none are picked the entry's rule. With none picked and no rule covering the entry, the break changes nothing. A body with no break follows the entry's rule as a whole; readers it keeps out see the collection's `teaser` (the paragraphs within that many words, never half a paragraph), if one is set. Plain `<PortableText>` ignores the break and shows everything, so use `<Content>` for any body that may hold one.

A "Members only" block starts a part for the levels picked on it (none picked: the entry's rule, or any signed-in member) that runs to the next "Members only: end" block. Readers who can't read it see the wall there, and the body goes on after the end block.

The wall is `<LockedPanel>`: it says why the reader is kept out and offers sign-in or the join link, with the wall text of the first level they are missing. `<Content>` and `<Gate>` show it; its default slot (and `<Content>`'s "locked" slot) goes on top.

To lock a part of a template that isn't the body, wrap it in `<Gate>` (`<Gate levels={["pro"]}>…</Gate>`).

Show what an entry needs with `<AccessBadge>`, on cards and on the entry. It reads the entry's rules (and a paywall break's levels when you pass `content`), shows "Free" for open entries (`free=""` hides it), and adds `is-locked` and a lock for readers it keeps out. `data-redeemid-level` holds the level slugs, for colours:

```astro
---
import AccessBadge from "@redeemid/emdash/components/AccessBadge.astro";
---
<AccessBadge collection="posts" terms={post.data.terms} content={post.data.content} />
```

In your own code (`@redeemid/emdash/access`), `entryRequirement(config, collection, terms)` gives what an entry needs (a list of clauses, each passed by any of its levels, or `null` when open), `canRead(Astro, entry)` gives the verdict for the visitor, and `readEntry(Astro, { collection, terms, id })` gives it with drip and the meter applied (and counts a metered read).

Put `<Notices />` near the top of your layout. It shows the message for a `?redeemid_notice=` code (see [docs/shopify-setup.md](docs/shopify-setup.md)) and nothing otherwise; pass `messages={{ cart_empty: "…" }}` to reword one.

Add the account box and cart to your header. Visitors see Sign in; members see their name, levels, Account and Sign out. The cart shows how many items are in the visitor's Shopify cart and goes to its checkout:

```astro
---
import Account from "@redeemid/emdash/components/Account.astro";
import Cart from "@redeemid/emdash/components/Cart.astro";
---
<Account />
<Cart />
```

For an account page, `<MemberCard />` shows the member's levels (with when each started), levels they held before, how much of the meter they've used, and links to their store account, Refresh membership and Sign out. Visitors get a sign-in link. Refresh membership (`refreshUrl(returnTo)` in `@redeemid/emdash/access`) sends the member to the store with no sign-in form; a member still signed in there comes straight back with their tags read again and the `refreshed` notice, and anyone else goes through the usual sign-in. Use it after a purchase, when Shopify's tag webhook hasn't arrived yet.

Sell a plan. `<Plan>` shows a Shopify product's title and price with a button that adds it to the visitor's Shopify cart and opens checkout (signed-in members check out with their email). Shopify Flow or an app tags the customer after the order, and access follows that tag. With `levels`, members who already hold one of them see "You're on this plan." (`heldLabel`) in place of the button; the Plan block has the same choice:

```astro
---
import Plan from "@redeemid/emdash/components/Plan.astro";
---
<Plan handle="gold-membership" label="Join Gold" levels={["gold"]}>
	<p>Shown if the product can't be loaded.</p>
</Plan>
```

### Shop

Products, collections and the cart come from the Storefront API; Shopify works out prices, discounts, taxes and stock.

```astro
---
import Product from "@redeemid/emdash/components/Product.astro";
import Collection from "@redeemid/emdash/components/Collection.astro";
import CartView from "@redeemid/emdash/components/CartView.astro";
import Contribution from "@redeemid/emdash/components/Contribution.astro";
---
<!-- /shop/ -->
<Collection handle="shop" productHref="/shop/{handle}/" showTitle />
<!-- /shop/[handle]/ -->
<Product handle={Astro.params.handle} heading="h1"><p>No such product.</p></Product>
<!-- /cart/ -->
<CartView productHref="/shop/{handle}/" />
<!-- anywhere -->
<Contribution handle="support" amounts={[5, 10, 25]} />
```

- `<Product>`: image, title, price, description, the variants (sold-out ones shown but not choosable), a quantity, Add to cart (back to the page with the `cart_added` notice) and Buy now (straight to checkout).
- `<Collection>`: the collection's products (`limit`, up to 50) as cards linking to `productHref`.
- `<CartView>`: each line with its price, a quantity to change (0 removes it) and Remove, a discount code field, the subtotal and total, and Checkout. Pages with it are sent `Cache-Control: private, no-store`.
- `<Contribution>`: pay what you want. Make a Shopify product priced at 1.00; the amount the reader picks becomes the quantity, so Shopify charges exactly that.

The forms post to `/_emdash/api/auth/redeemid/cart-edit`, which reads every product and variant from Shopify again and only changes lines in the visitor's own cart. A new cart carries the `_redeemid_page` attribute (the page the first item was added on), which shows on the order in Shopify admin; Shopify hides attributes starting with `_` at checkout. Editors get the same with the Product, Collection and Contribution blocks.

Or ask directly:

```ts
import { canRead } from "@redeemid/emdash/access";

const verdict = await canRead(Astro, { collection: "posts", terms: post.data.terms });
// verdict.allowed, verdict.reason: open | allowed | sign_in | upgrade | disabled
// readEntry() adds drip (verdict.opensAt) and metered (verdict.meterLeft)
```

Pages rendered for a signed-in member are sent with `Cache-Control: private, no-store`; pages for visitors stay cacheable.

## Rules

- Shopify is the only source of entitlements. Nothing on the EmDash side grants access.
- Levels read the mirrored tags as they are, however old; they change only when Shopify sends new ones.
- Status (enabled or disabled) comes only from the `customers/enable` and `customers/disable` webhooks.
- Staff accounts (any EmDash role above Subscriber) can't sign in through the store, even with a matching email.
- Customers can't create the first (admin) account on a new site.

## Develop

```sh
pnpm install
pnpm test        # unit tests
pnpm typecheck
pnpm e2e         # boots the playground site against a fake Shopify store
```

Releases: bump `version` in package.json and merge to main. The Release workflow runs the tests, then stages that version on npm with a stage-only token. A maintainer approves it on npmjs.com or with `npm stage approve <id>` (2FA), and only then is it public. The same run cuts a matching GitHub release, `v<version>`, with the exact tarball it staged and a `.sha256`.

`playground/` is the EmDash starter template with RedeemID wired in and two locked posts in its seed.

## License

MIT, the same as EmDash.
