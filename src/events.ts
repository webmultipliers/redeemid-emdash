/**
 * Outbound events: RedeemID POSTs JSON to `events.url` when something
 * happens to a member, signed so the receiver can trust it.
 *
 *   events: { url: "https://hooks.example.com/redeemid" }   // + REDEEMID_EVENTS_SECRET
 *
 * Headers: X-RedeemID-Event (the name), X-RedeemID-Delivery (a fresh id) and
 * X-RedeemID-Signature: sha256=<hex HMAC of the raw body>. Events:
 * member.signed_in, member.levels_changed, meter.used, meter.exhausted,
 * preferences.saved.
 * Sending never blocks or breaks the page: failures are logged and dropped.
 * No event carries an email address or a name; match people by `customerId`.
 */

import { env, ENV, type RedeemIDConfig } from "./config.js";
import { USER_AGENT } from "./shopify.js";

export type EventName = "member.signed_in" | "member.levels_changed" | "meter.used" | "meter.exhausted" | "preferences.saved";

const TIMEOUT_MS = 3000;

export async function signBody(body: string, secret: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
	return [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Send one event. Returns whether the receiver answered 2xx; never throws. */
export async function emit(config: RedeemIDConfig | null, name: EventName, data: Record<string, unknown>, fetcher: typeof fetch = fetch): Promise<boolean> {
	const url = config?.events?.url;
	const secret = env(ENV.eventsSecret);
	if (!url || !secret) return false;
	if (config.events?.only && !config.events.only.includes(name)) return false;
	const id = crypto.randomUUID();
	const body = JSON.stringify({ id, event: name, at: new Date().toISOString(), data });
	try {
		const res = await fetcher(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"User-Agent": USER_AGENT,
				"X-RedeemID-Event": name,
				"X-RedeemID-Delivery": id,
				"X-RedeemID-Signature": `sha256=${await signBody(body, secret)}`,
			},
			body,
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		return res.ok;
	} catch (e) {
		console.error("[redeemid] event not sent:", name, (e as Error).message);
		return false;
	}
}

/** Send member.levels_changed when a mirror write changed the member's levels. */
export async function levelChange(
	config: RedeemIDConfig | null,
	beforeTags: string[] | null,
	after: { customerId: string; tags: string[]; status: string },
	source: string,
	fetcher: typeof fetch = fetch,
): Promise<void> {
	if (!config?.events?.url) return;
	const { levelsFor } = await import("./access.js");
	const was = beforeTags ? levelsFor(beforeTags, config.levels) : [];
	const now = after.status === "disabled" ? [] : levelsFor(after.tags, config.levels);
	if (was.length === now.length && was.every((l) => now.includes(l))) return;
	await emit(
		config,
		"member.levels_changed",
		{ customerId: after.customerId, levels: now, added: now.filter((l) => !was.includes(l)), removed: was.filter((l) => !now.includes(l)), source },
		fetcher,
	);
}
