/**
 * Protected files: uploads in a media folder named in `files` are served only
 * to readers the folder's rule lets in, checked on every download. EmDash
 * serves uploads at /_emdash/api/media/file/<storage key>; the guard
 * middleware calls fileAccess() before EmDash answers, refuses readers
 * without access, and marks allowed downloads private so no cache keeps them.
 *
 *   files: [
 *     { folder: "Gold downloads", levels: ["gold"] },
 *     { folder: "Member downloads", levels: [] },            // any signed-in member
 *     { folder: "Supporter extras", features: ["supporter"] },
 *     { folder: "Story files", entries: true },              // whoever can read an entry using it
 *   ]
 *
 * Staff (any EmDash role above Subscriber) can always download. Folder names
 * match case-insensitively. Access still comes only from Shopify tags.
 */

import { readEntry, viewer, type AstroLike, type Terms } from "./access.js";
import { holdsItem, ITEM_BLOCK, PAYWALL_BLOCK, sections, soldItem, splitAtPaywall } from "./blocks-names.js";
import type { FileRule, RedeemIDConfig } from "./config.js";
import { featuresFor } from "./features.js";
import { text } from "./text.js";

export const FILE_PATH = "/_emdash/api/media/file/";
const SUBSCRIBER = 10;

export type FileVerdict = { protected: false } | { protected: true; allowed: true } | { protected: true; allowed: false; reason: "sign_in" | "denied" };

interface MediaRow {
	id: string;
	folder: string | null;
}

/** The media item behind a storage key, with its folder's name. */
async function mediaByKey(db: unknown, key: string): Promise<MediaRow | null> {
	// Kysely, typed loosely: EmDash's schema types aren't exported.
	const k = db as {
		selectFrom(t: string): {
			leftJoin(t: string, a: string, b: string): { select(c: string[]): { where(c: string, op: string, v: string): { executeTakeFirst(): Promise<Record<string, unknown> | undefined> } } };
		};
	};
	const row = await k
		.selectFrom("media")
		.leftJoin("media_folders", "media_folders.id", "media.folder_id")
		.select(["media.id as id", "media_folders.name as folder"])
		.where("media.storage_key", "=", key)
		.executeTakeFirst();
	return row ? { id: String(row.id), folder: (row.folder as string | null) ?? null } : null;
}

/** Published entries that use the media item: collection and id. */
async function entriesUsing(db: unknown, mediaId: string): Promise<Array<{ collection: string; id: string }>> {
	const k = db as {
		selectFrom(t: string): {
			innerJoin(t: string, cb: (j: { onRef(a: string, op: string, b: string): { onRef(a: string, op: string, b: string): unknown } }) => unknown): {
				select(c: string[]): {
					where(c: string, op: string, v: unknown): {
						where(c: string, op: string, v: unknown): { where(c: string, op: string, v: unknown): { limit(n: number): { execute(): Promise<Array<Record<string, unknown>>> } } };
					};
				};
			};
		};
	};
	const rows = await k
		.selectFrom("_emdash_media_usage_sources as s")
		.innerJoin("_emdash_media_usage as u", (j) => j.onRef("u.source_key", "=", "s.source_key").onRef("u.generation", "=", "s.current_generation"))
		.select(["s.collection_slug as collection", "s.content_id as id"])
		.where("u.media_id", "=", mediaId)
		.where("s.content_status", "=", "published")
		.where("s.content_deleted_at", "is", null)
		.limit(50)
		.execute();
	const seen = new Set<string>();
	return rows
		.filter((r) => typeof r.collection === "string" && typeof r.id === "string")
		.map((r) => ({ collection: r.collection as string, id: r.id as string }))
		.filter((e) => !seen.has(`${e.collection}:${e.id}`) && Boolean(seen.add(`${e.collection}:${e.id}`)));
}

/** The levels picked on an entry body's breaks and members-only parts: readers must hold one from each. */
export function bodyClauses(body: unknown): string[][] {
	const blocks = Array.isArray(body) ? body : [];
	const out: string[][] = [];
	const split = splitAtPaywall(blocks);
	if (split.paywall && split.levels.length) out.push(split.levels);
	for (const s of sections(blocks)) if (s.members && s.levels.length) out.push(s.levels);
	return out;
}

/** May this reader read the whole entry: its rule, drip, and every part with levels picked? */
async function readsWhole(astro: AstroLike, entry: { collection: string; id: string }): Promise<boolean> {
	const { getEmDashEntry } = await import("emdash");
	const result = (await getEmDashEntry(entry.collection, entry.id)) as { entry?: { data?: Record<string, unknown> } | null } | null;
	const data = result?.entry?.data;
	if (!data) return false;
	const terms = data.terms as Terms | undefined;
	const body = Object.values(data).find((v) => Array.isArray(v) && v.some((b) => [PAYWALL_BLOCK, "redeemid-members", ITEM_BLOCK].includes((b as { _type?: string })?._type ?? "")));
	const item = soldItem(body);
	if (item) {
		const m = (await viewer(astro)).member;
		if (m && m.status !== "disabled" && holdsItem(item, m.tags)) return true;
	}
	const verdict = await readEntry(astro, { collection: entry.collection, terms, ruleId: entry.id });
	if (!verdict.allowed) return false;
	const clauses = bodyClauses(body);
	return clauses.every((clause) => clause.some((l) => verdict.viewer.levels.includes(l) || (l === "signed-in" && verdict.viewer.signedIn)));
}

export function ruleFor(config: RedeemIDConfig | null, folder: string | null): FileRule | null {
	if (!folder || !config?.files?.length) return null;
	const name = folder.trim().toLowerCase();
	return config.files.find((r) => r.folder.trim().toLowerCase() === name) ?? null;
}

/** Decide one download. `key` is the storage key from the file URL. */
export async function fileAccess(astro: AstroLike, config: RedeemIDConfig | null, key: string): Promise<FileVerdict> {
	if (!config?.files?.length && !config?.unavailable) return { protected: false };
	const locals = astro.locals as { user?: { role?: number } | null; emdash?: { db?: unknown } | null };
	const db = locals.emdash?.db;
	// No database to look the file up in: the caller fails closed.
	if (!db) throw new Error("no database for the file check");
	const media = await mediaByKey(db, key);
	const role = locals.user?.role ?? 0;
	// Saved settings can't be read: any file in a folder might be protected.
	if (config.unavailable) {
		if (!media?.folder) return { protected: false };
		if (role > SUBSCRIBER) return { protected: true, allowed: true };
		return { protected: true, allowed: false, reason: (await viewer(astro)).signedIn ? "denied" : "sign_in" };
	}
	const rule = ruleFor(config, media?.folder ?? null);
	if (!media || !rule) return { protected: false };

	if (role > SUBSCRIBER) return { protected: true, allowed: true };
	const v = await viewer(astro);
	if (!v.signedIn) return { protected: true, allowed: false, reason: "sign_in" };
	const m = v.member;
	if (!m || m.status === "disabled") return { protected: true, allowed: false, reason: "denied" };

	if (rule.levels && (rule.levels.length === 0 ? true : rule.levels.some((l) => v.levels.includes(l) || l === "signed-in"))) {
		return { protected: true, allowed: true };
	}
	if (rule.features?.length && featuresFor(m, config.features, config.levels).some((f) => rule.features?.includes(f))) {
		return { protected: true, allowed: true };
	}
	if (rule.entries) {
		for (const e of await entriesUsing(db, media.id)) {
			if (await readsWhole(astro, e)) return { protected: true, allowed: true };
		}
	}
	return { protected: true, allowed: false, reason: "denied" };
}

/**
 * Every storage key a file URL path could name: the key after each layer of
 * percent-decoding, because storage backends differ in whether they decode
 * keys. The guard checks all of them, so an encoded key can't slip past.
 */
export function keysFromPath(pathname: string): string[] | null {
	if (!pathname.startsWith(FILE_PATH)) return null;
	let candidate = pathname.slice(FILE_PATH.length);
	if (!candidate) return null;
	const out: string[] = [];
	for (let layer = 0; layer < 4; layer++) {
		let decoded: string;
		try {
			decoded = decodeURIComponent(candidate);
		} catch {
			break;
		}
		out.push(decoded);
		// The file route drops slashes around the key, so the check does too.
		const trimmed = decoded.replace(/^\/+|\/+$/g, "");
		if (trimmed && trimmed !== decoded) out.push(trimmed);
		if (decoded === candidate) break;
		candidate = decoded;
	}
	return [...new Set(out)];
}

/** Astro's image endpoint, which reads the file its `href` names and answers with it. */
export const IMAGE_PATH = "/_image";

/**
 * The storage keys a request could reach: a file URL's own, or those of the
 * file an image-endpoint request asks for by `href`. Null when it names none.
 */
export function keysFromUrl(url: URL): string[] | null {
	const direct = keysFromPath(url.pathname);
	if (direct) return direct;
	if (url.pathname.replace(/\/+$/, "") !== IMAGE_PATH) return null;
	const out: string[] = [];
	for (const href of url.searchParams.getAll("href")) {
		let candidate = href;
		for (let layer = 0; layer < 4; layer++) {
			try {
				const keys = keysFromPath(new URL(candidate, url.origin).pathname);
				if (keys) out.push(...keys);
			} catch {
				// Not a URL: nothing to check.
			}
			let decoded: string;
			try {
				decoded = decodeURIComponent(candidate);
			} catch {
				break;
			}
			if (decoded === candidate) break;
			candidate = decoded;
		}
	}
	return out.length ? [...new Set(out)] : null;
}

/** Decide a download that may name several keys: the first protected one decides. */
export async function pathAccess(astro: AstroLike, config: RedeemIDConfig | null, keys: string[]): Promise<FileVerdict> {
	for (const key of keys) {
		const v = await fileAccess(astro, config, key);
		if (v.protected) return v;
	}
	return { protected: false };
}

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The page a refused download gets. */
export function refusal(reason: "sign_in" | "denied", signIn: string, config: RedeemIDConfig | null = null): Response {
	const status = reason === "sign_in" ? 401 : 403;
	const t = (s: string) => escapeHtml(text(config, s));
	const body =
		reason === "sign_in"
			? `<p>${t("Sign in to download this file.")}</p><p><a href="${escapeHtml(signIn)}">${t("Sign in")}</a></p>`
			: `<p>${t("Your membership doesn't include this file.")}</p>`;
	return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>${t("File not available")}</title></head><body><main>${body}</main></body></html>`, {
		status,
		headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store", "x-robots-tag": "noindex" },
	});
}
