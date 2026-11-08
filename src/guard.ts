/**
 * Keeps members out of EmDash's own APIs and admin.
 *
 * EmDash's Subscriber role may read every published entry through
 * /_emdash/api/content. With RedeemID, access comes from Shopify tags only, so
 * a member with one level could otherwise read another level's posts there.
 * This middleware runs after EmDash's auth and refuses Subscribers on every
 * /_emdash path except the few public pages need.
 */

import { defineMiddleware } from "astro:middleware";

import { siteConfig } from "./site-config.js";

const SUBSCRIBER = 10;

/** Paths signed-in members still need. Everything else under /_emdash is refused. */
export const MEMBER_PATHS = [
	"/_emdash/api/auth/redeemid/",
	"/_emdash/api/auth/logout",
	"/_emdash/api/media/file/",
	"/_emdash/api/comments",
	"/_emdash/api/plugins/",
];

export function memberMayUse(path: string, extra: string[] = []): boolean {
	if (!path.startsWith("/_emdash")) return true;
	return [...MEMBER_PATHS, ...extra].some((p) => path === p.replace(/\/$/, "") || path.startsWith(p));
}

export const onRequest = defineMiddleware(async ({ locals, url }, next) => {
	const user = (locals as { user?: { role?: number } | null }).user;
	if (!user || user.role !== SUBSCRIBER) return next();

	const config = siteConfig((locals as { emdash?: { config?: unknown } }).emdash?.config);
	if (memberMayUse(url.pathname, config?.memberPaths)) return next();

	if (url.pathname.startsWith("/_emdash/admin")) {
		return new Response(null, { status: 302, headers: { location: "/", "cache-control": "private, no-store" } });
	}
	return new Response(JSON.stringify({ error: { code: "FORBIDDEN", message: "Members can't use this API." } }), {
		status: 403,
		headers: { "content-type": "application/json", "cache-control": "private, no-store" },
	});
});
