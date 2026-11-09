/**
 * Answers for AI agents (EmDash's MCP server) and the command line: the same
 * questions the admin answers, as plain data. Staff only. Read-only by
 * default; the three actions (resync one member, resync a batch, edit a
 * member's tags in Shopify) are offered only with config `agents.actions`.
 *
 * Nothing here grants access on the site, edits a level or rule, or returns a
 * secret: Shopify still decides who is entitled, and settings show only
 * whether each value is set.
 */

import { adminConfigured } from "./admin-api.js";
import { describe as describeRequirement, dripDays, levelsFor, membership, passes, requirement, termTree, type Requirement, type Terms } from "./access.js";
import { ENV, env, storeDomain, type RedeemIDConfig } from "./config.js";
import { featuresFor } from "./features.js";
import { bodyClauses } from "./files.js";
import { cleanTags, numericId, type MemberRecord, type Stores } from "./storage.js";
import { textProblems } from "./text.js";

export class AgentError extends Error {}

export interface ExplainInput {
	collection: string;
	/** An entry's id or slug: its terms and body are read from the site. */
	id?: string;
	/** Terms by taxonomy, when no `id` is given: { category: ["investigations"] }. */
	terms?: Record<string, string[]>;
	/** A reader by their Shopify tags… */
	tags?: string[];
	/** …or a real member, by Shopify customer id. */
	customerId?: string;
	/** A signed-out visitor when false. Defaults to true. */
	signedIn?: boolean;
}

/** Can this reader read this entry, and why. */
export async function explainAccess(config: RedeemIDConfig, s: Stores, input: ExplainInput): Promise<Record<string, unknown>> {
	const levels = config.levels ?? [];
	const collection = input.collection.trim();
	if (!collection) throw new AgentError("collection is required");
	let terms: Terms = input.terms ?? {};
	let parts: string[][] = [];
	let entry: { id: string; title: string | null } | null = null;
	if (input.id) {
		const { getEmDashEntry } = await import("emdash");
		const result = (await getEmDashEntry(collection, input.id)) as { entry?: { id?: string; data?: Record<string, unknown> } | null } | null;
		const data = result?.entry?.data;
		if (!data) throw new AgentError(`No published ${collection} entry "${input.id}"`);
		terms = (data.terms as Terms | undefined) ?? {};
		const body = Object.values(data).find((v) => Array.isArray(v) && v.some((b) => typeof (b as { _type?: unknown })?._type === "string" && String((b as { _type: string })._type).startsWith("redeemid-")));
		parts = bodyClauses(body);
		entry = { id: String(result?.entry?.id ?? input.id), title: typeof data.title === "string" ? data.title : null };
	}

	let tags = cleanTags(input.tags ?? []);
	let member: MemberRecord | null = null;
	if (input.customerId) {
		const id = numericId(input.customerId);
		member = id ? await s.members.get(id) : null;
		if (!member) throw new AgentError(`No synced member with customer id ${input.customerId}`);
		tags = member.tags;
	}
	const signedIn = input.signedIn !== false || Boolean(member);
	const disabled = member?.status === "disabled";
	const held = disabled ? [] : levelsFor(tags, levels);
	const tree = await termTree(config.rules, collection, terms);
	const required: Requirement = requirement(config.rules, collection, terms, { combine: config.combine, tree });
	const canReadRule = required === null || (signedIn && !disabled && passes(held, required));
	const name = (slug: string) => levels.find((l) => l.slug === slug)?.name ?? slug;
	const partResults = parts.map((clause) => ({
		needs: clause.map(name),
		canRead: signedIn && !disabled && (clause.includes("signed-in") || clause.some((l) => held.includes(l))),
	}));
	const missing = required?.find((clause) => clause.length > 0 && !passes(held, [clause]));
	return {
		entry,
		collection,
		terms,
		reader: {
			signedIn,
			...(member ? { customerId: member.customerId, status: member.status } : {}),
			tags,
			levels: held.map(name),
		},
		needs: describeRequirement(required, levels),
		canRead: canReadRule,
		reason: canReadRule ? "allowed" : !signedIn ? "sign_in" : disabled ? "disabled" : "upgrade",
		offered: !canReadRule && missing ? name(missing[0] as string) : null,
		dripDays: dripDays(config.rules, collection, terms, tree),
		parts: partResults,
		note: "Drip and the meter depend on the member's dates and use, so they can still change what the page shows.",
	};
}

export function listLevels(config: RedeemIDConfig): Array<Record<string, unknown>> {
	return (config.levels ?? []).map((l) => ({ slug: l.slug, name: l.name, tags: l.tags, match: l.match ?? "any", wall: l.wall ?? null, joinUrl: l.joinUrl ?? null }));
}

export function getRules(config: RedeemIDConfig): Record<string, unknown> {
	return {
		combine: config.combine ?? "all",
		rules: config.rules ?? [],
		meter: config.meter ?? null,
		teaser: config.teaser ?? {},
		features: config.features ?? [],
		files: config.files ?? [],
	};
}

/** One synced member, by customer id or email. */
export async function getMember(config: RedeemIDConfig, s: Stores, input: { customerId?: string; email?: string }): Promise<Record<string, unknown>> {
	let m: MemberRecord | null = null;
	const id = input.customerId ? numericId(input.customerId) : null;
	if (id) m = await s.members.get(id);
	else if (input.email) {
		const { items } = await s.members.query({ where: { email: input.email.trim().toLowerCase() }, limit: 1 });
		m = items[0]?.data ?? null;
	} else throw new AgentError("Give customerId or email");
	if (!m) throw new AgentError("No synced member matches");
	const levels = config.levels ?? [];
	const { current, past } = membership(m, levels);
	const held = featuresFor(m, config.features, levels);
	return {
		customerId: m.customerId,
		email: m.email,
		name: [m.firstName, m.lastName].filter(Boolean).join(" ") || null,
		status: m.status,
		signedInHere: Boolean(m.userId),
		linkedAt: m.linkedAt ?? null,
		tags: m.tags,
		levels: current.map((l) => ({ slug: l.slug, name: l.name, since: l.since })),
		pastLevels: past.map((l) => ({ slug: l.slug, name: l.name, from: l.from, to: l.to })),
		features: (config.features ?? []).filter((f) => held.includes(f.slug)).map((f) => f.slug),
		syncedAt: m.syncedAt,
		source: m.source,
	};
}

/** What's set up, as yes or no: never a value. */
export async function siteHealth(config: RedeemIDConfig, s: Stores): Promise<Record<string, unknown>> {
	const { items } = await s.deliveries.query({ orderBy: { receivedAt: "desc" }, limit: 1 });
	const open = await s.requests.query({ where: { status: "open" }, limit: 50 });
	return {
		storeDomain: Boolean(storeDomain(config)),
		customerAccountClientId: Boolean(env(ENV.clientId)),
		webhookSecret: Boolean(env(ENV.webhookSecret)),
		adminApi: adminConfigured(),
		events: Boolean(config.events?.url) && Boolean(env(ENV.eventsSecret)),
		storefront: env(ENV.storefrontPrivateToken) ? "private token" : env(ENV.storefrontPublicToken) ? "public token" : "tokenless",
		lastWebhook: items[0]?.data ?? null,
		openPrivacyRequests: open.items.length,
		ignoredTextReplacements: textProblems(config).length,
	};
}

/** Who started or ended a level since a date, from each member's tag dates. */
export async function levelChanges(config: RedeemIDConfig, s: Stores, input: { since: string; level?: string }): Promise<Array<Record<string, unknown>>> {
	const since = Date.parse(input.since);
	if (Number.isNaN(since)) throw new AgentError("since must be a date, e.g. 2026-11-01");
	const levels = (config.levels ?? []).filter((l) => !input.level || l.slug === input.level);
	if (input.level && levels.length === 0) throw new AgentError(`No level "${input.level}"`);
	const out: Array<Record<string, unknown>> = [];
	let cursor: string | undefined;
	do {
		const page = await s.members.query({ limit: 100, cursor });
		for (const { data: m } of page.items) {
			const { current, past } = membership(m, config.levels ?? []);
			for (const l of current) if (levels.some((x) => x.slug === l.slug) && l.since && Date.parse(l.since) >= since) out.push({ customerId: m.customerId, email: m.email, level: l.slug, change: "joined", at: l.since });
			for (const l of past) if (levels.some((x) => x.slug === l.slug) && Date.parse(l.to) >= since) out.push({ customerId: m.customerId, email: m.email, level: l.slug, change: "left", at: l.to });
		}
		cursor = page.cursor;
	} while (cursor);
	return out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}
