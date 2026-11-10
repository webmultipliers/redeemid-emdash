/**
 * App events: what RedeemID did and what came of it, for the admin's App
 * events page. Webhooks received and rejected, sign-ins and refusals, calls to
 * Shopify's Admin API, staff actions, settings saves and outbound events.
 *
 * Each entry holds ids, labels, outcomes and timings only, never request or
 * response bodies, tokens or emails. Kept 30 days.
 */

import type { StorageCollection } from "emdash";

export const LOG_DAYS = 30;
const PRUNE_PAGES = 5;

export type LogOrigin = "webhook" | "member" | "staff" | "agent" | "cron" | "site";

export interface LogEntry {
	at: string;
	/** Dotted name, e.g. "webhook.received", "shopify.admin". */
	event: string;
	/** What it was about, e.g. a webhook topic or an Admin API operation. */
	label: string;
	/** ok, or what went wrong, e.g. "processed", "rejected", "error". */
	status: string;
	/** "ok" | "warn" | "error", for colour and the Problems filter. */
	level: "ok" | "warn" | "error";
	origin?: LogOrigin;
	customerId?: string | null;
	ms?: number;
	/** A short note, never a body or a secret. */
	note?: string;
}

/** Event names, for the filter. */
export const LOG_EVENTS: Record<string, string> = {
	"webhook.received": "Webhook received",
	"webhook.rejected": "Webhook rejected",
	"webhook.failed": "Webhook failed",
	"webhook.quiet": "No webhooks lately",
	"member.signed_in": "Sign-in",
	"member.refused": "Sign-in refused",
	"shopify.admin": "Admin API call",
	"staff.resync": "Resync",
	"staff.tags": "Tag edit",
	"staff.webhooks": "Webhook registration",
	"settings.saved": "Settings saved",
	"events.failed": "Outbound event failed",
	"health.check": "Health check",
	"meter.used": "Metered read",
	"meter.exhausted": "Metered read, meter used up",
};

type Sink = (entry: LogEntry) => Promise<void>;
const SINK = Symbol.for("redeemid:log-sink");

/** Where entries go (the plugin's storage, or a test's array). */
export function setLogSink(sink: Sink | null): void {
	(globalThis as unknown as Record<symbol, Sink | null>)[SINK] = sink;
}

async function defaultSink(entry: LogEntry): Promise<void> {
	const [{ getDb }, { stores }] = await Promise.all([import("emdash/runtime"), import("./storage.js")]);
	const s = stores(await getDb());
	await s.log.put(`${entry.at}:${crypto.randomUUID().slice(0, 8)}`, entry);
}

/** Record one entry. Never throws: a log that can't be written never breaks the work. */
export async function record(entry: Omit<LogEntry, "at" | "level"> & { level?: LogEntry["level"] }): Promise<void> {
	const full: LogEntry = { at: new Date().toISOString(), level: entry.level ?? "ok", ...entry } as LogEntry;
	try {
		const sink = (globalThis as unknown as Record<symbol, Sink | null | undefined>)[SINK] ?? defaultSink;
		await sink(full);
	} catch {
		// No storage here (e.g. outside a request): skip.
	}
}

/** Time a call and record it. */
export async function timed<T>(event: string, label: string, run: () => Promise<T>, extra: Partial<LogEntry> = {}): Promise<T> {
	const started = Date.now();
	try {
		const out = await run();
		await record({ event, label, status: "ok", ms: Date.now() - started, ...extra });
		return out;
	} catch (e) {
		await record({ event, label, status: "error", level: "error", ms: Date.now() - started, note: String((e as Error).message ?? e).slice(0, 200), ...extra });
		throw e;
	}
}

/** Delete entries (and other dated records) older than `days`, a page at a time. */
export async function prune<T>(store: StorageCollection<T>, field: string, days = LOG_DAYS, where: Record<string, unknown> = {}): Promise<number> {
	const before = new Date(Date.now() - days * 86_400_000).toISOString();
	let gone = 0;
	// A few pages a run: enough to keep up with a busy site, few enough queries for one request.
	for (let page = 0; page < PRUNE_PAGES; page++) {
		const { items } = await store.query({ where: { ...where, [field]: { lt: before } }, limit: 100 });
		if (items.length === 0) break;
		gone += await store.deleteMany(items.map((i) => i.id));
		if (items.length < 100) break;
	}
	return gone;
}
