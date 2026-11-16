# Permissions and trust

What RedeemID can reach on your site, what it calls, and what it keeps. Read this before you install it, and again when the [changelog](../CHANGELOG.md) marks an **Upgrade**.

## Why it runs as a native plugin

EmDash has two kinds of plugins. Sandboxed plugins run in an isolated runtime and can only use the APIs they declare. Native plugins run inside your site, with the same access as your own code. RedeemID is native because it needs things the sandbox doesn't offer:

- **Sign-in.** An EmDash auth provider, so store customers sign in with their Shopify customer account.
- **Editor blocks.** Portable Text blocks (Paywall break, Members only, Plan, Product and others) with Astro components that render them.
- **Astro components and middleware.** `<Content>`, `<Gate>`, the cart and product components, and `redeemidGuard()`, which keeps locked text out of pages and EmDash's own APIs.
- **Admin screens.** A React admin entry that draws its own blocks (the Access map, dialogs and copy fields) next to Block Kit.

So treat RedeemID the way you'd treat code you wrote yourself. Its declared capabilities gate the EmDash APIs it calls, but they aren't a security boundary. Like any native plugin, it could read your environment or call the network directly. The rest of this page says what it actually does.

## Capabilities it declares

| Capability | What uses it |
| --- | --- |
| `content:read` | The editor's Access panel reads the entry it's on, so each entry's rule follows its slug. |
| `content:write` | Product entries: `content:beforeSave` puts back Shopify's fields when an editor changes them, and product sync creates and updates entries in your products content type. |
| `email:send` | The daily webhook check emails staff when deliveries stop or fail, if the site has an email provider. |

Plugin routes are for staff (EmDash's `plugins:manage`, Admin by default). The sign-in, webhook, cart and checkout routes belong to the auth provider, under `/_emdash/api/auth/redeemid/`.

## Hosts it calls

The server only calls Shopify, plus the one address you give for outbound events:

| Host | When | Why |
| --- | --- | --- |
| Your store's domain (`shop`, or `REDEEMID_SHOPIFY_STORE_DOMAIN`) | Sign-in, product and cart pages, staff tools | `/.well-known/` discovery for sign-in, the Storefront API for products, carts and checkout, and the Admin API for staff tools, resyncs, tag edits, privacy requests and webhook registration. The Admin API only answers on the `myshopify.com` domain. |
| The customer account hosts Shopify's discovery names (usually `shopify.com` or `account.` on your domain) | Sign-in, Account, signed-in checkout, preferences | The sign-in, token and sign-out endpoints and the Customer Account API. |
| The `events.url` you set | Only when `events` is configured | Signed member events, such as `member.signed_in`. They never carry an email address. |

In the browser, RedeemID's scripts only call your own site. Product images load from Shopify's CDN, and checkout opens on Shopify.

## What it keeps

| Data | Where | How long |
| --- | --- | --- |
| A mirror of each customer who signed in or arrived by webhook: Shopify customer ID, email, first and last name, tags, enabled or disabled, when each tag was first seen, and their EmDash user ID | EmDash's auth-provider storage (`auth:redeemid`) | Until Shopify deletes or redacts the customer, staff delete them, or the member deletes their data from `<YourData>` |
| An EmDash user for each customer who signs in, with the Subscriber role | EmDash's users table | Like any EmDash user |
| The member's Customer Account API tokens, for signed-in checkout | The server-side session, encrypted with AES-GCM under a key in your database (`redeemid:session_key`) | The session |
| The cart ID and a discount code from a link | The server-side session | The session |
| App events: ids, labels, outcomes and timings, never bodies, tokens or emails | Plugin storage | 30 days |
| Webhook deliveries (topic, id, outcome) and outbound events that failed | Plugin storage | 30 days |
| Finished privacy requests | Plugin storage | A year |
| Access settings saved in the admin (levels, rules, features, files, meter) | Plugin storage | Until changed |
| Synced product entries | Your products content type | Until staff stop syncing them |

Secrets come from the environment (`REDEEMID_` variables) and are never shown, logged or returned. Connection → Environment shows only whether each one is set.

## What it changes in Shopify

Nothing, unless staff ask for it. Staff tools can add or remove a customer's tags, and with `agents.actions` on, AI agents can too. Privacy requests can ask Shopify to erase a customer. Members can save their own preferences to customer metafields you define. Registering webhooks creates subscriptions to RedeemID's own webhook address. RedeemID never creates orders, discounts or products, and never grants access on the site: access only ever follows the customer's tags in Shopify.

## Taking it out

Remove `redeemid()`, `redeemidPlugin()` and `redeemidGuard()` from `astro.config.mjs`, swap `<Content>` back to `<PortableText>`, and deploy. Removing the guard opens every locked entry to everyone, so unpublish members' content first if it shouldn't become public. The customer mirror and plugin storage stay in the database until you delete them. Webhook subscriptions stay in Shopify until you delete them there (Settings → Notifications → Webhooks, or the Admin API app).

## Upgrading

Read the [changelog](../CHANGELOG.md) before each update. Lines marked **Upgrade** need something from you, such as a newer EmDash or a changed address. A release that adds a capability, a host or a kind of stored data says so there, because native installs don't ask for consent again.
