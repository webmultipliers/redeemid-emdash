/**
 * Product structured data for a product entry's own page, given to EmDash's
 * `page:metadata` hook (plugin.ts), so `<EmDashHead>` prints it without any
 * template code. Built only from the fields Shopify owns on the entry
 * (products.ts MIRROR_KEYS), never from what an editor typed.
 *
 * Pages that render `<Product heading="h1">` print their own Product data
 * from a live Storefront read; on a product entry's page, pass
 * `schema={false}` to that component so search engines see one product.
 */

const STOCK = { in: "https://schema.org/InStock", out: "https://schema.org/OutOfStock" };

export interface PageForSchema {
	url: string;
	canonical: string | null;
	content?: { collection: string; id: string; slug: string | null };
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** The `jsonld` contribution for a synced product entry, or null when it lacks a title, handle or price. */
export function productMetadata(page: PageForSchema, data: Record<string, unknown>): { kind: "jsonld"; id: string; graph: Record<string, unknown> } | null {
	const name = str(data.title);
	const handle = str(data.handle);
	const price = str(data.price);
	const currency = str(data.currency);
	if (!name || !handle || !price || !currency) return null;
	const high = str(data.price_max);
	const available = data.available === true || data.available === 1;
	const url = page.canonical ?? page.url;
	const availability = available ? STOCK.in : STOCK.out;
	const offers =
		high && high !== price
			? { "@type": "AggregateOffer", lowPrice: price, highPrice: high, priceCurrency: currency, availability, url }
			: { "@type": "Offer", price, priceCurrency: currency, availability, url };
	const graph: Record<string, unknown> = {
		"@context": "https://schema.org",
		"@type": "Product",
		name,
		url,
		productID: handle,
		offers,
	};
	const description = str(data.summary);
	if (description) graph.description = description.slice(0, 5000);
	const image = str(data.image_url);
	if (image) graph.image = image;
	const vendor = str(data.vendor);
	if (vendor) graph.brand = { "@type": "Brand", name: vendor };
	const category = str(data.product_type);
	if (category) graph.category = category;
	return { kind: "jsonld", id: `redeemid:product:${handle}`, graph };
}
