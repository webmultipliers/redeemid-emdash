/**
 * Outbound events: RedeemID POSTs JSON to `events.url` when something
 * happens to a member, signed so the receiver can trust it.
 *
 *   events: { url: "https://hooks.example.com/redeemid" }   // + REDEEMID_EVENTS_SECRET
 *
 * Headers: X-RedeemID-Event (the name), X-RedeemID-Delivery (a fresh id) and
 * X-RedeemID-Signature: sha256=<hex HMAC of the raw body>. Events:
 * member.signed_in, member.levels_changed, meter.used, meter.exhausted,
 * preferences.saved, member.erased.
 * Sending never blocks or breaks the page: events go out after the response
 * (waitUntil on Workers), are tried three times, and one that fails every
 * try is kept under App events → Failed events, where staff can send it
 * again or clear it.
 * No event carries an email address or a name; match people by `customerId`.
 */

import { env, ENV, type RedeemIDConfig } from "./config.js";
import { USER_AGENT } from "./shopify.js";
import { record } from "./log.js";

export type EventName = "member.signed_in" | "member.levels_changed" | "meter.used" | "meter.exhausted" | "preferences.saved" | "member.erased";

const TIMEOUT_MS = 3000;
/** Waits before the second and third tries. */
export const RETRY_DELAYS_MS = [1000, 5000];

export async function signBody(body: string, secret: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
	return [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** An event that failed every try, kept so staff can send it again or clear it (App events). */
export interface FailedEvent {
	/** The delivery id, also the record id: a resend keeps it, so receivers can drop duplicates. */
	id: string;
	event: EventName;
	/** The JSON body as first sent (ids and levels, never an email or a name). */
	body: string;
	at: string;
	attempts: number;
	error: string;
}

/** One POST. Resolves to null when the receiver answered 2xx, else what went wrong. */
async function post(url: string, name: string, id: string, body: string, secret: string, fetcher: typeof fetch): Promise<string | null> {
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
		return res.ok ? null : `HTTP ${res.status}`;
	} catch (e) {
		return String((e as Error).message || "error").slice(0, 200);
	}
}

type Sleep = (ms: number) => Promise<void>;
const sleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Try a delivery up to three times (now, after 1 s, after 5 s). One that
 * fails every try goes to the failed list (App events) for staff. True when
 * the receiver took it.
 */
export async function deliver(
	url: string,
	secret: string,
	name: EventName,
	id: string,
	body: string,
	opts: { fetcher?: typeof fetch; wait?: Sleep; failed?: (f: FailedEvent) => Promise<void> } = {},
): Promise<boolean> {
	const fetcher = opts.fetcher ?? fetch;
	let error: string | null = null;
	let attempts = 0;
	for (const delay of [0, ...RETRY_DELAYS_MS]) {
		if (delay) await (opts.wait ?? sleep)(delay);
		attempts++;
		error = await post(url, name, id, body, secret, fetcher);
		if (error === null) return true;
	}
	console.error("[redeemid] event not sent:", name, error);
	const failed: FailedEvent = { id, event: name, body, at: new Date().toISOString(), attempts, error: error ?? "error" };
	await record({ event: "events.failed", label: name, status: error ?? "error", level: "error", origin: "site", note: `${attempts} tries` });
	await (opts.failed ?? keepFailed)(failed).catch(() => undefined);
	return false;
}

async function keepFailed(f: FailedEvent): Promise<void> {
	const { getDb } = await import("emdash/runtime");
	const { stores } = await import("./storage.js");
	await stores(await getDb()).failedEvents.put(f.id, f);
}

/** Deliveries started and not finished yet: tests and the CLI can wait for them. */
const pending = new Set<Promise<boolean>>();

/** Wait until every event started so far has been delivered or given up on. */
export async function flushEvents(): Promise<void> {
	while (pending.size) await Promise.allSettled([...pending]);
}

/** EmDash's after(), loaded once; null outside an EmDash site. */
let afterFn: Promise<((fn: () => Promise<void>) => void) | null> | null = null;

/** Keep the work alive after the response (waitUntil on Workers); plain Node needs nothing. Never waits. */
function keepAlive(work: Promise<unknown>): void {
	afterFn ??= import("emdash").then(
		(m) => m.after,
		() => null,
	);
	void afterFn.then((after) =>
		after?.(async () => {
			await work;
		}),
	);
}

/**
 * Send one event, after the response: the page, sign-in or webhook never
 * waits for the receiver. Returns at once; false when events are off.
 */
export async function emit(
	config: RedeemIDConfig | null,
	name: EventName,
	data: Record<string, unknown>,
	opts: { fetcher?: typeof fetch; wait?: Sleep; failed?: (f: FailedEvent) => Promise<void> } = {},
): Promise<boolean> {
	const url = config?.events?.url;
	const secret = env(ENV.eventsSecret);
	if (!url || !secret) return false;
	if (config.events?.only && !config.events.only.includes(name)) return false;
	const id = crypto.randomUUID();
	const body = JSON.stringify({ id, event: name, at: new Date().toISOString(), data });
	const work = deliver(url, secret, name, id, body, opts).catch(() => false);
	pending.add(work);
	void work.finally(() => pending.delete(work));
	keepAlive(work);
	return true;
}

/** Send a failed event again (staff). On success it leaves the failed list. */
export async function resend(config: RedeemIDConfig, s: { failedEvents: { get(id: string): Promise<FailedEvent | null>; delete(id: string): Promise<boolean> } }, id: string, fetcher: typeof fetch = fetch): Promise<boolean> {
	const f = await s.failedEvents.get(id);
	const url = config.events?.url;
	const secret = env(ENV.eventsSecret);
	if (!f || !url || !secret) return false;
	const error = await post(url, f.event, f.id, f.body, secret, fetcher);
	await record({ event: "events.resent", label: f.event, status: error ?? "ok", level: error ? "warn" : "ok", origin: "staff" });
	if (error) return false;
	await s.failedEvents.delete(id);
	return true;
}

/** Send member.levels_changed when a mirror write changed the member's levels. */
export async function levelChange(
	config: RedeemIDConfig | null,
	beforeTags: string[] | null,
	after: { customerId: string; tags: string[]; status: string },
	source: string,
	fetcher?: typeof fetch,
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
		fetcher ? { fetcher } : {},
	);
}
