/**
 * An entry's body as one reader may read it: the single filter behind
 * `<Content>`, and for any other place a body leaves the site (an RSS or
 * Atom feed, a JSON route, a Markdown copy, an email digest).
 *
 * EmDash has no content filter, so code that hands `post.data.content` to a
 * feed sends the whole body, locked part included. Pass it through
 * `readableBody()` first:
 *
 *   const { blocks } = await readableBody(Astro, { value: post.data.content, collection: "posts", terms: post.data.terms, id: post.id });
 *
 * The rules are `<Content>`'s: everything before the first Paywall break is
 * for everyone and the rest follows the entry's rule; a body with no break
 * follows the rule as a whole and readers it keeps out get the collection's
 * teaser; a Members only part is dropped for readers its levels keep out; a
 * reader holding the Sold on its own tag reads it all. Drip applies. The
 * meter is never used: a feed or list never counts a read or opens one.
 * A feed reader sends no cookies, so a feed gets what a visitor would see.
 */

import { canRead, entryRequirement, readEntry, viewer, type AstroLike, type Requirement, type Terms, type Verdict } from "./access.js";
import { holdsItem, sections, soldItem, splitAtPaywall, teaser, type SoldItem } from "./blocks-names.js";
import { siteConfig } from "./site-config.js";

export interface BodyEntry<T = unknown> {
	/** The Portable Text body (`post.data.content`). */
	value: T[] | null | undefined;
	collection: string;
	terms?: Terms;
	/** The entry's id or slug: applies its Access panel rule and drip. */
	id?: string;
}

export type OpenVerdict = { allowed: true; reason: "open" };

/** One run of blocks, with its verdict when it's a Members only part. */
export interface BodyPart<T = unknown> {
	blocks: T[];
	verdict?: Verdict;
}

export interface BodyParts<T = unknown> {
	/** The verdict for what follows the break (or the whole body with none). */
	verdict: Verdict | OpenVerdict;
	/** The entry's own requirement (its rule), null when nothing covers it. */
	entryRule: Requirement;
	/** Shown above the wall: what precedes the break, the teaser, or the whole body when allowed. */
	before: BodyPart<T>[];
	/** What follows the break, for readers allowed it (else empty). */
	after: BodyPart<T>[];
	/** The body has a Paywall break. */
	paywall: boolean;
	/** The Sold on its own block, if any, and whether this reader holds its tag. */
	item: SoldItem | null;
	owned: boolean;
}

/**
 * The body cut into parts for this reader. `meter: true` (on the entry's own
 * page, with `id`) lets the meter count and open the read, as `<Content>` does.
 */
export async function bodyParts<T>(astro: AstroLike, entry: BodyEntry<T>, options: { meter?: boolean } = {}): Promise<BodyParts<T>> {
	const { value, collection, terms, id } = entry;
	const split = splitAtPaywall(value);
	const config = await siteConfig(astro.locals);
	const entryRule = await entryRequirement(config, collection, terms, id);
	// Bought on its own: the whole entry, no meter, no drip.
	const item = soldItem(value);
	const reader = item ? (await viewer(astro)).member : null;
	const owned = Boolean(reader && reader.status !== "disabled" && holdsItem(item, reader.tags));
	// The rest after a break follows the entry's rule, and the break does
	// nothing when no rule covers the entry.
	const required = split.paywall ? entryRule : undefined;
	const override = required ? { required } : undefined;
	const verdict: Verdict | OpenVerdict =
		owned || (split.paywall && required === null)
			? { allowed: true, reason: "open" }
			: id
				? await readEntry(astro, { collection, terms, id }, override, { meter: options.meter === true })
				: await canRead(astro, { collection, terms }, override);
	const words = config?.teaser?.[collection] ?? 0;
	const shown = split.paywall ? split.open : verdict.allowed ? split.open : teaser(split.open, words);
	const rest = verdict.allowed ? split.locked : [];

	// Each "Members only" part gets its own verdict.
	const parts = async (blocks: T[]) => {
		const out: BodyPart<T>[] = [];
		for (const section of sections(blocks)) {
			if (!section.members || owned) {
				out.push({ blocks: section.blocks });
				continue;
			}
			const needs = section.levels.length ? [section.levels] : (entryRule ?? [[]]);
			out.push({ blocks: section.blocks, verdict: await canRead(astro, { collection, terms, id }, { required: needs }) });
		}
		return out;
	};
	return { verdict, entryRule, before: await parts(shown), after: await parts(rest), paywall: split.paywall, item, owned };
}

export interface ReadableBody<T = unknown> {
	/** The blocks this reader may read, in order, with RedeemID's marker blocks removed. */
	blocks: T[];
	/** True when nothing was held back. */
	whole: boolean;
	verdict: Verdict | OpenVerdict;
}

/** The blocks this reader may read (see the top of this file). Never counts a metered read. */
export async function readableBody<T>(astro: AstroLike, entry: BodyEntry<T>): Promise<ReadableBody<T>> {
	const p = await bodyParts(astro, entry);
	const keep = (list: BodyPart<T>[]) => list.filter((x) => !x.verdict || x.verdict.allowed);
	const shown = [...keep(p.before), ...(p.verdict.allowed ? keep(p.after) : [])];
	// Allowed past the break (so no teaser) and no Members only part held back.
	const whole = p.verdict.allowed && [...p.before, ...p.after].every((x) => !x.verdict || x.verdict.allowed);
	return { blocks: shown.flatMap((x) => x.blocks), whole, verdict: p.verdict };
}
