/**
 * Watching what RedeemID does, in the admin (Block Kit):
 *
 * - Webhooks: what Shopify sent and what became of it (Received), whether
 *   deliveries are flowing (Health: the daily check, rejected and failed
 *   deliveries, and when to warn staff by email), and where Shopify sends them
 *   (Setup: endpoint, signatures, subscriptions).
 * - App events: the log in log.ts, newest first, by event or problems only.
 * - Reports: members by level, who joined and left, sign-ins and metered reads.
 *
 * The daily check re-creates subscriptions Shopify dropped and never changes
 * anyone's access: members still gain and lose levels only from Shopify tags.
 */

import { levelsFor, membership } from "./access.js";
import { adminConfigured, registerWebhooks, topicName } from "./admin-api.js";
import { env, ENV, type RedeemIDConfig } from "./config.js";
import { LOG_DAYS, LOG_EVENTS, prune, record, type LogEntry } from "./log.js";
import { RETRY_DELAYS_MS, type FailedEvent } from "./events.js";
import type { DeliveryRecord, MemberRecord, Stores } from "./storage.js";
import { webhooksSection } from "./staff.js";

export const WEBHOOK_PATH = "/_emdash/api/auth/redeemid/webhook";
/** The daily check's cron task name. */
export const HEALTH_TASK = "health";

const DAY = 86_400_000;

type Toast = { message: string; type: "success" | "error" | "info" };
type Blocks = { blocks: unknown[]; toast?: Toast };

/** The plugin's key-value store (ctx.kv), or a test's map. */
export interface Kv {
	get<T>(key: string): Promise<T | null>;
	set(key: string, value: unknown): Promise<void>;
}

/** When to warn staff, saved from the Health tab. */
export interface MonitorSettings {
	/** Warn when no delivery has come in for this many days (0 = never). */
	quietDays: number;
	/** Where warnings go. Empty: shown in the admin only. */
	alertEmail: string;
}

export const MONITOR_DEFAULTS: MonitorSettings = { quietDays: 3, alertEmail: "" };

export interface Problem {
	level: "warn" | "error";
	text: string;
}

export interface HealthResult {
	at: string;
	problems: Problem[];
	/** Topics the check registered again. */
	registered: string[];
	/** Whether subscriptions could be checked (needs the Admin API app). */
	subscriptions: "ok" | "fixed" | "failed" | "unchecked";
	emailed?: boolean;
}

const KEY_SETTINGS = "monitor:settings";
const KEY_LAST = "monitor:last";
const KEY_ALERTED = "monitor:alerted";

export async function monitorSettings(kv: Kv): Promise<MonitorSettings> {
	return { ...MONITOR_DEFAULTS, ...((await kv.get<MonitorSettings>(KEY_SETTINGS)) ?? {}) };
}

export async function lastCheck(kv: Kv): Promise<HealthResult | null> {
	return kv.get<HealthResult>(KEY_LAST);
}

/** Sends one email (ctx.email), when the site has an email provider. */
export type Mailer = { send(message: { to: string; subject: string; text: string }): Promise<void> } | undefined;

export interface MonitorEnv {
	config: RedeemIDConfig;
	s: Stores;
	kv: Kv;
	/** This site's webhook address. */
	uri: string;
	email: Mailer;
	now?: () => number;
	/** Who ran the check: the daily task, or staff with Check now. */
	by?: "cron" | "staff";
}

const since = (now: number, days: number) => new Date(now - days * DAY).toISOString();

async function lastDelivery(s: Stores): Promise<DeliveryRecord | null> {
	const { items } = await s.deliveries.query({ orderBy: { receivedAt: "desc" }, limit: 1 });
	return items[0]?.data ?? null;
}

function count(s: Stores, event: string, from: string): Promise<number> {
	return s.log.count({ event, at: { gte: from } });
}

/**
 * The daily check: subscriptions in place (re-creating any that are
 * missing), deliveries arriving, none rejected or failing. Warns by email
 * when problems change, or once a week while they last. Also drops app
 * events and delivery records older than LOG_DAYS.
 */
export async function healthCheck(env_: MonitorEnv): Promise<HealthResult> {
	const { config, s, kv, uri } = env_;
	const now = env_.now?.() ?? Date.now();
	const settings = await monitorSettings(kv);
	const problems: Problem[] = [];
	let registered: string[] = [];
	let subscriptions: HealthResult["subscriptions"] = "unchecked";

	if (!env(ENV.webhookSecret)) problems.push({ level: "error", text: `The webhook signing secret (the Admin API app's client secret, ${ENV.webhookSecret}) is missing, so the site turns away every delivery.` });

	if (adminConfigured()) {
		try {
			const { added, failed } = await registerWebhooks(config, uri);
			registered = added;
			subscriptions = failed.length ? "failed" : added.length ? "fixed" : "ok";
			if (added.length) problems.push({ level: "warn", text: `Shopify had dropped ${added.length} webhook ${added.length === 1 ? "subscription" : "subscriptions"}; registered again: ${added.map(topicName).join(", ")}.` });
			for (const f of failed) problems.push({ level: "error", text: `Shopify refused ${topicName(f.topic)}: ${f.message}` });
		} catch (e) {
			subscriptions = "failed";
			problems.push({ level: "error", text: `Couldn't check webhook subscriptions with Shopify: ${(e as Error).message}` });
		}
	}

	const last = await lastDelivery(s);
	if (settings.quietDays > 0) {
		if (!last) problems.push({ level: "warn", text: "No webhooks received yet. Check the subscriptions under Setup." });
		else if (Date.parse(last.receivedAt) < now - settings.quietDays * DAY) {
			const days = Math.floor((now - Date.parse(last.receivedAt)) / DAY);
			problems.push({ level: "warn", text: `No webhooks for ${days} days. Quiet stores are normal; if customers changed in Shopify since, check Setup.` });
		}
	}

	const day = since(now, 1);
	const rejected = await count(s, "webhook.rejected", day);
	if (rejected) problems.push({ level: "warn", text: `${rejected} ${rejected === 1 ? "delivery was" : "deliveries were"} turned away in the last day (bad signature): check the webhook signing secret.` });
	const failed = await count(s, "webhook.failed", day);
	if (failed) problems.push({ level: "error", text: `${failed} ${failed === 1 ? "delivery" : "deliveries"} failed to save in the last day. Shopify sends them again; see App events.` });

	const result: HealthResult = { at: new Date(now).toISOString(), problems, registered, subscriptions };
	result.emailed = await alert(env_, settings, result, now);
	await kv.set(KEY_LAST, result);
	await record({
		event: "health.check",
		label: env_.by === "staff" ? "check now" : "daily check",
		status: problems.length ? `${problems.length} ${problems.length === 1 ? "problem" : "problems"}` : "healthy",
		level: problems.some((p) => p.level === "error") ? "error" : problems.length ? "warn" : "ok",
		origin: env_.by ?? "cron",
	});
	await tidy(s);
	return result;
}

/** Email the problems when they're new, or a week after the last email. */
async function alert(env_: MonitorEnv, settings: MonitorSettings, result: HealthResult, now: number): Promise<boolean> {
	if (!result.problems.length || !settings.alertEmail || !env_.email) return false;
	const sig = result.problems.map((p) => p.text.replace(/\d+/g, "#")).join("\n");
	const before = await env_.kv.get<{ sig: string; at: number }>(KEY_ALERTED);
	if (before && before.sig === sig && now - before.at < 7 * DAY) return false;
	try {
		await env_.email.send({
			to: settings.alertEmail,
			subject: "RedeemID: webhooks need attention",
			text: [
				"The daily check of Shopify webhooks found:",
				"",
				...result.problems.map((p) => `- ${p.text}`),
				"",
				"Members gain and lose access only when Shopify sends tag changes, so these are worth a look: Plugins → RedeemID → Webhooks.",
			].join("\n"),
		});
		await env_.kv.set(KEY_ALERTED, { sig, at: now });
		return true;
	} catch (e) {
		await record({ event: "health.check", label: "alert email", status: "not sent", level: "warn", origin: "cron", note: String((e as Error).message).slice(0, 200) });
		return false;
	}
}

/** Finished privacy requests are kept this long, as the record that they were answered. Open ones stay until staff close them. */
export const REQUEST_DAYS = 365;

/** Drop app events and delivery records older than LOG_DAYS, and finished privacy requests older than REQUEST_DAYS. */
export async function tidy(s: Stores): Promise<void> {
	await prune(s.log, "at").catch(() => 0);
	await prune(s.deliveries, "receivedAt").catch(() => 0);
	await prune(s.failedEvents, "at").catch(() => 0);
	await prune(s.requests, "at", REQUEST_DAYS, { status: "done" }).catch(() => 0);
}

export { topicName };

// ---------------------------------------------------------------- Webhooks page

export const WEBHOOK_TABS = ["received", "health", "setup"] as const;
export type WebhookTab = (typeof WEBHOOK_TABS)[number];

const OUTCOMES: Record<string, string> = {
	processed: "Processed",
	skipped: "Skipped",
	stale: "Out of date",
	ignored: "Not used",
	pending: "Running",
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export async function webhooksPage(env_: MonitorEnv, tab: WebhookTab = "received", toast?: Toast, cursor?: string): Promise<Blocks> {
	const { s, kv } = env_;
	const now = env_.now?.() ?? Date.now();
	const month = since(now, LOG_DAYS);
	const [received, rejected, failed, last, check, settings] = await Promise.all([
		s.log.count({ event: "webhook.received", at: { gte: month } }),
		count(s, "webhook.rejected", month),
		count(s, "webhook.failed", month),
		lastDelivery(s),
		lastCheck(kv),
		monitorSettings(kv),
	]);
	const page = await s.deliveries.query({ orderBy: { receivedAt: "desc" }, limit: 25, ...(cursor ? { cursor } : {}) });
	const attention = Boolean(check?.problems.length);

	const receivedTab = [
		{ type: "context", text: `What Shopify sent, and what became of it. Kept ${LOG_DAYS} days. Bodies are never stored: only the topic, the result and the customer id. Skipped: nothing to do. Out of date: older than what's stored. Not used: a topic RedeemID ignores.` },
		...(attention ? [{ type: "banner", variant: "alert", title: "Webhook delivery needs attention", description: "See the Health tab." }] : []),
		{
			type: "stats",
			items: [
				{ label: "Received", value: String(received), description: `${LOG_DAYS} days` },
				{ label: "Turned away", value: String(rejected), ...(rejected ? { trend: "down" } : {}) },
				{ label: "Failed", value: String(failed), ...(failed ? { trend: "down" } : {}) },
			],
		},
		...(cursor ? [{ type: "actions", elements: [{ type: "button", action_id: "webhooks_tab", value: "received", label: "Back to the newest", style: "secondary" }] }] : []),
		{
			type: "table",
			page_action_id: "deliveries_page",
			empty_text: "No webhooks received yet.",
			columns: [
				{ key: "topic", label: "Topic", format: "code" },
				{ key: "result", label: "Result", format: "badge" },
				{ key: "customer", label: "Customer" },
				{ key: "at", label: "Received", format: "relative_time" },
			],
			rows: page.items.map(({ data: d }) => ({
				topic: d.topic,
				result: OUTCOMES[d.outcome ?? "processed"] ?? cap(d.outcome ?? ""),
				customer: d.customerId ?? "",
				at: d.receivedAt,
			})),
			...(page.cursor ? { next_cursor: page.cursor } : {}),
		},
	];

	const healthTab = [
		{
			type: "context",
			text: "Members gain and lose access only when Shopify sends tag changes. Once a day RedeemID checks that the subscriptions are still in place (registering again any Shopify dropped), that deliveries are coming in, and that none were turned away or failed.",
		},
		check === null
			? { type: "banner", variant: "default", title: "Not checked yet", description: "Check now, or wait for the daily check." }
			: check.problems.length
				? { type: "banner", variant: check.problems.some((p) => p.level === "error") ? "error" : "alert", title: check.problems.length === 1 ? "1 problem" : `${check.problems.length} problems`, description: check.problems.map((p) => p.text).join(" ") }
				: { type: "banner", variant: "default", title: "Healthy", description: "Subscriptions are in place and deliveries look fine." },
		{
			type: "fields",
			fields: [
				{ label: "Last check", value: check ? when(check.at, now) : "Never" },
				{ label: "Last delivery", value: last ? when(last.receivedAt, now) : "None yet" },
				{ label: "Turned away", value: String(rejected) },
				{ label: "Failed", value: String(failed) },
			],
		},
		{ type: "context", text: `Turned away and failed: the last ${LOG_DAYS} days. Subscriptions: ${SUBS[check?.subscriptions ?? "unchecked"]}.` },
		{
			type: "actions",
			elements: [
				{ type: "button", action_id: "health_check", label: "Check now", style: "primary" },
				...(rejected ? [{ type: "button", action_id: "events_show", value: "webhook.rejected", label: "See turned away", style: "secondary" }] : []),
				...(failed ? [{ type: "button", action_id: "events_show", value: "webhook.failed", label: "See failed", style: "secondary" }] : []),
			],
		},
		{ type: "header", text: "Warnings" },
		{
			type: "form",
			block_id: "monitor",
			fields: [
				{ type: "number_input", action_id: "quiet_days", label: "Warn after this many days without a webhook (0 = never)", min: 0, max: 60, initial_value: settings.quietDays },
				{ type: "text_input", action_id: "alert_email", label: "Email warnings to", placeholder: "you@example.com", initial_value: settings.alertEmail },
			],
			submit: { label: "Save", action_id: "monitor_save" },
		},
		{
			type: "context",
			text: env_.email
				? "One email when problems start or change, and once a week while they last."
				: "No email provider is set up in EmDash, so warnings show here and on the dashboard only. Add an email plugin to get them by email.",
		},
	];

	const setupTab = [
		{ type: "context", text: "Where Shopify sends deliveries, how they're checked, and the app's webhook subscriptions." },
		{ type: "section", text: `Endpoint: ${env_.uri}` },
		{
			type: "section",
			text: env(ENV.webhookSecret)
				? "Signatures: checked with the Admin API app's client secret."
				: `Signatures: the Admin API app's client secret (${ENV.webhookSecret}) is missing, so every delivery is turned away.`,
		},
		...(await webhooksSection(env_.config, env_.uri)),
		{ type: "context", text: "customers/redact, customers/data_request and shop/redact are set in the app's compliance webhooks, not here." },
	];

	return {
		blocks: [
			{ type: "header", text: "Webhooks" },
			{
				type: "tab",
				default_tab: WEBHOOK_TABS.indexOf(tab),
				panels: [
					{ label: "Received", blocks: receivedTab },
					{ label: attention ? "Health (!)" : "Health", blocks: healthTab },
					{ label: "Setup", blocks: setupTab },
				],
			},
		],
		...(toast ? { toast } : {}),
	};
}

const SUBS: Record<HealthResult["subscriptions"], string> = {
	ok: "all in place",
	fixed: "some were missing and are registered again",
	failed: "couldn't all be registered (see the problems above)",
	unchecked: "not checked (set the Admin API app's client ID to check them)",
};

function when(iso: string, now: number): string {
	const ms = now - Date.parse(iso);
	if (ms < 60_000) return "just now";
	if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
	if (ms < DAY) return `${Math.floor(ms / 3_600_000)} h ago`;
	const days = Math.floor(ms / DAY);
	return days === 1 ? "1 day ago" : `${days} days ago`;
}

/** Save the Health tab's warning settings. */
export async function saveMonitor(kv: Kv, values: Record<string, unknown> = {}): Promise<Toast> {
	const days = Math.max(0, Math.min(60, Math.round(Number(values.quiet_days ?? MONITOR_DEFAULTS.quietDays)) || 0));
	const email = String(values.alert_email ?? "").trim();
	if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { type: "error", message: "That email address doesn't look right." };
	await kv.set(KEY_SETTINGS, { quietDays: days, alertEmail: email } satisfies MonitorSettings);
	await record({ event: "settings.saved", label: "webhook warnings", status: "ok", origin: "staff" });
	return { type: "success", message: "Saved." };
}

// ---------------------------------------------------------------- App events page

export interface EventFilter {
	event?: string;
	problems?: boolean;
}

/** A filter carried in the table's block id, so Load more keeps it. */
export function filterId(f: EventFilter): string {
	return `events:${f.event ?? ""}:${f.problems ? 1 : 0}`;
}

export function parseFilter(raw: unknown): EventFilter {
	const [, event = "", problems = "0"] = String(raw ?? "").split(":");
	return { ...(event ? { event } : {}), problems: problems === "1" };
}

export async function eventsPage(s: Stores, filter: EventFilter = {}, cursor?: string, toast?: Toast): Promise<Blocks> {
	if (!cursor) await tidy(s);
	const where: Record<string, unknown> = {};
	if (filter.event && filter.event in LOG_EVENTS) where.event = filter.event;
	if (filter.problems) where.level = { in: ["warn", "error"] };
	const page = await s.log.query({ where: where as never, orderBy: { at: "desc" }, limit: 50, ...(cursor ? { cursor } : {}) });
	const failed = cursor ? null : await s.failedEvents.query({ orderBy: { at: "desc" }, limit: 50 }).catch(() => null);
	return {
		blocks: [
			{ type: "header", text: "App events" },
			{
				type: "context",
				text: `What RedeemID did and what came of it: webhooks, sign-ins, calls to Shopify, staff actions, settings saves and outbound events. Kept ${LOG_DAYS} days. Never bodies, tokens or emails.`,
			},
			...(failed?.items.length ? failedBlocks(failed.items.map((r) => r.data)) : []),
			{
				type: "form",
				block_id: "events_filter",
				fields: [
					{
						type: "select",
						action_id: "event",
						label: "Event",
						options: [{ label: "All events", value: "" }, ...Object.entries(LOG_EVENTS).map(([value, label]) => ({ label, value }))],
						initial_value: filter.event ?? "",
					},
					{ type: "toggle", action_id: "problems", label: "Problems only", initial_value: Boolean(filter.problems) },
				],
				submit: { label: "Show", action_id: "events_filter" },
			},
			...(cursor ? [{ type: "actions", elements: [{ type: "button", action_id: "events_show", value: filter.event ?? "", label: "Back to the newest", style: "secondary" }] }] : []),
			{
				type: "table",
				block_id: filterId(filter),
				page_action_id: "events_page",
				empty_text: filter.event || filter.problems ? "Nothing matches." : "Nothing recorded yet.",
				columns: [
					{ key: "event", label: "Event" },
					{ key: "about", label: "About" },
					{ key: "result", label: "Result", format: "badge" },
					{ key: "customer", label: "Customer" },
					{ key: "ms", label: "Took" },
					{ key: "at", label: "When", format: "relative_time" },
					{ key: "note", label: "Note" },
				],
				rows: page.items.map(({ data }) => eventRow(data)),
				...(page.cursor ? { next_cursor: page.cursor } : {}),
			},
		],
		...(toast ? { toast } : {}),
	};
}

/** Outbound events that failed every try: send again or clear. */
function failedBlocks(list: FailedEvent[]): unknown[] {
	return [
		{ type: "header", text: "Failed events" },
		{
			type: "context",
			text: `Outbound events your receiver didn't take after ${RETRY_DELAYS_MS.length + 1} tries. Send again keeps each one's delivery id, so a receiver that got it after all can drop the copy. Cleared after ${LOG_DAYS} days.`,
		},
		{
			type: "table",
			page_action_id: "failed_page",
			columns: [
				{ key: "event", label: "Event" },
				{ key: "customer", label: "Customer" },
				{ key: "error", label: "Last error" },
				{ key: "tries", label: "Tries" },
				{ key: "at", label: "When", format: "relative_time" },
				{ key: "resend", label: "", format: "element" },
				{ key: "clear", label: "", format: "element" },
			],
			rows: list.map((f) => ({
				event: f.event,
				customer: customerOfBody(f.body),
				error: f.error,
				tries: String(f.attempts),
				at: f.at,
				resend: { type: "button", action_id: "failed_resend", label: "Send again", style: "primary", value: f.id },
				clear: { type: "button", action_id: "failed_clear", label: "Clear", style: "secondary", value: f.id },
			})),
		},
		{
			type: "actions",
			elements: [
				{
					type: "button",
					action_id: "failed_clear_all",
					label: "Clear all",
					style: "danger",
					confirm: { title: "Clear every failed event?", text: "They won't be sent. App events keeps the record that they failed.", confirm: "Clear all", deny: "Cancel", style: "danger" },
				},
			],
		},
	];
}

function customerOfBody(body: string): string {
	try {
		const id = (JSON.parse(body) as { data?: { customerId?: unknown } }).data?.customerId;
		return typeof id === "string" ? id : "";
	} catch {
		return "";
	}
}

function eventRow(e: LogEntry) {
	const status = e.status === "ok" ? "OK" : cap(e.status);
	return {
		event: LOG_EVENTS[e.event] ?? e.event,
		about: e.label,
		result: e.level === "error" && !/error/i.test(status) ? `Error: ${status}` : status,
		customer: e.customerId ?? "",
		ms: e.ms !== undefined ? `${e.ms} ms` : "",
		at: e.at,
		note: e.note ?? "",
	};
}

// ---------------------------------------------------------------- Reports page

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const weekLabel = (ts: number) => `${MONTHS[new Date(ts).getUTCMonth()]} ${new Date(ts).getUTCDate()}`;

const MEMBER_CAP = 1000;
const WEEKS = 12;

export async function reportsPage(config: RedeemIDConfig, s: Stores, now = Date.now()): Promise<Blocks> {
	const levels = config.levels ?? [];
	const members: MemberRecord[] = [];
	let cursor: string | undefined;
	do {
		const page = await s.members.query({ limit: 100, ...(cursor ? { cursor } : {}) });
		members.push(...page.items.map((r) => r.data));
		cursor = page.cursor;
	} while (cursor && members.length < MEMBER_CAP);
	const capped = Boolean(cursor);

	const month = now - 30 * DAY;
	const weekEnd = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate()) + DAY;
	const joinsByWeek = new Array<number>(WEEKS).fill(0);
	const leavesByWeek = new Array<number>(WEEKS).fill(0);
	const byLevel = new Map(levels.map((l) => [l.slug, { members: 0, joined: 0, left: 0 }]));
	const bucket = (iso: string | null | undefined, into: number[]) => {
		if (!iso) return;
		const i = Math.floor((weekEnd - Date.parse(iso)) / (7 * DAY));
		if (i >= 0 && i < WEEKS) into[WEEKS - 1 - i]!++;
	};
	const recent = (iso: string | null | undefined) => Boolean(iso) && Date.parse(iso!) >= month;

	for (const m of members) {
		const { current, past } = membership(m, levels);
		for (const l of current) {
			const row = byLevel.get(l.slug)!;
			if (m.status === "enabled") row.members++;
			if (recent(l.since)) row.joined++;
			bucket(l.since, joinsByWeek);
		}
		for (const l of past) {
			const row = byLevel.get(l.slug)!;
			if (recent(l.from)) row.joined++;
			if (recent(l.to)) row.left++;
			bucket(l.from, joinsByWeek);
			bucket(l.to, leavesByWeek);
		}
	}
	const joined = [...byLevel.values()].reduce((n, r) => n + r.joined, 0);
	const left = [...byLevel.values()].reduce((n, r) => n + r.left, 0);
	const from = since(now, 30);
	const [signIns, metered, usedUp] = await Promise.all([
		count(s, "member.signed_in", from),
		count(s, "meter.used", from),
		count(s, "meter.exhausted", from),
	]);
	const holding = members.filter((m) => m.status === "enabled" && levelsFor(m.tags, levels).length > 0).length;
	const weekTs = (i: number) => weekEnd - (WEEKS - 1 - i) * 7 * DAY - DAY;

	return {
		blocks: [
			{ type: "header", text: "Reports" },
			{
				type: "context",
				text: "A level is joined or left when Shopify adds or removes its tag. Counts come from each member's tag dates; sign-ins and metered reads from App events (kept 30 days).",
			},
			{
				type: "stats",
				items: [
					{ label: "On a level", value: String(holding), description: "now" },
					{ label: "Joined", value: String(joined), description: "30 days", ...(joined ? { trend: "up" } : {}) },
					{ label: "Left", value: String(left), description: "30 days", ...(left ? { trend: "down" } : {}) },
				],
			},
			{
				type: "stats",
				items: [
					{ label: "Sign-ins", value: String(signIns), description: "30 days" },
					{ label: "Metered reads", value: String(metered + usedUp), description: usedUp ? `30 days; ${usedUp} used up the meter` : "30 days" },
				],
			},
			{ type: "header", text: "Joined and left, by week" },
			{
				type: "chart",
				config: {
					chart_type: "custom",
					height: 260,
					options: {
						tooltip: { trigger: "axis" },
						legend: { data: ["Joined", "Left"], bottom: 0 },
						grid: { left: 32, right: 8, top: 16, bottom: 56 },
						xAxis: { type: "category", data: joinsByWeek.map((_, i) => weekLabel(weekTs(i))), axisLabel: { hideOverlap: true } },
						yAxis: { type: "value", minInterval: 1 },
						series: [
							{ name: "Joined", type: "bar", data: joinsByWeek },
							{ name: "Left", type: "bar", data: leavesByWeek },
						],
					},
				},
			},
			{ type: "context", text: "Each bar is the week ending on the date shown." },
			{ type: "header", text: "By level" },
			levels.length
				? {
						type: "table",
						page_action_id: "reports_levels",
						columns: [
							{ key: "level", label: "Level" },
							{ key: "members", label: "Members", format: "number" },
							{ key: "joined", label: "Joined (30 days)", format: "number" },
							{ key: "left", label: "Left (30 days)", format: "number" },
						],
						rows: levels.map((l) => {
							const r = byLevel.get(l.slug)!;
							return { level: l.name, members: r.members, joined: r.joined, left: r.left };
						}),
					}
				: { type: "context", text: "No levels yet. Add them under Access." },
			...(capped ? [{ type: "context", text: `Counted from the first ${MEMBER_CAP} members.` }] : []),
		],
	};
}
