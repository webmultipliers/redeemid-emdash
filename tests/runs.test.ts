import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("emdash/api/route-utils", () => ({ getAuthProviderStorage: () => null }));
vi.mock("virtual:emdash/config", () => ({ default: {} }));

import { ENV } from "../src/config.js";
import { resetAdminToken } from "../src/admin-api.js";
import { loadRun, MAX_TRIES, runBlock, startRun, stepRun, stopRun, type RunKv, type RunLabels } from "../src/runs.js";
import { resyncBatch, resyncTotal } from "../src/staff.js";
import { emptyMember } from "../src/storage.js";
import { resourcesPage, RESOURCES } from "../src/resources.js";
import { memoryStores } from "./memory-store.js";

function kv(): RunKv {
	const m = new Map<string, unknown>();
	return { get: async <T>(k: string) => (m.has(k) ? structuredClone(m.get(k)) as T : null), set: async (k, v) => void m.set(k, structuredClone(v)) };
}

const labels: RunLabels = { title: "T", about: "About", noun: "customers", start: "Resync all", verb: "read", prefix: "customers_resync" };

describe("runs", () => {
	it("starts, steps a batch at a time, pauses, resumes and finishes", async () => {
		const store = kv();
		let left = 3;
		const batch = async () => (left-- > 0 ? { read: 10, changed: 1 } : { read: 0 });
		const run = await startRun(store, "job", "new", async () => 30);
		expect(run).toMatchObject({ state: "running", total: 30, done: 0 });
		await stepRun(store, "job", batch);
		await stopRun(store, "job");
		expect((await loadRun(store, "job"))!.state).toBe("paused");
		// A paused run doesn't step.
		expect((await stepRun(store, "job", batch))!.done).toBe(10);
		await startRun(store, "job", "resume", async () => 99);
		await stepRun(store, "job", batch);
		await stepRun(store, "job", batch);
		const end = await stepRun(store, "job", batch);
		expect(end).toMatchObject({ state: "finished", done: 30, changed: 3, total: 30 });
		const block = runBlock(end, labels) as { state: string; text: string; actions: Record<string, string> };
		expect(block.state).toBe("finished");
		expect(block.text).toContain("30 customers read");
		expect(block.actions.next).toBe("customers_resync_next");
	});

	it("waits longer when Shopify throttles, then pauses with the reason", async () => {
		const store = kv();
		await startRun(store, "job", "new", async () => null);
		const throttled = async () => {
			throw new Error("Throttled");
		};
		for (let n = 1; n <= MAX_TRIES; n++) {
			const r = await stepRun(store, "job", throttled);
			expect(r).toMatchObject({ state: "running", tries: n });
			expect((runBlock(r, labels) as { pace_ms: number }).pace_ms).toBeGreaterThan(1500);
		}
		expect(await stepRun(store, "job", throttled)).toMatchObject({ state: "paused", error: "Throttled" });
		expect(await stepRun(store, "job", async () => ({ read: 0 }))).toMatchObject({ state: "paused" });
	});

	it("pauses when every one in a batch fails", async () => {
		const store = kv();
		await startRun(store, "job", "new", async () => null);
		expect(await stepRun(store, "job", async () => ({ read: 4, failed: 4 }))).toMatchObject({ state: "paused", failed: 4 });
	});
});

describe("resync all", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		resetAdminToken();
		delete process.env[ENV.adminClientId];
		delete process.env[ENV.webhookSecret];
	});

	it("reads every customer synced before the run once, in batches, stepping over ones Shopify lost", async () => {
		process.env[ENV.adminClientId] = "c";
		process.env[ENV.webhookSecret] = "s";
		const { stores } = memoryStores();
		const old = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
		for (let n = 0; n < 60; n++) await stores.members.put(String(n), { ...emptyMember(String(n)), syncedAt: old(n % 50) });
		const gone = new Set(["3", "41"]);
		const read: string[] = [];
		vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
			if (url.endsWith("/admin/oauth/access_token")) return Response.json({ access_token: "t", expires_in: 86400, scope: "write_customers" });
			const ids = (JSON.parse(String(init.body)).variables.ids as string[]).map((g) => g.split("/").pop()!);
			read.push(...ids);
			return Response.json({ data: { nodes: ids.filter((id) => !gone.has(id)).map((id) => ({ id: `gid://shopify/Customer/${id}`, email: `${id}@x.test`, tags: ["member"], updatedAt: old(0) })) } });
		});
		const store = kv();
		const config = { shop: "s.myshopify.com" };
		const run = await startRun(store, "customers-resync", "new", () => resyncTotal(stores));
		expect(run.total).toBe(60);
		let r = run;
		for (let n = 0; n < 10 && r.state === "running"; n++) r = (await stepRun(store, "customers-resync", (x) => resyncBatch(config, stores, x)))!;
		expect(r.state).toBe("finished");
		expect(r.done).toBe(60);
		expect(r.missing).toBe(2);
		expect(new Set(read).size).toBe(60);
		expect(read.length).toBe(60);
	});
});

describe("resources", () => {
	it("lists every section, with store links only once the store is set", () => {
		const without = JSON.stringify(resourcesPage({}));
		for (const s of RESOURCES.filter((x) => !x.items.every((i) => i.url.startsWith("/")))) expect(without).toContain(s.title);
		expect(without).not.toContain("/admin/customers");
		const withShop = JSON.stringify(resourcesPage({ shop: "my-store.myshopify.com" }));
		expect(withShop).toContain("https://my-store.myshopify.com/admin/customers");
		expect(withShop).toContain("In your Shopify admin");
	});
});
