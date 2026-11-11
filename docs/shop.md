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
