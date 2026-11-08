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

export interface Verdict {
	allowed: boolean;
	reason: Reason;
	/** Levels any of which would unlock the entry. Empty = any signed-in member. */
	required: string[];
	viewer: Viewer;
}

export type Terms = Record<string, Array<{ slug: string } | string> | undefined>;

export function levelsFor(tags: string[], levels: LevelConfig[] = []): string[] {
	const held = new Set(tags.map((t) => t.toLowerCase()));
	return levels.filter((l) => l.tags.some((t) => held.has(t.toLowerCase()))).map((l) => l.slug);
}

/**
 * Required levels for an entry, or null when no rule covers it.
 * Term rules beat collection rules; several matching term rules combine.
 */
export function requiredLevels(rules: RuleConfig[] = [], collection: string, terms: Terms = {}): string[] | null {
	const forCollection = rules.filter((r) => r.collection === collection);
	const termRules = forCollection.filter((r) => {
		if (!r.taxonomy || !r.term) return false;
		const list = terms[r.taxonomy] ?? [];
		return list.some((t) => (typeof t === "string" ? t : t.slug) === r.term);
	});
	const chosen = termRules.length > 0 ? termRules : forCollection.filter((r) => !r.taxonomy && !r.term);
	if (chosen.length === 0) return null;
	// Any rule that admits every member wins.
	if (chosen.some((r) => r.levels.length === 0)) return [];
	return [...new Set(chosen.flatMap((r) => r.levels))];
}

export async function viewer(astro: AstroLike): Promise<Viewer> {
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

export async function canRead(
	astro: AstroLike,
	entry: { collection: string; terms?: Terms },
	override?: { levels: string[] },
): Promise<Verdict> {
	const locals = astro.locals as Locals;
	const config: RedeemIDConfig | null = siteConfig(locals.emdash?.config);
	const required = override ? override.levels : requiredLevels(config?.rules, entry.collection, entry.terms);
	const v = await viewer(astro);

	if (required === null) return { allowed: true, reason: "open", required: [], viewer: v };
	if (!config) return { allowed: false, reason: "unconfigured", required, viewer: v };
	if (!v.signedIn) return { allowed: false, reason: "sign_in", required, viewer: v };
	if (v.member?.status === "disabled") return { allowed: false, reason: "disabled", required, viewer: v };
	if (!v.member) return { allowed: false, reason: "upgrade", required, viewer: v };
	const ok = required.length === 0 || required.some((l) => v.levels.includes(l));
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

export function signOutUrl(returnTo = "/"): string {
	return `/_emdash/api/auth/redeemid/logout?return=${encodeURIComponent(safeReturn(returnTo))}`;
}
