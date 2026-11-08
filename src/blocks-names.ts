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
