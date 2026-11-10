/**
 * Shopify webhooks → member mirror.
 *
 * Shopify is the only source of entitlements: these handlers copy what Shopify
 * says and never invent access. Status comes from customers/disable|enable
 * only; a profile payload without `tags` never means "tags removed".
 */

import { cleanTags, emptyMember, numericId, stampTags, type MemberRecord, type Stores } from "./storage.js";
import type { RedeemIDConfig } from "./config.js";
import { eraseAll, eraseMember, shopifyDataRequest } from "./privacy.js";

/** customers/merge: the customer kept and the one merged away, or nulls for a failed merge. */
export function mergeIds(payload: Record<string, unknown>): { kept: string | null; gone: string | null } {
	if (payload.status === "failed") return { kept: null, gone: null };
	return { kept: numericId(payload.admin_graphql_api_customer_kept_id), gone: numericId(payload.admin_graphql_api_customer_deleted_id) };
}

export type Kind = "profile" | "delete" | "status" | "tags" | "merge" | "compliance" | "ignored";

const TOPICS: Record<string, Kind> = {
	"customers/create": "profile",
	"customers/update": "profile",
	"customers/delete": "delete",
	"customers/disable": "status",
	"customers/enable": "status",
	"customers/merge": "merge",
	"customer.tags_added": "tags",
	"customer.tags_removed": "tags",
	"customers/redact": "compliance",
	"customers/data_request": "compliance",
	"shop/redact": "compliance",
	"customer_account_settings/update": "ignored",
};

export function kindOf(topic: string): Kind | null {
	return TOPICS[topic.trim().toLowerCase()] ?? null;
}

/** Shopify signs the raw body with the app's client secret (HMAC-SHA256, base64). */
export async function verifyHmac(body: Uint8Array<ArrayBuffer>, header: string, secret: string): Promise<boolean> {
	if (!secret || !header) return false;
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["verify"],
	);
	let sig: Uint8Array<ArrayBuffer>;
	try {
		sig = Uint8Array.from(atob(header.trim()), (c) => c.charCodeAt(0));
	} catch {
		return false;
	}
	// crypto.subtle.verify compares in constant time.
	return crypto.subtle.verify("HMAC", key, sig, body);
}

export async function sign(body: Uint8Array<ArrayBuffer>, secret: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
	let s = "";
	for (const b of mac) s += String.fromCharCode(b);
	return btoa(s);
}

function time(raw: unknown): number | null {
	if (typeof raw !== "string") return null;
	const t = Date.parse(raw);
	return Number.isFinite(t) ? t : null;
}

function str(raw: unknown): string | null {
	return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}

/** The Shopify customer a payload is about, when it names one. */
export function customerOf(payload: Record<string, unknown>): string | null {
	const nested = (payload.customer as { id?: unknown } | undefined)?.id;
	for (const c of [payload.id, payload.customerId, payload.customer_id, nested]) {
		const id = numericId(c);
		if (id) return id;
	}
	return null;
}

export type Outcome = "processed" | "skipped" | "stale" | "ignored";

/**
 * Apply one webhook to the mirror. Throws on storage errors so the caller can
 * answer 500 and let Shopify retry.
 */
export async function apply(
	s: Stores,
	topic: string,
	payload: Record<string, unknown>,
	/** Called after a member is written, with their tags before (null when new). */
	onWrite?: (beforeTags: string[] | null, after: MemberRecord) => Promise<void> | void,
	/** For the member.erased event on customers/redact. */
	config?: RedeemIDConfig | null,
): Promise<Outcome> {
	const kind = kindOf(topic);
	if (!kind || kind === "ignored") return "ignored";

	if (kind === "compliance") {
		// Every compliance topic is logged as a privacy request (see privacy.ts).
		const id = customerOf(payload);
		if (topic === "customers/redact") {
			if (id) await eraseMember(config ?? null, s, id, "shopify");
			return id ? "processed" : "skipped";
		}
		if (topic === "customers/data_request") {
			if (!id) return "skipped";
			const req = (payload.data_request as { id?: unknown } | undefined)?.id;
			await shopifyDataRequest(s, id, req === undefined || req === null ? null : String(req));
			return "processed";
		}
		if (topic === "shop/redact") {
			await eraseAll(config ?? null, s);
			return "processed";
		}
		return "skipped";
	}

	if (kind === "merge") {
		const { kept, gone } = mergeIds(payload);
		if (!kept || !gone) return "skipped";
		const old = await s.members.get(gone);
		if (old?.userId) {
			const survivor = (await s.members.get(kept)) ?? emptyMember(kept);
			if (!survivor.userId) survivor.userId = old.userId;
			survivor.syncedAt = new Date().toISOString();
			survivor.source = topic;
			await s.members.put(kept, stampTags(survivor));
		}
		await s.members.delete(gone);
		return "processed";
	}

	const id = customerOf(payload);
	if (!id) return "skipped";

	if (kind === "delete") {
		const gone = await s.members.get(id);
		await s.members.delete(id);
		// The levels end with the customer: receivers of member.levels_changed hear it.
		if (gone) await onWrite?.([...gone.tags], { ...gone, tags: [] });
		return "processed";
	}

	const existing = await s.members.get(id);
	const beforeTags = existing ? [...existing.tags] : null;
	const current: MemberRecord = existing ?? emptyMember(id);
	const updatedAt = time(payload.updated_at);

	if (kind === "profile") {
		if (updatedAt !== null && current.profileUpdatedAt !== null && updatedAt < current.profileUpdatedAt) {
			return "stale";
		}
		current.email = str(payload.email)?.toLowerCase() ?? current.email;
		current.firstName = str(payload.first_name) ?? current.firstName;
		current.lastName = str(payload.last_name) ?? current.lastName;
		if ("tags" in payload) current.tags = cleanTags(payload.tags);
		// Marketing consent, as Shopify states it (display and export only).
		const consent = (raw: unknown) => str((raw as { state?: unknown } | null | undefined)?.state)?.toUpperCase() ?? null;
		if (payload.email_marketing_consent && typeof payload.email_marketing_consent === "object") current.emailMarketing = consent(payload.email_marketing_consent);
		if (payload.sms_marketing_consent && typeof payload.sms_marketing_consent === "object") current.smsMarketing = consent(payload.sms_marketing_consent);
		current.profileUpdatedAt = updatedAt ?? current.profileUpdatedAt;
	} else if (kind === "status") {
		if (updatedAt !== null && current.statusUpdatedAt !== null && updatedAt < current.statusUpdatedAt) {
			return "stale";
		}
		current.status = topic.endsWith("/disable") ? "disabled" : "enabled";
		current.statusUpdatedAt = updatedAt ?? current.statusUpdatedAt;
	} else if (kind === "tags") {
		const change = cleanTags(payload.tags);
		const lower = new Set(change.map((t) => t.toLowerCase()));
		current.tags = topic.endsWith("tags_added")
			? cleanTags([...current.tags, ...change])
			: current.tags.filter((t) => !lower.has(t.toLowerCase()));
	}

	current.syncedAt = new Date().toISOString();
	current.source = topic;
	await s.members.put(id, stampTags(current));
	await onWrite?.(beforeTags, current);
	return "processed";
}
