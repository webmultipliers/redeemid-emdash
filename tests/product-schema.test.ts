import { describe, expect, it } from "vitest";

import { productMetadata } from "../src/product-schema.js";

const page = { url: "https://site.test/products/tote", canonical: null, content: { collection: "products", id: "p1", slug: "tote" } };
const data = { title: "Harbor tote", handle: "tote", price: "19.00", price_max: "19.00", currency: "USD", available: 1, summary: "A bag.", image_url: "https://cdn.shopify.com/t.jpg", vendor: "Harbor", product_type: "Bags", editor_note: "never shown" };

describe("product entry structured data", () => {
	it("builds a Product from Shopify's fields only", () => {
		const out = productMetadata(page, data)!;
		expect(out.kind).toBe("jsonld");
		expect(out.id).toBe("redeemid:product:tote");
		expect(out.graph).toMatchObject({
			"@type": "Product",
			name: "Harbor tote",
			url: page.url,
			productID: "tote",
			description: "A bag.",
			image: "https://cdn.shopify.com/t.jpg",
			brand: { "@type": "Brand", name: "Harbor" },
			offers: { "@type": "Offer", price: "19.00", priceCurrency: "USD", availability: "https://schema.org/InStock" },
		});
		expect(JSON.stringify(out.graph)).not.toContain("never shown");
	});

	it("uses a price range and the canonical address", () => {
		const out = productMetadata({ ...page, canonical: "https://site.test/p/tote" }, { ...data, price_max: "29.00", available: false })!;
		expect(out.graph.url).toBe("https://site.test/p/tote");
		expect(out.graph.offers).toMatchObject({ "@type": "AggregateOffer", lowPrice: "19.00", highPrice: "29.00", availability: "https://schema.org/OutOfStock" });
	});

	it("skips entries without a title, handle or price", () => {
		expect(productMetadata(page, { ...data, price: null })).toBeNull();
		expect(productMetadata(page, { ...data, title: "" })).toBeNull();
	});
});
