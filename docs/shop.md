# Shop and preferences

## Shop

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

**Product pages in search.** `<Product heading="h1">` prints Product structured data. Give the page the product's own title and description, and answer 404 for a handle Shopify doesn't have, by reading the product in the page (the same cached read `<Product>` makes):

```astro
---
// src/pages/shop/[handle].astro
import { siteConfig } from "@redeemid/emdash/access";
import { product, storeContext } from "@redeemid/emdash/storefront";

const config = await siteConfig(Astro.locals);
const p = config ? await product(config, Astro.params.handle, undefined, storeContext(config, Astro.request)).catch(() => null) : null;
if (!p) Astro.response.status = 404;
const title = p?.seo?.title || p?.title;
const description = p?.seo?.description || p?.description.slice(0, 160);
---
```

EmDash's sitemap lists content entries only, so add one for products. `productSitemap()` lists every product the Headless channel sells (up to 5,000), newest change first, linked with the same pattern as the cards:

```ts
// src/pages/sitemap-products.xml.ts
import { siteConfig } from "@redeemid/emdash/access";
import { productSitemap } from "@redeemid/emdash/catalog";
import type { APIRoute } from "astro";

export const GET: APIRoute = async ({ locals, url }) => productSitemap(await siteConfig(locals), url, { productHref: "/shop/{handle}/" });
```

Then submit it to search engines, or list it in robots.txt. A custom robots.txt in EmDash's SEO settings replaces the generated one, so keep both lines in it: `Sitemap: https://<your site>/sitemap.xml` and `Sitemap: https://<your site>/sitemap-products.xml`. If the store's Online Store channel is open too, search engines find two pages for each product: publish the [redirect theme](https://github.com/webmultipliers/redeemid-emdash-shopify-redirect-theme) on the store to send its pages to the site (below).

<a id="discount-links"></a>**The store's own pages and discount links.** The [RedeemID redirect theme](https://github.com/webmultipliers/redeemid-emdash-shopify-redirect-theme) is a Shopify theme that sends the store's online store pages to the site (`/products/gold` to `/shop/gold/`, with editable path rules), while checkout and customer accounts stay on Shopify. It passes two things along, and the guard middleware (`redeemidGuard()`) takes both off the URL before the page renders:

- `?discount=CODE`, from Shopify's discount links (`https://<store>/discount/CODE?redirect=/products/gold`). The code goes on the visitor's cart straight away, or waits in their session for the first cart made for them (an Add to cart or a plan's Join button). Shopify decides at checkout whether it applies.
- `?logged_in=true`, when the customer is signed in to the store. A visitor who isn't signed in on the site is sent through sign-in with `prompt=none` (`login?quiet=1`), so they come back signed in without a form, or still signed out if the store session has ended, with no notice either way.

You can link to any site page with `?discount=CODE` yourself, too.

**Shoppers' agents.** Shopify runs a Storefront MCP server for every store at `https://<store domain>/api/mcp`, for AI agents that browse, build a cart and check out. Point shopping agents there; RedeemID's own tools are for staff.

## Preferences

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
