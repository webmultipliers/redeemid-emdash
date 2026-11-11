# Reference

## Config

Pass one object to both `redeemid(config)` and `redeemidPlugin(config)`. `levels`, `rules`, `meter`, `features`, `files`, `combine`, `teaser` and `join` are defaults that the Access page can replace.

| Option | Type | What it does |
| --- | --- | --- |
| `shop` | `string` | The store's `*.myshopify.com` domain. A custom domain works for sign-in, but the Admin API (staff tools, webhook registration, tag reads) answers only on myshopify.com, and the Status page warns when the app is set up with a custom domain. Leave it out to read `REDEEMID_SHOPIFY_STORE_DOMAIN`. |
| `label` | `string` | The sign-in button's label. Default "Sign in". |
| `levels` | `{ slug, name, tags?, match?, groups?, includes?, wall?, joinUrl?, products?, home?, badge? }[]` | Levels from customer tags. See [levels](access.md#levels). |
| `rules` | `{ collection, taxonomy?, term?, levels, open?, drip?, meter? }[]` | What needs which levels. See [rules](access.md#rules). |
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

## Secrets

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

## Components

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
| `Plan` | `handle`, `label`, `title`, `levels`, `heldLabel`, `renewLabel`, `upgradeLabel` | A product with a buy button that fits the member |
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

## Editor blocks

`redeemidPlugin()` adds these Portable Text blocks to the EmDash editor. `<Content>` renders them.

| Block | Type | Does |
| --- | --- | --- |
| Paywall break | `redeemid-paywall` | Everyone reads up to here; the rest follows the entry's rule |
| Members only / Members only: end | `redeemid-members`, `redeemid-members-end` | A members-only part in the middle of a body |
| Sold on its own | `redeemid-item` | Sells the entry by itself to holders of a tag |
| Plan | `redeemid-plan` | A product with a buy button |
| Product | `redeemid-product` | A product with variants and Add to cart |
| Collection | `redeemid-collection` | A grid of products, optionally with filters, pages and Add to cart |
| Product search | `redeemid-search` | A search box with Shopify's results |
| Contribution | `redeemid-contribution` | Pay what you want |
| Preferences | `redeemid-preferences` | The member's preference form |

## Modules

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
| `@redeemid/emdash/search` | `readableResults()`, for a search page that calls EmDash's `search()` |
| `@redeemid/emdash/contract` | The stable API as a list, and `API_VERSION` |

The full developer API (stable exports, JSON routes, the browser client and its events, MCP tools) is in [docs/developer-api.md](developer-api.md).

## Routes

Under `/_emdash/api/auth/redeemid/`: `login`, `callback`, `logout`, `webhook`, `buy`, `cart`, `cart-edit`, `account`, `preferences` and `privacy`, and the JSON routes `api/state`, `api/cart` and `api/search`. Staff-only routes for the admin, agents and the command line are under `/_emdash/api/plugins/redeemid/`.

In the Customer Account API client, set the callback URI to `https://<site>/_emdash/api/auth/redeemid/callback`, the logout URI to `https://<site>/`, and (public clients) the JavaScript origin to `https://<site>`. Point webhooks at `https://<site>/_emdash/api/auth/redeemid/webhook`: `customers/create`, `customers/update`, `customers/delete`, `customers/disable`, `customers/enable`, `customers/merge`, `customer.tags_added` and `customer.tags_removed` (the Setup page registers these for you). The compliance topics `customers/data_request`, `customers/redact` and `shop/redact` go to the same URL, set in the app's own configuration.

## Notices

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
