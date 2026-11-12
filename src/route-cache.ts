/**
 * Astro's route cache, made safe for gated content.
 *
 * The route cache keys pages by URL and serves a stored page without running
 * any code, middleware included. So a page cached for one reader reaches the
 * next one whoever they are: a visitor's copy (wall included) reaches a
 * member, and a page cached while its entry was free keeps showing all of it
 * after a rule locks it. Use these in page frontmatter instead of calling
 * `Astro.cache.set()` yourself:
 *
 *   const { entry: post, cacheHint } = await getEmDashEntry("posts", slug);
 *   await cacheEntry(Astro, "posts", post, cacheHint);
 *
 *   const { entries, cacheHint } = await getEmDashCollection("posts");
 *   cachePage(Astro, cacheHint);
 *
 * cacheEntry caches the page only when it reads the same for everyone: no
 * rule covers the entry, no open window is running out, and the body has no
 * Members only part, single sale, Plan or Preferences block. Otherwise the
 * page stays out of the route cache, even when a layout sets a hint later:
 * redeemidGuard() opts it out again after the page renders.
 *
 * RedeemID's member-aware components (Content for a locked body, Gate, Plan,
 * MemberCard, Preferences, YourData) call noRouteCache() themselves as a
 * safety net, for pages that set hints by hand or sites with route rules.
 *
 * Both tag the page `redeemid`. Saving on the Access page or an entry's
 * Access panel purges that tag, so cached pages follow the new rules.
 *
 * The cache still serves its copy to signed-in members (no code runs on a
 * hit), so keep member-aware chrome on cached pages, such as the header's
 * Account link, in the browser (window.redeemid) or out of cached pages.
 */

import { entryRequirement, entryRuleFor, type AstroLike, type Terms } from "./access.js";
import { ITEM_BLOCK, MEMBERS_BLOCK, PLAN_BLOCK, PREFERENCES_BLOCK } from "./blocks-names.js";
import { siteConfig } from "./site-config.js";

/** The cache tag RedeemID puts on pages it lets into the route cache. */
export const CACHE_TAG = "redeemid";

/** Blocks whose output depends on who reads them. */
export const MEMBER_BLOCKS: readonly string[] = [MEMBERS_BLOCK, ITEM_BLOCK, PLAN_BLOCK, PREFERENCES_BLOCK];

type Hint = { tags?: string[]; maxAge?: number; swr?: number; lastModified?: Date; etag?: string };
interface RouteCache {
	enabled?: boolean;
	set(options: Hint | false): void;
}
type CacheAstro = AstroLike & { cache?: RouteCache };

const KEEP_OUT = Symbol.for("redeemid:keep-out-of-route-cache");

/** Did page code ask to keep this request out of the route cache? (Read by redeemidGuard.) */
export function keptOut(locals: unknown): boolean {
	return Boolean(locals && typeof locals === "object" && (locals as Record<symbol, unknown>)[KEEP_OUT]);
}

/**
 * Keep this page out of the route cache, whatever sets a hint later. Its
 * Cache-Control stays as it was: a visitor's copy is the same for every
 * visitor, and redeemidGuard() already makes signed-in pages private.
 */
export function noRouteCache(astro: CacheAstro): void {
	if (astro.locals && typeof astro.locals === "object") (astro.locals as Record<symbol, unknown>)[KEEP_OUT] = true;
	astro.cache?.set(false);
}

/** Cache a page that shows no gated body (a list, a page RedeemID doesn't touch), tagged so Access saves purge it. */
export function cachePage(astro: CacheAstro, hint?: Hint | null): void {
	if (keptOut(astro.locals) || !astro.cache?.enabled) return;
	astro.cache.set({ ...(hint ?? {}), tags: [...(hint?.tags ?? []), CACHE_TAG] });
}

/** Does a body hold a block that reads differently for members? Looks at every field of the entry's data. */
export function hasMemberBlocks(data: Record<string, unknown> | null | undefined): boolean {
	for (const v of Object.values(data ?? {})) {
		if (Array.isArray(v) && v.some((b) => MEMBER_BLOCKS.includes((b as { _type?: string })?._type ?? ""))) return true;
	}
	return false;
}

/**
 * An entry as EmDash's queries return it. `data` is `object` so the
 * interfaces `emdash types` generates for each collection fit.
 */
export interface CacheableEntry {
	id?: string;
	data?: object | null;
}

/**
 * May this entry's page be stored and served to everyone? Only when it reads
 * the same for every visitor, now and until the cache could expire.
 */
export async function cacheable(
	astro: AstroLike,
	collection: string,
	entry: CacheableEntry | null | undefined,
): Promise<boolean> {
	if (!entry) return false;
	const data = entry.data as Record<string, unknown> | null | undefined;
	const config = await siteConfig(astro.locals);
	if (!config) return !hasMemberBlocks(data);
	if (config.unavailable) return false;
	const terms = data?.terms as Terms | undefined;
	if ((await entryRequirement(config, collection, terms, entry.id)) !== null) return false;
	// Free until a date: a stored copy would outlive the window.
	const own = entryRuleFor(config, collection, entry.id);
	if (own?.openUntil && Date.now() < Date.parse(own.openUntil)) return false;
	return !hasMemberBlocks(data);
}

/**
 * Cache an entry's page with its hint when it reads the same for everyone;
 * otherwise keep it out of the route cache. Returns whether it was cached.
 */
export async function cacheEntry(
	astro: CacheAstro,
	collection: string,
	entry: CacheableEntry | null | undefined,
	hint?: Hint | null,
): Promise<boolean> {
	if (keptOut(astro.locals)) return false;
	if (!(await cacheable(astro, collection, entry))) {
		noRouteCache(astro);
		return false;
	}
	if (!astro.cache?.enabled) return false;
	cachePage(astro, hint);
	return true;
}

// ------------------------------------------------------------------ purging

/** Purge RedeemID's cached pages. Never throws: the save it follows already happened. */
export async function purgeRouteCache(cache: { enabled?: boolean; invalidate?(o: { tags: string[] }): Promise<unknown> } | undefined): Promise<void> {
	if (!cache?.enabled || !cache.invalidate) return;
	try {
		await cache.invalidate({ tags: [CACHE_TAG] });
	} catch (e) {
		console.error("[redeemid] couldn't purge the route cache:", (e as Error).message);
	}
}
