# RedeemID for EmDash

Shopify customer accounts, member levels and paywalls for [EmDash](https://github.com/emdash-cms/emdash) sites. Shopify runs the store and the customer account; EmDash runs the content.

**Status: 0.0.1, foundation.** Sign-in, the member mirror, webhooks, levels, rules and the page gate work end to end against a fake store. Nothing has run against a live Shopify store or on Cloudflare Workers yet. See [docs/feasibility.md](docs/feasibility.md) for what was tested and what is still open.

## What it does

- **Sign in with the store's customer account.** Members click "Sign in" on your site, sign in on the store's account page and come back signed in. They become EmDash Subscribers. That role only means "signed in"; it never grants content.
- **Mirrors the customer.** Email, name, tags and enabled/disabled status, kept current by signed Shopify webhooks.
- **Levels from tags.** You map Shopify customer tags to levels. Set tags in Shopify Flow or any app; RedeemID only reads them.
- **Rules per collection or term.** Lock a collection, or only entries in a category or tag.
- **A page gate.** `<Gate>` shows the entry to readers who may read it and a teaser plus "Sign in" to everyone else.
- **Keeps members out of EmDash's own APIs**, so the gate is the only way to read locked content.

## Install

The package is a native EmDash plugin (an npm dependency, not a registry plugin), because sign-in and page gating run in the site process.

```sh
pnpm add @redeemid/emdash
```

```js title="astro.config.mjs"
import { redeemid, redeemidGuard } from "@redeemid/emdash";
import emdash from "emdash/astro";

export default defineConfig({
	integrations: [
		emdash({
			// database, storage, …
			authProviders: [
				redeemid({
					shop: "my-store.myshopify.com",
					levels: [
						{ slug: "member", name: "Member", tags: ["member"] },
						{ slug: "pro", name: "Pro", tags: ["pro"] },
					],
					rules: [
						{ collection: "posts", taxonomy: "category", term: "members", levels: ["member", "pro"] },
						{ collection: "posts", taxonomy: "category", term: "pro", levels: ["pro"] },
					],
				}),
			],
		}),
		redeemidGuard(),
	],
});
```

Set these secrets in the environment (`.env` locally, `wrangler secret put` on Workers):

| Variable | What it is |
| --- | --- |
| `REDEEMID_CLIENT_ID` | Client ID of the store's Headless customer account client |
| `REDEEMID_CLIENT_SECRET` | Its client secret (confidential client) |
| `REDEEMID_WEBHOOK_SECRET` | The client secret of the Shopify app that sends webhooks |

In Shopify, give the customer account client this callback and logout URL:

- Callback: `https://your-site.example/_emdash/api/auth/redeemid/callback`
- Logout: `https://your-site.example/`

Point webhooks (`customers/create`, `customers/update`, `customers/delete`, `customers/disable`, `customers/enable`, `customers/merge`, `customer.tags_added`, `customer.tags_removed`, `customers/redact`) at `https://your-site.example/_emdash/api/auth/redeemid/webhook`.

## Use it in templates

EmDash has no content filter hook, so templates decide what to render. Wrap the entry body:

```astro
---
import Gate from "@redeemid/emdash/components/Gate.astro";
---
<Gate collection="posts" terms={post.data.terms}>
	<PortableText value={post.data.content} />
	<p slot="locked">{post.data.excerpt}</p>
</Gate>
```

Add the account box to your header:

```astro
---
import Account from "@redeemid/emdash/components/Account.astro";
---
<Account />
```

Or ask directly:

```ts
import { canRead } from "@redeemid/emdash/access";

const verdict = await canRead(Astro, { collection: "posts", terms: post.data.terms });
// verdict.allowed, verdict.reason: open | allowed | sign_in | upgrade | disabled
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

`playground/` is the EmDash starter template with RedeemID wired in and two locked posts in its seed.

## License

GPL-2.0-or-later, the same as RedeemID for WordPress.
