/**
 * EmDash's site search (/_emdash/api/search) is public. It matches the
 * collection's searchable fields, entry bodies included, and answers with a
 * snippet of the text around the match. Without this, anyone could search for
 * a word from a locked entry and read the text around it, or learn which
 * locked entries contain it.
 *
 * For visitors and members (never staff), each result is checked like a
 * protected file's entry: the reader must be able to read the whole entry
 * (its rule, drip, and every part with levels picked). A result they can't
 * read keeps its title, which lists show anyway, but loses its snippet, and
 * it stays in the results only when its title matches every searched word.
 */

import type { AstroLike } from "./access.js";

/** Loaded when used: the access checks read the site's build-time config. */
async function readsWhole(astro: AstroLike, entry: { collection: string; id: string }): Promise<boolean> {
	return (await import("./files.js")).readsWhole(astro, entry);
}

export const SEARCH_PATH = "/_emdash/api/search";
/** Title suggestions only: nothing from bodies. */
export const SUGGEST_PATH = "/_emdash/api/search/suggest";
const SUBSCRIBER = 10;

interface Result {
	collection?: unknown;
	id?: unknown;
	title?: unknown;
	snippet?: unknown;
}

/** The searched words, lowercased. */
export function words(q: string): string[] {
	return q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Does the title hold every searched word (as a word or the start of one)? */
export function titleMatches(title: unknown, q: string): boolean {
	if (typeof title !== "string") return false;
	const have = words(title);
	const want = words(q);
	return want.length > 0 && want.every((w) => have.some((h) => h.startsWith(w)));
}

/**
 * Filter one search answer for this reader. `readable` decides one result;
 * a failed check counts as unreadable.
 */
export async function filterResults(
	items: Result[],
	q: string,
	readable: (collection: string, id: string) => Promise<boolean>,
): Promise<Result[]> {
	const out: Result[] = [];
	for (const item of items) {
		const collection = typeof item.collection === "string" ? item.collection : "";
		const id = typeof item.id === "string" ? item.id : "";
		const ok = collection && id ? await readable(collection, id).catch(() => false) : false;
		if (ok) {
			out.push(item);
			continue;
		}
		if (!titleMatches(item.title, q)) continue;
		const { snippet: _gone, ...rest } = item;
		out.push(rest);
	}
	return out;
}

/**
 * For a site's own search page that calls EmDash's `search()` in its
 * template: the results this reader may see, filtered like the API's.
 *
 *   const results = await readableResults(Astro, q, (await search(q)).items);
 */
export async function readableResults<T extends Result>(astro: AstroLike, q: string, items: T[]): Promise<T[]> {
	const role = (astro.locals as { user?: { role?: number } | null }).user?.role ?? 0;
	if (role > SUBSCRIBER) return items;
	return (await filterResults(items, q, (collection, id) => readsWhole(astro, { collection, id }))) as T[];
}

/** The search answer with locked text taken out (see above). Other answers pass as they are. */
export async function guardSearch(astro: AstroLike, url: URL, res: Response): Promise<Response> {
	if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return res;
	let body: { data?: { items?: Result[] } };
	try {
		body = (await res.clone().json()) as typeof body;
	} catch {
		return res;
	}
	const items = body.data?.items;
	if (!Array.isArray(items)) return res;
	const q = url.searchParams.get("q") ?? "";
	const filtered = await filterResults(items, q, (collection, id) => readsWhole(astro, { collection, id }));
	const out = new Response(JSON.stringify({ ...body, data: { ...body.data, items: filtered } }), { status: res.status, headers: res.headers });
	out.headers.delete("content-length");
	return out;
}
