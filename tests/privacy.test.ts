import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetAdminToken } from "../src/admin-api.js";
import { eraseAll, eraseMember, exportMember, exportRequest, requestShopifyErasure } from "../src/privacy.js";
import { emptyMember } from "../src/storage.js";
import { apply } from "../src/webhooks.js";
import { memoryStores } from "./memory-store.js";

function seeded() {
	const m = memoryStores();
	m.members.set("7", { ...emptyMember("7"), userId: "u7", email: "a@b.co", tags: ["member"] });
	m.members.set("8", { ...emptyMember("8"), userId: "u8" });
	m.meter.set("u7:2026-11", { userId: "u7", period: "2026-11", items: ["posts:1"] });
	m.meter.set("u8:2026-11", { userId: "u8", period: "2026-11", items: ["posts:2"] });
	return m;
}

describe("privacy", () => {
	it("exports the member record and their meter only", async () => {
		const m = seeded();
		const data = await exportMember(m.stores, "7");
		expect(data.member?.email).toBe("a@b.co");
		expect(data.meter).toEqual([{ userId: "u7", period: "2026-11", items: ["posts:1"] }]);
		await exportRequest(m.stores, "7", "member");
		expect([...m.requests.values()]).toMatchObject([{ kind: "export", source: "member", customerId: "7", status: "done" }]);
	});

	it("erases one member's record and meter and logs it without their email", async () => {
		const m = seeded();
		expect(await eraseMember(null, m.stores, "7", "staff")).toBe(true);
		expect(m.members.has("7")).toBe(false);
		expect(m.meter.has("u7:2026-11")).toBe(false);
		expect(m.members.has("8") && m.meter.has("u8:2026-11")).toBe(true);
		const log = [...m.requests.values()];
		expect(log).toMatchObject([{ kind: "erase", source: "staff", customerId: "7", status: "done" }]);
		expect(JSON.stringify(log)).not.toContain("a@b.co");
	});

	it("handles Shopify's three compliance topics", async () => {
		const m = seeded();
		await apply(m.stores, "customers/data_request", { customer: { id: 7 }, data_request: { id: 9001 } });
		expect([...m.requests.values()]).toMatchObject([{ kind: "export", source: "shopify", customerId: "7", status: "open", shopifyRequestId: "9001" }]);
		expect(m.members.has("7")).toBe(true);
		await apply(m.stores, "customers/redact", { customer: { id: 7 } });
		expect(m.members.has("7") || m.meter.has("u7:2026-11")).toBe(false);
		await apply(m.stores, "shop/redact", { shop_domain: "s.myshopify.com" });
		expect(m.members.size + m.meter.size).toBe(0);
		expect([...m.requests.values()].map((r) => r.note ?? r.kind)).toEqual(["export", "erase", "Shop redacted: 1 members"]);
	});
});

describe("shop/redact", () => {
	it("erases a large shop in a few queries per hundred members", async () => {
		const m = memoryStores();
		for (let i = 0; i < 450; i++) {
			m.members.set(String(i), { ...emptyMember(String(i)), userId: `u${i}` });
			m.meter.set(`u${i}:2026-11`, { userId: `u${i}`, period: "2026-11", items: ["posts:1"] });
		}
		let calls = 0;
		for (const c of [m.stores.members, m.stores.meter] as unknown as Array<Record<string, (...a: unknown[]) => unknown>>) {
			for (const k of ["get", "delete", "query", "deleteMany"]) {
				const f = c[k]!.bind(c);
				c[k] = (...a: unknown[]) => (calls++, f(...a));
			}
		}
		expect(await eraseAll(null, m.stores)).toBe(450);
		expect(m.members.size + m.meter.size).toBe(0);
		// 5 pages of members and meter (query + delete each) plus the two empty reads.
		expect(calls).toBeLessThanOrEqual(22);
	});
});

describe("Shopify erasure", () => {
	beforeEach(() => {
		process.env.REDEEMID_SHOPIFY_ADMIN_APP_CLIENT_ID = "id";
		process.env.REDEEMID_SHOPIFY_ADMIN_APP_CLIENT_SECRET = "secret";
		resetAdminToken();
	});
	afterEach(() => {
		delete process.env.REDEEMID_SHOPIFY_ADMIN_APP_CLIENT_ID;
		delete process.env.REDEEMID_SHOPIFY_ADMIN_APP_CLIENT_SECRET;
	});

	it("asks Shopify with the customer's gid and surfaces its errors", async () => {
		const sent: Array<Record<string, unknown>> = [];
		let error: string | null = null;
		const fetcher = (async (url: string, init: RequestInit) => {
			if (url.endsWith("/access_token")) return Response.json({ access_token: "t", expires_in: 3600 });
			sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
			return Response.json({ data: { customerRequestDataErasure: { customerId: "gid://shopify/Customer/7", userErrors: error ? [{ field: null, message: error, code: "X" }] : [] } } });
		}) as unknown as typeof fetch;
		const m = seeded();
		const config = { shop: "s.myshopify.com" };
		await requestShopifyErasure(config, m.stores, "7", fetcher);
		expect(sent[0]?.variables).toEqual({ id: "gid://shopify/Customer/7" });
		expect(String(sent[0]?.query)).toContain("customerRequestDataErasure(customerId: $id)");
		expect([...m.requests.values()]).toMatchObject([{ kind: "erase", source: "staff", status: "open" }]);
		error = "Customer does not exist";
		await expect(requestShopifyErasure(config, m.stores, "7", fetcher)).rejects.toThrow("Customer does not exist");
	});
});
