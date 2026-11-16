/**
 * The Access column in EmDash's content lists: who can read each entry on the
 * page, in a word or two ("Free", "Gold", "Signed in"), so staff can see
 * access without opening every entry. The admin asks once per page of the
 * list (admin.ts asks for every visible row together).
 *
 * The label comes from the same rule the site enforces (entryRequirement):
 * the content type, the entry's terms (with their parents) and its own Access
 * panel rule, with the dates on that rule as of now.
 */

import { describe, entryRequirement, type Terms } from "./access.js";
import type { RedeemIDConfig } from "./config.js";

/** At most this many entries per ask (EmDash lists 50 a page at most). */
export const COLUMN_MAX = 100;

export interface AccessLabel {
	/** "Free", "Signed in", "Gold", "Silver or Gold"… */
	label: string;
	/** Anyone has to sign in or hold a level to read it all. */
	locked: boolean;
}

/** The ask, checked: a collection slug and up to COLUMN_MAX entry ids. */
export function parseColumnInput(raw: unknown): { collection: string; ids: string[] } | null {
	if (!raw || typeof raw !== "object") return null;
	const { collection, ids } = raw as { collection?: unknown; ids?: unknown };
	if (typeof collection !== "string" || !/^[a-z0-9_-]{1,64}$/i.test(collection)) return null;
	if (!Array.isArray(ids)) return null;
	const clean = [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 128))].slice(0, COLUMN_MAX);
	return { collection, ids: clean };
}

/**
 * Labels for entries of one collection. `termsFor` gives each entry's terms
 * by taxonomy (one batched read; see plugin.ts).
 */
export async function accessLabels(
	config: RedeemIDConfig,
	collection: string,
	ids: string[],
	termsFor: (ids: string[]) => Promise<Map<string, Terms>>,
): Promise<Record<string, AccessLabel>> {
	const terms = ids.length ? await termsFor(ids) : new Map<string, Terms>();
	const out: Record<string, AccessLabel> = {};
	for (const id of ids) {
		const required = await entryRequirement(config, collection, terms.get(id) ?? {}, id);
		out[id] = { label: describe(required, config.levels ?? []), locked: required !== null };
	}
	return out;
}
