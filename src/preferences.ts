/**
 * Member preferences: customer metafields members may see or change, such as
 * the topics they follow. Shopify defines each field (Settings → Custom data
 * → Customers); `preferences` in the config picks which ones members get, and
 * whether they may change them. Answers live on the Shopify customer, where
 * Flow, segments and email can use them. The site keeps no copy.
 *
 * Reading and saving use the Admin API app (the staff tools' client ID), and
 * always on the signed-in member's own customer. Preferences never open
 * content: access still comes only from tags.
 */

import { admin, adminConfigured, AdminError } from "./admin-api.js";
import type { PreferenceConfig, RedeemIDConfig } from "./config.js";
import type { MemberRecord } from "./storage.js";

/** Metafield types members can use, and the value each takes. */
export const PREFERENCE_TYPES = [
	"single_line_text_field",
	"multi_line_text_field",
	"list.single_line_text_field",
	"boolean",
	"number_integer",
	"number_decimal",
	"date",
] as const;
export type PreferenceType = (typeof PREFERENCE_TYPES)[number];
export type PreferenceValue = string | string[] | boolean | number | null;

export interface PreferenceField {
	/** "namespace.key" */
	key: string;
	name: string;
	description: string | null;
	type: PreferenceType;
	choices: string[] | null;
	/** Length for text, value for numbers and dates. */
	min: string | null;
	max: string | null;
	editable: boolean;
	value: PreferenceValue;
}

export type Refusal = "unknown_field" | "read_only" | "invalid_type" | "invalid_choice" | "invalid_length" | "invalid_range";

export class PreferenceError extends Error {
	constructor(
		message: string,
		readonly fields: Record<string, Refusal> = {},
	) {
		super(message);
	}
}

/** Saves allowed per member per minute. */
export const SAVES_PER_MINUTE = 10;
const DEFINITIONS_TTL_MS = 5 * 60 * 1000;
/** RedeemID reads membership dates from this namespace, so members never get it. */
const RESERVED_NAMESPACE = "membership";

type Definition = Omit<PreferenceField, "editable" | "value">;
let cache: { at: number; shop: string; defs: Definition[] } | null = null;

export function resetPreferenceCache(): void {
	cache = null;
}

/** Can preferences run at all? */
export function preferencesConfigured(config: RedeemIDConfig | null): boolean {
	return Boolean(config?.preferences?.length && adminConfigured());
}

function wanted(config: RedeemIDConfig): PreferenceConfig[] {
	return (config.preferences ?? []).filter((p) => /^[\w-]+\.[\w-]+$/.test(p.key) && !p.key.startsWith(`${RESERVED_NAMESPACE}.`));
}

/** The customer metafield definitions Shopify has for the configured keys, cached for five minutes. */
export async function definitions(config: RedeemIDConfig, fetcher: typeof fetch = fetch): Promise<Definition[]> {
	const shop = config.shop ?? "";
	if (cache && cache.shop === shop && Date.now() - cache.at < DEFINITIONS_TTL_MS) return cache.defs;
	type Node = { namespace: string; key: string; name: string; description: string | null; type: { name: string }; validations: Array<{ name: string; value: string | null }> };
	const data = await admin<{ metafieldDefinitions: { nodes: Node[] } }>(
		config,
		`query RedeemIDPreferenceDefinitions { metafieldDefinitions(ownerType: CUSTOMER, first: 250) { nodes { namespace key name description type { name } validations { name value } } } }`,
		{},
		fetcher,
	);
	const defs = data.metafieldDefinitions.nodes
		.filter((n) => (PREFERENCE_TYPES as readonly string[]).includes(n.type.name))
		.map((n) => {
			const v = (name: string) => n.validations.find((x) => x.name === name)?.value ?? null;
			let choices: string[] | null = null;
			try {
				const raw = v("choices");
				const parsed = raw ? (JSON.parse(raw) as unknown) : null;
				if (Array.isArray(parsed)) choices = parsed.map(String);
			} catch {
				choices = null;
			}
			return {
				key: `${n.namespace}.${n.key}`,
				name: n.name,
				description: n.description || null,
				type: n.type.name as PreferenceType,
				choices,
				// Length for text types, value for numbers and dates.
				min: v("min") || null,
				max: v("max") || null,
			};
		});
	cache = { at: Date.now(), shop, defs };
	return defs;
}

/** Turn a stored metafield value into what members see. */
export function decode(type: PreferenceType, raw: string | null | undefined): PreferenceValue {
	if (raw == null || raw === "") return type.startsWith("list.") ? [] : null;
	switch (type) {
		case "list.single_line_text_field":
			try {
				const v = JSON.parse(raw) as unknown;
				return Array.isArray(v) ? v.map(String) : [];
			} catch {
				return [];
			}
		case "boolean":
			return raw === "true";
		case "number_integer":
			return Number.parseInt(raw, 10);
		default:
			return raw;
	}
}

const isEmpty = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

/**
 * Check one value against its definition. Returns the metafield value to
 * save, null to clear the field, or a refusal.
 */
export function encode(def: Definition, input: unknown): { value: string | null } | { refused: Refusal } {
	if (isEmpty(input)) return { value: null };
	const len = (s: string) => {
		if (def.min !== null && s.length < Number(def.min)) return false;
		if (def.max !== null && s.length > Number(def.max)) return false;
		return true;
	};
	const choice = (s: string) => !def.choices || def.choices.includes(s);
	switch (def.type) {
		case "single_line_text_field":
		case "multi_line_text_field": {
			if (typeof input !== "string") return { refused: "invalid_type" };
			const s = def.type === "single_line_text_field" ? input.trim() : input;
			if (def.type === "single_line_text_field" && /[\r\n]/.test(s)) return { refused: "invalid_type" };
			if (!choice(s)) return { refused: "invalid_choice" };
			if (!len(s)) return { refused: "invalid_length" };
			return { value: s };
		}
		case "list.single_line_text_field": {
			const list = typeof input === "string" ? [input] : input;
			if (!Array.isArray(list) || list.some((x) => typeof x !== "string")) return { refused: "invalid_type" };
			const items = [...new Set((list as string[]).map((x) => x.trim()).filter(Boolean))];
			if (items.some((x) => /[\r\n]/.test(x))) return { refused: "invalid_type" };
			if (!items.every(choice)) return { refused: "invalid_choice" };
			if (!items.every(len)) return { refused: "invalid_length" };
			return { value: items.length ? JSON.stringify(items) : null };
		}
		case "boolean": {
			const b = input === true || input === "true" || input === "on" ? true : input === false || input === "false" ? false : null;
			if (b === null) return { refused: "invalid_type" };
			return { value: String(b) };
		}
		case "number_integer":
		case "number_decimal": {
			const s = typeof input === "number" ? String(input) : typeof input === "string" ? input.trim() : "";
			const ok = def.type === "number_integer" ? /^-?\d+$/.test(s) : /^-?\d+(\.\d+)?$/.test(s);
			if (!ok) return { refused: "invalid_type" };
			const n = Number(s);
			if ((def.min !== null && n < Number(def.min)) || (def.max !== null && n > Number(def.max))) return { refused: "invalid_range" };
			return { value: s };
		}
		case "date": {
			const s = typeof input === "string" ? input.trim() : "";
			if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) return { refused: "invalid_type" };
			if ((def.min !== null && s < def.min.slice(0, 10)) || (def.max !== null && s > def.max.slice(0, 10))) return { refused: "invalid_range" };
			return { value: s };
		}
	}
}

/** The fields members can use, in config order, with their access. Without values. */
export async function preferenceFields(config: RedeemIDConfig, fetcher: typeof fetch = fetch): Promise<Array<Omit<PreferenceField, "value">>> {
	const defs = await definitions(config, fetcher);
	return wanted(config).flatMap((p) => {
		const def = defs.find((d) => d.key === p.key);
		return def ? [{ ...def, editable: p.access !== "view" }] : [];
	});
}

const gid = (id: string) => `gid://shopify/Customer/${id}`;

/** The member's fields with their current values, read from Shopify. */
export async function readPreferences(config: RedeemIDConfig, customerId: string, fetcher: typeof fetch = fetch): Promise<PreferenceField[]> {
	const fields = await preferenceFields(config, fetcher);
	if (fields.length === 0) return [];
	type Node = { namespace: string; key: string; value: string };
	const data = await admin<{ customer: { metafields: { nodes: Node[] } } | null }>(
		config,
		`query RedeemIDPreferences($id: ID!, $keys: [String!]) { customer(id: $id) { metafields(first: 100, keys: $keys) { nodes { namespace key value } } } }`,
		{ id: gid(customerId), keys: fields.map((f) => f.key) },
		fetcher,
	);
	if (!data.customer) throw new AdminError("Shopify has no such customer.");
	const values = new Map(data.customer.metafields.nodes.map((n) => [`${n.namespace}.${n.key}`, n.value]));
	return fields.map((f) => ({ ...f, value: decode(f.type, values.get(f.key)) }));
}

/** Room for one more save this minute? Records it when there is. */
export function allowSave(member: Pick<MemberRecord, "prefSaves">, now = Date.now()): number[] | null {
	const recent = (member.prefSaves ?? []).filter((t) => now - t < 60_000);
	if (recent.length >= SAVES_PER_MINUTE) return null;
	return [...recent, now];
}

/**
 * Save some of the member's fields to their Shopify customer, then read them
 * back. Every value is checked first; one refusal saves nothing. Keys left
 * out are left alone; an empty value clears the field.
 */
export async function savePreferences(
	config: RedeemIDConfig,
	customerId: string,
	values: Record<string, unknown>,
	fetcher: typeof fetch = fetch,
): Promise<{ fields: PreferenceField[]; changed: string[] }> {
	const fields = await preferenceFields(config, fetcher);
	const refused: Record<string, Refusal> = {};
	const set: Array<{ namespace: string; key: string; type: string; value: string }> = [];
	const clear: Array<{ namespace: string; key: string }> = [];
	for (const [key, input] of Object.entries(values)) {
		const f = fields.find((x) => x.key === key);
		if (!f) {
			refused[key] = "unknown_field";
			continue;
		}
		if (!f.editable) {
			refused[key] = "read_only";
			continue;
		}
		const out = encode(f, input);
		if ("refused" in out) {
			refused[key] = out.refused;
			continue;
		}
		const [namespace = "", k = ""] = key.split(".");
		if (out.value === null) clear.push({ namespace, key: k });
		else set.push({ namespace, key: k, type: f.type, value: out.value });
	}
	if (Object.keys(refused).length) throw new PreferenceError("Some answers weren't saved.", refused);

	const ownerId = gid(customerId);
	if (set.length) {
		const data = await admin<{ metafieldsSet: { userErrors: Array<{ field?: string[] | null; message: string }> } }>(
			config,
			`mutation RedeemIDSavePreferences($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { userErrors { field message } } }`,
			{ metafields: set.map((m) => ({ ownerId, ...m })) },
			fetcher,
		);
		const err = data.metafieldsSet.userErrors[0];
		if (err) throw new AdminError(err.message);
	}
	if (clear.length) {
		const data = await admin<{ metafieldsDelete: { userErrors: Array<{ message: string }> } }>(
			config,
			`mutation RedeemIDClearPreferences($metafields: [MetafieldIdentifierInput!]!) { metafieldsDelete(metafields: $metafields) { userErrors { field message } } }`,
			{ metafields: clear.map((m) => ({ ownerId, ...m })) },
			fetcher,
		);
		const err = data.metafieldsDelete.userErrors[0];
		if (err) throw new AdminError(err.message);
	}
	const changed = [...set, ...clear].map((m) => `${m.namespace}.${m.key}`);
	return { fields: await readPreferences(config, customerId, fetcher), changed };
}

/** Read a posted form into values: `pref:<key>` fields, with `present:<key>` marking checkboxes and lists that may be empty. */
export function formValues(form: FormData, fields: Array<Pick<PreferenceField, "key" | "type" | "editable">>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const f of fields) {
		if (!f.editable || !form.has(`present:${f.key}`)) continue;
		const all = form.getAll(`pref:${f.key}`).map(String);
		// A list without choices comes from a textarea: one answer per line.
		if (f.type === "list.single_line_text_field") out[f.key] = all.flatMap((v) => v.split(/\r?\n/));
		else if (f.type === "boolean") out[f.key] = all.includes("true");
		else out[f.key] = all[0] ?? "";
	}
	return out;
}
