/**
 * Staff tools in the admin (Block Kit): member detail with Resync and tag
 * edits written to Shopify, a paced manual bulk resync, webhook
 * registration and the access test.
 */

import { adminConfigured, adminScopes, editTags, registerWebhooks, resync, webhookSubscriptions, WEBHOOK_TOPICS } from "./admin-api.js";
import { applyEntryRule, describe, entryRuleFor, levelsFor, membership, passes, requirement, termTree, type Terms } from "./access.js";
import { PROVIDER_ID, type RedeemIDConfig } from "./config.js";
import { levelChange } from "./events.js";
import { featuresFor } from "./features.js";
import { record } from "./log.js";
import { recentRequests } from "./privacy.js";
import { cleanTags, memberForUser, numericId, type MemberRecord, type Stores } from "./storage.js";

/** Members resynced per click; well inside Shopify's query cost limits. */
/**
 * Members per bulk resync click. Each one costs a database write, and on the
 * Workers Free plan one request may make only 50 database queries (EmDash's
 * own session and settings reads included), so a batch has to leave room.
 */
export const BULK_BATCH = 25;

type Blocks = { blocks: unknown[]; toast?: { message: string; type: "success" | "error" | "info" } };

const date = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : "—");

/** Shopify's marketing state in words: SUBSCRIBED → "Subscribed". */
function consentLabel(state: string | null | undefined): string {
	if (!state) return "—";
	const t = state.toLowerCase().replace(/_/g, " ");
	return t.charAt(0).toUpperCase() + t.slice(1);
}

export function memberDetail(config: RedeemIDConfig, m: MemberRecord, toast?: Blocks["toast"]): Blocks {
	const levels = config.levels ?? [];
	const { current, past } = membership(m, levels);
	const features = featuresFor(m, config.features, levels);
	const featureNames = (config.features ?? []).filter((f) => features.includes(f.slug)).map((f) => f.name);
	const name = [m.firstName, m.lastName].filter(Boolean).join(" ") || m.email || `Customer ${m.customerId}`;
	return {
		toast,
		blocks: [
			{ type: "actions", elements: [{ type: "button", action_id: "members_back", label: "← All members", style: "secondary" }] },
			{ type: "header", text: name },
			{
				type: "fields",
				fields: [
					{ label: "Email", value: m.email ?? "—" },
					{ label: "Shopify customer", value: m.customerId },
					{ label: "Account", value: m.status === "enabled" ? "On" : "Turned off in Shopify" },
					{ label: "Signed in here", value: m.userId ? `Yes, first on ${date(m.linkedAt)}` : "Not yet" },
					{ label: "Levels", value: current.map((l) => `${l.name} (since ${date(l.since)})`).join(", ") || "—" },
					{ label: "Levels before", value: past.map((l) => `${l.name} (${date(l.from)} to ${date(l.to)})`).join(", ") || "—" },
					{ label: "Features", value: featureNames.join(", ") || "—" },
					{ label: "Member since (Shopify)", value: m.dates?.since ?? "—" },
					{ label: m.dates?.ends ? "Ends on (Shopify)" : "Renews on (Shopify)", value: m.dates?.ends ?? m.dates?.renews ?? "—" },
					{ label: "Gift until (Shopify)", value: m.dates?.gift ?? "—" },
					{ label: "Email verified", value: m.emailVerified === undefined ? "—" : m.emailVerified ? "Yes" : "No" },
					{ label: "Email marketing", value: consentLabel(m.emailMarketing) },
					{ label: "SMS marketing", value: consentLabel(m.smsMarketing) },
					{ label: "Last synced", value: `${m.syncedAt} (${m.source || "unknown"})` },
				],
			},
			{ type: "header", text: "Shopify tags" },
			m.tags.length
				? {
						type: "table",
						page_action_id: "member_tags",
						columns: [
							{ key: "tag", label: "Tag" },
							{ key: "since", label: "Since" },
							{ key: "remove", label: "", format: "element" },
						],
						rows: m.tags.map((t) => ({
							tag: t,
							since: date(m.tagsSince?.[t.toLowerCase()]),
							remove: adminConfigured()
								? {
										type: "button",
										action_id: "member_tag_remove",
										label: "Remove in Shopify",
										style: "danger",
										value: { customerId: m.customerId, tag: t },
										confirm: { title: "Remove this tag in Shopify?", text: `Removes "${t}" from the customer in Shopify. Access follows.`, confirm: "Remove", deny: "Cancel", style: "danger" },
									}
								: null,
						})),
					}
				: { type: "context", text: "No tags." },
			adminConfigured()
				? {
						type: "form",
						block_id: `tags:${m.customerId}`,
						fields: [{ type: "text_input", action_id: "tags", label: "Add tags in Shopify (comma separated)", placeholder: "gold-member" }],
						submit: { label: "Add in Shopify", action_id: "member_tag_add" },
					}
				: { type: "context", text: "Set the Admin API app's client ID to edit tags and resync from here." },
			adminConfigured()
				? { type: "actions", elements: [{ type: "button", action_id: "member_resync", label: "Resync from Shopify", style: "primary", value: m.customerId }] }
				: { type: "divider" },
			{ type: "context", text: "Tags are written to Shopify, then read back. Shopify stays the only source of access." },
			...linkSection(m),
			...privacySection(m.customerId),
		],
	};
}

/** Linking the customer to a site user whose email differs, on their detail page. */
function linkSection(m: MemberRecord): unknown[] {
	return [
		{ type: "header", text: "Site user" },
		{
			type: "context",
			text: m.userId
				? "This customer signs in as the site user linked below. Unlink to let their next sign-in pick the user by email again."
				: "Signing in links the customer to the site user with the same verified email. When their emails differ, link them here: their next sign-in uses that user.",
		},
		m.userId
			? {
					type: "actions",
					elements: [
						{
							type: "button",
							action_id: "member_unlink",
							label: "Unlink site user",
							style: "danger",
							value: m.customerId,
							confirm: { title: "Unlink this site user?", text: "Their levels stop applying to that user until a sign-in links a user again. Nothing changes in Shopify.", confirm: "Unlink", deny: "Cancel", style: "danger" },
						},
					],
				}
			: {
					type: "form",
					block_id: `link:${m.customerId}`,
					fields: [{ type: "text_input", action_id: "email", label: "Site user's email", placeholder: "reader@example.com" }],
					submit: { label: "Link", action_id: "member_link" },
				},
	];
}

/** The parts of EmDash's auth adapter that linking uses. */
export interface LinkAdapter {
	getUserByEmail(email: string): Promise<{ id: string; role: number; disabled: boolean } | null>;
	getOAuthAccount(provider: string, providerAccountId: string): Promise<{ userId: string } | null>;
	getOAuthAccountsByUserId(userId: string): Promise<Array<{ provider: string; providerAccountId: string }>>;
	createOAuthAccount(account: { provider: string; providerAccountId: string; userId: string }): Promise<unknown>;
	deleteOAuthAccount(provider: string, providerAccountId: string): Promise<void>;
}

/** EmDash's Subscriber role: anything above it is staff. */
const SUBSCRIBER = 10;

export class LinkError extends Error {}

/**
 * Link a customer to an existing site user by the user's email, for a member
 * whose store email differs. Only Subscribers, never staff, and never a user
 * already linked to another customer. Access still comes only from the
 * customer's Shopify tags.
 */
export async function staffLink(adapter: LinkAdapter, s: Stores, customerId: string, rawEmail: unknown): Promise<MemberRecord> {
	const m = await s.members.get(customerId);
	if (!m) throw new LinkError("That member is gone.");
	if (m.userId) throw new LinkError("This customer is already linked. Unlink first.");
	const email = String(rawEmail ?? "").trim().toLowerCase();
	if (!email.includes("@")) throw new LinkError("Give the site user's email.");
	const user = await adapter.getUserByEmail(email);
	if (!user) throw new LinkError("No site user has that email.");
	if (user.role > SUBSCRIBER) throw new LinkError("Staff accounts can't be linked to a store customer.");
	if (user.disabled) throw new LinkError("That site user is turned off.");
	const theirs = (await adapter.getOAuthAccountsByUserId(user.id)).find((a) => a.provider === PROVIDER_ID && a.providerAccountId !== customerId);
	const other = theirs ? null : await memberForUser(s, user.id);
	if (theirs || (other && other.customerId !== customerId)) throw new LinkError(`That site user is linked to customer ${theirs?.providerAccountId ?? other?.customerId}.`);
	const held = await adapter.getOAuthAccount(PROVIDER_ID, customerId);
	if (held && held.userId !== user.id) await adapter.deleteOAuthAccount(PROVIDER_ID, customerId);
	if (!held || held.userId !== user.id) await adapter.createOAuthAccount({ provider: PROVIDER_ID, providerAccountId: customerId, userId: user.id });
	const linked = { ...m, userId: user.id, linkedAt: m.linkedAt ?? new Date().toISOString() };
	await s.members.put(customerId, linked);
	await record({ event: "staff.link", label: "linked", status: "ok", origin: "staff", customerId });
	return linked;
}

/** Undo a link: the customer's next sign-in picks a user by email again. */
export async function staffUnlink(adapter: LinkAdapter, s: Stores, customerId: string): Promise<MemberRecord> {
	const m = await s.members.get(customerId);
	if (!m) throw new LinkError("That member is gone.");
	if (await adapter.getOAuthAccount(PROVIDER_ID, customerId)) await adapter.deleteOAuthAccount(PROVIDER_ID, customerId);
	const unlinked = { ...m, userId: null };
	await s.members.put(customerId, unlinked);
	await record({ event: "staff.link", label: "unlinked", status: "ok", origin: "staff", customerId });
	return unlinked;
}

/** Export and erase for one member, on their detail page. */
function privacySection(customerId: string): unknown[] {
	const erase = {
		type: "button",
		action_id: "member_erase",
		label: "Erase site data",
		style: "danger",
		value: customerId,
		confirm: {
			title: "Erase this member's data on the site?",
			text: "Removes their synced record and meter here. Their site user and everything in Shopify stay. If they sign in again they're linked again.",
			confirm: "Erase",
			deny: "Cancel",
			style: "danger",
		},
	};
	const shopify = adminConfigured()
		? [
				{
					type: "button",
					action_id: "member_shopify_erase",
					label: "Also request erasure in Shopify",
					style: "danger",
					value: customerId,
					confirm: {
						title: "Ask Shopify to erase this customer?",
						text: "Shopify erases the customer's personal data across the store, orders included, after a waiting period. Needs the write_customer_data_erasure scope.",
						confirm: "Request erasure",
						deny: "Cancel",
						style: "danger",
					},
				},
				{ type: "button", action_id: "member_shopify_cancel", label: "Cancel the Shopify erasure", style: "secondary", value: customerId },
			]
		: [];
	return [
		{ type: "header", text: "Privacy" },
		{ type: "actions", elements: [{ type: "button", action_id: "member_export", label: "Export data", style: "secondary", value: customerId }, erase, ...shopify] },
		{ type: "context", text: "Export shows everything RedeemID keeps about this member. Erasing removes it from the site; Shopify stays the record of the customer." },
	];
}

/** The member's export, as JSON, under their detail page. */
export function exportBlocks(detail: Blocks, data: unknown): Blocks {
	return { ...detail, blocks: [...detail.blocks, { type: "header", text: "Export" }, { type: "code", language: "jsonc", code: JSON.stringify(data, null, 2) }] };
}

/** Every privacy request: what came in, from where, and what's still open. */
export async function privacyPage(s: Stores, toast?: Blocks["toast"], extra: unknown[] = []): Promise<Blocks> {
	const items = await recentRequests(s);
	return {
		toast,
		blocks: [
			{ type: "header", text: "Privacy requests" },
			{ type: "context", text: "Exports and erasures of what RedeemID keeps, from members, staff and Shopify's compliance webhooks. Open requests need staff: send a Shopify data request's export to the store owner, then mark it done." },
			items.length
				? {
						type: "table",
						page_action_id: "privacy_requests",
						columns: [
							{ key: "at", label: "When", format: "relative_time" },
							{ key: "kind", label: "Request" },
							{ key: "source", label: "From" },
							{ key: "customer", label: "Shopify customer" },
							{ key: "status", label: "Status", format: "badge" },
							{ key: "act", label: "", format: "element" },
						],
						rows: items.map(({ id, data: r }) => ({
							at: r.at,
							kind: r.kind === "export" ? "Export" : "Erase",
							source: { member: "Member, on the site", staff: "Staff", shopify: "Shopify" }[r.source] + (r.shopifyRequestId ? ` (request ${r.shopifyRequestId})` : "") + (r.note ? `: ${r.note}` : ""),
							customer: r.customerId ?? "All",
							status: r.status === "open" ? "Open" : "Done",
							act:
								r.status === "open"
									? {
											type: "button",
											action_id: "privacy_done",
											label: r.kind === "export" && r.customerId ? "Export and mark done" : "Mark done",
											value: id,
										}
									: null,
						})),
					}
				: { type: "context", text: "No requests yet." },
			...extra,
		],
	};
}

/** Resync the members synced longest ago, one batch per click. */
export async function bulkResync(config: RedeemIDConfig, s: Stores): Promise<{ done: number; missing: number; changed: number }> {
	const page = await s.members.query({ orderBy: { syncedAt: "asc" }, limit: BULK_BATCH });
	const ids = page.items.map((r) => r.data.customerId);
	const before = new Map(page.items.map((r) => [r.data.customerId, [...r.data.tags]]));
	const { updated, missing } = await resync(config, s, ids, "bulk resync");
	let changed = 0;
	for (const m of updated) {
		const was = before.get(m.customerId) ?? [];
		if (was.join("\n") !== m.tags.join("\n")) changed++;
		await levelChange(config, was, m, "bulk resync");
	}
	await record({ event: "staff.resync", label: "bulk", status: `${updated.length} read, ${changed} changed${missing.length ? `, ${missing.length} missing` : ""}`, origin: "staff" });
	return { done: updated.length, missing: missing.length, changed };
}

export async function resyncOne(config: RedeemIDConfig, s: Stores, customerId: string, source: string): Promise<MemberRecord | null> {
	const before = await s.members.get(customerId);
	const { updated } = await resync(config, s, [customerId], source);
	const m = updated[0] ?? null;
	if (m) await levelChange(config, before?.tags ?? null, m, source);
	await record({ event: "staff.resync", label: source, status: m ? "ok" : "not in Shopify", level: m ? "ok" : "warn", origin: source.startsWith("agent") ? "agent" : "staff", customerId });
	return m;
}

export async function tagEdit(config: RedeemIDConfig, s: Stores, customerId: string, change: "add" | "remove", raw: unknown): Promise<MemberRecord | null> {
	const id = numericId(customerId);
	if (!id) return null;
	const tags = cleanTags(raw);
	await editTags(config, id, change, tags);
	await record({ event: "staff.tags", label: change === "add" ? "added" : "removed", status: "ok", origin: "staff", customerId: id, note: tags.join(", ").slice(0, 200) });
	return resyncOne(config, s, id, change === "add" ? "staff added tags" : "staff removed tags");
}

/** Webhooks: what Shopify sends to this site, and what's missing. */
export async function webhooksSection(config: RedeemIDConfig, uri: string): Promise<unknown[]> {
	if (!adminConfigured()) {
		return [{ type: "context", text: "Set the Admin API app's client ID to check and register webhooks from here. Until then, add them in the app's settings." }];
	}
	try {
		const [subs, scope] = await Promise.all([webhookSubscriptions(config), adminScopes(config)]);
		const rows = WEBHOOK_TOPICS.map((t) => {
			const here = subs.find((s) => s.topic === t && s.uri === uri);
			const elsewhere = subs.find((s) => s.topic === t && s.uri !== uri);
			return { topic: t.toLowerCase().replace("_", "/").replace("customer/tags", "customer.tags"), state: here ? "Registered" : elsewhere ? `Goes to ${elsewhere.uri}` : "Missing" };
		});
		const missing = rows.filter((r) => r.state !== "Registered").length;
		return [
			{ type: "section", text: `Admin API: connected (${scope || "no scopes reported"}).` },
			{ type: "table", page_action_id: "webhooks", columns: [{ key: "topic", label: "Topic" }, { key: "state", label: "Sends here", format: "badge" }], rows },
			missing
				? { type: "actions", elements: [{ type: "button", action_id: "webhooks_register", label: `Register ${missing} missing`, style: "primary", value: uri }] }
				: { type: "context", text: "Every topic RedeemID needs is sent here. customers/redact is set in the app's compliance settings." },
		];
	} catch (e) {
		return [{ type: "banner", variant: "alert", title: "Couldn't read webhooks from Shopify", description: (e as Error).message }];
	}
}

export { registerWebhooks };

/** "category:pro, tag:weekend" → { category: ["pro"], tag: ["weekend"] } */
export function parseTerms(raw: string): Terms {
	const terms: Record<string, string[]> = {};
	for (const part of raw.split(",")) {
		const [tax, term] = part.split(":").map((x) => x.trim());
		if (tax && term) (terms[tax] ??= []).push(term);
	}
	return terms;
}

/** The access test: what an entry needs, and whether a reader with these tags passes. */
export async function accessTest(config: RedeemIDConfig, values: Record<string, unknown> = {}): Promise<Blocks> {
	const collection = String(values.collection ?? "").trim();
	const entryId = String(values.entry ?? "").trim();
	const termsRaw = String(values.terms ?? "").trim();
	const tags = cleanTags(String(values.tags ?? ""));
	const signedIn = values.signed_in !== false;
	const levels = config.levels ?? [];
	const form = {
		type: "form",
		block_id: "access_test",
		fields: [
			{ type: "text_input", action_id: "collection", label: "Collection", placeholder: "posts", initial_value: collection },
			{ type: "text_input", action_id: "entry", label: "Entry id or slug (optional: applies its own rule)", initial_value: entryId },
			{ type: "text_input", action_id: "terms", label: "Terms (taxonomy:slug, comma separated)", placeholder: "category:investigations, tag:free-to-read", initial_value: termsRaw },
			{ type: "text_input", action_id: "tags", label: "Reader's Shopify tags (comma separated)", placeholder: "gold-member", initial_value: tags.join(", ") },
			{ type: "toggle", action_id: "signed_in", label: "Signed in", initial_value: signedIn },
		],
		submit: { label: "Test", action_id: "access_test" },
	};
	const out: unknown[] = [
		{ type: "header", text: "Access test" },
		{ type: "context", text: "Check what an entry needs under the rules, and whether a reader with some Shopify tags may read it. Nothing is saved." },
		form,
	];
	if (collection) {
		const terms = parseTerms(termsRaw);
		const tree = await termTree(config.rules, collection, terms);
		const required = applyEntryRule(requirement(config.rules, collection, terms, { combine: config.combine, tree }), entryRuleFor(config, collection, entryId));
		const held = levelsFor(tags, levels);
		const ok = required === null || (signedIn && passes(held, required));
		out.push(
			{ type: "divider" },
			{
				type: "fields",
				fields: [
					{ label: "Needs", value: describe(required, levels) },
					{ label: "Reader's levels", value: levels.filter((l) => held.includes(l.slug)).map((l) => l.name).join(", ") || "None" },
					{ label: "Result", value: ok ? "Can read" : signedIn ? "Locked: asked to upgrade" : "Locked: asked to sign in" },
				],
			},
			{
				type: "banner",
				variant: ok ? "default" : "alert",
				title: ok ? "This reader can read it" : "This reader is kept out",
				description: "A Members only part with levels picked, drip and the meter can still change what a page shows.",
			},
		);
	}
	return { blocks: out };
}
