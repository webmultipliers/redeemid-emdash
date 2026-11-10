import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("emdash/api/route-utils", () => ({ getAuthProviderStorage: () => store.stores }));
vi.mock("virtual:emdash/config", () => ({ default: {} }));

const shopify = vi.hoisted(() => ({ configured: true, tags: ["member"] as string[], fail: false, calls: 0 }));
vi.mock("../src/admin-api.js", async (orig) => {
	const real = await orig<typeof import("../src/admin-api.js")>();
	return {
		...real,
		adminConfigured: () => shopify.configured,
		// Shopify's tags as they are now, written to the mirror as the real resync does.
		resync: async (_c: unknown, s: import("../src/storage.js").Stores, ids: string[], source: string) => {
			shopify.calls++;
			if (shopify.fail) throw new Error("Admin API down");
			const { emptyMember, stampTags } = await import("../src/storage.js");
			const m = (await s.members.get(ids[0]!)) ?? emptyMember(ids[0]!);
			m.tags = [...shopify.tags];
			m.source = source;
			await s.members.put(ids[0]!, stampTags(m));
			return { updated: [m], missing: [] };
		},
	};
});

import type { RedeemIDConfig } from "../src/config.js";
import { POST } from "../src/routes/webhook.js";
import { emptyMember } from "../src/storage.js";
import { sign } from "../src/webhooks.js";
import { memoryStores } from "./memory-store.js";

const store = memoryStores();
const config: RedeemIDConfig = { shop: "s.myshopify.com", levels: [{ slug: "member", name: "Member", tags: ["member"] }] };
process.env.REDEEMID_SHOPIFY_ADMIN_APP_CLIENT_SECRET = "shh";

async function deliver(topic: string, payload: unknown) {
	const body = new TextEncoder().encode(JSON.stringify(payload)) as Uint8Array<ArrayBuffer>;
	const request = new Request("https://site.test/_emdash/api/auth/redeemid/webhook", {
		method: "POST",
		body,
		headers: { "x-shopify-topic": topic, "x-shopify-hmac-sha256": await sign(body, "shh"), "x-shopify-event-id": crypto.randomUUID() },
	});
	const locals = { emdash: { db: {}, config: { authProviders: [{ id: "redeemid", config }] } } };
	return (POST as unknown as (c: unknown) => Promise<Response>)({ request, locals });
}

afterEach(() => {
	store.members.clear();
	store.deliveries.clear();
	store.log.clear();
	Object.assign(shopify, { configured: true, tags: ["member"], fail: false, calls: 0 });
});

describe("tag webhooks", () => {
	it("read the customer's tags from Shopify, so out-of-order deliveries can't leave them wrong", async () => {
		store.members.set("7", { ...emptyMember("7"), tags: [] });
		// Shopify added then removed "member"; the removal arrives first.
		shopify.tags = [];
		await deliver("customer.tags_removed", { customerId: "gid://shopify/Customer/7", tags: ["member"] });
		await deliver("customer.tags_added", { customerId: "gid://shopify/Customer/7", tags: ["member"] });
		expect(store.members.get("7")?.tags).toEqual([]);
		expect(shopify.calls).toBe(2);
	});

	it("apply the change without the Admin API app, or when the read fails", async () => {
		store.members.set("7", { ...emptyMember("7"), tags: [] });
		shopify.configured = false;
		await deliver("customer.tags_added", { customerId: "gid://shopify/Customer/7", tags: ["gold"] });
		expect(store.members.get("7")?.tags).toEqual(["gold"]);
		shopify.configured = true;
		shopify.fail = true;
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		await deliver("customer.tags_added", { customerId: "gid://shopify/Customer/7", tags: ["pro"] });
		expect(store.members.get("7")?.tags).toEqual(["gold", "pro"]);
	});
});

describe("customers/merge", () => {
	const merge = { admin_graphql_api_customer_kept_id: "gid://shopify/Customer/8", admin_graphql_api_customer_deleted_id: "gid://shopify/Customer/7" };

	it("reads the survivor's tags from Shopify after moving the link", async () => {
		store.members.set("7", { ...emptyMember("7"), userId: "u1", tags: ["member"] });
		shopify.tags = ["member", "gold"];
		const res = await deliver("customers/merge", merge);
		expect(await res.text()).toBe("processed");
		expect(store.members.get("7")).toBeUndefined();
		expect(store.members.get("8")).toMatchObject({ userId: "u1", tags: ["member", "gold"] });
		expect(shopify.calls).toBe(1);
	});

	it("keeps the merge when the read fails, and skips it without the app", async () => {
		store.members.set("7", { ...emptyMember("7"), userId: "u1" });
		shopify.fail = true;
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		await deliver("customers/merge", merge);
		expect(store.members.get("8")).toMatchObject({ userId: "u1", tags: [] });
		store.members.clear();
		store.members.set("7", { ...emptyMember("7"), userId: "u2" });
		Object.assign(shopify, { configured: false, fail: false, calls: 0 });
		await deliver("customers/merge", merge);
		expect(shopify.calls).toBe(0);
	});
});
