/**
 * Optional per-visitor rate limits on the routes that start work at Shopify:
 * Sign in, Buy, cart changes and catalog search. On Cloudflare Workers they use a Rate
 * Limiting binding named REDEEMID_RATE_LIMIT (see rate-limit-cloudflare.ts);
 * nothing is limited without one.
 */

export const RATE_LIMIT_BINDING = "REDEEMID_RATE_LIMIT";

/** The shape of a Workers Rate Limiting binding. */
export interface RateLimiter {
	limit(options: { key: string }): Promise<{ success: boolean }>;
}

const BASE = "/_emdash/api/auth/redeemid";
const LIMITED: Record<string, string> = {
	[`GET ${BASE}/login`]: "login",
	[`POST ${BASE}/buy`]: "buy",
	[`POST ${BASE}/cart-edit`]: "cart",
	[`POST ${BASE}/api/cart`]: "cart",
	// Each new query is a Storefront API call.
	[`GET ${BASE}/api/search`]: "search",
};

/** Which limited action a request is, or null. */
export function limitedAction(method: string, path: string): string | null {
	return LIMITED[`${method.toUpperCase()} ${path.replace(/\/+$/, "")}`] ?? null;
}

/** Where to send a reader who was limited: the page they came from, on this site. */
function backTo(url: URL, request: Request): string {
	const ret = url.searchParams.get("return");
	if (ret && ret.startsWith("/") && !ret.startsWith("//") && !ret.startsWith("/\\")) return ret;
	const referer = request.headers.get("referer");
	if (referer) {
		try {
			const r = new URL(referer);
			if (r.origin === url.origin && !r.pathname.startsWith("/_emdash")) return `${r.pathname}${r.search}`;
		} catch {
			// ignore
		}
	}
	return "/";
}

/**
 * A response for a request over its limit, or null to let it through. Fails
 * open: a limiter that errors never blocks a reader.
 */
export async function rateLimited(limiter: RateLimiter | undefined, request: Request): Promise<Response | null> {
	if (!limiter || typeof limiter.limit !== "function") return null;
	const url = new URL(request.url);
	const action = limitedAction(request.method, url.pathname);
	if (!action) return null;
	const ip = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
	try {
		const { success } = await limiter.limit({ key: `${action}:${ip}` });
		if (success) return null;
	} catch (e) {
		console.error("[redeemid] rate limit check failed:", (e as Error).message);
		return null;
	}
	if (url.pathname.startsWith(`${BASE}/api/`)) {
		return new Response(JSON.stringify({ error: "too_many_requests" }), {
			status: 429,
			headers: { "content-type": "application/json", "retry-after": "60", "cache-control": "private, no-store" },
		});
	}
	const back = backTo(url, request);
	const sep = back.includes("?") ? "&" : "?";
	return new Response(null, {
		status: 303,
		headers: { location: `${back}${sep}redeemid_notice=too_many_requests`, "retry-after": "60", "cache-control": "private, no-store" },
	});
}
