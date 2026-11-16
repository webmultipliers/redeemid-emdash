# Product sync

Choose which Shopify products your site keeps in sync: all of them, or only the ones you tick. Each synced product becomes an entry in a `products` collection. That puts it in EmDash's own search, sitemap, menus and taxonomies, lets posts link to it, and lets editors write a story around it.

Shopify stays the source of truth:

- **Shopify's fields are copied from Shopify.** That covers the title, handle, description, image, prices, availability and vendor. Only Shopify changes them, through an add, a refresh or one of Shopify's product webhooks. If an editor changes one, RedeemID puts it back on save.
- **Everything else is yours.** The story, extra images, categories and links stay as editors leave them.
- **Buyers always get Shopify live.** `<Product>`, the Product block, cart and checkout read variants, the price in the buyer's market, selling plans and stock from Shopify on every request. The entry's copy feeds cards, lists, search and links.
- **A product Shopify stops selling goes to draft.** This covers a product that is deleted, archived or taken off the Headless channel. RedeemID marks the entry "Off the store" (`listed: false`) and sets it to draft, and the story stays. When Shopify sells the product again, the entry comes back. An entry that staff unpublished themselves stays unpublished.
- **Nothing syncs on a schedule.** Shopify's webhooks keep entries up to date, and staff can update them all by hand, a batch at a time.
- **Stopping a sync keeps the story.** The entry moves to the trash. Tick the product again and it comes back, story and all.

## Set up products

Open **Plugins → RedeemID → Products** and press **Set up products**. RedeemID creates a `products` content type with every field below, and nothing else to do. If the content type already exists but lacks some of the fields, the button adds just those.

You can also define the collection yourself, in your seed (`seed/seed.json`) or under Content types. It needs every field below, with these slugs. You can add your own fields and taxonomies on top.

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

## Choose products

Open **Plugins → RedeemID → Products**.

- **Choose products to sync** lists the store's products by name, 10 at a time, with a box for each. Ticked ones are synced. Tick the ones you want, untick any you don't, and press **Save**. **Find products by name** narrows the list, and **Next** and **Previous** page through it.
- **Synced products** lists what's synced, with **Edit** and **Stop syncing**.
- **Automatic updates** shows whether Shopify sends product changes. **Turn on automatic updates** registers Shopify's `products/create`, `products/update` and `products/delete` webhooks with the Admin API app, which needs the `read_products` scope. Each webhook only tells RedeemID to read the product again from the Storefront API. The entry follows what that read returns.
- **Sync every product** syncs every product Shopify sells on the site's channel, 10 at a time. It remembers where it stopped, so you can carry on later.
- **Update synced products** reads every synced product from Shopify again. Use it after a webhook was missed, or after you take products off the Headless channel. Shopify sends no webhook for that.

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

### Product structured data

On a product entry's own page, RedeemID adds Product structured data to `<EmDashHead>` through EmDash's `page:metadata` hook, with no template code. It's built only from Shopify's fields on the entry: the title, handle, summary, image, vendor, product type, price or price range, currency and stock. Nothing an editor wrote goes in. It runs when the page builds its page context with `kind: "content"` and the entry, as EmDash's SEO guide shows:

```astro
---
import Product from "@redeemid/emdash/components/Product.astro";
import { getEmDashEntry } from "emdash";
import { createPublicPageContext } from "emdash/page";
import { EmDashHead } from "emdash/ui";

const { entry } = await getEmDashEntry("products", Astro.params.handle ?? "");
const page = createPublicPageContext({ Astro, kind: "content", title: entry?.data.title ?? "Shop", content: entry ? { collection: "products", id: entry.data.id, slug: entry.data.slug } : undefined });
---
<head><EmDashHead page={page} /></head>
<Product handle={entry?.data.handle} heading="h1" schema={false} />
```

`<Product heading="h1">` prints its own Product data from a live read, so pass `schema={false}` on such a page to give search engines one product. Config `schema: false` turns both off.

## A product field for any content type

Any content type can hold a Shopify product in a plain text field, such as a post's featured product. Give the field the `redeemid:product` widget, and editors search the store's products and pick one, in place of typing a handle:

```json
{ "slug": "featured_product", "label": "Featured product", "type": "string", "widget": "redeemid:product" }
```

The field holds the product's handle, so a template renders it with `<Product handle={post.data.featured_product} />`. The search reads the Storefront API live, so it lists every product on the Headless channel, whether it's synced or not. Set the widget in a seed or through EmDash's schema API.

