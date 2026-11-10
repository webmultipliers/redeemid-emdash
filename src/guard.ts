/**
 * Keeps members out of EmDash's own APIs and admin, and keeps their pages out
 * of shared caches.
 *
 * EmDash's Subscriber role may read every published entry through
 * /_emdash/api/content. With RedeemID, access comes from Shopify tags only, so
 * a member with one level could otherwise read another level's posts there.
 * This middleware runs after EmDash's auth and refuses Subscribers on every
 * /_emdash path except the few public pages need.
 *
 * Site pages for a signed-in visitor, or a visitor with a cart, are private:
 * `Cache-Control: private, no-store` and out of Astro's route cache. The route
 * cache ignores Cache-Control and takes its options from `cache.set()`, which
 * EmDash templates call on every page with the content's cache hint, and it
 * serves a stored page to the next visitor without running any code. EmDash
 * opts editors out, not Subscribers, so without this a member's page (locked
 * text included) could be stored and served to anyone. A later
 * `Astro.cache.set(hint)` turns caching back on, and the route cache reads its
 * options only after the page has rendered, so the opt-out runs after `next()`.
 */

import { defineMiddleware } from "astro:middleware";

import { signInUrl } from "./access.js";
import { readCart } from "./cart.js";
import { keysFromUrl, pathAccess, refusal } from "./files.js";
import { AFTER_LOGOUT_COOKIE, readAfterLogout } from "./routes/shared.js";
import { shareConfig, siteConfig } from "./site-config.js";

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

/**
 * EmDash skips the session on its public file route, so resolve the signed-in
 * user here: the access check needs it.
 */
async function withUser(context: { locals: unknown; session?: { get(k: string): Promise<unknown> } }) {
	const locals = context.locals as { user?: { id: string; role?: number } | null; emdash?: { db?: unknown } | null };
	if (!locals.emdash?.db) {
		// EmDash leaves the database off some public requests: fetch it, so the check can run.
		const { getDb } = await import("emdash/runtime");
		const next = { ...locals, emdash: { ...(locals.emdash ?? {}), db: await getDb() } };
		shareConfig(locals, next);
		return withUser({ ...context, locals: next });
	}
	if (locals.user) return context;
	const sessionUser = (await context.session?.get("user")) as { id?: string } | undefined;
	if (!sessionUser?.id) return context;
	const { createKyselyAdapter } = await import("@emdash-cms/auth/adapters/kysely");
	const user = await createKyselyAdapter(locals.emdash.db as never).getUserById(sessionUser.id);
	if (!user || user.disabled) return context;
	const next = { ...locals, user: { id: user.id, role: user.role, disabled: user.disabled } };
	shareConfig(locals, next);
	return { ...context, locals: next };
}

/** Keep one visitor's response out of every shared cache, the route cache included. */
export function keepPrivate(context: { cache?: { set(options: false): void } }, res: Response): Response {
	context.cache?.set(false);
	try {
		res.headers.set("cache-control", "private, no-store");
		return res;
	} catch {
		// Immutable headers (a redirect made with Response.redirect).
		const out = new Response(res.body, res);
		out.headers.set("cache-control", "private, no-store");
		return out;
	}
}

export const onRequest = defineMiddleware(async (context, next) => {
	const { locals, url } = context;
	const user = (locals as { user?: { role?: number } | null }).user;
	const config = await siteConfig(locals);

	// Protected files: checked for everyone, on every download.
	const keys = config?.files?.length || config?.unavailable ? keysFromUrl(url) : null;
	if (keys) {
		let verdict;
		try {
			verdict = await pathAccess(await withUser(context), config, keys);
		} catch (e) {
			// Fail closed: a file we can't check isn't served.
			console.error("[redeemid] file check failed:", (e as Error).message);
			return refusal("denied", signInUrl(url.pathname), config);
		}
		if (verdict.protected) {
			if (!verdict.allowed) return refusal(verdict.reason, signInUrl(url.pathname), config);
			const res = await next();
			const out = new Response(res.body, res);
			out.headers.set("cache-control", "private, no-store");
			out.headers.set("vary", "Cookie");
			out.headers.set("x-robots-tag", "noindex");
			return out;
		}
	}

	// Back from ending the store session after a refused sign-in.
	if (url.pathname === "/" && !url.searchParams.has("redeemid_notice")) {
		const after = readAfterLogout(context.cookies.get(AFTER_LOGOUT_COOKIE)?.value);
		if (after) {
			const sep = after.returnTo.includes("?") ? "&" : "?";
			const location = `${after.returnTo}${sep}redeemid_notice=${encodeURIComponent(after.code)}`;
			return new Response(null, { status: 302, headers: { location, "cache-control": "private, no-store", "set-cookie": `${AFTER_LOGOUT_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` } });
		}
	}

	if (!url.pathname.startsWith("/_emdash")) {
		const own = Boolean(user) || Boolean(await readCart(context.session as never).catch(() => null));
		return own ? keepPrivate(context, await next()) : next();
	}

	if (!user || user.role !== SUBSCRIBER) return next();

	if (memberMayUse(url.pathname, config?.memberPaths)) return next();

	if (url.pathname.startsWith("/_emdash/admin")) {
		return new Response(null, { status: 302, headers: { location: "/", "cache-control": "private, no-store" } });
	}
	return new Response(JSON.stringify({ error: { code: "FORBIDDEN", message: "Members can't use this API." } }), {
		status: 403,
		headers: { "content-type": "application/json", "cache-control": "private, no-store" },
	});
});
