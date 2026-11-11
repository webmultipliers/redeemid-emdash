/**
 * Templates that put an entry's body on the page with EmDash's own
 * `<PortableText>` instead of RedeemID's `<Content>`. Those bodies skip
 * every rule, Paywall break and Members only part, so a gated collection
 * rendered that way reaches every visitor in full.
 *
 * Also templates that call `Astro.cache.set()` themselves on a gated
 * collection's pages instead of cacheEntry()/cachePage() (route-cache.ts):
 * the route cache then serves one reader's copy to everyone.
 *
 * redeemidGuard() scans the site's src/ at build time (scanTemplate, in
 * Node) and hands the findings to the running site; the Status page then
 * compares them with the rules as they are now (gatedFindings), because
 * rules can change in the admin after the build.
 *
 * Both functions are pure.
 */

import type { RedeemIDConfig } from "./config.js";

export interface TemplateFinding {
	/** Path from the site's root, e.g. src/pages/[slug].astro. */
	file: string;
	/** Lines with a <PortableText> tag (from emdash/ui). */
	lines: number[];
	/** Lines that call Astro.cache.set() directly; absent when there are none. */
	cache?: number[];
	/** Collections the file loads with getEmDashEntry or getEmDashCollection. */
	collections: string[];
}

const FROM_EMDASH_UI = /import\s*\{[^}]*\bPortableText\b[^}]*\}\s*from\s*["']emdash\/ui["']/;
const LOADS = /getEmDash(?:Entry|Collection)\(\s*["'`]([\w-]+)["'`]/g;

const CACHE_SET = /\bAstro\.cache\??\.set\(/;

/** One template's finding, or null when it neither renders <PortableText> from emdash/ui nor sets a cache hint. */
export function scanTemplate(file: string, source: string): TemplateFinding | null {
	const fromUi = FROM_EMDASH_UI.test(source);
	const lines: number[] = [];
	const cache: number[] = [];
	source.split("\n").forEach((line, i) => {
		if (fromUi && /<PortableText[\s/>]/.test(line)) lines.push(i + 1);
		if (CACHE_SET.test(line)) cache.push(i + 1);
	});
	if (!lines.length && !cache.length) return null;
	const collections = [...new Set([...source.matchAll(LOADS)].map((m) => m[1]!))].sort();
	return cache.length ? { file, lines, cache, collections } : { file, lines, collections };
}

/** Collections some rule or entry rule can lock: "*" when the site default does. */
export function gatedCollections(config: RedeemIDConfig): Set<string> {
	const out = new Set<string>();
	for (const r of config.rules ?? []) if (!r.open) out.add(r.collection);
	for (const e of Object.values(config.entries ?? {})) if (e && (e.mode === "levels" || e.mode === "add")) out.add(e.collection);
	return out;
}

export interface GatedFinding extends TemplateFinding {
	/** The file's collections that a rule covers; empty when the file loads none we could see. */
	gated: string[];
}

/**
 * Findings that matter now: a file that loads a gated collection, or a file
 * whose collection we couldn't see (a component given the body as a prop)
 * while some collection is gated.
 */
export function gatedFindings(findings: TemplateFinding[], config: RedeemIDConfig): GatedFinding[] {
	const gated = gatedCollections(config);
	if (!gated.size) return [];
	const all = gated.has("*");
	return findings.flatMap((f) => {
		if (!f.lines.length) return [];
		if (!f.collections.length) return [{ ...f, gated: [] }];
		const hit = f.collections.filter((c) => all || gated.has(c));
		return hit.length ? [{ ...f, gated: hit }] : [];
	});
}

/**
 * Templates that set a route cache hint themselves on pages that load a
 * gated collection. Files whose collection we can't see (layouts, which set
 * hints for menus and settings) aren't listed: cacheEntry() on the page keeps
 * those out anyway.
 */
export function cacheFindings(findings: TemplateFinding[], config: RedeemIDConfig): GatedFinding[] {
	const gated = gatedCollections(config);
	if (!gated.size) return [];
	const all = gated.has("*");
	return findings.flatMap((f) => {
		const hit = f.collections.filter((c) => all || gated.has(c));
		return f.cache?.length && hit.length ? [{ ...f, gated: hit }] : [];
	});
}

/** Where the running site keeps the scan; unset when redeemidGuard() isn't installed. */
export const TEMPLATES_KEY = "__redeemidTemplates";

/** The scan, or null when redeemidGuard() isn't installed (or hasn't run yet). */
export function templateFindings(): TemplateFinding[] | null {
	const v = (globalThis as Record<string, unknown>)[TEMPLATES_KEY];
	return Array.isArray(v) ? (v as TemplateFinding[]) : null;
}
