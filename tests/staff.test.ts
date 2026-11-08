import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("emdash/api/route-utils", () => ({ getAuthProviderStorage: () => null }));
vi.mock("virtual:emdash/config", () => ({ default: {} }));

import { customers, editTags, registerWebhooks, resetAdminToken, resync, WEBHOOK_TOPICS } from "../src/admin-api.js";
import type { RedeemIDConfig } from "../src/config.js";
import { emit, levelChange } from "../src/events.js";
import { featuresFor } from "../src/features.js";
import { accessTest, parseTerms } from "../src/staff.js";
import { emptyMember } from "../src/storage.js";
import { memoryStores } from "./memory-store.js";

const config: RedeemIDConfig = {
	shop: "s.myshopify.com",
	levels: [
		{ slug: "member", name: "Member", tags: ["member"] },
		{ slug: "pro", name: "Pro", tags: ["pro"] },
	],
	rules: [{ collection: "posts", taxonomy: "category", term: "reports", levels: ["pro"] }],
	features: [
		{ slug: "ad-free", name: "Ad-free", levels: ["pro"] },
		{ slug: "supporter", name: "Supporter", tags: ["Supporter"] },
	],
	events: { url: "https://hooks.test/in" },
};

type Call = { url: string; init: RequestInit };
function fakeFetch(answer: (url: string, body: string) => unknown) {
	const calls: Call[] = [];
	const fetcher = (async (url: string, init: RequestInit) => {
		calls.push({ url, init });
		return new Response(JSON.stringify(answer(url, String(init.body ?? ""))), { status: 200, headers: { "content-type": "application/json" } });
	}) as unknown as typeof fetch;
	return { calls, fetcher };
}

beforeEach(() => {
	process.env.REDEEMID_SHOPIFY_ADMIN_APP_CLIENT_ID = "admin-client";
	process.env.REDEEMID_SHOPIFY_ADMIN_APP_CLIENT_SECRET = "admin-secret";
	process.env.REDEEMID_EVENTS_SECRET = "events-secret";
	resetAdminToken();
});
afterEach(() => {
	delete process.env.REDEEMID_SHOPIFY_ADMIN_APP_CLIENT_ID;
	delete process.env.REDEEMID_SHOPIFY_ADMIN_APP_CLIENT_SECRET;
	delete process.env.REDEEMID_EVENTS_SECRET;
});

describe("featuresFor", () => {
	it("grants features through levels or tags, case-insensitively", () => {
		expect(featuresFor({ tags: ["pro"], status: "enabled" }, config.features, config.levels)).toEqual(["ad-free"]);
		expect(featuresFor({ tags: ["supporter"], status: "enabled" }, config.features, config.levels)).toEqual(["supporter"]);
		expect(featuresFor({ tags: ["member"], status: "enabled" }, config.features, config.levels)).toEqual([]);
	});
	it("gives nothing to a disabled or missing member", () => {
		expect(featuresFor({ tags: ["pro", "supporter"], status: "disabled" }, config.features, config.levels)).toEqual([]);
		expect(featuresFor(null, config.features, config.levels)).toEqual([]);
	});
});

describe("events", () => {
	it("signs the raw body with the events secret", async () => {
		const { calls, fetcher } = fakeFetch(() => ({}));
		expect(await emit(config, "meter.used", { left: 1 }, fetcher)).toBe(true);
		const { url, init } = calls[0]!;
		const headers = init.headers as Record<string, string>;
		expect(url).toBe("https://hooks.test/in");
		expect(headers["X-RedeemID-Event"]).toBe("meter.used");
		const expected = createHmac("sha256", "events-secret").update(String(init.body)).digest("hex");
		expect(headers["X-RedeemID-Signature"]).toBe(`sha256=${expected}`);
		const body = JSON.parse(String(init.body));
		expect(body).toMatchObject({ event: "meter.used", data: { left: 1 }, id: headers["X-RedeemID-Delivery"] });
	});
	it("sends nothing without a secret, or for an event left out of `only`", async () => {
		const { calls, fetcher } = fakeFetch(() => ({}));
		expect(await emit({ ...config, events: { url: "https://hooks.test/in", only: ["member.signed_in"] } }, "meter.used", {}, fetcher)).toBe(false);
		delete process.env.REDEEMID_EVENTS_SECRET;
		expect(await emit(config, "meter.used", {}, fetcher)).toBe(false);
		expect(calls).toHaveLength(0);
	});
	it("never throws when the receiver is down", async () => {
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		const down = (async () => {
			throw new Error("refused");
		}) as unknown as typeof fetch;
		expect(await emit(config, "meter.used", {}, down)).toBe(false);
		err.mockRestore();
	});
	it("sends member.levels_changed only when the levels change", async () => {
		const { calls, fetcher } = fakeFetch(() => ({}));
		const after = { customerId: "1", tags: ["member", "pro"], status: "enabled" };
		await levelChange(config, ["pro", "member", "newsletter"], after, "webhook", fetcher);
		expect(calls).toHaveLength(0);
		await levelChange(config, ["member"], after, "webhook", fetcher);
		expect(JSON.parse(String(calls[0]!.init.body)).data).toMatchObject({ levels: ["member", "pro"], added: ["pro"], removed: [], source: "webhook" });
		expect(JSON.parse(String(calls[0]!.init.body)).data).not.toHaveProperty("email");
		await levelChange(config, ["member"], { ...after, status: "disabled" }, "webhook", fetcher);
		expect(JSON.parse(String(calls[1]!.init.body)).data).toMatchObject({ levels: [], added: [], removed: ["member"] });
	});
});

describe("Admin API", () => {
	const customer = { id: "gid://shopify/Customer/7", firstName: "Mia", lastName: null, tags: ["Pro", "member"], updatedAt: "2026-11-01T00:00:00Z", defaultEmailAddress: { emailAddress: "Mia@Example.test" } };
	function shop() {
		return fakeFetch((url, body) => {
			if (url.endsWith("/admin/oauth/access_token")) {
				const form = new URLSearchParams(body);
				expect(form.get("grant_type")).toBe("client_credentials");
				expect(form.get("client_id")).toBe("admin-client");
				return { access_token: "tok", scope: "read_customers,write_customers", expires_in: 86399 };
			}
			const { query, variables } = JSON.parse(body);
			if (query.includes("nodes(ids")) return { data: { nodes: variables.ids.map((id: string) => (id === customer.id ? customer : null)) } };
			if (query.includes("tagsAdd(")) return { data: { tagsAdd: { userErrors: [] } } };
			if (query.includes("webhookSubscriptions(")) return { data: { webhookSubscriptions: { nodes: [{ id: "w1", topic: "CUSTOMERS_UPDATE", uri: "https://site.test/hook" }] } } };
			if (query.includes("webhookSubscriptionCreate(")) return { data: { webhookSubscriptionCreate: { userErrors: [] } } };
			return { errors: [{ message: "unexpected" }] };
		});
	}

	it("gets one client-credentials token and reuses it", async () => {
		const { calls, fetcher } = shop();
		const found = await customers(config, ["7", "8"], fetcher);
		await customers(config, ["7"], fetcher);
		expect(found).toEqual([{ customerId: "7", email: "mia@example.test", firstName: "Mia", lastName: null, tags: ["Pro", "member"], updatedAt: Date.parse("2026-11-01T00:00:00Z") }]);
		expect(calls.filter((c) => c.url.endsWith("/access_token"))).toHaveLength(1);
		expect((calls[1]!.init.headers as Record<string, string>)["X-Shopify-Access-Token"]).toBe("tok");
	});

	it("resync updates profile and tags but never the status", async () => {
		const { fetcher } = shop();
		const store = memoryStores();
		await store.stores.members.put("7", { ...emptyMember("7"), status: "disabled", tags: ["member"] });
		const { updated, missing } = await resync(config, store.stores, ["7", "9"], "resync", fetcher);
		expect(missing).toEqual(["9"]);
		expect(updated[0]).toMatchObject({ email: "mia@example.test", tags: ["Pro", "member"], status: "disabled", source: "resync" });
	});

	it("writes tags with tagsAdd on the customer gid", async () => {
		const { calls, fetcher } = shop();
		await editTags(config, "7", "add", ["VIP", " "], fetcher);
		const body = JSON.parse(String(calls.at(-1)!.init.body));
		expect(body.variables).toEqual({ id: "gid://shopify/Customer/7", tags: ["VIP"] });
	});

	it("registers only the topics missing for this address", async () => {
		const { fetcher } = shop();
		const added = await registerWebhooks(config, "https://site.test/hook", fetcher);
		expect(added).toEqual(WEBHOOK_TOPICS.filter((t) => t !== "CUSTOMERS_UPDATE"));
	});
});

describe("access test", () => {
	it("parses taxonomy:term lists", () => {
		expect(parseTerms("category:pro, tag:weekend, category:news, junk")).toEqual({ category: ["pro", "news"], tag: ["weekend"] });
	});
	it("reports whether a reader with these tags gets in", async () => {
		const locked = JSON.stringify(await accessTest(config, { collection: "posts", terms: "category:reports", tags: "member", signed_in: true }));
		expect(locked).toContain("Locked: asked to upgrade");
		const open = JSON.stringify(await accessTest(config, { collection: "posts", terms: "category:reports", tags: "pro", signed_in: true }));
		expect(open).toContain("Can read");
		const out = JSON.stringify(await accessTest(config, { collection: "posts", terms: "category:reports", tags: "pro", signed_in: false }));
		expect(out).toContain("Locked: asked to sign in");
	});
});
