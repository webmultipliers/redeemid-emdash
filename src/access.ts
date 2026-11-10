/**
 * Who may read what, for page code.
 *
 * EmDash has no content filter hook, so templates ask before they render:
 *
 *   const access = await canRead(Astro, { collection: "posts", terms: post.data.terms });
 *
 * or wrap the body in <Gate>. The answer comes from the member's mirrored
 * Shopify tags only. The EmDash "Subscriber" role means "signed in", never
 * "entitled".
 */

import type { LevelConfig, RedeemIDConfig, RuleConfig } from "./config.js";
import { UNAVAILABLE, type EntryRule } from "./settings.js";
import { siteConfig } from "./site-config.js";
import { memberForUser, stores, type MemberRecord } from "./storage.js";

/** The parts of Astro's global that access checks read. */
export interface AstroLike {
	locals: unknown;
	response?: { headers: Headers };
}

interface Locals {
	user?: { id: string; disabled?: boolean | number } | null;
	emdash?: { db?: unknown; config?: unknown } | null;
}

export interface Viewer {
	signedIn: boolean;
	member: MemberRecord | null;
	/** Level slugs held right now. Empty when the Shopify account is disabled. */
	levels: string[];
}

export type Reason = "open" | "allowed" | "sign_in" | "upgrade" | "disabled" | "unconfigured" | "drip" | "metered";

/**
 * What an entry needs, in conjunctive form: every clause must pass, and a
 * clause passes when the reader holds any of its levels. An empty clause means
 * any signed-in member. `null` means the entry is open to everyone.
 */
export type Requirement = string[][] | null;

/**
 * The built-in level every signed-in member holds. A clause
 * with it passes for any signed-in member, like an empty clause.
 */
export const SIGNED_IN = "signed-in";

export interface Verdict {
	allowed: boolean;
	reason: Reason;
	/** What the entry needs (see Requirement). `[]` when it is open. */
	required: string[][];
	viewer: Viewer;
	/** For "drip": when the entry opens for this member. */
	opensAt?: Date;
	/** For "metered", and for a locked "upgrade" when a meter runs: free entries left this period. */
	meterLeft?: number;
	/** The meter's size and period, when one ran. */
	meter?: { limit: number; period: "month" | "week" };
}

/** A term as EmDash hydrates it onto an entry, or just its slug. */
export type TermRef = { slug: string; id?: string; parentId?: string | null } | string;
export type Terms = Record<string, TermRef[] | undefined>;

/** Parent slug by term slug, per taxonomy, for walking up a hierarchy. */
export type TermTree = Record<string, Record<string, string | null>>;

export function levelsFor(tags: string[], levels: LevelConfig[] = []): string[] {
	const held = new Set(tags.map((t) => t.toLowerCase()));
	return levels
		.filter((l) => {
			if (l.tags.length === 0) return false;
			const has = (t: string) => held.has(t.toLowerCase());
			return l.match === "all" ? l.tags.every(has) : l.tags.some(has);
		})
		.map((l) => l.slug);
}

const slugOf = (t: TermRef) => (typeof t === "string" ? t : t.slug);

/**
 * The clauses, simplified: duplicates go, a clause that contains another
 * clause goes (needing Pro already passes "Member or Pro"), and an empty
 * clause goes when a level clause is there (any level implies signed in).
 */
function reduce(clauses: string[][]): string[][] {
	const seen = new Set<string>();
	const out: string[][] = [];
	for (const c of clauses) {
		const sorted = c.includes(SIGNED_IN) ? [] : [...new Set(c)].sort();
		const key = sorted.join("|");
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(sorted);
	}
	const levelled = out.filter((c) => c.length > 0);
	if (levelled.length === 0) return out;
	return levelled.filter((c) => !levelled.some((o) => o !== c && o.length < c.length && o.every((l) => c.includes(l))));
}

function combined(rules: RuleConfig[], mode: "all" | "any"): string[][] {
	if (mode === "any") {
		return rules.some((r) => r.levels.length === 0) ? [[]] : [[...new Set(rules.flatMap((r) => r.levels))]];
	}
	return reduce(rules.map((r) => r.levels));
}

/** Rules that can cover `collection`: its own, and term rules for every collection ("*"). */
function rulesFor(rules: RuleConfig[], collection: string): RuleConfig[] {
	return rules.filter((r) => r.collection === collection || (r.collection === "*" && r.taxonomy && r.term));
}

/** The rules that decide an entry: matching term rules, else the collection's, else the site default. */
function deciding(rules: RuleConfig[], collection: string, terms: Terms, tree?: TermTree): RuleConfig[] | "open" {
	const forCollection = rulesFor(rules, collection);
	const matched: RuleConfig[] = [];
	for (const [taxonomy, list] of Object.entries(terms)) {
		const taxRules = forCollection.filter((r) => r.taxonomy === taxonomy && r.term);
		if (taxRules.length === 0) continue;
		const parents = tree?.[taxonomy] ?? {};
		for (const ref of list ?? []) {
			let slug: string | null = slugOf(ref);
			const seen = new Set<string>();
			while (slug && !seen.has(slug)) {
				seen.add(slug);
				const own = taxRules.filter((r) => r.term === slug);
				if (own.length > 0) {
					// A rule for this collection beats one for every collection.
					const specific = own.filter((r) => r.collection === collection);
					matched.push(...(specific.length ? specific : own));
					break;
				}
				slug = parents[slug] ?? null;
			}
		}
	}
	if (matched.some((r) => r.open)) return "open";
	if (matched.length > 0) return matched;
	const whole = forCollection.filter((r) => r.collection === collection && !r.taxonomy && !r.term);
	if (whole.some((r) => r.open)) return "open";
	if (whole.length > 0) return whole;
	const site = rules.filter((r) => r.collection === "*" && !r.taxonomy && !r.term);
	if (site.some((r) => r.open)) return "open";
	return site;
}

/** Where the site's rules for an entry come from, in words, for the editor. */
export function ruleSource(rules: RuleConfig[] = [], collection: string, terms: Terms = {}, tree?: TermTree): string {
	const found = deciding(rules, collection, terms, tree);
	const termRules = (list: RuleConfig[]) => [...new Set(list.map((r) => `${r.taxonomy}: ${r.term}`))].join(", ");
	if (found === "open") {
		const opener = rulesFor(rules, collection).filter((r) => r.open && r.taxonomy);
		const hit = opener.filter((r) => (terms[r.taxonomy!] ?? []).some((t) => slugOf(t) === r.term));
		if (hit.length) return `A term that makes it free (${termRules(hit)})`;
		return rules.some((r) => r.collection === collection && r.open && !r.taxonomy) ? `The rule for ${collection} (free)` : "The site default (free)";
	}
	if (found.length === 0) return "No rule covers it";
	if (found[0]!.taxonomy) return `Terms: ${termRules(found)}`;
	if (found[0]!.collection === collection) return `The rule for ${collection}`;
	return "The site default";
}

/** The entry's own rule (set in the editor), by id or slug. */
export function entryRuleFor(config: RedeemIDConfig | null, collection: string, id?: string | null): EntryRule | null {
	if (!config?.entries || !id) return null;
	return config.entries[`${collection}:${id}`] ?? null;
}

/**
 * The site's requirement with the entry's own rule applied (see EntryRule).
 * `now` decides the date windows.
 */
export function applyEntryRule(site: Requirement, own: EntryRule | null, now = Date.now()): Requirement {
	if (!own) return site;
	if (own.openUntil && now < Date.parse(own.openUntil)) return null;
	if (own.lockedUntil && now >= Date.parse(own.lockedUntil)) return null;
	switch (own.mode) {
		case "open":
			return null;
		case "levels":
			return [own.levels];
		case "add":
			return reduce([...(site ?? []), own.levels]);
		default:
			return site;
	}
}

/**
 * What an entry needs (see Requirement), from the site's rules.
 *
 * Each term the entry carries is walked up its taxonomy (with `tree`) to the
 * nearest term that has a rule, so a child term takes its parent's rule unless
 * it has its own. Any matching `open` rule opens the entry.
 */
export function requirement(
	rules: RuleConfig[] = [],
	collection: string,
	terms: Terms = {},
	options: { combine?: "all" | "any"; tree?: TermTree } = {},
): Requirement {
	const found = deciding(rules, collection, terms, options.tree);
	if (found === "open" || found.length === 0) return null;
	return combined(found, options.combine ?? "all");
}

/** Days of membership the entry's deciding rules ask for (the largest drip), or 0. */
export function dripDays(rules: RuleConfig[] = [], collection: string, terms: Terms = {}, tree?: TermTree, own?: EntryRule | null): number {
	if (own && typeof own.drip === "number" && own.drip > 0) return own.drip;
	if (own?.mode === "open" || own?.mode === "levels") return 0;
	const found = deciding(rules, collection, terms, tree);
	if (found === "open") return 0;
	return Math.max(0, ...found.map((r) => (typeof r.drip === "number" && r.drip > 0 ? r.drip : 0)));
}

/** May the meter open the entry? Not when a deciding rule says `meter: false`. */
export function meterable(rules: RuleConfig[] = [], collection: string, terms: Terms = {}, tree?: TermTree, own?: EntryRule | null): boolean {
	if (own?.meter === false) return false;
	if (own?.mode === "levels") return true;
	const found = deciding(rules, collection, terms, tree);
	return found === "open" || !found.some((r) => r.meter === false);
}

/**
 * When a member's membership started, for drip: the earliest start among the
 * levels they hold now (a level starts when its last needed tag arrived),
 * else when they first signed in. Null when neither is known.
 */
export function memberSince(member: MemberRecord, levels: LevelConfig[] = []): string | null {
	const since = member.tagsSince ?? {};
	const starts: string[] = [];
	for (const slug of levelsFor(member.tags, levels)) {
		const level = levels.find((l) => l.slug === slug);
		const dates = (level?.tags ?? []).map((t) => since[t.toLowerCase()]).filter((d): d is string => Boolean(d)).sort();
		if (dates.length === 0) continue;
		const pick = level?.match === "all" ? dates[dates.length - 1] : dates[0];
		if (pick) starts.push(pick);
	}
	starts.sort();
	return starts[0] ?? member.linkedAt ?? null;
}

export interface HeldLevel {
	slug: string;
	name: string;
	/** When the level started (see memberSince), ISO, or null when unknown. */
	since: string | null;
}

export interface PastLevel {
	slug: string;
	name: string;
	from: string | null;
	to: string;
}

/**
 * The member's levels now (with when each started) and the levels they held
 * before (from the tags Shopify has since removed), newest first.
 */
export function membership(member: MemberRecord, levels: LevelConfig[] = []): { current: HeldLevel[]; past: PastLevel[] } {
	const held = levelsFor(member.tags, levels);
	const current = held.map((slug) => {
		const level = levels.find((l) => l.slug === slug)!;
		return { slug, name: level.name, since: memberSince({ ...member, linkedAt: null }, [level]) };
	});
	const pastTags = member.pastTags ?? [];
	const past: PastLevel[] = [];
	for (const level of levels) {
		if (held.includes(level.slug)) continue;
		const wanted = new Set(level.tags.map((t) => t.toLowerCase()));
		const spans = pastTags.filter((p) => wanted.has(p.tag));
		if (spans.length === 0) continue;
		const froms = spans.map((p) => p.from).filter((d): d is string => Boolean(d)).sort();
		const to = spans.map((p) => p.to).sort().at(-1)!;
		past.push({ slug: level.slug, name: level.name, from: froms[0] ?? null, to });
	}
	past.sort((a, b) => (a.to < b.to ? 1 : a.to > b.to ? -1 : 0));
	return { current, past };
}

/** How much of this period's meter the signed-in reader has used, or null when no meter runs. */
export async function meterUsage(astro: AstroLike): Promise<{ used: number; limit: number; period: "month" | "week" } | null> {
	const locals = astro.locals as Locals;
	const meter = (await siteConfig(locals))?.meter;
	const user = locals.user;
	const db = locals.emdash?.db;
	if (!meter || !(meter.limit > 0) || !user?.id || !db) return null;
	const period = meter.period ?? "month";
	try {
		const record = await stores(db).meter.get(`${user.id}:${periodKey(new Date(), period)}`);
		return { used: Math.min(record?.items.length ?? 0, meter.limit), limit: meter.limit, period };
	} catch {
		return null;
	}
}

/** When drip opens an entry for this member: `since` plus `days`. */
export function dripOpensAt(since: string | null, days: number): Date | null {
	if (!since || days <= 0) return null;
	const t = Date.parse(since);
	return Number.isNaN(t) ? null : new Date(t + days * 86_400_000);
}

/** The meter period an instant falls in: "2026-11", or ISO week "2026-W45". UTC. */
export function periodKey(at: Date, period: "month" | "week" = "month"): string {
	if (period === "month") return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
	const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
	const day = d.getUTCDay() || 7;
	d.setUTCDate(d.getUTCDate() + 4 - day);
	const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
	const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
	return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Count `id` against a meter: an item already counted stays free; a new one needs room. Pure. */
export function consume(items: string[], id: string, limit: number): { allowed: boolean; items: string[]; left: number } {
	if (items.includes(id)) return { allowed: true, items, left: Math.max(0, limit - items.length) };
	if (items.length >= limit) return { allowed: false, items, left: 0 };
	const next = [...items, id];
	return { allowed: true, items: next, left: limit - next.length };
}

/** Does someone holding `held` pass `required`? Signed-in membership is checked by the caller. */
export function passes(held: string[], required: string[][]): boolean {
	return required.every((clause) => clause.length === 0 || clause.includes(SIGNED_IN) || clause.some((l) => held.includes(l)));
}

/**
 * The requirement in words, for badges and admin pages: "Gold + Silver",
 * "Silver or Gold", "Signed in". `null` gives `open`.
 */
export function describe(required: Requirement, levels: LevelConfig[] = [], open = "Free", signedIn = "Signed in"): string {
	if (required === null) return open;
	const name = (slug: string) => (slug === UNAVAILABLE ? "Members" : (levels.find((l) => l.slug === slug)?.name ?? slug));
	const parts = reduce(required).filter((c) => c.length > 0).map((c) => c.map(name).join(" or "));
	return parts.length ? parts.join(" + ") : signedIn;
}

/**
 * Parent slugs for the taxonomies whose rules could cover an entry through a
 * parent term. Reads EmDash's term lists (cached by EmDash) only when a term
 * on the entry has no rule of its own.
 */
export async function termTree(rules: RuleConfig[] = [], collection: string, terms: Terms = {}): Promise<TermTree> {
	const tree: TermTree = {};
	const forCollection = rulesFor(rules, collection).filter((r) => r.taxonomy && r.term);
	const wanted = Object.entries(terms).filter(([taxonomy, list]) => {
		const own = new Set(forCollection.filter((r) => r.taxonomy === taxonomy).map((r) => r.term));
		return own.size > 0 && (list ?? []).some((t) => !own.has(slugOf(t)));
	});
	if (wanted.length === 0) return tree;
	try {
		const { getTaxonomyTerms } = await import("emdash");
		for (const [taxonomy] of wanted) {
			type Node = { id: string; slug: string; parentId?: string | null; children?: Node[] };
			const flat: Node[] = [];
			const walk = (list: Node[]) => list.forEach((n) => (flat.push(n), walk(n.children ?? [])));
			walk((await getTaxonomyTerms(taxonomy)) as Node[]);
			const byId = new Map(flat.map((n) => [n.id, n.slug]));
			const byGroup = new Map(flat.map((n) => [(n as { translationGroup?: string | null }).translationGroup ?? n.id, n.slug]));
			tree[taxonomy] = Object.fromEntries(
				flat.map((n) => [n.slug, n.parentId ? (byId.get(n.parentId) ?? byGroup.get(n.parentId) ?? null) : null]),
			);
		}
	} catch {
		// No term lists (outside an EmDash request): only direct term rules apply.
	}
	return tree;
}

/**
 * The entry's requirement with the site's config, walking term parents. With
 * `id` (EmDash's id or the slug), the entry's own rule from the editor applies.
 */
export async function entryRequirement(
	config: RedeemIDConfig | null,
	collection: string,
	terms: Terms = {},
	id?: string | null,
): Promise<Requirement> {
	if (!config) return null;
	// Saved settings can't be read: nobody passes this.
	if (config.unavailable) return [[UNAVAILABLE]];
	const own = entryRuleFor(config, collection, id);
	if (own && (own.mode === "open" || own.mode === "levels") && !own.openUntil && !own.lockedUntil) return applyEntryRule(null, own);
	const tree = await termTree(config.rules, collection, terms);
	return applyEntryRule(requirement(config.rules, collection, terms, { combine: config.combine, tree }), own);
}

const viewers = new WeakMap<object, Promise<Viewer>>();

/** The visitor, read once per request (badges on a list page all ask). */
export async function viewer(astro: AstroLike): Promise<Viewer> {
	const key = astro.locals as object;
	if (key && typeof key === "object") {
		const known = viewers.get(key);
		if (known) {
			const v = await known;
			if (v.signedIn) astro.response?.headers.set("Cache-Control", "private, no-store");
			return v;
		}
		const fresh = readViewer(astro);
		viewers.set(key, fresh);
		return fresh;
	}
	return readViewer(astro);
}

async function readViewer(astro: AstroLike): Promise<Viewer> {
	const locals = astro.locals as Locals;
	const user = locals.user;
	if (!user?.id || user.disabled) return { signedIn: false, member: null, levels: [] };

	// Member-specific output must never be shared by a cache.
	astro.response?.headers.set("Cache-Control", "private, no-store");

	const config = await siteConfig(locals);
	const db = locals.emdash?.db;
	if (!config || !db) return { signedIn: true, member: null, levels: [] };

	const member = await memberForUser(stores(db), user.id);
	const levels = member && member.status !== "disabled" ? levelsFor(member.tags, config.levels) : [];
	return { signedIn: true, member, levels };
}

/**
 * May this visitor read the entry? `override` replaces the entry's rule, for a
 * part of a page locked to its own levels (a paywall break with levels).
 */
export async function canRead(
	astro: AstroLike,
	entry: { collection: string; terms?: Terms; id?: string; ruleId?: string },
	override?: { levels: string[] } | { required: string[][] },
): Promise<Verdict> {
	const locals = astro.locals as Locals;
	const config: RedeemIDConfig | null = await siteConfig(locals);
	const required: Requirement = override
		? "required" in override
			? override.required
			: [override.levels]
		: await entryRequirement(config, entry.collection, entry.terms, entry.ruleId ?? entry.id);
	const v = await viewer(astro);

	if (required === null) return { allowed: true, reason: "open", required: [], viewer: v };
	if (!config || config.unavailable) return { allowed: false, reason: "unconfigured", required, viewer: v };
	if (!v.signedIn) return { allowed: false, reason: "sign_in", required, viewer: v };
	if (v.member?.status === "disabled") return { allowed: false, reason: "disabled", required, viewer: v };
	if (!v.member) return { allowed: false, reason: "upgrade", required, viewer: v };
	const ok = passes(v.levels, required);
	return { allowed: ok, reason: ok ? "allowed" : "upgrade", required, viewer: v };
}

/** Same-site path to return to after sign-in, or "/". */
export function safeReturn(raw: string | null | undefined): string {
	if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
	return raw;
}

export function signInUrl(returnTo: string): string {
	return `/_emdash/api/auth/redeemid/login?return=${encodeURIComponent(safeReturn(returnTo))}`;
}

/** Where the Cart link goes: the visitor's Shopify checkout. */
export function cartUrl(returnTo = "/"): string {
	return `/_emdash/api/auth/redeemid/cart?return=${encodeURIComponent(safeReturn(returnTo))}`;
}

/** Where the Account link goes: the member's Shopify customer account. */
export function accountUrl(returnTo = "/"): string {
	return `/_emdash/api/auth/redeemid/account?return=${encodeURIComponent(safeReturn(returnTo))}`;
}

/** Re-read the member's tags from the store without a sign-in form when their store session is still open. */
export function refreshUrl(returnTo = "/"): string {
	return `/_emdash/api/auth/redeemid/login?refresh=1&return=${encodeURIComponent(safeReturn(returnTo))}`;
}

export function signOutUrl(returnTo = "/"): string {
	return `/_emdash/api/auth/redeemid/logout?return=${encodeURIComponent(safeReturn(returnTo))}`;
}

/**
 * The entry's verdict with drip and the meter applied, for the entry's own
 * page. Drip narrows a granted verdict; the meter opens a locked one for a
 * signed-in reader while the period has room, and never opens a drip entry.
 */
export async function readEntry(
	astro: AstroLike,
	entry: { collection: string; terms?: Terms; id?: string; ruleId?: string },
	override?: { required: string[][] },
): Promise<Verdict> {
	const verdict = await canRead(astro, entry, override);
	const locals = astro.locals as Locals;
	const config = await siteConfig(locals);
	if (!config) return verdict;

	if (verdict.allowed && verdict.reason === "allowed" && verdict.viewer.member) {
		const own = entryRuleFor(config, entry.collection, entry.ruleId ?? entry.id);
		const tree = await termTree(config.rules, entry.collection, entry.terms);
		const days = dripDays(config.rules, entry.collection, entry.terms, tree, own);
		const opensAt = dripOpensAt(memberSince(verdict.viewer.member, config.levels), days);
		if (days > 0 && (!opensAt || opensAt.getTime() > Date.now())) {
			return { ...verdict, allowed: false, reason: "drip", opensAt: opensAt ?? undefined };
		}
		return verdict;
	}

	const meter = config.meter;
	const user = locals.user;
	const db = locals.emdash?.db;
	if (
		verdict.reason !== "upgrade" ||
		!meter ||
		!(meter.limit > 0) ||
		!entry.id ||
		!user?.id ||
		!db ||
		(meter.collections && !meter.collections.includes(entry.collection))
	) {
		return verdict;
	}
	if (!meterable(config.rules, entry.collection, entry.terms, await termTree(config.rules, entry.collection, entry.terms), entryRuleFor(config, entry.collection, entry.ruleId ?? entry.id))) {
		return verdict;
	}
	const period = meter.period ?? "month";
	const key = `${user.id}:${periodKey(new Date(), period)}`;
	try {
		const s = stores(db);
		const record = (await s.meter.get(key)) ?? { userId: user.id, period: periodKey(new Date(), period), items: [] };
		const used = consume(record.items, `${entry.collection}:${entry.id}`, meter.limit);
		const info = { limit: meter.limit, period };
		if (!used.allowed) return { ...verdict, meterLeft: 0, meter: info };
		if (used.items !== record.items) {
			await s.meter.put(key, { ...record, items: used.items });
			const { emit } = await import("./events.js");
			const data = { userId: user.id, entry: `${entry.collection}:${entry.id}`, used: used.items.length, limit: meter.limit, period: record.period };
			const { record: log } = await import("./log.js");
			await log({ event: used.left === 0 ? "meter.exhausted" : "meter.used", label: entry.collection, status: used.left === 0 ? "used up" : `${used.left} left`, origin: "member" });
			await emit(config, "meter.used", data);
			if (used.left === 0) await emit(config, "meter.exhausted", data);
		}
		return { ...verdict, allowed: true, reason: "metered", meterLeft: used.left, meter: info };
	} catch {
		return verdict;
	}
}
