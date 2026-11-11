# Developer API

What site code, other plugins and AI agents can rely on in `@redeemid/emdash`. API version **1.3.0** (`API_VERSION` in `@redeemid/emdash/contract`, also in `api/state` and `window.redeemid.apiVersion`).

Everything on this page is stable: it changes only with a changelog entry and an API version bump (minor when something is added, major when something changes or goes). Anything not listed is internal, even when a module exports it. `src/contract.ts` is the same list as code, and a test fails when the code, that list and this page disagree.

Three rules hold everywhere:

- **Shopify decides.** Levels and features come only from the member's Shopify tags; prices, stock, discounts and checkout come only from Shopify. Nothing here grants access or sets a price.
- **Nothing personal leaves the server.** Browser-facing answers and events never carry an email, a name, a customer id or a Shopify tag. Match people by `customerId` only in signed server events.
- **Vendor-agnostic.** RedeemID never sends anything to an analytics tool, CRM or tag manager. You subscribe and forward what you choose.

## Server modules

Import these in Astro pages, components and endpoints.

| Import | Stable exports |
| --- | --- |
| `@redeemid/emdash` | `redeemid`, `redeemidGuard`, `redeemidPlugin` |
| `@redeemid/emdash/access` | `siteConfig`, `viewer`, `canRead`, `readEntry`, `entryRequirement`, `meterUsage`, `membership`, `levelsFor`, `topLevels`, `closure`, `simplify`, `signInUrl`, `signOutUrl`, `accountUrl`, `cartUrl`, `refreshUrl`, `safeReturn` |
| `@redeemid/emdash/features` | `hasFeature`, `viewerFeatures`, `featuresFor` |
| `@redeemid/emdash/preferences` | `readPreferences`, `savePreferences`, `preferenceFields` |
| `@redeemid/emdash/storefront` | `plan`, `product`, `collection`, `money`, `realOptions`, `variantFor`, `storeContext`, `cartDetails`, `addToCart`, `updateLines`, `removeLines`, `setDiscountCodes` |
| `@redeemid/emdash/catalog` | `searchProducts`, `collectionPage`, `suggest`, `recommendations`, `browseFromUrl`, `browseHref`, `parseFilters`, `priceFilter`, `SORTS` |
| `@redeemid/emdash/events` | `signBody` |
| `@redeemid/emdash/text` | `STRINGS`, `text`, `textParts` |
| `@redeemid/emdash/search` | `readableResults` |

Levels: `levelsFor(tags, levels)` answers every level the tags hold, including the ones a held level `includes` (so `levels` in `api/state`, `Viewer.levels` and `member.levels_changed` list Silver for a Gold member whose Gold includes Silver). `topLevels(held, levels)` keeps the ones no other held level includes, for showing ("Gold"). `closure(slug, levels)` is every level holding `slug` opens, itself first. `simplify(required, levels)` drops what inclusion already covers from a requirement (`[["silver"], ["gold"]]` becomes `[["gold"]]`); `entryRequirement` already does it. `membership()` marks a level held only through another with `via` (that level's slug).

Functions that take a `config` want the site's config for the request: `await siteConfig(Astro.locals)`, which is the code's config with the admin's saved settings laid over it. Passing the object from `astro.config.mjs` instead skips what staff saved on the Access page. A few examples:

```astro
---
import { canRead, siteConfig } from "@redeemid/emdash/access";
import { hasFeature } from "@redeemid/emdash/features";
import { searchProducts } from "@redeemid/emdash/catalog";
import { storeContext } from "@redeemid/emdash/storefront";

const verdict = await canRead(Astro, { collection: "posts", terms: post.data.terms, id: post.id });
const adFree = await hasFeature(Astro, "ad-free");
const config = await siteConfig(Astro.locals);
const totes = config && (await searchProducts(config, "tote", {}, { context: storeContext(config, Astro.request) }));
---
```

Catalog reads (`product`, `collection`, `searchProducts`, `collectionPage`, `suggest`, `recommendations`) are cached for five minutes per Worker isolate. Pass `storeContext(config, Astro.request)` as `context` for local prices when config `market` is set.

## JSON routes

Under `/_emdash/api/auth/redeemid/`. Same-origin only: EmDash checks `Origin` on every POST, and the browser client also sends `X-EmDash-Request: 1`. Member answers are `Cache-Control: private, no-store`.

- `api/state` (GET): the visitor's own state.

  ```json
  { "apiVersion": "1.3.0", "version": "0.0.24", "signedIn": true, "linked": true,
    "levels": ["gold"], "features": ["ad-free"], "cart": { "count": 2 },
    "meter": { "used": 1, "limit": 3, "period": "month" } }
  ```

- `api/cart` (GET, POST): the Shopify cart. GET answers `{ cart }` (null without one). POST takes `{ action, ... }`:
  - `add`: `product` (handle), then `variant` (an id of that product's) or `options` (`{ "Size": "M" }`), optional `sellingPlan` (one of the product's, or `""` for one-time), `quantity` (1 to 1000);
  - `update`: `line`, `quantity` (0 removes); `remove`: `line`; `discount`: `code` (`""` clears);
  - `checkout`: answers `{ checkoutUrl }`, signed in for members.

  Other actions answer `{ notice, cart, added? }`. An add Shopify can't fill answers 422 with `notice: "plan_unavailable"`. Over the rate limit (with `redeemidGuard({ rateLimit: true })`) POST answers 429 with `{ "error": "too_many_requests" }`.
- `api/search` (GET): public catalog data, `Cache-Control: public, max-age=60` (private when `market.country` is `"visitor"`).
  - `?q=tote&suggest=1[&limit=6]`: `{ queries, products, collections }`, for search-as-you-type;
  - `?q=tote`: `{ products, filters, pageInfo, total }`;
  - `?collection=shop`: the collection's page, `{ handle, title, description, products, filters, pageInfo }`.

  Both take `first` (1 to 50), `sort`, `after` or `before` (cursors from `pageInfo`), `filter` (repeatable: a filter value's `input` exactly as Shopify gave it), `price_min` and `price_max`. Sorts are `relevance`, `best-selling`, `newest`, `price-asc`, `price-desc`, `title-asc`, `title-desc` (search: relevance and price only). Over the rate limit a search answers 429, as `api/cart` does.
- `preferences` (GET, POST) and `privacy` (GET export, POST erase): see [preferences](shop.md#preferences) and [privacy requests](staff.md#privacy-requests).

Form routes, which redirect back with `?redeemid_notice=<code>` when something needs saying: `login`, `callback`, `logout`, `buy`, `cart`, `cart-edit`, `account`. `webhook` is for Shopify only and answers with a status code.

## Browser client

Add `<RedeemIDClient />` once to the site layout (from `@redeemid/emdash/components/RedeemIDClient.astro`). It defines `window.redeemid` and sends nothing anywhere by itself.

```js
const stop = window.redeemid.subscribe((name, props, event) => {
  // event: { name, version, time, props }, props are scalars only
});
```

A subscriber also gets the events that fired before it subscribed (`{ replay: false }` skips them), so it can wait for consent. Each event is also dispatched on `document` as a `CustomEvent` named `redeemid:<name>`.

| Member | What it does |
| --- | --- |
| `version`, `apiVersion` | Package and API versions |
| `events` | The event names below |
| `subscribe(fn, { replay })` | Listen; returns an unsubscribe function |
| `emit(name, props)` | Send your own event; names must start `site_` |
| `state()`, `refresh()` | The visitor's `api/state`, read once (or again) |
| `signIn(returnTo?)`, `signOut(returnTo?)` | Go to sign-in; sign out (a POST) |
| `cart` | `get()`, `add({ product, variant?, options?, sellingPlan?, quantity? })`, `update(line, quantity)`, `remove(line)`, `discount(code)`, `checkout()` |
| `openCart()`, `closeCart()` | The cart drawer, when `<CartDrawer />` is on the page |
| `search(q, { first, after, sort })`, `suggest(q, limit)`, `collection(handle, { first, after, sort })` | The `api/search` answers |

Events:

| Event | Props |
| --- | --- |
| `ready` | `api_version` |
| `state` | `signedIn`, `linked`, `levels` and `features` (comma-separated slugs), `cartCount` |
| `wall_shown` | `entry`, `level`, `reason` |
| `metered_view` | `left` |
| `sign_in_click` | `source` (`page`, `wall`, `drawer`) |
| `checkout_click` | `source`, `product` |
| `cart_changed` | `action`, `notice`, `count`, `product`, `quantity`, `subscription` |
| `cart_opened` | `source` (`link`, `add`, `api`) |
| `search` | `query_length` (never the words) |

The client also enhances RedeemID's markup: with `<CartDrawer />` on the page, Add to cart updates the cart in place and opens the drawer, and `<Cart drawer />` opens it. Product option pickers keep the price, sale price, image and stock in step, and `<ProductSearch>` suggests as you type. Without JavaScript every form still works.

## Server events

Signed outbound webhooks for a CRM or email tool. Verify `X-RedeemID-Signature` with `signBody(rawBody, secret)` from `@redeemid/emdash/events`.

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

## MCP and the command line

RedeemID's tools join EmDash's MCP server once staff turn them on for RedeemID under Plugins. They need an administrator's API token (the routes ask for `users:read`, which only Admins hold) with the `mcp:tools` or `mcp:tools:redeemid` scope. Always offered, read-only:

- `explain_access`, `list_levels`, `get_rules`, `get_member`, `site_health`, `level_changes`
- `find_products`, `get_product`, `get_collection`: the Shopify catalog the site sells, so an agent writing content can find the right product and collection handles.

Only with config `agents: { actions: true }`: `resync_member`, `resync_batch`, `edit_member_tags`.

The `redeemid-emdash` command line calls the same routes (`npx -p @redeemid/emdash redeemid-emdash --help`).

For shoppers' own agents (browsing products, building a cart, checking out), point them at Shopify's Storefront MCP server for the store, `https://<store domain>/api/mcp`. It runs on Shopify, where checkout and prices already live, so RedeemID doesn't repeat it.
