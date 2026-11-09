# Developer API

What site code, other plugins and AI agents can rely on in `@redeemid/emdash`. API version **1.0.0** (`API_VERSION` in `@redeemid/emdash/contract`, also in `api/state` and `window.redeemid.apiVersion`).

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
| `@redeemid/emdash/access` | `viewer`, `canRead`, `readEntry`, `entryRequirement`, `meterUsage`, `membership`, `levelsFor`, `signInUrl`, `signOutUrl`, `accountUrl`, `cartUrl`, `refreshUrl`, `safeReturn` |
| `@redeemid/emdash/features` | `hasFeature`, `viewerFeatures`, `featuresFor` |
| `@redeemid/emdash/preferences` | `readPreferences`, `savePreferences`, `preferenceFields` |
| `@redeemid/emdash/storefront` | `plan`, `product`, `collection`, `money`, `realOptions`, `variantFor`, `storeContext`, `cartDetails`, `addToCart`, `updateLines`, `removeLines`, `setDiscountCodes` |
| `@redeemid/emdash/catalog` | `searchProducts`, `collectionPage`, `suggest`, `recommendations`, `browseFromUrl`, `browseHref`, `parseFilters`, `priceFilter`, `SORTS` |
| `@redeemid/emdash/events` | `signBody` |
| `@redeemid/emdash/text` | `STRINGS`, `text`, `textParts` |

The site's config for a request comes from `siteConfig(Astro.locals)` (code config with the admin's saved settings laid over it). A few examples:

```astro
---
import { canRead, viewer } from "@redeemid/emdash/access";
import { hasFeature } from "@redeemid/emdash/features";
import { searchProducts } from "@redeemid/emdash/catalog";

const verdict = await canRead(Astro, { collection: "posts", terms: post.data.terms, id: post.id });
const adFree = await hasFeature(Astro, "ad-free");
---
```

Catalog reads (`product`, `collection`, `searchProducts`, `collectionPage`, `suggest`, `recommendations`) are cached for five minutes per Worker isolate. Pass `storeContext(config, Astro.request)` as `context` for local prices when config `market` is set.

## JSON routes

Under `/_emdash/api/auth/redeemid/`. Same-origin only: EmDash checks `Origin` on every POST, and the browser client also sends `X-EmDash-Request: 1`. Member answers are `Cache-Control: private, no-store`.

- `api/state` (GET): the visitor's own state.

  ```json
  { "apiVersion": "1.0.0", "version": "0.0.18", "signedIn": true, "linked": true,
    "levels": ["gold"], "features": ["ad-free"], "cart": { "count": 2 },
    "meter": { "used": 1, "limit": 3, "period": "month" } }
  ```

- `api/cart` (GET, POST): the Shopify cart. GET answers `{ cart }` (null without one). POST takes `{ action, ... }`:
  - `add`: `product` (handle), then `variant` (an id of that product's) or `options` (`{ "Size": "M" }`), optional `sellingPlan` (one of the product's, or `""` for one-time), `quantity` (1 to 1000);
  - `update`: `line`, `quantity` (0 removes); `remove`: `line`; `discount`: `code` (`""` clears);
  - `checkout`: answers `{ checkoutUrl }`, signed in for members.

  Other actions answer `{ notice, cart, added? }`. An add Shopify can't fill answers 422 with `notice: "plan_unavailable"`. Over the rate limit (with `redeemidGuard({ rateLimit: true })`) POST answers 429.
- `api/search` (GET): public catalog data, `Cache-Control: public, max-age=60` (private when `market.country` is `"visitor"`).
  - `?q=tote&suggest=1[&limit=6]`: `{ queries, products, collections }`, for search-as-you-type;
  - `?q=tote`: `{ products, filters, pageInfo, total }`;
  - `?collection=shop`: the collection's page, `{ handle, title, description, products, filters, pageInfo }`.

  Both take `first` (1 to 50), `sort`, `after` or `before` (cursors from `pageInfo`), `filter` (repeatable: a filter value's `input` exactly as Shopify gave it), `price_min` and `price_max`. Sorts are `relevance`, `best-selling`, `newest`, `price-asc`, `price-desc`, `title-asc`, `title-desc` (search: relevance and price only).
- `preferences` (GET, POST) and `privacy` (GET export, POST erase): see the README.

Form routes, which redirect back with `?redeemid_notice=<code>`: `login`, `callback`, `logout`, `webhook`, `buy`, `cart`, `cart-edit`, `account`.

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

Signed outbound webhooks to config `events.url` (see the README): `member.signed_in`, `member.levels_changed`, `meter.used`, `meter.exhausted`, `preferences.saved`, `member.erased`. Verify `X-RedeemID-Signature` with `signBody(rawBody, secret)`.

## MCP and the command line

RedeemID's tools join EmDash's MCP server once staff turn them on for RedeemID under Plugins. They need a staff token (permission `users:read`). Always offered, read-only:

- `explain_access`, `list_levels`, `get_rules`, `get_member`, `site_health`, `level_changes`
- `find_products`, `get_product`, `get_collection`: the Shopify catalog the site sells, so an agent writing content can find the right product and collection handles.

Only with config `agents: { actions: true }`: `resync_member`, `resync_batch`, `edit_member_tags`.

The `redeemid-emdash` command line calls the same routes (`npx redeemid-emdash --help`).

For shoppers' own agents (browsing products, building a cart, checking out), point them at Shopify's Storefront MCP server for the store, `https://<store domain>/api/mcp`. It runs on Shopify, where checkout and prices already live, so RedeemID doesn't repeat it.
