/**
 * The Access screens (Block Kit): levels, site rules, content types,
 * taxonomies, features and protected files in the admin, and the Access
 * panel on each entry in the editor.
 *
 * Content types and taxonomies are read from the site's schema every time,
 * so a new collection or taxonomy gets its settings with no code change.
 * Level names and slugs are whatever the site picks; the only built-in level
 * is "signed-in" (any signed-in member).
 *
 * Saving copies the code's value for that setting first, so nothing set in
 * astro.config.mjs is lost; "Use the code's setting" removes the admin's copy.
 * No screen grants access: levels come only from Shopify customer tags.
 */

import type { StorageCollection } from "emdash";

import { applyEntryRule, describe, requirement, ruleSource, SIGNED_IN, termTree, type Requirement, type Terms } from "./access.js";
import type { FeatureConfig, FileRule, LevelConfig, MeterConfig, RedeemIDConfig, RuleConfig } from "./config.js";
import {
	days,
	entryKey,
	list,
	MANAGED,
	mergeAccess,
	overridden,
	SITE_ID,
	slugify,
	validSlug,
	type AccessRecord,
	type EntryRule,
	type LoadedAccess,
	type ManagedKey,
	type SiteAccess,
} from "./settings.js";

type Toast = { message: string; type: "success" | "error" | "info" };
export type Blocks = { blocks: unknown[]; toast?: Toast };

export interface CollectionInfo {
	slug: string;
	label: string;
}
export interface TaxonomyInfo {
	name: string;
	label: string;
	collections: string[];
}
export interface TermInfo {
	slug: string;
	label: string;
}

/** What the screens need, gathered by the plugin (or by a test). */
export interface AccessEnv {
	code: RedeemIDConfig;
	store: StorageCollection<AccessRecord>;
	saved: LoadedAccess;
	collections: CollectionInfo[];
	taxonomies: TaxonomyInfo[];
	/** Terms of a taxonomy, parents before children, labels showing the path. */
	terms(taxonomy: string): Promise<TermInfo[]>;
}

export const TABS = ["levels", "site", "types", "taxonomies", "features", "files"] as const;
export type Tab = (typeof TABS)[number];
/** Which of the four panels holds each part. */
const PANEL: Record<Tab, number> = { levels: 0, features: 0, site: 1, types: 1, taxonomies: 2, files: 3 };

const effective = (env: AccessEnv) => mergeAccess(env.code, env.saved) ?? env.code;

// ---------------------------------------------------------------- shared form parts

type Who = "none" | "open" | "signed-in" | "levels";

function whoOf(rule: RuleConfig | undefined): Who {
	if (!rule) return "none";
	if (rule.open) return "open";
	return rule.levels.length && !rule.levels.includes(SIGNED_IN) ? "levels" : "signed-in";
}

function whoOptions(none: string | null, open = true) {
	return [
		...(none ? [{ label: none, value: "none" }] : []),
		...(open ? [{ label: "Free to everyone", value: "open" }] : []),
		{ label: "Any signed-in member", value: "signed-in" },
		{ label: "Members with a level", value: "levels" },
	];
}

function levelOptions(levels: LevelConfig[]) {
	return levels.map((l) => ({ label: l.name, value: l.slug }));
}

function ruleFields(levels: LevelConfig[], rule: RuleConfig | undefined, none: string | null, open = true) {
	const who = whoOf(rule);
	return [
		{ type: "select", action_id: "who", label: "Who can read", options: whoOptions(none, open), initial_value: !open && who === "open" ? "none" : !none && who === "none" ? "signed-in" : who },
		...(levels.length
			? [{ type: "checkbox", action_id: "levels", label: "Levels (any one)", options: levelOptions(levels), initial_value: rule?.levels.filter((l) => l !== SIGNED_IN) ?? [], condition: { field: "who", eq: "levels" } }]
			: []),
		{ type: "number_input", action_id: "drip", label: "Days of membership first (0 = none)", min: 0, max: 3650, initial_value: rule?.drip ?? 0, condition: { field: "who", neq: "open" } },
		{ type: "toggle", action_id: "no_meter", label: "Never metered", initial_value: rule?.meter === false, condition: { field: "who", neq: "open" } },
	];
}

/** A rule from a rule form, or null for "none". Unknown levels are dropped. */
function ruleFrom(values: Record<string, unknown>, base: Omit<RuleConfig, "levels">, levels: LevelConfig[]): RuleConfig | { error: string } | null {
	const who = String(values.who ?? "none") as Who;
	if (who === "none") return null;
	const known = new Set(levels.map((l) => l.slug));
	const picked = list(values.levels).filter((l) => known.has(l));
	if (who === "levels" && picked.length === 0) return { error: "Tick at least one level, or pick another choice." };
	const rule: RuleConfig = { ...base, levels: who === "levels" ? picked : [] };
	if (who === "open") rule.open = true;
	const drip = days(values.drip);
	if (drip && who !== "open") rule.drip = drip;
	if (values.no_meter === true && who !== "open") rule.meter = false;
	return rule;
}

function sourceLine(env: AccessEnv, key: ManagedKey, what: string): unknown[] {
	const own = overridden(env.saved.site).has(key);
	const inCode = (env.code as Record<string, unknown>)[key] !== undefined;
	return [
		{
			type: "context",
			text: own
				? `${what}: set here.${inCode ? " The site's code has its own value, which this replaces." : ""}`
				: inCode
					? `${what}: from the site's code (astro.config.mjs). Saving here copies it and takes over.`
					: `${what}: none yet.`,
		},
		...(own && inCode
			? [{ type: "actions", elements: [{ type: "button", action_id: "reset", value: key, label: "Use the code's setting", style: "secondary", confirm: { title: "Use the code's setting?", text: "What was saved here for this setting is removed and the value in astro.config.mjs applies again.", confirm: "Use the code's setting", deny: "Cancel" } }] }]
			: []),
	];
}

function ruleText(rule: RuleConfig | undefined, levels: LevelConfig[]): string {
	if (!rule) return "—";
	if (rule.open) return "Free to everyone";
	const who = rule.levels.length ? describe([rule.levels], levels) : "Any signed-in member";
	const extra = [rule.drip ? `after ${rule.drip} days` : "", rule.meter === false ? "never metered" : ""].filter(Boolean).join(", ");
	return extra ? `${who} (${extra})` : who;
}

// ---------------------------------------------------------------- tabs

function levelsTab(env: AccessEnv, editing?: string): unknown[] {
	const config = effective(env);
	const levels = config.levels ?? [];
	const rules = config.rules ?? [];
	const used = (slug: string) => rules.filter((r) => r.levels.includes(slug)).length;
	const current = editing ? levels.find((l) => l.slug === editing) : undefined;
	return [
		{ type: "context", text: "A level is a name for readers who hold some Shopify customer tags. Name them anything. Tags come from Shopify (Flow, a subscription app or staff), never from this site." },
		...sourceLine(env, "levels", "Levels"),
		levels.length
			? {
					type: "table",
					page_action_id: "levels_table",
					// Three columns so it fits a phone; the slug and use count ride along.
					columns: [
						{ key: "name", label: "Level" },
						{ key: "tags", label: "Shopify tags" },
						{ key: "act", label: "", format: "element" },
					],
					rows: levels.map((l) => ({
						name: `${l.name} (${l.slug}${used(l.slug) ? `, ${used(l.slug)} ${used(l.slug) === 1 ? "rule" : "rules"}` : ""})`,
						tags: `${l.tags.join(", ")}${l.tags.length > 1 ? (l.match === "all" ? " (all)" : " (any)") : ""}`,
						act: { type: "menu", action_id: "level_menu", label: "Edit", items: [{ label: "Edit", value: `edit:${l.slug}` }, { label: "Remove", value: `remove:${l.slug}` }] },
					})),
				}
			: { type: "empty", title: "No levels yet", description: "Add one below, such as Members for the tag member.", size: "sm" },
		{ type: "header", text: current ? `Edit ${current.name}` : "Add a level" },
		{
			type: "form",
			block_id: current ? `level:${current.slug}` : "level:new",
			fields: [
				{ type: "text_input", action_id: "name", label: "Name", placeholder: "Members", initial_value: current?.name ?? "" },
				...(current ? [] : [{ type: "text_input", action_id: "slug", label: "Slug (optional, fixed once saved)", placeholder: "members" }]),
				{ type: "text_input", action_id: "tags", label: "Shopify tags, comma separated", placeholder: "member", initial_value: current?.tags.join(", ") ?? "" },
				{ type: "select", action_id: "match", label: "Customer needs", options: [{ label: "Any one tag", value: "any" }, { label: "Every tag", value: "all" }], initial_value: current?.match ?? "any" },
				{ type: "text_input", action_id: "wall", label: "Wall text (optional)", initial_value: current?.wall ?? "", multiline: true },
				{ type: "text_input", action_id: "join_url", label: "Join link (optional)", placeholder: "/join/", initial_value: current?.joinUrl ?? "" },
			],
			submit: { label: current ? "Save level" : "Add level", action_id: "level_save" },
		},
		...(current ? [{ type: "actions", elements: [{ type: "button", action_id: "level_cancel", label: "Cancel", style: "secondary" }] }] : []),
	];
}

function siteTab(env: AccessEnv): unknown[] {
	const config = effective(env);
	const levels = config.levels ?? [];
	const site = (config.rules ?? []).find((r) => r.collection === "*" && !r.taxonomy && !r.term);
	const meter = config.meter;
	return [
		{ type: "context", text: "What applies when nothing more specific does, how rules combine, the meter and the join link." },
		...sourceLine(env, "rules", "Rules"),
		{
			type: "form",
			block_id: "site",
			fields: [
				...ruleFields(levels, site, "Free to everyone", false),
				{ type: "select", action_id: "combine", label: "Several term rules on one entry", options: [{ label: "Pass every one", value: "all" }, { label: "Pass any one", value: "any" }], initial_value: config.combine ?? "all" },
				{ type: "number_input", action_id: "meter_limit", label: "Meter: free locked reads per period (0 = off)", min: 0, max: 1000, initial_value: meter?.limit ?? 0 },
				{ type: "select", action_id: "meter_period", label: "Meter period", options: [{ label: "Month", value: "month" }, { label: "Week", value: "week" }], initial_value: meter?.period ?? "month" },
				...(env.collections.length
					? [{ type: "checkbox", action_id: "meter_collections", label: "Meter covers (none ticked = all)", options: env.collections.map((c) => ({ label: c.label, value: c.slug })), initial_value: meter?.collections ?? [] }]
					: []),
				{ type: "text_input", action_id: "join_href", label: "Join link", placeholder: "/join/", initial_value: config.join?.href ?? "" },
				{ type: "text_input", action_id: "join_label", label: "Join link text", placeholder: "Become a member", initial_value: config.join?.label ?? "" },
			],
			submit: { label: "Save site rules", action_id: "site_save" },
		},
		...sourceLine(env, "meter", "Meter"),
		...sourceLine(env, "join", "Join link"),
	];
}

function typesTab(env: AccessEnv): unknown[] {
	const config = effective(env);
	const levels = config.levels ?? [];
	const rules = config.rules ?? [];
	if (env.collections.length === 0) return [{ type: "empty", title: "No content types yet", size: "sm" }];
	return [
		{ type: "context", text: "Who can read each content type. New content types appear here as soon as they're made. Term rules (Terms tab) and an entry's own rule (its Access panel) beat these." },
		...sourceLine(env, "rules", "Rules"),
		...env.collections.map((c) => {
			const rule = rules.find((r) => r.collection === c.slug && !r.taxonomy && !r.term);
			const teaser = config.teaser?.[c.slug] ?? 0;
			return {
				type: "accordion",
				label: `${c.label}: ${rule ? ruleText(rule, levels) : "follows the site default"}`,
				blocks: [
					{
						type: "form",
						block_id: `type:${c.slug}`,
						fields: [
							...ruleFields(levels, rule, "Follow the site default"),
							{ type: "number_input", action_id: "teaser", label: "Teaser words without a paywall break (0 = none)", min: 0, max: 2000, initial_value: teaser },
						],
						submit: { label: `Save ${c.label}`, action_id: "type_save" },
					},
				],
			};
		}),
	];
}

async function taxonomiesTab(env: AccessEnv): Promise<unknown[]> {
	const config = effective(env);
	const levels = config.levels ?? [];
	const rules = config.rules ?? [];
	if (env.taxonomies.length === 0) return [{ type: "empty", title: "No taxonomies yet", size: "sm" }];
	const label = (slug: string) => (slug === "*" ? "Every content type" : (env.collections.find((c) => c.slug === slug)?.label ?? slug));
	const out: unknown[] = [
		{ type: "context", text: "Rules for entries with a term, such as a category. A child term follows its parent's rule unless it has its own. New taxonomies appear here as soon as they're made." },
		...sourceLine(env, "rules", "Rules"),
	];
	for (const t of env.taxonomies) {
		const own = rules.filter((r) => r.taxonomy === t.name && r.term);
		const terms = await env.terms(t.name);
		const termLabel = (slug: string) => terms.find((x) => x.slug === slug)?.label ?? slug;
		out.push({
			type: "accordion",
			label: `${t.label}: ${own.length} ${own.length === 1 ? "rule" : "rules"}`,
			default_open: own.length > 0,
			blocks: [
				own.length
					? {
							type: "table",
							page_action_id: `term_rules:${t.name}`,
							columns: [
								{ key: "term", label: "Term" },
								{ key: "who", label: "Who can read" },
								{ key: "act", label: "", format: "element" },
							],
							rows: own.map((r) => ({
								term: r.collection === "*" ? termLabel(r.term!) : `${termLabel(r.term!)} (${label(r.collection)} only)`,
								who: ruleText(r, levels),
								act: { type: "button", action_id: "term_remove", label: "Remove", style: "secondary", value: `${r.collection}|${t.name}|${r.term}`, confirm: { title: "Remove this term rule?", text: "Its entries follow the other rules again.", confirm: "Remove", deny: "Cancel" } },
							})),
						}
					: { type: "context", text: "No rules: its terms don't change who can read." },
				terms.length
					? {
							type: "form",
							block_id: `term:${t.name}`,
							fields: [
								{ type: "combobox", action_id: "term", label: "Term", options: terms.map((x) => ({ label: x.label, value: x.slug })) },
								{ type: "select", action_id: "scope", label: "In", options: [{ label: "Every content type", value: "*" }, ...t.collections.map((c) => ({ label: label(c), value: c }))], initial_value: "*" },
								...ruleFields(levels, undefined, null),
							],
							submit: { label: "Save term rule", action_id: "term_save" },
						}
					: { type: "context", text: "Add terms to this taxonomy to give them rules." },
			],
		});
	}
	return out;
}

function featuresTab(env: AccessEnv, editing?: string): unknown[] {
	const config = effective(env);
	const levels = config.levels ?? [];
	const features = config.features ?? [];
	const current = editing ? features.find((f) => f.slug === editing) : undefined;
	return [
		{ type: "context", text: "Perks members hold through a level or a Shopify tag, such as ad-free reading. Pages check them with <Feature>." },
		...sourceLine(env, "features", "Features"),
		features.length
			? {
					type: "table",
					page_action_id: "features_table",
					columns: [
						{ key: "name", label: "Feature" },
						{ key: "from", label: "Held through" },
						{ key: "act", label: "", format: "element" },
					],
					rows: features.map((f) => ({
						name: `${f.name} (${f.slug})`,
						from: [...(f.levels ?? []).map((l) => levels.find((x) => x.slug === l)?.name ?? l), ...(f.tags ?? []).map((t) => `tag ${t}`)].join(", ") || "—",
						act: { type: "menu", action_id: "feature_menu", label: "Edit", items: [{ label: "Edit", value: `edit:${f.slug}` }, { label: "Remove", value: `remove:${f.slug}` }] },
					})),
				}
			: { type: "context", text: "No features." },
		{ type: "header", text: current ? `Edit ${current.name}` : "Add a feature" },
		{
			type: "form",
			block_id: current ? `feature:${current.slug}` : "feature:new",
			fields: [
				{ type: "text_input", action_id: "name", label: "Name", placeholder: "Ad-free", initial_value: current?.name ?? "" },
				...(current ? [] : [{ type: "text_input", action_id: "slug", label: "Slug (optional, fixed once saved)", placeholder: "ad-free" }]),
				...(levels.length ? [{ type: "checkbox", action_id: "levels", label: "Levels that hold it", options: levelOptions(levels), initial_value: current?.levels ?? [] }] : []),
				{ type: "text_input", action_id: "tags", label: "Shopify tags, comma separated (optional)", initial_value: current?.tags?.join(", ") ?? "" },
			],
			submit: { label: current ? "Save feature" : "Add feature", action_id: "feature_save" },
		},
	];
}

function filesTab(env: AccessEnv): unknown[] {
	const config = effective(env);
	const levels = config.levels ?? [];
	const features = config.features ?? [];
	const files = config.files ?? [];
	const describeRule = (f: FileRule) =>
		[
			f.levels ? (f.levels.length ? describe([f.levels], levels) : "Any signed-in member") : "",
			...(f.features ?? []).map((s) => `feature ${features.find((x) => x.slug === s)?.name ?? s}`),
			f.entries ? "readers of an entry that uses the file" : "",
		]
			.filter(Boolean)
			.join("; ") || "Nobody (no way in picked)";
	return [
		{ type: "context", text: "Media folders whose files only some readers may download. Any of the ways in is enough." },
		...sourceLine(env, "files", "Protected files"),
		files.length
			? {
					type: "table",
					page_action_id: "files_table",
					columns: [
						{ key: "folder", label: "Media folder" },
						{ key: "who", label: "Who can download" },
						{ key: "act", label: "", format: "element" },
					],
					rows: files.map((f) => ({ folder: f.folder, who: describeRule(f), act: { type: "button", action_id: "file_remove", label: "Remove", style: "secondary", value: f.folder, confirm: { title: "Stop protecting this folder?", text: "Anyone with a file's link can download it again.", confirm: "Remove", deny: "Cancel" } } })),
				}
			: { type: "context", text: "No protected folders: every file is public." },
		{ type: "header", text: "Protect a folder" },
		{
			type: "form",
			block_id: "file",
			fields: [
				{ type: "text_input", action_id: "folder", label: "Media folder name", placeholder: "Member downloads" },
				{ type: "toggle", action_id: "members", label: "Signed-in members", initial_value: true },
				...(levels.length ? [{ type: "checkbox", action_id: "levels", label: "Only these levels (none = any member)", options: levelOptions(levels), condition: { field: "members", eq: true } }] : []),
				...(features.length ? [{ type: "checkbox", action_id: "features", label: "Features", options: features.map((f) => ({ label: f.name, value: f.slug })) }] : []),
				{ type: "toggle", action_id: "entries", label: "Readers of an entry that uses it", initial_value: false },
			],
			submit: { label: "Save folder", action_id: "file_save" },
		},
	];
}

/** The Access page, opened on `tab`. */
export async function accessPage(env: AccessEnv, tab: Tab = "levels", toast?: Toast, edit?: { level?: string; feature?: string }): Promise<Blocks> {
	const panels = [
		// Four short tabs so they fit across a phone without scrolling the page.
		{ label: "Levels", blocks: [...levelsTab(env, edit?.level), { type: "divider" }, { type: "header", text: "Features" }, ...featuresTab(env, edit?.feature)] },
		{ label: "Rules", blocks: [{ type: "header", text: "Site default" }, ...siteTab(env), { type: "divider" }, { type: "header", text: "Content types" }, ...typesTab(env)] },
		{ label: "Terms", blocks: await taxonomiesTab(env) },
		{ label: "Files", blocks: filesTab(env) },
	];
	return {
		toast,
		blocks: [
			{ type: "header", text: "Access" },
			{ type: "context", text: "Who can read what. Shopify decides who holds which tags; these settings only say what each tag opens." },
			{ type: "tab", panels, default_tab: PANEL[tab] ?? 0 },
		],
	};
}

// ---------------------------------------------------------------- saving

async function saveSite(env: AccessEnv, change: (site: SiteAccess, now: RedeemIDConfig) => SiteAccess | string): Promise<string | null> {
	const now = effective(env);
	const site: SiteAccess = structuredClone(env.saved.site ?? { kind: "site" });
	const out = change(site, now);
	if (typeof out === "string") return out;
	out.updatedAt = new Date().toISOString();
	await env.store.put(SITE_ID, out);
	env.saved = { ...env.saved, site: out };
	return null;
}

/** The current value of a setting, to start from when the admin first takes it over. */
function start<K extends ManagedKey>(site: SiteAccess, now: RedeemIDConfig, key: K): NonNullable<RedeemIDConfig[K]> {
	const value = (key in site ? site[key as keyof SiteAccess] : now[key]) as RedeemIDConfig[K] | null | undefined;
	return structuredClone(value ?? (key === "teaser" ? {} : [])) as NonNullable<RedeemIDConfig[K]>;
}

function newSlug(values: Record<string, unknown>, taken: string[]): string | { error: string } {
	const raw = String(values.slug ?? "").trim() || String(values.name ?? "");
	const slug = slugify(raw);
	if (!validSlug(slug)) return { error: "Give it a name or slug with letters or numbers (\"signed-in\" is built in)." };
	if (taken.includes(slug)) return { error: `"${slug}" is already used.` };
	return slug;
}

export interface Interaction {
	action_id?: string;
	block_id?: string;
	value?: unknown;
	values?: Record<string, unknown>;
}

const ACCESS_ACTIONS = new Set(["reset", "level_menu", "level_cancel", "level_save", "site_save", "type_save", "term_save", "term_remove", "feature_menu", "feature_save", "file_save", "file_remove"]);

export function isAccessAction(id: string | undefined): boolean {
	return Boolean(id && ACCESS_ACTIONS.has(id));
}

/** Handle one interaction on the Access page. */
export async function accessAction(env: AccessEnv, i: Interaction): Promise<Blocks> {
	const values = i.values ?? {};
	const ok = (tab: Tab, message: string) => accessPage(env, tab, { type: "success", message });
	const bad = (tab: Tab, message: string, edit?: { level?: string; feature?: string }) => accessPage(env, tab, { type: "error", message }, edit);
	const target = String(i.block_id ?? "").split(":").slice(1).join(":");

	switch (i.action_id) {
		case "reset": {
			const key = String(i.value ?? "") as ManagedKey;
			if (!MANAGED.includes(key)) return accessPage(env);
			await saveSite(env, (site) => {
				delete site[key as keyof SiteAccess];
				return site;
			});
			const tab: Tab = key === "levels" ? "levels" : key === "features" ? "features" : key === "files" ? "files" : key === "teaser" ? "types" : "site";
			return ok(tab, "Using the code's setting again.");
		}

		case "level_cancel":
			return accessPage(env, "levels");

		case "level_menu": {
			const [verb, slug] = String(i.value ?? "").split(":");
			if (verb === "edit") return accessPage(env, "levels", undefined, { level: slug });
			const now = effective(env);
			const used = (now.rules ?? []).filter((r) => r.levels.includes(slug!)).length + (now.files ?? []).filter((f) => f.levels?.includes(slug!)).length + (now.features ?? []).filter((f) => f.levels?.includes(slug!)).length;
			if (used) return bad("levels", `Rules, features or folders use this level (${used}). Change them first.`);
			await saveSite(env, (site, n) => ({ ...site, levels: start(site, n, "levels").filter((l) => l.slug !== slug) }));
			return ok("levels", "Level removed.");
		}

		case "level_save": {
			const name = String(values.name ?? "").trim();
			const tags = list(values.tags);
			const editing = target !== "new" ? target : null;
			if (!name) return bad("levels", "Give the level a name.", { level: editing ?? undefined });
			if (tags.length === 0) return bad("levels", "Give it at least one Shopify tag.", { level: editing ?? undefined });
			const fail = await saveSite(env, (site, n) => {
				const levels = start(site, n, "levels");
				let slug = editing;
				if (!slug) {
					const made = newSlug(values, levels.map((l) => l.slug));
					if (typeof made !== "string") return made.error;
					slug = made;
				}
				const level: LevelConfig = { slug, name, tags, ...(values.match === "all" ? { match: "all" as const } : {}) };
				const wall = String(values.wall ?? "").trim();
				const joinUrl = String(values.join_url ?? "").trim();
				if (wall) level.wall = wall;
				if (joinUrl) level.joinUrl = joinUrl;
				const at = levels.findIndex((l) => l.slug === slug);
				if (at >= 0) levels[at] = level;
				else levels.push(level);
				return { ...site, levels };
			});
			return fail ? bad("levels", fail) : ok("levels", editing ? "Level saved." : "Level added.");
		}

		case "site_save": {
			const now = effective(env);
			const rule = ruleFrom(values, { collection: "*" }, now.levels ?? []);
			if (rule && "error" in rule) return bad("site", rule.error);
			const limit = Math.max(0, Math.floor(Number(values.meter_limit) || 0));
			const known = new Set(env.collections.map((c) => c.slug));
			const covered = list(values.meter_collections).filter((c) => known.has(c));
			const meter: MeterConfig | null = limit ? { limit, period: values.meter_period === "week" ? "week" : "month", ...(covered.length ? { collections: covered } : {}) } : null;
			const href = String(values.join_href ?? "").trim();
			const label = String(values.join_label ?? "").trim();
			await saveSite(env, (site, n) => {
				const rules = start(site, n, "rules").filter((r) => !(r.collection === "*" && !r.taxonomy && !r.term));
				if (rule) rules.push(rule);
				return {
					...site,
					rules,
					combine: values.combine === "any" ? "any" : "all",
					meter,
					join: href ? { href, ...(label ? { label } : {}) } : null,
				};
			});
			return ok("site", "Site rules saved.");
		}

		case "type_save": {
			const now = effective(env);
			if (!env.collections.some((c) => c.slug === target)) return bad("types", "That content type is gone.");
			const rule = ruleFrom(values, { collection: target }, now.levels ?? []);
			if (rule && "error" in rule) return bad("types", rule.error);
			const words = Math.max(0, Math.min(2000, Math.floor(Number(values.teaser) || 0)));
			await saveSite(env, (site, n) => {
				const rules = start(site, n, "rules").filter((r) => !(r.collection === target && !r.taxonomy && !r.term));
				if (rule) rules.push(rule);
				const teaser = start(site, n, "teaser");
				if (words) teaser[target] = words;
				else delete teaser[target];
				return { ...site, rules, teaser };
			});
			return ok("types", "Saved.");
		}

		case "term_save": {
			const now = effective(env);
			const taxonomy = env.taxonomies.find((t) => t.name === target);
			const term = String(values.term ?? "").trim();
			const scope = String(values.scope ?? "*");
			if (!taxonomy) return bad("taxonomies", "That taxonomy is gone.");
			if (!term) return bad("taxonomies", "Pick a term.");
			if (scope !== "*" && !taxonomy.collections.includes(scope)) return bad("taxonomies", "Pick where the rule applies.");
			const rule = ruleFrom({ ...values, who: values.who === "none" ? "signed-in" : values.who }, { collection: scope, taxonomy: taxonomy.name, term }, now.levels ?? []);
			if (!rule) return bad("taxonomies", "Pick who can read.");
			if ("error" in rule) return bad("taxonomies", rule.error);
			await saveSite(env, (site, n) => {
				const rules = start(site, n, "rules").filter((r) => !(r.collection === scope && r.taxonomy === taxonomy.name && r.term === term));
				rules.push(rule);
				return { ...site, rules };
			});
			return ok("taxonomies", "Term rule saved.");
		}

		case "term_remove": {
			const [collection, taxonomy, term] = String(i.value ?? "").split("|");
			await saveSite(env, (site, n) => ({ ...site, rules: start(site, n, "rules").filter((r) => !(r.collection === collection && r.taxonomy === taxonomy && r.term === term)) }));
			return ok("taxonomies", "Term rule removed.");
		}

		case "feature_menu": {
			const [verb, slug] = String(i.value ?? "").split(":");
			if (verb === "edit") return accessPage(env, "features", undefined, { feature: slug });
			const usedBy = (effective(env).files ?? []).filter((f) => f.features?.includes(slug!)).length;
			if (usedBy) return bad("features", "A protected folder uses this feature. Change it first.");
			await saveSite(env, (site, n) => ({ ...site, features: start(site, n, "features").filter((f) => f.slug !== slug) }));
			return ok("features", "Feature removed.");
		}

		case "feature_save": {
			const name = String(values.name ?? "").trim();
			const editing = target !== "new" ? target : null;
			if (!name) return bad("features", "Give the feature a name.", { feature: editing ?? undefined });
			const known = new Set((effective(env).levels ?? []).map((l) => l.slug));
			const levels = list(values.levels).filter((l) => known.has(l));
			const tags = list(values.tags);
			if (!levels.length && !tags.length) return bad("features", "Tick a level or give a tag that holds it.", { feature: editing ?? undefined });
			const fail = await saveSite(env, (site, n) => {
				const features = start(site, n, "features");
				let slug = editing;
				if (!slug) {
					const made = newSlug(values, features.map((f) => f.slug));
					if (typeof made !== "string") return made.error;
					slug = made;
				}
				const feature: FeatureConfig = { slug, name, ...(levels.length ? { levels } : {}), ...(tags.length ? { tags } : {}) };
				const at = features.findIndex((f) => f.slug === slug);
				if (at >= 0) features[at] = feature;
				else features.push(feature);
				return { ...site, features };
			});
			return fail ? bad("features", fail) : ok("features", "Feature saved.");
		}

		case "file_save": {
			const now = effective(env);
			const folder = String(values.folder ?? "").trim();
			if (!folder) return bad("files", "Give the media folder's name.");
			const knownLevels = new Set((now.levels ?? []).map((l) => l.slug));
			const knownFeatures = new Set((now.features ?? []).map((f) => f.slug));
			const rule: FileRule = { folder };
			if (values.members === true) rule.levels = list(values.levels).filter((l) => knownLevels.has(l));
			const features = list(values.features).filter((f) => knownFeatures.has(f));
			if (features.length) rule.features = features;
			if (values.entries === true) rule.entries = true;
			if (!rule.levels && !rule.features && !rule.entries) return bad("files", "Pick at least one way in.");
			await saveSite(env, (site, n) => {
				const files = start(site, n, "files").filter((f) => f.folder.trim().toLowerCase() !== folder.toLowerCase());
				files.push(rule);
				return { ...site, files };
			});
			return ok("files", "Folder protected.");
		}

		case "file_remove": {
			const folder = String(i.value ?? "").trim().toLowerCase();
			await saveSite(env, (site, n) => ({ ...site, files: start(site, n, "files").filter((f) => f.folder.trim().toLowerCase() !== folder) }));
			return ok("files", "Folder no longer protected.");
		}
	}
	return accessPage(env);
}

// ---------------------------------------------------------------- the editor's Access panel

export interface PanelEntry {
	collection: string;
	id: string;
	slug: string | null;
	terms: Terms;
}

const MODES = [
	{ label: "Follow the site rules", value: "inherit" },
	{ label: "Free to everyone", value: "open" },
	{ label: "Only some levels", value: "levels" },
	{ label: "Site rules plus a level", value: "add" },
];

function words(required: Requirement, levels: LevelConfig[]): string {
	return required === null ? "free to everyone" : `readers need ${describe(required, levels, "", "to be signed in")}`;
}

const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : "");

/** The entry's Access panel. */
export async function entryPanel(env: AccessEnv, entry: PanelEntry, toast?: Toast): Promise<Blocks> {
	const config = effective(env);
	const levels = config.levels ?? [];
	const rules = config.rules ?? [];
	const tree = await termTree(rules, entry.collection, entry.terms);
	const site = requirement(rules, entry.collection, entry.terms, { combine: config.combine, tree });
	const own = env.saved.entries.find((e) => e.entryId === entry.id && e.collection === entry.collection) ?? null;
	const now = applyEntryRule(site, own);
	const hasLevels = levels.length > 0;
	return {
		toast,
		blocks: [
			{ type: "section", text: `Right now: ${words(now, levels)}.` },
			{ type: "context", text: own && own.mode !== "inherit" ? "Set by: this entry's own rule." : `Set by: ${ruleSource(rules, entry.collection, entry.terms, tree)}.` },
			{
				type: "form",
				block_id: "entry",
				fields: [
					{ type: "select", action_id: "mode", label: "Who can read it", options: MODES, initial_value: own?.mode ?? "inherit" },
					...(hasLevels
						? [{ type: "checkbox", action_id: "levels", label: "Levels (any one; none = any member)", options: levelOptions(levels), initial_value: own?.levels ?? [], condition: { field: "mode", neq: "inherit" } }]
						: []),
					{ type: "number_input", action_id: "drip", label: "Days of membership first (0 = rules decide)", min: 0, max: 3650, initial_value: own?.drip ?? 0 },
					{ type: "toggle", action_id: "no_meter", label: "Never metered", initial_value: own?.meter === false },
					{ type: "date_input", action_id: "locked_until", label: "Locked until (then free, UTC)", initial_value: day(own?.lockedUntil) },
					{ type: "date_input", action_id: "open_until", label: "Free until (then locked, UTC)", initial_value: day(own?.openUntil) },
				],
				submit: { label: "Save access", action_id: "entry_save" },
			},
			{ type: "context", text: "Paywall break and Members only blocks can still lock parts of the body." },
		],
	};
}

function isoDay(raw: unknown): string | null {
	const s = String(raw ?? "").trim();
	if (!s) return null;
	const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s);
	return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** Save the entry's Access panel. */
export async function entrySave(env: AccessEnv, entry: PanelEntry, values: Record<string, unknown>): Promise<Blocks> {
	const levels = effective(env).levels ?? [];
	const known = new Set(levels.map((l) => l.slug));
	const mode = (["inherit", "open", "levels", "add"].includes(String(values.mode)) ? String(values.mode) : "inherit") as EntryRule["mode"];
	const picked = list(values.levels).filter((l) => known.has(l));
	if (mode === "add" && picked.length === 0) return entryPanel(env, entry, { type: "error", message: "Tick the level readers also need." });
	const rule: EntryRule = {
		kind: "entry",
		collection: entry.collection,
		entryId: entry.id,
		slug: entry.slug,
		mode,
		levels: mode === "levels" || mode === "add" ? picked : [],
		updatedAt: new Date().toISOString(),
	};
	const drip = days(values.drip);
	if (drip) rule.drip = drip;
	if (values.no_meter === true) rule.meter = false;
	rule.lockedUntil = isoDay(values.locked_until);
	rule.openUntil = isoDay(values.open_until);
	const empty = mode === "inherit" && !rule.drip && rule.meter !== false && !rule.lockedUntil && !rule.openUntil;
	if (empty) await env.store.delete(entryKey(entry.id));
	else await env.store.put(entryKey(entry.id), rule);
	env.saved = { ...env.saved, entries: [...env.saved.entries.filter((e) => e.entryId !== entry.id), ...(empty ? [] : [rule])] };
	return entryPanel(env, entry, { type: "success", message: empty ? "This entry follows the site rules." : "Access saved." });
}

/** Keep an entry's own rule in step with its slug, and drop it with the entry. */
export async function entrySlugChanged(store: StorageCollection<AccessRecord>, collection: string, id: string, slug: string | null): Promise<void> {
	const rule = (await store.get(entryKey(id))) as EntryRule | null;
	if (rule?.kind === "entry" && rule.collection === collection && rule.slug !== slug) await store.put(entryKey(id), { ...rule, slug });
}
