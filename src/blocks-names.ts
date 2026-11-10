/** Portable Text block types RedeemID adds to the editor. */
export const PAYWALL_BLOCK = "redeemid-paywall";
export const PLAN_BLOCK = "redeemid-plan";
export const PRODUCT_BLOCK = "redeemid-product";
export const COLLECTION_BLOCK = "redeemid-collection";
export const SEARCH_BLOCK = "redeemid-search";
export const CONTRIBUTION_BLOCK = "redeemid-contribution";
export const PREFERENCES_BLOCK = "redeemid-preferences";
/** Starts a members-only part of the body; it runs to the next end block. */
export const MEMBERS_BLOCK = "redeemid-members";
export const MEMBERS_END_BLOCK = "redeemid-members-end";
/** Sells the entry on its own: readers holding its tag read all of it. */
export const ITEM_BLOCK = "redeemid-item";

export interface SoldItem {
	/** The Shopify customer tag buyers get, lowercased. */
	tag: string;
	/** The Shopify product handle that sells it, or null. */
	product: string | null;
}

/** The entry's "Sold on its own" block, if it has one with a tag. */
export function soldItem(value: unknown): SoldItem | null {
	const blocks = Array.isArray(value) ? value : [];
	const b = blocks.find((x) => (x as { _type?: unknown })?._type === ITEM_BLOCK) as { tag?: unknown; product?: unknown } | undefined;
	const tag = typeof b?.tag === "string" ? b.tag.trim().toLowerCase() : "";
	if (!tag) return null;
	const raw = typeof b?.product === "string" ? b.product.trim() : "";
	// A handle, or a product link: /products/<handle>.
	const handle = (/\/products\/([a-z0-9][a-z0-9-]*)/i.exec(raw)?.[1] ?? raw).toLowerCase();
	return { tag, product: /^[a-z0-9][a-z0-9-]*$/.test(handle) ? handle : null };
}

/** Does someone with these tags hold the item? */
export function holdsItem(item: SoldItem | null, tags: string[] | undefined): boolean {
	return Boolean(item && tags?.some((t) => t.toLowerCase() === item.tag));
}

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
 * The text blocks within the first `words` words of a body:
 * a block is never cut in half, so a block that would pass the count ends the
 * teaser. Images and custom blocks are left out. A "Members only" part ends
 * it too: its text is never teaser. 0 gives nothing.
 */
export function teaser<T>(value: T[] | null | undefined, words: number): T[] {
	if (!Array.isArray(value) || !(words > 0)) return [];
	const out: T[] = [];
	let count = 0;
	for (const b of value) {
		const node = b as TextNode;
		if (node?._type === MEMBERS_BLOCK) break;
		if (node?._type !== "block") continue;
		const text = (node.children ?? []).map((c) => (typeof c.text === "string" ? c.text : "")).join("");
		count += text.split(/\s+/).filter(Boolean).length;
		if (count > words) break;
		out.push(b);
	}
	return out;
}

export interface Section<T> {
	/** True for a part between a "Members only" block and its end. */
	members: boolean;
	/** Levels picked on the "Members only" block (empty = none picked). */
	levels: string[];
	blocks: T[];
}

const levelsOf = (raw: unknown) =>
	Array.isArray(raw) ? raw.filter((l): l is string => typeof l === "string" && l !== "") : [];

/**
 * Split blocks into open parts and members-only parts. A "Members only" block
 * starts a part that runs to the next "Members only: end" block (or the end of
 * the blocks); the marker blocks themselves are dropped. A stray end block is
 * dropped too.
 */
export function sections<T>(value: T[] | null | undefined): Section<T>[] {
	const out: Section<T>[] = [];
	let current: Section<T> = { members: false, levels: [], blocks: [] };
	for (const b of Array.isArray(value) ? value : []) {
		const type = (b as Node)?._type;
		if (type === MEMBERS_BLOCK || type === MEMBERS_END_BLOCK) {
			if (current.blocks.length > 0 || current.members) out.push(current);
			current =
				type === MEMBERS_BLOCK
					? { members: true, levels: levelsOf((b as Node).levels), blocks: [] }
					: { members: false, levels: [], blocks: [] };
			continue;
		}
		current.blocks.push(b);
	}
	if (current.blocks.length > 0 || current.members) out.push(current);
	return out;
}
