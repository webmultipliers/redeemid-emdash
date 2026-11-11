/**
 * Access settings made in the admin.
 *
 * Levels, rules, the meter, protected folders and the rest can be set in
 * astro.config.mjs (the defaults) and changed in the admin (Plugins →
 * RedeemID → Access). A setting saved in the admin replaces the code's value
 * for that setting; "Use the code's value" removes it again. Each entry can
 * also carry its own rule, set in the editor's Access panel.
 *
 * Saved in the auth-provider storage collection `access`: record `site` for
 * the site settings and `entry:<id>` for each entry's own rule. Nothing here
 * grants access to anyone: levels still come only from Shopify tags.
 */

import type { FeatureConfig, FileRule, LevelConfig, MeterConfig, RedeemIDConfig, RuleConfig } from "./config.js";
import type { StorageCollection } from "emdash";

import { stores } from "./storage.js";

/** The settings the admin can manage, by config key. */
export const MANAGED = ["levels", "rules", "meter", "files", "features", "combine", "teaser", "join"] as const;
export type ManagedKey = (typeof MANAGED)[number];

/** What the admin saved. A key that's present replaces the code's value (null turns it off). */
export interface SiteAccess {
	kind: "site";
	levels?: LevelConfig[];
	rules?: RuleConfig[];
	meter?: MeterConfig | null;
	files?: FileRule[];
	features?: FeatureConfig[];
	combine?: "all" | "any";
	teaser?: Record<string, number>;
	join?: { href: string; label?: string } | null;
	updatedAt?: string;
}

/**
 * One entry's own rule, set in the editor:
 *
 * - inherit: the site's rules decide (the default).
 * - open: free to everyone.
 * - levels: only the levels picked (none picked means any signed-in member).
 * - add: the site's rules, and also one of the levels picked.
 *
 * `lockedUntil` opens the entry to everyone from that time; `openUntil` keeps
 * it free to everyone until that time. `drip` and `meter: false` work as on
 * a rule.
 */
export interface EntryRule {
	kind: "entry";
	collection: string;
	/** EmDash's id for the entry. */
	entryId: string;
	/** Its slug when last saved, so page code can pass either. */
	slug?: string | null;
	mode: "inherit" | "open" | "levels" | "add";
	levels: string[];
	drip?: number;
	meter?: false;
	lockedUntil?: string | null;
	openUntil?: string | null;
	updatedAt?: string;
}

/**
 * Bumped on every write to the collection, so a request can tell with one
 * small read whether the settings it holds are still current.
 */
export interface AccessStamp {
	kind: "stamp";
	version: string;
}

export type AccessRecord = SiteAccess | EntryRule | AccessStamp;

export interface LoadedAccess {
	site: SiteAccess | null;
	entries: EntryRule[];
}

export const SITE_ID = "site";
export const STAMP_ID = "stamp";
export const entryKey = (entryId: string) => `entry:${entryId}`;

/** Read everything saved, in one query. */
export async function loadAccess(store: StorageCollection<AccessRecord>): Promise<LoadedAccess> {
	const out: LoadedAccess = { site: null, entries: [] };
	let cursor: string | undefined;
	let pages = 0;
	do {
		const page = await store.query({ limit: 1000, cursor });
		for (const r of page.items) {
			if (r.data?.kind === "site") out.site = r.data;
			else if (r.data?.kind === "entry") out.entries.push(r.data);
		}
		cursor = page.cursor;
	} while (cursor && ++pages < 10);
	return out;
}

/** The code's config with the admin's settings and entry rules laid over it. */
export function mergeAccess(code: RedeemIDConfig | null, saved: LoadedAccess | null): RedeemIDConfig | null {
	if (!code) return null;
	if (!saved) return code;
	const out: Record<string, unknown> = { ...code };
	const site = saved.site as Record<string, unknown> | null;
	if (site) {
		for (const key of MANAGED) {
			if (!(key in site)) continue;
			const value = site[key];
			if (value === null || value === undefined) delete out[key];
			else out[key] = value;
		}
	}
	const entries: Record<string, EntryRule> = {};
	for (const e of saved.entries) {
		if (e.mode === "inherit" && !e.drip && e.meter !== false && !e.lockedUntil && !e.openUntil) continue;
		entries[`${e.collection}:${e.entryId}`] = e;
		if (e.slug) entries[`${e.collection}:${e.slug}`] ??= e;
	}
	out.entries = { ...(code.entries ?? {}), ...entries };
	return out as RedeemIDConfig;
}

/** Which settings the admin has taken over from the code. */
export function overridden(site: SiteAccess | null): Set<ManagedKey> {
	return new Set(MANAGED.filter((k) => site && k in site));
}

/**
 * A level slug no level can have (slugs can't hold a colon), so nobody
 * passes a requirement that names it: what every entry needs while the
 * saved settings can't be read.
 */
export const UNAVAILABLE = "redeemid:unavailable";

/**
 * The settings while the saved ones can't be read and none were read before:
 * every entry locked (see UNAVAILABLE), no meter to open one, and files in
 * any folder refused. Failing open would show what the admin locked.
 */
export function lockdown(code: RedeemIDConfig): RedeemIDConfig {
	const out: RedeemIDConfig = { ...code, unavailable: true };
	delete out.meter;
	return out;
}

/** What this server last read, and the stamp it was read at. */
interface Held {
	version: string | null;
	saved: LoadedAccess;
}
const HELD = Symbol.for("redeemid:access-held");
const held = () => globalThis as unknown as Record<symbol, Held | undefined>;

/** Forget the settings held in memory (tests, and after a write here). */
export function forgetAccess(): void {
	held()[HELD] = undefined;
}

const WRITES = Symbol.for("redeemid:access-writes");

/** How many times this server has saved access settings. redeemidGuard() purges the route cache when a request moves it. */
export function accessWrites(): number {
	return (globalThis as unknown as Record<symbol, number | undefined>)[WRITES] ?? 0;
}

/** Record that the settings changed, so every server reads them again. */
export async function touchAccess(store: StorageCollection<AccessRecord>): Promise<void> {
	forgetAccess();
	const g = globalThis as unknown as Record<symbol, number | undefined>;
	g[WRITES] = (g[WRITES] ?? 0) + 1;
	await store.put(STAMP_ID, { kind: "stamp", version: crypto.randomUUID() });
}

/** Save one record and bump the stamp. */
export async function putAccess(store: StorageCollection<AccessRecord>, id: string, data: SiteAccess | EntryRule): Promise<void> {
	await store.put(id, data);
	await touchAccess(store);
}

/** Delete one record and bump the stamp. */
export async function deleteAccess(store: StorageCollection<AccessRecord>, id: string): Promise<void> {
	await store.delete(id);
	await touchAccess(store);
}

/**
 * The saved settings, read again only when the stamp has moved: one small
 * read per request instead of the whole collection.
 */
async function savedAccess(store: StorageCollection<AccessRecord>): Promise<LoadedAccess> {
	const stamp = (await store.get(STAMP_ID)) as AccessStamp | null;
	const version = stamp?.kind === "stamp" ? stamp.version : null;
	const known = held()[HELD];
	if (known && version !== null && known.version === version) return known.saved;
	const saved = await loadAccess(store);
	if (version === null) {
		// Saved before stamps existed: start one, so the next request can skip the read.
		const fresh = crypto.randomUUID();
		await store.put(STAMP_ID, { kind: "stamp", version: fresh }).catch(() => undefined);
		held()[HELD] = { version: fresh, saved };
	} else {
		held()[HELD] = { version, saved };
	}
	return saved;
}

/**
 * Code config plus the admin's settings, read with `db`. When storage can't
 * be read, the settings last read stand; with none, every entry is locked
 * (see lockdown). Never the code's settings alone: a rule saved only in the
 * admin would open its entries for as long as the error lasts.
 */
export async function withSaved(code: RedeemIDConfig | null, db: unknown): Promise<RedeemIDConfig | null> {
	if (!code) return null;
	let saved: LoadedAccess;
	try {
		saved = await savedAccess(stores(db).access);
	} catch (e) {
		const last = held()[HELD];
		console.error("[redeemid] couldn't read saved access settings:", (e as Error).message, last ? "(using the last ones read)" : "(locking entries)");
		if (!last) return lockdown(code);
		saved = last.saved;
	}
	const merged = mergeAccess(code, saved);
	announceLevels(merged?.levels);
	return merged;
}

// ---------------------------------------------------------------- level pickers

type LevelListener = (levels: LevelConfig[]) => void;
const LISTENERS = Symbol.for("redeemid:level-listeners");

/**
 * The editor's level pickers (on the Members only block and others) are
 * declared when the plugin starts. The plugin registers a listener here so
 * they follow levels saved in the admin.
 */
export function onLevels(listener: LevelListener): void {
	const g = globalThis as unknown as Record<symbol, LevelListener[]>;
	(g[LISTENERS] ??= []).push(listener);
}

export function announceLevels(levels: LevelConfig[] = []): void {
	const g = globalThis as unknown as Record<symbol, LevelListener[] | undefined>;
	for (const l of g[LISTENERS] ?? []) {
		try {
			l(levels);
		} catch {
			// A listener's failure never breaks a page.
		}
	}
}

// ---------------------------------------------------------------- checks

const SLUG = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** A slug from a name: "Gold members" → "gold-members". */
export function slugify(raw: string): string {
	return raw
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 63);
}

export function validSlug(slug: string): boolean {
	return SLUG.test(slug) && slug !== "signed-in";
}

/** Comma- or line-separated text to a trimmed, unique list. */
export function list(raw: unknown): string[] {
	const parts = Array.isArray(raw) ? raw : String(raw ?? "").split(/[,\n]/);
	const out: string[] = [];
	for (const p of parts) {
		const t = String(p).trim();
		if (t && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
	}
	return out;
}

/** A whole number of days, 0 to 3650. */
export function days(raw: unknown): number {
	const n = Math.floor(Number(raw));
	return Number.isFinite(n) && n > 0 ? Math.min(n, 3650) : 0;
}
