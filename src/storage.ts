/**
 * The member mirror: what Shopify says about each linked customer.
 *
 * Stored with EmDash's auth-provider storage (namespace `auth:redeemid`), the
 * one plugin-style store that is public API for provider routes and page code
 * alike. Nothing on the site grants access: a member's levels are
 * computed from these mirrored tags only.
 */

import type { StorageCollection } from "emdash";
import { getAuthProviderStorage } from "emdash/api/route-utils";

import { PROVIDER_ID } from "./config.js";

export interface MemberRecord {
	/** Numeric Shopify customer id, also the record id. */
	customerId: string;
	/** EmDash user id once the customer has signed in. */
	userId: string | null;
	email: string | null;
	firstName: string | null;
	lastName: string | null;
	tags: string[];
	/** From customers/enable|disable webhooks only. */
	status: "enabled" | "disabled";
	/** Shopify updated_at (ms) of the last profile write, to drop out-of-order webhooks. */
	profileUpdatedAt: number | null;
	/** Shopify updated_at (ms) of the last status write. */
	statusUpdatedAt: number | null;
	/** When anything was last written, ISO. */
	syncedAt: string;
	/** What wrote it last: sign-in or a webhook topic. */
	source: string;
}

export interface DeliveryRecord {
	topic: string;
	receivedAt: string;
}

export const STORAGE_CONFIG = {
	members: { indexes: ["email", "userId"] },
	deliveries: { indexes: ["receivedAt"] },
};

export interface Stores {
	members: StorageCollection<MemberRecord>;
	deliveries: StorageCollection<DeliveryRecord>;
}

export function stores(db: unknown): Stores {
	const s = getAuthProviderStorage(db as Parameters<typeof getAuthProviderStorage>[0], PROVIDER_ID, STORAGE_CONFIG);
	return s as unknown as Stores;
}

export function emptyMember(customerId: string): MemberRecord {
	return {
		customerId,
		userId: null,
		email: null,
		firstName: null,
		lastName: null,
		tags: [],
		status: "enabled",
		profileUpdatedAt: null,
		statusUpdatedAt: null,
		syncedAt: new Date().toISOString(),
		source: "",
	};
}

export async function memberForUser(s: Stores, userId: string): Promise<MemberRecord | null> {
	const { items } = await s.members.query({ where: { userId }, limit: 1 });
	return items[0]?.data ?? null;
}

/** Clean a tag list the way Shopify stores them: trimmed, unique, no blanks. */
export function cleanTags(raw: unknown): string[] {
	const list = typeof raw === "string" ? raw.split(",") : Array.isArray(raw) ? raw : [];
	const out: string[] = [];
	for (const tag of list) {
		if (typeof tag !== "string") continue;
		const t = tag.trim();
		if (t !== "" && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
	}
	return out;
}

/** "gid://shopify/Customer/123" or 123 → "123". */
export function numericId(raw: unknown): string | null {
	if (typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0) return String(raw);
	if (typeof raw !== "string") return null;
	const m = /^(?:gid:\/\/shopify\/Customer\/)?(\d+)$/.exec(raw.trim());
	return m?.[1] ?? null;
}
