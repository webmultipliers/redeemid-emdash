# RedeemID for EmDash

Shopify customer accounts, member levels and paywalls for [EmDash](https://github.com/emdash-cms/emdash) sites. Shopify runs the store and the customer account; EmDash runs the content.

**Status: 0.0.6, early.** Runs on Node and Cloudflare Workers. Sign-in, the member mirror, webhooks, levels, rules, the meter and drip, teasers, badges, the page gate, the Shopify cart and checkout are covered by an end-to-end test against a fake store.

## What it does

- **Sign in with the store's customer account.** Members click "Sign in" on your site, sign in on the store's account page and come back signed in. They become EmDash Subscribers. That role only means "signed in"; it never grants content.
- **Mirrors the customer.** Email, name, tags and enabled/disabled status, kept current by signed Shopify webhooks.
- **Levels from tags.** You map Shopify customer tags to levels. Set tags in Shopify Flow or any app; RedeemID only reads them.
- **Rules.** Lock a collection, entries with a term (and its child terms), or set a site default; a term can also open its entries to everyone. When several term rules cover an entry, readers must pass all of them.
- **Meter and drip.** Signed-in readers may open a few locked entries free each month or week. A rule can also drip: members read its entries once they've held their level for so many days.
- **Teasers and badges.** Locked entries can show their first paragraphs, up to a word count. `<AccessBadge>` names the level an entry needs and shows a lock to readers it keeps out.
- **Plans, cart and checkout.** `<Plan>` shows a Shopify product's price and adds it to the visitor's Shopify cart; `<Cart>` shows the count and opens Shopify checkout.
- **Account.** Members get an Account link to their Shopify customer account (orders, profile, addresses) and Sign out, which also ends the Shopify session.
- **Paywall break block.** Editors write one body and drop a "Paywall break" block where members-only content starts, picking which levels may read on, or leaving it to the entry's rule. `<Content>` renders the body and leaves the rest off the page for everyone else.
- **Members only block.** For a members part in the middle of a body: "Members only" (pick the levels) and "Members only: end". Everyone else sees the wall in its place and reads on after it.
- **The wall.** Readers kept out see why and what to do next: sign in, or join, with each level's own wall text. `<Notices>` shows the messages sign-in, Buy, Cart and Account send readers back with.
- **Plan block.** Editors add a Shopify product to any page with the "Plan" block: title, price and a buy button.
- **In the admin.** RedeemID shows under Plugins with a Members page (Shopify customers, tags, levels), a Status page (secrets, store discovery, the URLs to give Shopify, levels and rules) and a dashboard widget.
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

Sell a plan. `<Plan>` shows a Shopify product's title and price with a button that adds it to the visitor's Shopify cart and opens checkout (signed-in members check out with their email). Shopify Flow or an app tags the customer after the order, and access follows that tag:

```astro
---
import Plan from "@redeemid/emdash/components/Plan.astro";
---
<Plan handle="gold-membership" label="Join Gold">
	<p>Shown if the product can't be loaded.</p>
</Plan>
```

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
