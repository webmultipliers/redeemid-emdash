import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("emdash/api/route-utils", () => ({ getAuthProviderStorage: () => store.stores }));
vi.mock("virtual:emdash/config", () => ({ default: {} }));

const shopify = vi.hoisted(() => ({ configured: false, register: vi.fn(async () => ({ added: [] as string[], failed: [] as Array<{ topic: string; message: string }> })) }));
vi.mock("../src/admin-api.js", async (orig) => ({
	...(await orig<typeof import("../src/admin-api.js")>()),
	adminConfigured: () => shopify.configured,
	registerWebhooks: shopify.register,
}));

import type { RedeemIDConfig } from "../src/config.js";
import { LOG_DAYS, record, setLogSink, timed, type LogEntry } from "../src/log.js";
import { eventsPage, filterId, healthCheck, lastCheck, parseFilter, reportsPage, saveMonitor, webhooksPage, type Kv, type MonitorEnv } from "../src/monitor.js";
import { POST } from "../src/routes/webhook.js";
import { emptyMember } from "../src/storage.js";
import { sign } from "../src/webhooks.js";
import { memoryStores } from "./memory-store.js";

const store = memoryStores();
const SECRET = "REDEEMID_SHOPIFY_ADMIN_APP_CLIENT_SECRET";
const config: RedeemIDConfig = { shop: "s.myshopify.com", levels: [{ slug: "member", name: "Member", tags: ["member"] }, { slug: "pro", name: "Pro", tags: ["pro"] }] };

let n = 0;
setLogSink(async (e) => {
	store.log.set(`${e.at}:${n++}`, e);
});

function kv(): Kv & { rows: Map<string, unknown> } {
	const rows = new Map<string, unknown>();
	return { rows, get: async (k) => (rows.get(k) ?? null) as never, set: async (k, v) => void rows.set(k, structuredClone(v)) };
}

function monitor(extra: Partial<MonitorEnv> = {}): MonitorEnv {
	return { config, s: store.stores, kv: kv(), uri: "https://site.test/_emdash/api/auth/redeemid/webhook", email: undefined, ...extra };
}

const events = () => [...store.log.values()];

beforeEach(() => {
	process.env[SECRET] = "shh";
});

afterEach(() => {
	store.log.clear();
	store.deliveries.clear();
	store.members.clear();
	shopify.configured = false;
	shopify.register.mockClear();
	delete process.env[SECRET];
});

afterAll(() => setLogSink(null));

async function deliver(topic: string, payload: unknown, opts: { secret?: string; id?: string } = {}) {
	const body = new TextEncoder().encode(JSON.stringify(payload)) as Uint8Array<ArrayBuffer>;
	const request = new Request("https://site.test/_emdash/api/auth/redeemid/webhook", {
		method: "POST",
		body,
		headers: { "x-shopify-topic": topic, "x-shopify-hmac-sha256": await sign(body, opts.secret ?? "shh"), "x-shopify-event-id": opts.id ?? crypto.randomUUID() },
	});
	const locals = { emdash: { db: {}, config: { authProviders: [{ id: "redeemid", config }] } } };
	return (POST as unknown as (c: unknown) => Promise<Response>)({ request, locals });
}

describe("app events", () => {
	it("records each webhook: received with its outcome and customer, turned away, duplicate", async () => {
		expect((await deliver("customers/update", { id: 7, tags: "member", updated_at: "2026-11-01T00:00:00Z" }, { id: "d1" })).status).toBe(200);
		expect(store.deliveries.get("d1")).toMatchObject({ topic: "customers/update", outcome: "processed", customerId: "7" });
		expect((await deliver("customers/update", { id: 7 }, { id: "d1" })).status).toBe(200);
		expect((await deliver("customers/update", { id: 7 }, { secret: "wrong" })).status).toBe(401);
		const seen = events().map((e) => [e.event, e.status, e.customerId ?? null]);
		expect(seen).toEqual([
			["webhook.received", "processed", "7"],
			["webhook.received", "duplicate", "7"],
			["webhook.rejected", "rejected", null],
		]);
		expect(events()[2]).toMatchObject({ level: "warn", note: "Bad signature" });
	});

	it("never stores a body or an email", async () => {
		await deliver("customers/update", { id: 8, email: "someone@example.com", tags: "pro" });
		expect(JSON.stringify(events())).not.toContain("someone@example.com");
	});

	it("times a call and keeps its error short", async () => {
		await timed("shopify.admin", "Customers", async () => 1);
		await expect(timed("shopify.admin", "Customers", async () => Promise.reject(new Error("x".repeat(500))))).rejects.toThrow();
		expect(events().map((e) => e.status)).toEqual(["ok", "error"]);
		expect(events()[1]!.note).toHaveLength(200);
	});

	it("filters by event or problems, and keeps the filter for Load more", async () => {
		await record({ event: "member.signed_in", label: "sign-in", status: "ok" });
		await record({ event: "webhook.failed", label: "customers/update", status: "error", level: "error" });
		await record({ event: "member.refused", label: "staff_account", status: "refused", level: "warn" });
		const rows = async (f: Parameters<typeof eventsPage>[1]) => ((await eventsPage(store.stores, f)).blocks.find((b) => (b as { type: string }).type === "table") as { rows: Array<{ what: string }> }).rows.map((r) => r.what);
		expect(await rows({})).toHaveLength(3);
		expect((await rows({ problems: true })).sort()).toEqual(["Error. Webhook failed: customers/update, error", "Warning. Sign-in refused: staff_account, refused"]);
		expect(await rows({ event: "member.signed_in" })).toEqual(["Sign-in: sign-in"]);
		expect(parseFilter(filterId({ event: "webhook.failed", problems: true }))).toEqual({ event: "webhook.failed", problems: true });
	});

	it(`drops events and deliveries older than ${LOG_DAYS} days`, async () => {
		const old = new Date(Date.now() - (LOG_DAYS + 1) * 86_400_000).toISOString();
		store.log.set("old", { at: old, event: "member.signed_in", label: "x", status: "ok", level: "ok" } as LogEntry);
		store.deliveries.set("old", { topic: "customers/update", receivedAt: old });
		store.deliveries.set("new", { topic: "customers/update", receivedAt: new Date().toISOString() });
		await eventsPage(store.stores);
		expect(store.log.has("old")).toBe(false);
		expect([...store.deliveries.keys()]).toEqual(["new"]);
	});
});

describe("webhook health", () => {
	it("warns when nothing has come in, and when deliveries are turned away or fail", async () => {
		const m = monitor();
		let r = await healthCheck(m);
		expect(r.problems.map((p) => p.text)).toEqual([expect.stringContaining("No webhooks received yet")]);
		store.deliveries.set("d", { topic: "customers/update", receivedAt: new Date(Date.now() - 5 * 86_400_000).toISOString() });
		await record({ event: "webhook.rejected", label: "customers/update", status: "rejected", level: "warn" });
		await record({ event: "webhook.failed", label: "customers/update", status: "error", level: "error" });
		r = await healthCheck(m);
		expect(r.problems.map((p) => p.level)).toEqual(["warn", "warn", "error"]);
		expect(r.problems[0]!.text).toContain("No webhooks for 5 days");
		expect(await lastCheck(m.kv)).toMatchObject({ problems: r.problems });
		expect(events().filter((e) => e.event === "health.check").at(-1)).toMatchObject({ level: "error", origin: "cron" });
	});

	it("is quiet for a healthy site, and when warnings are off", async () => {
		store.deliveries.set("d", { topic: "customers/update", receivedAt: new Date().toISOString() });
		expect((await healthCheck(monitor())).problems).toEqual([]);
		store.deliveries.clear();
		const m = monitor();
		expect((await saveMonitor(m.kv, { quiet_days: 0 })).type).toBe("success");
		expect((await healthCheck(m)).problems).toEqual([]);
	});

	it("says when the signing secret is missing", async () => {
		delete process.env[SECRET];
		store.deliveries.set("d", { topic: "customers/update", receivedAt: new Date().toISOString() });
		expect((await healthCheck(monitor())).problems).toEqual([{ level: "error", text: expect.stringContaining("signing secret") }]);
	});

	it("registers dropped subscriptions again", async () => {
		shopify.configured = true;
		shopify.register.mockResolvedValueOnce({ added: ["CUSTOMERS_UPDATE"], failed: [] });
		store.deliveries.set("d", { topic: "customers/update", receivedAt: new Date().toISOString() });
		const r = await healthCheck(monitor());
		expect(shopify.register).toHaveBeenCalledWith(config, "https://site.test/_emdash/api/auth/redeemid/webhook");
		expect(r).toMatchObject({ subscriptions: "fixed", registered: ["CUSTOMERS_UPDATE"] });
		expect(r.problems[0]!.text).toContain("customers/update");
	});

	it("emails new problems once, then again only when they change", async () => {
		const sent: string[] = [];
		const m = monitor({ email: { send: async (msg) => void sent.push(`${msg.to}|${msg.text}`) } });
		await saveMonitor(m.kv, { quiet_days: 3, alert_email: "staff@example.com" });
		expect((await healthCheck(m)).emailed).toBe(true);
		expect((await healthCheck(m)).emailed).toBe(false);
		await record({ event: "webhook.failed", label: "customers/update", status: "error", level: "error" });
		expect((await healthCheck(m)).emailed).toBe(true);
		expect(sent).toHaveLength(2);
		expect(sent[0]).toMatch(/^staff@example\.com\|/);
	});

	it("refuses a bad alert address", async () => {
		expect((await saveMonitor(kv(), { alert_email: "not an email" })).type).toBe("error");
	});

	it("renders the three tabs with the deliveries", async () => {
		await deliver("customers/update", { id: 7, tags: "member" });
		const page = JSON.stringify(await webhooksPage(monitor(), "health"));
		for (const text of ["Received", "Health", "Setup", "customers/update", "customers/update: Processed, customer 7", "Check now", "Email warnings to", "No email provider"]) expect(page).toContain(text);
		expect(page).toContain('"default_tab":1');
	});
});

describe("reports", () => {
	it("counts members by level, who joined and left, and sign-ins", async () => {
		const now = Date.now();
		const ago = (d: number) => new Date(now - d * 86_400_000).toISOString();
		store.members.set("1", { ...emptyMember("1"), tags: ["member"], tagsSince: { member: ago(3) } });
		store.members.set("2", { ...emptyMember("2"), tags: ["pro"], tagsSince: { pro: ago(60) }, pastTags: [{ tag: "member", from: ago(90), to: ago(10) }] });
		await record({ event: "member.signed_in", label: "sign-in", status: "ok" });
		const page = await reportsPage(config, store.stores, now);
		const stats = page.blocks.filter((b) => (b as { type: string }).type === "stats").flatMap((b) => (b as { items: Array<{ label: string; value: string }> }).items);
		expect(Object.fromEntries(stats.map((s) => [s.label, s.value]))).toMatchObject({ "On a level": "2", Joined: "1", Left: "1", "Sign-ins": "1" });
		const table = page.blocks.find((b) => (b as { type: string }).type === "table") as { rows: unknown[] };
		expect(table.rows).toEqual([
			{ level: "Member", members: 1, change: "+1 / -1" },
			{ level: "Pro", members: 1, change: "+0 / -0" },
		]);
		const chart = page.blocks.find((b) => (b as { type: string }).type === "chart") as { config: { options: { series: Array<{ data: number[] }>; xAxis: { data: string[] } } } };
		expect(chart.config.options.xAxis.data).toHaveLength(12);
		expect(chart.config.options.series[0]!.data.at(-1)).toBe(1);
		expect(chart.config.options.series[1]!.data.at(-2)).toBe(1);
	});
});
