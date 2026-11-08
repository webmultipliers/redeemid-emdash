/** Portable Text block types RedeemID adds to the editor. */
export const PAYWALL_BLOCK = "redeemid-paywall";
export const PLAN_BLOCK = "redeemid-plan";

type Node = { _type?: unknown; levels?: unknown };

/**
 * Split a Portable Text body at its first paywall break: the open part, the
 * members part, and the levels picked on the break (empty = none picked).
 * With no break, everything is in `open` and `paywall` is false.
 */
export function splitAtPaywall<T>(value: T[] | null | undefined): {
	open: T[];
	locked: T[];
	levels: string[];
	paywall: boolean;
} {
	const blocks = Array.isArray(value) ? value : [];
	const at = blocks.findIndex((b) => (b as Node)?._type === PAYWALL_BLOCK);
	if (at === -1) return { open: blocks, locked: [], levels: [], paywall: false };
	const raw = (blocks[at] as Node).levels;
	const levels = Array.isArray(raw) ? raw.filter((l): l is string => typeof l === "string" && l !== "") : [];
	return { open: blocks.slice(0, at), locked: blocks.slice(at + 1), levels, paywall: true };
}

type TextNode = { _type?: unknown; children?: Array<{ text?: unknown }> };

/**
 * The text blocks within the first `words` words of a body, as on WordPress:
 * a block is never cut in half, so a block that would pass the count ends the
 * teaser. Images and custom blocks are left out. 0 gives nothing.
 */
export function teaser<T>(value: T[] | null | undefined, words: number): T[] {
	if (!Array.isArray(value) || !(words > 0)) return [];
	const out: T[] = [];
	let count = 0;
	for (const b of value) {
		const node = b as TextNode;
		if (node?._type !== "block") continue;
		const text = (node.children ?? []).map((c) => (typeof c.text === "string" ? c.text : "")).join("");
		count += text.split(/\s+/).filter(Boolean).length;
		if (count > words) break;
		out.push(b);
	}
	return out;
}
