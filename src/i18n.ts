/**
 * The admin in the staff member's language.
 *
 * RedeemID's admin pages are built on the server in English (Block Kit), and
 * a few parts are drawn in the browser (admin.ts). Both go through this file:
 * a page's blocks are translated on their way out, string by string, from a
 * catalog per language (src/locales/). A string with no translation stays in
 * English, so a new or changed sentence never breaks a page.
 *
 * The language is the one the staff member picked in EmDash (its
 * `emdash-locale` cookie), then the browser's Accept-Language. Catalogs are
 * keyed by the English text. A sentence built with values, such as
 * "Registered {0} webhooks.", matches with the values in place, and each
 * value is translated too when it's a known string.
 *
 * Only display text is translated: ids, values, links, slugs and code are
 * left alone (SKIP_KEYS). Member-facing text on the site is not here; sites
 * put that in their own words with `text` (text.ts).
 */

import de from "./locales/de.js";
import es from "./locales/es.js";
import fr from "./locales/fr.js";
import ja from "./locales/ja.js";
import ptBR from "./locales/pt-BR.js";

export type Catalog = Record<string, string>;

/** Languages with a catalog, by EmDash locale code. */
export const CATALOGS: Record<string, Catalog> = { de, es, fr, ja, "pt-BR": ptBR };

/** EmDash's locale codes (and plain language tags) that use one of the catalogs. */
const ALIASES: Record<string, string> = {
	de: "de",
	es: "es",
	"es-es": "es",
	"es-419": "es",
	fr: "fr",
	ja: "ja",
	pt: "pt-BR",
	"pt-br": "pt-BR",
	"pt-pt": "pt-BR",
};

const COOKIE = /(?:^|;\s*)emdash-locale=([^;]+)/;

function match(tag: string): string | null {
	const t = tag.trim().toLowerCase();
	if (!t) return null;
	return ALIASES[t] ?? ALIASES[t.split("-")[0]!] ?? null;
}

/** The catalog to use for one request: EmDash's locale cookie, then Accept-Language. Null means English. */
export function adminLocale(request?: { headers: { get(name: string): string | null } } | null, hint?: string | null): string | null {
	if (hint) {
		const m = match(hint);
		if (m || /^en\b/i.test(hint)) return m;
	}
	if (!request) return null;
	const cookie = decodeURIComponent(request.headers.get("cookie")?.match(COOKIE)?.[1] ?? "");
	if (cookie) return match(cookie);
	for (const part of (request.headers.get("accept-language") ?? "").split(",")) {
		const tag = part.split(";")[0] ?? "";
		if (/^en\b/i.test(tag.trim())) return null;
		const m = match(tag);
		if (m) return m;
	}
	return null;
}

type Pattern = { re: RegExp; slots: number[]; to: string; fixed: number };
const compiled = new Map<string, Pattern[]>();

const escape = (s: string) => s.replace(/[.*+?^$()|[\]\\]/g, "\\$&");

/** Sentences with values ({0}, {1}…), as patterns, most fixed text first so the most specific wins. */
function patterns(locale: string, catalog: Catalog): Pattern[] {
	let list = compiled.get(locale);
	if (list) return list;
	list = [];
	for (const [from, to] of Object.entries(catalog)) {
		if (!/\{\d\}/.test(from)) continue;
		const slots: number[] = [];
		const re = from
			.split(/(\{\d\})/)
			.map((part) => {
				const m = part.match(/^\{(\d)\}$/);
				if (!m) return escape(part);
				slots.push(Number(m[1]));
				return "([\\s\\S]*?)";
			})
			.join("");
		list.push({ re: new RegExp(`^${re}$`), slots, to, fixed: from.replace(/\{\d\}/g, "").length });
	}
	list.sort((a, b) => b.fixed - a.fixed);
	compiled.set(locale, list);
	return list;
}

/** One string in the catalog's language, or as it was. */
export function translate(locale: string | null, text: string, depth = 0): string {
	if (!locale || !text || depth > 5) return text;
	const catalog = CATALOGS[locale];
	if (!catalog) return text;
	const exact = catalog[text];
	if (exact !== undefined) return exact;
	if (!/[A-Za-z]/.test(text)) return text;
	for (const p of patterns(locale, catalog)) {
		const m = text.match(p.re);
		if (!m) continue;
		return p.to.replace(/\{(\d)\}/g, (_, n: string) => {
			const at = p.slots.indexOf(Number(n));
			const value = at >= 0 ? (m[at + 1] ?? "") : "";
			return translate(locale, value, depth + 1);
		});
	}
	return text;
}

/** Keys whose values are ids, data, links or code, never display text. */
const SKIP_KEYS = new Set([
	"action_id",
	"block_id",
	"id",
	"type",
	"value",
	"values",
	"initial_value",
	"initial_values",
	"path",
	"url",
	"href",
	"src",
	"icon",
	"variant",
	"style",
	"size",
	"code",
	"language",
	"kind",
	"collection",
	"page",
	"state",
	"key",
	"field",
	"slug",
	"handle",
	"format",
	"color",
	"copy",
	"neq",
	"eq",
	"target",
	"page_action_id",
]);

/** A page's blocks (or any route answer) with its display text in the locale's language. */
export function localize<T>(value: T, locale: string | null): T {
	if (!locale || !CATALOGS[locale]) return value;
	const walk = (v: unknown): unknown => {
		if (typeof v === "string") return translate(locale, v);
		if (Array.isArray(v)) return v.map(walk);
		if (v && typeof v === "object") {
			const out: Record<string, unknown> = {};
			for (const [k, inner] of Object.entries(v as Record<string, unknown>)) out[k] = SKIP_KEYS.has(k) ? inner : walk(inner);
			return out;
		}
		return v;
	};
	return walk(value) as T;
}

/** In the browser: the staff member's language, from EmDash's cookie or the browser. */
export function browserLocale(): string | null {
	if (typeof document === "undefined") return null;
	const cookie = decodeURIComponent(document.cookie.match(COOKIE)?.[1] ?? "");
	if (cookie) return match(cookie);
	for (const tag of typeof navigator === "undefined" ? [] : navigator.languages ?? [navigator.language]) {
		if (/^en\b/i.test(tag)) return null;
		const m = match(tag);
		if (m) return m;
	}
	return null;
}
