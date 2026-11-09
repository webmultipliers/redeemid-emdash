/**
 * GET /_emdash/api/auth/redeemid/api/search: the shop's catalog as JSON.
 *
 * - ?q=tote&suggest=1 : suggestions while typing { queries, products, collections }
 * - ?q=tote           : a page of matching products { products, filters, pageInfo, total }
 * - ?collection=shop  : a page of a collection's products, with its filters
 *
 * Paging and filters use the same params as the components: sort, after,
 * before, filter (Shopify's filter input, repeatable), price_min,
 * price_max, first (1 to 50). Everything is public catalog data, so answers
 * may be cached briefly by browsers and CDNs.
 */

import type { APIRoute } from "astro";

import { browseFromUrl, collectionPage, searchProducts, suggest } from "../../catalog.js";
import { readConfig, storeDomain } from "../../config.js";
import { storeContext } from "../../storefront.js";
import { json } from "./shared.js";

export const prerender = false;

const PUBLIC = "public, max-age=60";

export const GET: APIRoute = async ({ request, locals }) => {
	const config = readConfig((locals as { emdash?: { config?: unknown } }).emdash?.config);
	if (!config || !storeDomain(config)) return json(404, { error: "not_configured" });
	const url = new URL(request.url);
	const first = Number.parseInt(url.searchParams.get("first") ?? "", 10);
	const browse = browseFromUrl(url.searchParams, Number.isFinite(first) ? first : 24);
	const context = storeContext(config, request);
	// A visitor-country answer differs per visitor.
	const cache = config.market?.country === "visitor" ? "private, max-age=60" : PUBLIC;
	try {
		const handle = (url.searchParams.get("collection") ?? "").trim();
		if (handle) {
			if (!/^[a-z0-9][a-z0-9-]*$/i.test(handle)) return json(400, { error: "bad_request" });
			const page = await collectionPage(config, handle, browse, { context });
			return page ? json(200, page, cache) : json(404, { error: "not_found" });
		}
		if (url.searchParams.get("suggest") === "1") {
			const limit = Number.parseInt(url.searchParams.get("limit") ?? "6", 10);
			return json(200, await suggest(config, browse.query, Number.isFinite(limit) ? limit : 6, { context }), cache);
		}
		return json(200, await searchProducts(config, browse.query, browse, { context }), cache);
	} catch {
		return json(502, { error: "unavailable" });
	}
};
