# RedeemID for EmDash

Shopify customer accounts, member levels and paywalls for [EmDash](https://github.com/emdash-cms/emdash) sites. Shopify runs the store and the customer account; EmDash runs the content.

**Status: 0.0.2, early.** Runs on Node and Cloudflare Workers. Sign-in, the member mirror, webhooks, levels, rules, the page gate and plan checkout are covered by an end-to-end test against a fake store.

## What it does

- **Sign in with the store's customer account.** Members click "Sign in" on your site, sign in on the store's account page and come back signed in. They become EmDash Subscribers. That role only means "signed in"; it never grants content.
- **Mirrors the customer.** Email, name, tags and enabled/disabled status, kept current by signed Shopify webhooks.
- **Levels from tags.** You map Shopify customer tags to levels. Set tags in Shopify Flow or any app; RedeemID only reads them.
- **Rules per collection or term.** Lock a collection, or only entries in a category or tag.
- **Plans and checkout.** `<Plan>` shows a Shopify product's price and starts checkout through the Storefront API.
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
						// match: "all" needs every tag, e.g. both memberships:
						{ slug: "both", name: "Member + Pro", tags: ["member", "pro"], match: "all" },
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

Sell a plan. `<Plan>` shows a Shopify product's title and price with a button that starts checkout (signed-in members check out with their email). Shopify Flow or an app tags the customer after the order, and access follows that tag:

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
