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

export type Reason = "open" | "allowed" | "sign_in" | "upgrade" | "disabled" | "unconfigured";

/**
 * What an entry needs, in conjunctive form: every clause must pass, and a
 * clause passes when the reader holds any of its levels. An empty clause means
 * any signed-in member. `null` means the entry is open to everyone.
 */
export type Requirement = string[][] | null;

/**
 * The built-in level every signed-in member holds, as on WordPress. A clause
 * with it passes for any signed-in member, like an empty clause.
 */
export const SIGNED_IN = "signed-in";

export interface Verdict {
	allowed: boolean;
	reason: Reason;
	/** What the entry needs (see Requirement). `[]` when it is open. */
	required: string[][];
	viewer: Viewer;
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
	const mode = options.combine ?? "all";
	const forCollection = rules.filter((r) => r.collection === collection);
	const matched: RuleConfig[] = [];
	for (const [taxonomy, list] of Object.entries(terms)) {
		const taxRules = forCollection.filter((r) => r.taxonomy === taxonomy && r.term);
		if (taxRules.length === 0) continue;
		const parents = options.tree?.[taxonomy] ?? {};
		for (const ref of list ?? []) {
			let slug: string | null = slugOf(ref);
			const seen = new Set<string>();
			while (slug && !seen.has(slug)) {
				seen.add(slug);
				const own = taxRules.filter((r) => r.term === slug);
				if (own.length > 0) {
					matched.push(...own);
					break;
				}
				slug = parents[slug] ?? null;
			}
		}
	}
	if (matched.some((r) => r.open)) return null;
	if (matched.length > 0) return combined(matched, mode);
	const whole = forCollection.filter((r) => !r.taxonomy && !r.term && !r.open);
	if (whole.length > 0) return combined(whole, mode);
	const site = rules.filter((r) => r.collection === "*" && !r.taxonomy && !r.term && !r.open);
	if (site.length > 0) return combined(site, mode);
	return null;
}

/** Does someone holding `held` pass `required`? Signed-in membership is checked by the caller. */
export function passes(held: string[], required: string[][]): boolean {
	return required.every((clause) => clause.length === 0 || clause.includes(SIGNED_IN) || clause.some((l) => held.includes(l)));
}

/**
 * The requirement in words, for badges and admin pages: "Gold + Silver",
 * "Silver or Gold", "Signed in". `null` gives `open`.
 */
export function describe(required: Requirement, levels: LevelConfig[] = [], open = "Free"): string {
	if (required === null) return open;
	const name = (slug: string) => levels.find((l) => l.slug === slug)?.name ?? slug;
	const parts = reduce(required).filter((c) => c.length > 0).map((c) => c.map(name).join(" or "));
	return parts.length ? parts.join(" + ") : "Signed in";
}

/**
 * Parent slugs for the taxonomies whose rules could cover an entry through a
 * parent term. Reads EmDash's term lists (cached by EmDash) only when a term
 * on the entry has no rule of its own.
 */
export async function termTree(rules: RuleConfig[] = [], collection: string, terms: Terms = {}): Promise<TermTree> {
	const tree: TermTree = {};
	const forCollection = rules.filter((r) => r.collection === collection && r.taxonomy && r.term);
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

/** The entry's requirement with the site's config, walking term parents. */
export async function entryRequirement(
	config: RedeemIDConfig | null,
	collection: string,
	terms: Terms = {},
): Promise<Requirement> {
	if (!config) return null;
	const tree = await termTree(config.rules, collection, terms);
	return requirement(config.rules, collection, terms, { combine: config.combine, tree });
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

	const config = siteConfig(locals.emdash?.config);
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
	entry: { collection: string; terms?: Terms },
	override?: { levels: string[] } | { required: string[][] },
): Promise<Verdict> {
	const locals = astro.locals as Locals;
	const config: RedeemIDConfig | null = siteConfig(locals.emdash?.config);
	const required: Requirement = override
		? "required" in override
			? override.required
			: [override.levels]
		: await entryRequirement(config, entry.collection, entry.terms);
	const v = await viewer(astro);

	if (required === null) return { allowed: true, reason: "open", required: [], viewer: v };
	if (!config) return { allowed: false, reason: "unconfigured", required, viewer: v };
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

export function signOutUrl(returnTo = "/"): string {
	return `/_emdash/api/auth/redeemid/logout?return=${encodeURIComponent(safeReturn(returnTo))}`;
}
