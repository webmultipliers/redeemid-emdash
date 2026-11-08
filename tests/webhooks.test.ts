import { describe, expect, it } from "vitest";

import { emptyMember } from "../src/storage.js";
import { apply, sign, verifyHmac } from "../src/webhooks.js";
import { memoryStores } from "./memory-store.js";

const bytes = (s: string) => new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>;

describe("HMAC", () => {
	it("accepts Shopify's signature and rejects anything else", async () => {
		const body = bytes('{"id":1}');
		const sig = await sign(body, "shh");
		expect(await verifyHmac(body, sig, "shh")).toBe(true);
		expect(await verifyHmac(body, sig, "other")).toBe(false);
		expect(await verifyHmac(bytes('{"id":2}'), sig, "shh")).toBe(false);
		expect(await verifyHmac(body, "not base64!", "shh")).toBe(false);
		expect(await verifyHmac(body, "", "shh")).toBe(false);
	});

	it("matches a known HMAC-SHA256 vector", async () => {
		// echo -n 'hello' | openssl dgst -sha256 -hmac key -binary | base64
		expect(await sign(bytes("hello"), "key")).toBe("kwezuRXvtRcf8U2MtV+8x5jGwO8UVtZt7RpqpyOli3s=");
	});
});

describe("mirror", () => {
	it("creates and updates profiles, keeping tags when a payload has none", async () => {
		const m = memoryStores();
		await apply(m.stores, "customers/create", { id: 7, email: "A@B.co", first_name: "Ann", tags: "member, vip", updated_at: "2026-11-01T00:00:00Z" });
		expect(m.members.get("7")).toMatchObject({ email: "a@b.co", firstName: "Ann", tags: ["member", "vip"], status: "enabled" });
		await apply(m.stores, "customers/update", { id: 7, last_name: "Lee", updated_at: "2026-11-02T00:00:00Z" });
		expect(m.members.get("7")).toMatchObject({ lastName: "Lee", tags: ["member", "vip"] });
	});

	it("drops out-of-order profile and status webhooks", async () => {
		const m = memoryStores();
		await apply(m.stores, "customers/update", { id: 7, tags: "pro", updated_at: "2026-11-02T00:00:00Z" });
		expect(await apply(m.stores, "customers/update", { id: 7, tags: "", updated_at: "2026-11-01T00:00:00Z" })).toBe("stale");
		expect(m.members.get("7")?.tags).toEqual(["pro"]);
		await apply(m.stores, "customers/disable", { id: 7, updated_at: "2026-11-03T00:00:00Z" });
		expect(await apply(m.stores, "customers/enable", { id: 7, updated_at: "2026-11-02T12:00:00Z" })).toBe("stale");
		expect(m.members.get("7")?.status).toBe("disabled");
	});

	it("adds and removes tags from tag events", async () => {
		const m = memoryStores();
		m.members.set("7", { ...emptyMember("7"), tags: ["member"] });
		await apply(m.stores, "customer.tags_added", { customerId: "gid://shopify/Customer/7", tags: ["Pro", "member"] });
		expect(m.members.get("7")?.tags).toEqual(["member", "Pro"]);
		await apply(m.stores, "customer.tags_removed", { customerId: "gid://shopify/Customer/7", tags: ["pro"] });
		expect(m.members.get("7")?.tags).toEqual(["member"]);
	});

	it("moves the site link to the surviving customer on merge", async () => {
		const m = memoryStores();
		m.members.set("1", { ...emptyMember("1"), userId: "u1", tags: ["member"] });
		await apply(m.stores, "customers/merge", {
			admin_graphql_api_customer_kept_id: "gid://shopify/Customer/2",
			admin_graphql_api_customer_deleted_id: "gid://shopify/Customer/1",
			status: "completed",
		});
		expect(m.members.has("1")).toBe(false);
		expect(m.members.get("2")).toMatchObject({ userId: "u1", tags: [] });
	});

	it("forgets deleted and redacted customers and ignores unknown topics", async () => {
		const m = memoryStores();
		m.members.set("7", emptyMember("7"));
		m.members.set("8", emptyMember("8"));
		await apply(m.stores, "customers/delete", { id: 7 });
		await apply(m.stores, "customers/redact", { customer: { id: 8 }, shop_domain: "s.myshopify.com" });
		expect(m.members.size).toBe(0);
		expect(await apply(m.stores, "orders/create", { id: 1 })).toBe("ignored");
	});
});
