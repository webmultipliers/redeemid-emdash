/**
 * The access map: for each kind of reader (visitors, any signed-in member,
 * each level) what the site's settings give them, and through what. It reads
 * only the settings (levels, features, rules, entry rules, folders), so it
 * says which rules name a level, not which rule wins on a given post; the
 * Test tab answers that.
 */

import { closure } from "./access.js";
import type { FeatureConfig, LevelConfig, RedeemIDConfig } from "./config.js";
import type { EntryRule } from "./settings.js";

/** Where staff change an item: a tab on the Access page, a level or feature dialog, or an entry's editor. */
export type MapGo = { tab: "levels" | "features" | "site" | "types" | "taxonomies" | "files" } | { level: string } | { feature: string } | { entry: { collection: string; id: string } };

export type MapKind = "feature" | "content" | "term" | "entry" | "folder";

export interface MapItem {
	kind: MapKind;
	label: string;
	/** Extra fact, such as "drip 7 days" or "any content type". */
	note?: string;
	/** The level, feature or "Signed in" it comes through, when not held directly. */
	via?: string;
	go: MapGo;
}

export interface MapRow {
	/** "everyone", "signed-in" or the level's slug. */
	id: string;
	name: string;
	/** Who is in it: tags, or a sentence for the two built-in rows. */
	who: string;
	/** Members holding it now (levels only, when counted). */
	members?: number;
	/** Levels it includes, by name. */
	includes: string[];
	/** Ids of every row this one also gets (itself not included). */
	chain: string[];
	items: MapItem[];
}

export interface AccessMapInput {
	config: RedeemIDConfig;
	entries: EntryRule[];
	collections: Array<{ slug: string; label: string }>;
	taxonomies: Array<{ name: string; label: string }>;
	/** Tag words for a level, as the Levels table shows them. */
	tagWords(level: LevelConfig): string;
	/** Members holding each level (including through includes). */
	holders?: Record<string, number>;
}

/** Build the map. Levels come out with the ones others include first. */
export function accessMap(input: AccessMapInput): MapRow[] {
	const { config, entries } = input;
	const levels = config.levels ?? [];
	const features = config.features ?? [];
	const rules = config.rules ?? [];
	const files = config.files ?? [];
	const typeName = (slug: string) => (slug === "*" ? "any content type" : (input.collections.find((c) => c.slug === slug)?.label ?? slug));
	const taxName = (name: string) => input.taxonomies.find((t) => t.name === name)?.label ?? name;
	const levelName = (slug: string) => levels.find((l) => l.slug === slug)?.name ?? slug;

	// What names each reader directly: "everyone", "signed-in" or a level slug.
	const direct = new Map<string, MapItem[]>();
	const add = (who: string, item: MapItem) => direct.set(who, [...(direct.get(who) ?? []), item]);
	const whoOf = (open: boolean | undefined, list: string[]) => (open ? ["everyone"] : list.length ? list : ["signed-in"]);

	for (const r of rules) {
		const drip = r.drip ? `drip ${r.drip} days` : undefined;
		if (r.taxonomy && r.term) {
			const item: MapItem = { kind: "term", label: `${taxName(r.taxonomy)}: ${r.term}`, note: [typeName(r.collection), drip].filter(Boolean).join(", "), go: { tab: "taxonomies" } };
			for (const who of whoOf(r.open, r.levels)) add(who, item);
		} else if (r.collection === "*") {
			for (const who of whoOf(r.open, r.levels)) add(who, { kind: "content", label: "Site default", note: ["everything without its own rule", drip].filter(Boolean).join(", "), go: { tab: "site" } });
		} else {
			for (const who of whoOf(r.open, r.levels)) add(who, { kind: "content", label: typeName(r.collection), note: drip, go: { tab: "types" } });
		}
	}
	for (const e of entries) {
		if (e.mode === "inherit") continue;
		const note = [typeName(e.collection), e.mode === "add" ? "on top of the site's rules" : "", e.drip ? `drip ${e.drip} days` : ""].filter(Boolean).join(", ");
		const item: MapItem = { kind: "entry", label: e.slug || e.entryId, note, go: { entry: { collection: e.collection, id: e.entryId } } };
		for (const who of whoOf(e.mode === "open", e.levels)) add(who, item);
	}
	const featureFolders = new Map<string, MapItem[]>();
	for (const f of files) {
		const item: MapItem = { kind: "folder", label: f.folder, note: f.entries ? "also readers of entries that use its files" : undefined, go: { tab: "files" } };
		if (f.levels) for (const who of f.levels.length ? f.levels : ["signed-in"]) add(who, item);
		for (const slug of f.features ?? []) featureFolders.set(slug, [...(featureFolders.get(slug) ?? []), item]);
	}
	const featureItem = (f: FeatureConfig): MapItem => ({ kind: "feature", label: f.name, note: f.tags?.length ? `also tag ${f.tags.join(", ")}` : undefined, go: { feature: f.slug } });
	for (const f of features) for (const slug of f.levels ?? []) add(slug, featureItem(f));

	// Everything a reader gets: its own items, then each included level's (marked "via").
	const gather = (ids: Array<{ id: string; via?: string }>): MapItem[] => {
		const out: MapItem[] = [];
		const seen = new Set<string>();
		const push = (item: MapItem, via?: string) => {
			const key = `${item.kind}:${item.label}:${item.note ?? ""}`;
			if (seen.has(key)) return;
			seen.add(key);
			out.push(via ? { ...item, via } : item);
		};
		for (const { id, via } of ids) {
			for (const item of direct.get(id) ?? []) {
				push(item, via);
				// A folder opened to a feature this reader holds.
				if (item.kind === "feature") {
					const slug = (item.go as { feature: string }).feature;
					for (const folder of featureFolders.get(slug) ?? []) push(folder, via ?? item.label);
				}
			}
		}
		return out;
	};

	const ordered = [...levels].sort((a, b) => closure(a.slug, levels).length - closure(b.slug, levels).length);
	const rows: MapRow[] = [
		{ id: "everyone", name: "Everyone", who: "Visitors and members alike", includes: [], chain: [], items: gather([{ id: "everyone" }]) },
		{ id: "signed-in", name: "Signed in", who: "Any member who signs in, whatever their tags", includes: [], chain: ["everyone"], items: gather([{ id: "signed-in" }, { id: "everyone", via: "Everyone" }]) },
	];
	for (const l of ordered) {
		const chain = closure(l.slug, levels);
		rows.push({
			id: l.slug,
			name: l.name,
			who: input.tagWords(l),
			members: input.holders?.[l.slug],
			includes: (l.includes ?? []).map(levelName),
			chain: [...chain.slice(1), "signed-in", "everyone"],
			items: gather([...chain.map((slug, i) => ({ id: slug, via: i ? levelName(slug) : undefined })), { id: "signed-in", via: "Signed in" }, { id: "everyone", via: "Everyone" }]),
		});
	}
	return rows;
}

/** How many items of one kind a row holds, and how many of those are its own. */
export function tally(row: MapRow, kind: MapKind): { all: number; own: number } {
	const of = row.items.filter((i) => i.kind === kind);
	return { all: of.length, own: of.filter((i) => !i.via).length };
}
