/**
 * Replacement text: give any string members and visitors see new words, one
 * string at a time. Config `text` maps a string's original English to its
 * replacement:
 *
 *   text: {
 *     "Sign in": "Log in",
 *     "This is for {level} members.": "{level} members only.",
 *   }
 *
 * Only the strings named change: there is no find-and-replace across
 * strings, so nothing changes that nobody looked at. STRINGS lists every
 * original. Some have placeholders such as `{level}`, filled in when the
 * text shows; a replacement may use its original's placeholders, in any
 * order or not at all, but no others. A replacement that breaks this, or
 * names a string RedeemID doesn't show, is ignored (the original shows) and
 * listed on the Status page. Text is plain: HTML in a replacement shows as
 * typed. Explicit component props (`label`, `title`, Notices `messages`) win
 * over `text`.
 */

import type { RedeemIDConfig } from "./config.js";

/** Every string RedeemID shows members and visitors, by where it shows. */
export const STRINGS = {
	account: ["Signed in", "Account", "Sign out", "Sign in"],
	badge: ["Free", "Signed in", " (locked)"],
	cart: [
		"Cart",
		"Your cart is empty.",
		"Your cart isn't available right now. Try again in a few minutes.",
		"{price} each · {total}",
		"Quantity",
		"Update",
		"Remove",
		"Discount code",
		"Apply",
		"{code} doesn't apply to this cart.",
		"Subtotal",
		"Total",
		"Taxes and shipping are worked out at checkout.",
		"Checkout",
	],
	collection: ["From {price}", "Sold out", "Add to cart"],
	contribution: ["Give", "Another amount ({currency})", "Quantity ({price} each)"],
	meter: ["This is your last free read this week.", "This is your last free read this month.", "You have 1 free read left this week.", "You have 1 free read left this month.", "You have {count} free reads left this week.", "You have {count} free reads left this month."],
	wall: [
		"Become a member",
		"This is for members. {signIn} to read on.",
		"Sign in",
		"Not a member yet? {join}.",
		"You've used your free reads this week.",
		"You've used your free reads this month.",
		"This opens for you on {date}.",
		"This opens for you after you've been a member a little longer.",
		"This is for {level} members.",
		"Your membership doesn't include this yet.",
		"Your account is turned off. Contact the store for help.",
		"This is for members.",
		"Or buy just this for {price}.",
		"Buy just this",
		"Your {level} membership has ended.",
		"Renew {level}",
		"Already renewed? {refresh}",
		"Refresh",
	],
	member: [
		"Your membership",
		"Your account is turned off. Contact the store for help.",
		"since {date}",
		"Renews on {date}",
		"Ends on {date}",
		"Gift membership until {date}",
		"You don't have a membership yet.",
		"Become a member",
		"Includes: {features}",
		"Before",
		"{from} to {to}",
		"until {to}",
		"Free reads this week: {used} of {limit} used.",
		"Free reads this month: {used} of {limit} used.",
		"Orders and details",
		"Refresh membership",
		"Sign out",
		"Just bought a plan? It can take a minute to show here. Refresh membership checks again.",
		"{signIn} to see your membership.",
		"Sign in",
	],
	notices: [
		"Sign-in isn't set up on this site yet.",
		"Sign-in isn't available right now. Try again in a few minutes.",
		"That sign-in took too long. Try again.",
		"This account can't sign in here. Use a different email.",
		"Your account is turned off. Contact the store for help.",
		"Too many tries. Wait a minute, then try again.",
		"This site isn't ready for sign-in yet.",
		"Your account needs an email address to sign in.",
		"Sign-in didn't finish. Try again.",
		"That plan isn't available right now.",
		"Checkout didn't open. Try again.",
		"Your cart is empty.",
		"Added to your cart.",
		"Your cart is updated.",
		"Discount applied.",
		"That discount code doesn't apply to this cart.",
		"Your membership is up to date.",
		"Your preferences are saved.",
		"Some answers weren't saved. Check them and try again.",
		"Your preferences can't be saved right now. Try again in a few minutes.",
		"Your data on this site is deleted, and you're signed out.",
		"Tick the box to confirm, then try again.",
		"Your account page isn't available right now. Try again in a few minutes.",
	],
	privacy: [
		"Your data",
		"Download my data",
		"Deleting removes what this site keeps about you and signs you out. Your store account and orders stay; ask the store to delete those.",
		"I understand",
		"Delete my data",
	],
	plan: ["Join", "Renew", "You're on this plan.", "Not available right now."],
	preferences: ["Your preferences", "Save preferences", "Your preferences can't be loaded right now. Try again in a few minutes.", "Not set", "Yes", "No", "One per line."],
	product: [
		"Add to cart",
		"Buy now",
		"Quantity",
		"Sold out.",
		"Image {number} of {count}",
		"Purchase options",
		"One-time purchase",
		"{group}: {plan}",
		"Not available in this combination.",
		"Pair it with",
		"You may also like",
	],
	drawer: ["Your cart", "Close", "Loading your cart…"],
	search: [
		"Search products",
		"Search",
		"{count} suggestions",
		"Search isn't available right now. Try again in a few minutes.",
		"No products match “{query}”.",
		"1 result for “{query}”",
		"{count} results for “{query}”",
		"Sort and filter",
		"Sort by",
		"Featured",
		"Relevance",
		"Best selling",
		"Newest",
		"Price, low to high",
		"Price, high to low",
		"Title, A to Z",
		"Title, Z to A",
		"{label} ({count})",
		"Price",
		"From",
		"To",
		"Apply",
		"Clear filters",
		"Pages",
		"Previous page",
		"Next page",
	],
	files: ["File not available", "Sign in to download this file.", "Sign in", "Your membership doesn't include this file."],
} as const;

const ALL = new Set<string>(Object.values(STRINGS).flat());

const PLACEHOLDER = /\{(\w+)\}/g;

export function placeholders(s: string): string[] {
	return [...s.matchAll(PLACEHOLDER)].map((m) => m[1] as string);
}

/** Why a replacement can't be used, or null when it can. */
export function textProblem(original: string, replacement: unknown): string | null {
	if (!ALL.has(original)) return "RedeemID doesn't show this string";
	if (typeof replacement !== "string") return "The replacement isn't text";
	const allowed = new Set(placeholders(original));
	const extra = placeholders(replacement).filter((p) => !allowed.has(p));
	if (extra.length) return `Uses ${[...new Set(extra)].map((p) => `{${p}}`).join(", ")}, which the original doesn't have`;
	return null;
}

const checked = new WeakMap<object, { ok: Map<string, string>; problems: Array<{ original: string; problem: string }> }>();

function table(config: RedeemIDConfig | null | undefined) {
	const map = config?.text;
	if (!map || typeof map !== "object") return null;
	let t = checked.get(map);
	if (!t) {
		t = { ok: new Map(), problems: [] };
		for (const [original, replacement] of Object.entries(map)) {
			const problem = textProblem(original, replacement);
			if (problem) t.problems.push({ original, problem });
			else t.ok.set(original, replacement as string);
		}
		if (t.problems.length) console.warn(`[redeemid] ${t.problems.length} text replacement(s) ignored; see Status.`);
		checked.set(map, t);
	}
	return t;
}

/** Replacements that are ignored, and why. */
export function textProblems(config: RedeemIDConfig | null | undefined): Array<{ original: string; problem: string }> {
	return table(config)?.problems ?? [];
}

/** The text for one string, with plain placeholders filled in. */
export function text(config: RedeemIDConfig | null | undefined, original: string, vars: Record<string, string | number> = {}): string {
	const template = table(config)?.ok.get(original) ?? original;
	return template.replace(PLACEHOLDER, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}

/**
 * The text for a string whose placeholders are elements (a link inside a
 * sentence): the parts to render, in order.
 *
 *   {textParts(config, "This is for members. {signIn} to read on.", { signIn: <a href={u}>Sign in</a> })}
 */
export function textParts(config: RedeemIDConfig | null | undefined, original: string, slots: Record<string, unknown>): unknown[] {
	const template = table(config)?.ok.get(original) ?? original;
	const out: unknown[] = [];
	let last = 0;
	for (const m of template.matchAll(PLACEHOLDER)) {
		const name = m[1] as string;
		if (!(name in slots)) continue;
		if (m.index > last) out.push(template.slice(last, m.index));
		out.push(slots[name]);
		last = m.index + m[0].length;
	}
	if (last < template.length) out.push(template.slice(last));
	return out;
}
