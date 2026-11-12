import { siteConfig } from "@redeemid/emdash/access";
import { productSitemap } from "@redeemid/emdash/catalog";
import type { APIRoute } from "astro";

export const GET: APIRoute = async ({ locals, url }) => productSitemap(await siteConfig(locals), url, { productHref: "/shop/{handle}/" });
