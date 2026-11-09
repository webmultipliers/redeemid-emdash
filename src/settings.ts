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

export type AccessRecord = SiteAccess | EntryRule;

export interface LoadedAccess {
	site: SiteAccess | null;
	entries: EntryRule[];
}

export const SITE_ID = "site";
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

/** Code config plus the admin's settings, read with `db`. */
export async function withSaved(code: RedeemIDConfig | null, db: unknown): Promise<RedeemIDConfig | null> {
	if (!code) return null;
	try {
		const merged = mergeAccess(code, await loadAccess(stores(db).access));
		announceLevels(merged?.levels);
		return merged;
	} catch (e) {
		// No storage yet (or it can't be read): the code's settings stand.
		console.error("[redeemid] couldn't read saved access settings:", (e as Error).message);
		return code;
	}
}

// ---------------------------------------------------------------- level pickers

type LevelListener = (levels: LevelConfig[]) => void;
const LISTENERS = Symbol.for("redeemid:level-listeners");

/**
 * The editor's level pickers (on the Paywall break and other blocks) are
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
