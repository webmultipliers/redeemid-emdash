# Product entries

Keep the Shopify products your site uses as EmDash entries. You can keep all of them or only the ones you pick. Each product you add becomes an entry in a `products` collection. That puts it in EmDash's own search, sitemap, menus and taxonomies, lets posts link to it, and lets editors write a story around it.

Shopify stays the source of truth:

- **Shopify's fields are copied from Shopify.** That covers the title, handle, description, image, prices, availability and vendor. Only Shopify changes them, through an add, a refresh or one of Shopify's product webhooks. If an editor changes one, RedeemID puts it back on save.
- **Everything else is yours.** The story, extra images, categories and links stay as editors leave them.
- **Buyers always get Shopify live.** `<Product>`, the Product block, cart and checkout read variants, the price in the buyer's market, selling plans and stock from Shopify on every request. The entry's copy feeds cards, lists, search and links.
- **A product Shopify stops selling goes to draft.** This covers a product that is deleted, archived or taken off the Headless channel. RedeemID marks the entry "Off the store" (`listed: false`) and sets it to draft, and the story stays. When Shopify sells the product again, the entry comes back. An entry that staff unpublished themselves stays unpublished.
- **Nothing syncs on a schedule.** Webhooks keep entries up to date, and staff refresh by hand, a batch at a time.

## Add the collection

Product entries live in a collection your site defines, named `products` by default. Add it to your seed (`seed/seed.json`) or create it under Content types. It needs every field below, with these slugs. You can add your own fields and taxonomies on top.

```json
{
	"slug": "products",
	"label": "Products",
	"labelSingular": "Product",
	"urlPattern": "/shop/{slug}/",
	"icon": "storefront",
	"supports": ["drafts", "search", "seo"],
	"admin": { "listColumns": ["price", "listed", "synced_at"] },
	"fields": [
		{ "slug": "title", "label": "Title (Shopify)", "type": "string", "required": true, "searchable": true },
		{ "slug": "handle", "label": "Handle (Shopify)", "type": "string", "required": true, "indexed": true, "unique": true },
		{ "slug": "content", "label": "Story", "type": "portableText", "searchable": true },
		{ "slug": "shopify_id", "label": "Product id (Shopify)", "type": "string", "indexed": true },
		{ "slug": "summary", "label": "Description (Shopify)", "type": "text", "searchable": true },
		{ "slug": "image_url", "label": "Image (Shopify)", "type": "string" },
		{ "slug": "image_alt", "label": "Image alt text (Shopify)", "type": "string" },
		{ "slug": "price", "label": "Price, lowest (Shopify)", "type": "string" },
		{ "slug": "price_max", "label": "Price, highest (Shopify)", "type": "string" },
		{ "slug": "compare_at", "label": "Compare-at price (Shopify)", "type": "string" },
		{ "slug": "currency", "label": "Currency (Shopify)", "type": "string" },
		{ "slug": "available", "label": "In stock (Shopify)", "type": "boolean" },
		{ "slug": "quick_add", "label": "Quick-add variant (Shopify)", "type": "string" },
		{ "slug": "vendor", "label": "Vendor (Shopify)", "type": "string" },
		{ "slug": "product_type", "label": "Product type (Shopify)", "type": "string" },
		{ "slug": "listed", "label": "On sale here (Shopify)", "type": "boolean", "indexed": true },
		{ "slug": "synced_at", "label": "Read from Shopify", "type": "datetime", "indexed": true }
	]
}
```

Leave `revisions` out of `supports`. RedeemID writes Shopify's fields straight to the live entry. If the collection keeps revisions, publishing an older draft can bring back old prices until the next refresh, and the Products page warns about it.

Two config options change the defaults:

```js
const redeemidConfig = {
	// Another collection slug, and also add products Shopify creates later.
	products: { collection: "shop_items", follow: "all" },
};
```

`follow: "picked"` is the default. With it, a webhook only updates products you already added, and a product created in Shopify isn't added until you add it. `products: false` turns product entries off.

## Pick products

Open **Plugins → RedeemID → Products**.

- **Search** the store by title, or paste handles or product links separated by commas. Each result has **Add**, or **Refresh** if it's already in the catalog.
- **Add all from Shopify** adds every product Shopify sells on the site's channel, 10 per click. It remembers where it stopped, so you can carry on later.
- **Refresh** reads again the 10 products that were read from Shopify longest ago. Use it after a webhook was missed, or after you take products off the Headless channel. Shopify sends no webhook for that.
- **Turn on product updates** registers Shopify's `products/create`, `products/update` and `products/delete` webhooks with the Admin API app. The app needs the `read_products` scope. Each webhook only tells RedeemID to read the product again from the Storefront API. The entry follows what that read returns.

An editor can also make a product entry under Content. Give it a handle, or paste a product link, and RedeemID fills in Shopify's fields when the entry is saved.

Batches stay at 10 because each product takes a few database queries, and the Workers Free plan allows 50 per request.

## Use entries on the site

Entries are ordinary EmDash content, so `getEmDashCollection("products")` and `getEmDashEntry("products", handle)` read them with no Shopify call. `entryCard()` turns one into the card `<ProductGrid>` draws:

```astro
---
import ProductGrid from "@redeemid/emdash/components/ProductGrid.astro";
import { entryCard } from "@redeemid/emdash/products";
import { getEmDashCollection } from "emdash";

const { entries } = await getEmDashCollection("products", { orderBy: { title: "asc" } });
---
<ProductGrid products={entries.map(entryCard)} productHref="/shop/{handle}/" quickAdd />
```

On a product page, sell the product live and put the entry's story under it:

```astro
---
import Product from "@redeemid/emdash/components/Product.astro";
import { getEmDashEntry } from "emdash";
import { PortableText } from "emdash/ui";

const { handle = "" } = Astro.params;
const { entry } = await getEmDashEntry("products", handle);
---
<Product handle={handle} heading="h1" />
{entry?.data.content && <PortableText value={entry.data.content} />}
```

EmDash's sitemap lists published product entries at the collection's `urlPattern`. If you also serve `/sitemap-products.xml` for the rest of the store, leave the entries out so no page is listed twice:

```ts
import { siteConfig } from "@redeemid/emdash/access";
import { productSitemap } from "@redeemid/emdash/catalog";
import { catalogHandles } from "@redeemid/emdash/products";
import type { APIRoute } from "astro";

export const GET: APIRoute = async ({ locals, url }) =>
	productSitemap(await siteConfig(locals), url, { productHref: "/shop/{handle}/", exclude: await catalogHandles(locals) });
```

The editor's **Product** block gets a **Product from the catalog** picker that lists the entries. You can still type any handle in the second field.
