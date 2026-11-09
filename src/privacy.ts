/**
 * Privacy requests: every export and erase of the member data RedeemID keeps,
 * whether the member asked on the site, staff started it, or Shopify sent it.
 *
 * What RedeemID keeps about a member: the mirror record (customer id, email,
 * name, tags and their dates, status, when they first signed in and last
 * synced, preference save times) and their meter records. Preference answers
 * live on the Shopify customer, and webhook deliveries keep only a topic and
 * a time. Shopify stays the record of the customer: erasing here never
 * erases Shopify data, though staff can ask Shopify to (requestShopifyErasure).
 */

import { admin, AdminError } from "./admin-api.js";
import type { RedeemIDConfig } from "./config.js";
import { emit } from "./events.js";
import type { MemberRecord, MeterRecord, PrivacyRequest, Stores } from "./storage.js";

export const EXPORT_VERSION = 1;

export interface MemberExport {
	format: "redeemid-member-export";
	version: number;
	exportedAt: string;
	member: MemberRecord | null;
	meter: MeterRecord[];
	elsewhere: string[];
}

async function meterFor(s: Stores, userId: string | null): Promise<Array<{ id: string; data: MeterRecord }>> {
	if (!userId) return [];
	const out: Array<{ id: string; data: MeterRecord }> = [];
	let cursor: string | undefined;
	do {
		const page = await s.meter.query({ where: { userId }, limit: 100, cursor });
		out.push(...page.items);
		cursor = page.cursor;
	} while (cursor);
	return out;
}

async function log(s: Stores, r: Omit<PrivacyRequest, "at"> & { at?: string }): Promise<string> {
	const id = crypto.randomUUID();
	await s.requests.put(id, { ...r, at: r.at ?? new Date().toISOString() });
	return id;
}

/** Everything RedeemID keeps about one member. */
export async function exportMember(s: Stores, customerId: string): Promise<MemberExport> {
	const member = await s.members.get(customerId);
	const meter = await meterFor(s, member?.userId ?? null);
	return {
		format: "redeemid-member-export",
		version: EXPORT_VERSION,
		exportedAt: new Date().toISOString(),
		member,
		meter: meter.map((m) => m.data),
		elsewhere: [
			"Orders, addresses, preference answers and the full customer record are kept by the store.",
			"The site's own user account (email and name) is kept by the site's content system.",
		],
	};
}

/** Export and log it. */
export async function exportRequest(s: Stores, customerId: string, source: PrivacyRequest["source"]): Promise<MemberExport> {
	const data = await exportMember(s, customerId);
	await log(s, { kind: "export", source, customerId, status: "done" });
	return data;
}

/**
 * Erase what RedeemID keeps about one member: the mirror record and their
 * meter. The site user stays; if they sign in again they're linked again.
 */
export async function eraseMember(config: RedeemIDConfig | null, s: Stores, customerId: string, source: PrivacyRequest["source"], shopifyRequestId: string | null = null): Promise<boolean> {
	const member = await s.members.get(customerId);
	for (const m of await meterFor(s, member?.userId ?? null)) await s.meter.delete(m.id);
	if (member) await s.members.delete(customerId);
	await log(s, { kind: "erase", source, customerId, status: "done", shopifyRequestId });
	// Receivers of earlier events hold their own copies: tell them, by id only.
	await emit(config, "member.erased", { customerId, source });
	return Boolean(member);
}

/** shop/redact: erase every member and meter record. */
export async function eraseAll(config: RedeemIDConfig | null, s: Stores): Promise<number> {
	let n = 0;
	for (;;) {
		const page = await s.members.query({ limit: 100 });
		if (page.items.length === 0) break;
		for (const r of page.items) {
			for (const m of await meterFor(s, r.data.userId)) await s.meter.delete(m.id);
			await s.members.delete(r.id);
			n++;
		}
	}
	for (;;) {
		const page = await s.meter.query({ limit: 100 });
		if (page.items.length === 0) break;
		for (const r of page.items) await s.meter.delete(r.id);
	}
	await log(s, { kind: "erase", source: "shopify", customerId: null, status: "done", note: `Shop redacted: ${n} members` });
	return n;
}

/** customers/data_request: an open export request for staff to send to the store owner. */
export async function shopifyDataRequest(s: Stores, customerId: string, shopifyRequestId: string | null): Promise<void> {
	await log(s, { kind: "export", source: "shopify", customerId, status: "open", shopifyRequestId });
}

export async function closeRequest(s: Stores, id: string): Promise<PrivacyRequest | null> {
	const r = await s.requests.get(id);
	if (!r) return null;
	const done = { ...r, status: "done" as const };
	await s.requests.put(id, done);
	return done;
}

export async function recentRequests(s: Stores, limit = 50): Promise<Array<{ id: string; data: PrivacyRequest }>> {
	const { items } = await s.requests.query({ orderBy: { at: "desc" }, limit });
	return items;
}

/**
 * Ask Shopify to erase the customer's personal data across the store, orders
 * included. Shopify waits before it does; cancelShopifyErasure withdraws it.
 * Needs the write_customer_data_erasure scope.
 */
export async function requestShopifyErasure(config: RedeemIDConfig, s: Stores, customerId: string, fetcher: typeof fetch = fetch): Promise<void> {
	await erasureMutation(config, "customerRequestDataErasure", customerId, fetcher);
	await log(s, { kind: "erase", source: "staff", customerId, status: "open", note: "Asked Shopify to erase" });
}

export async function cancelShopifyErasure(config: RedeemIDConfig, s: Stores, customerId: string, fetcher: typeof fetch = fetch): Promise<void> {
	await erasureMutation(config, "customerCancelDataErasure", customerId, fetcher);
	await log(s, { kind: "erase", source: "staff", customerId, status: "done", note: "Cancelled the Shopify erasure" });
}

async function erasureMutation(config: RedeemIDConfig, name: "customerRequestDataErasure" | "customerCancelDataErasure", customerId: string, fetcher: typeof fetch): Promise<void> {
	const data = await admin<Record<string, { userErrors: Array<{ message: string }> } | null>>(
		config,
		`mutation RedeemIDErasure($id: ID!) { ${name}(customerId: $id) { customerId userErrors { field message code } } }`,
		{ id: `gid://shopify/Customer/${customerId}` },
		fetcher,
	);
	const err = data[name]?.userErrors[0];
	if (err) throw new AdminError(err.message);
}
