/**
 * Rate limits on Cloudflare Workers, added by `redeemidGuard({ rateLimit: true })`.
 * Reads the REDEEMID_RATE_LIMIT Rate Limiting binding from wrangler config.
 */

import { defineMiddleware } from "astro:middleware";
import { env } from "cloudflare:workers";

import { RATE_LIMIT_BINDING, rateLimited, type RateLimiter } from "./rate-limit.js";

let warned = false;

export const onRequest = defineMiddleware(async (context, next) => {
	const limiter = (env as Record<string, unknown>)[RATE_LIMIT_BINDING] as RateLimiter | undefined;
	if (!limiter && !warned) {
		warned = true;
		console.warn(`[redeemid] rateLimit is on but there is no ${RATE_LIMIT_BINDING} binding; nothing is limited.`);
	}
	return (await rateLimited(limiter, context.request)) ?? next();
});
