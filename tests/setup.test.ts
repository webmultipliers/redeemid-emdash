import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV } from "../src/config.js";
import { grantedScopes, resetAdminToken, WEBHOOK_TOPICS } from "../src/admin-api.js";
import { setupFacts, setupPage, setupSteps, WEBHOOK, type SetupFacts } from "../src/setup.js";
import { memoryStores } from "./memory-store.js";

const blank: SetupFacts = {
	origin: "https://site.test",
	domain: null,
	discovery: null,
	clientId: false,
	clientSecret: false,
	webhookSecret: false,
	adminClientId: false,
	admin: null,
	scopes: [],
	webhooksMissing: null,
	levels: [],
	signedIn: 0,
	storefront: false,
};
const ready: SetupFacts = {
	...blank,
	domain: "shop.myshopify.com",
	discovery: "ok",
	clientId: true,
	webhookSecret: true,
	adminClientId: true,
	admin: "ok",
	scopes: ["read_customers", "write_customers"],
	webhooksMissing: [],
	levels: [{ name: "Members", tags: ["member"] }],
};
const state = (f: SetupFacts) => Object.fromEntries(setupSteps(f).map((s) => [s.key, s.state]));
const text = (b: { blocks: unknown[] }) => JSON.stringify(b.blocks);

describe("setup steps", () => {
	it("a fresh site starts at the store, with the rest waiting", () => {
		expect(state(blank)).toEqual({ store: "todo", sign_in: "waiting", app: "waiting", webhooks: "waiting", level: "todo", try: "waiting", storefront: "optional" });
	});

	it("a store that doesn't answer stays to do and says why", () => {
		const f = { ...blank, domain: "nope.myshopify.com", discovery: "404 Not Found" };
		expect(state(f).store).toBe("todo");
		expect(text(setupPage(f))).toContain("404 Not Found");
	});

	it("the app needs both scopes", () => {
		const f = { ...ready, scopes: ["read_customers"], webhooksMissing: null };
		expect(state(f).app).toBe("todo");
		expect(state(f).webhooks).toBe("waiting");
		expect(text(setupPage(f))).toContain("lacks write_customers");
	});

	it("write_customers alone covers read_customers, as Shopify reports it", () => {
		expect(grantedScopes("write_customers,read_customer_merge").sort()).toEqual(["read_customer_merge", "read_customers", "write_customers"]);
		expect(grantedScopes(" read_customers ")).toEqual(["read_customers"]);
		expect(grantedScopes("")).toEqual([]);
		const f = { ...ready, scopes: grantedScopes("write_customers") };
		expect(state(f).app).toBe("done");
		expect(state(f).webhooks).toBe("done");
	});

	it("missing webhooks get a Register button", () => {
		const f = { ...ready, webhooksMissing: ["customers/update", "customers/delete"] };
		expect(state(f).webhooks).toBe("todo");
		const t = text(setupPage(f));
		expect(t).toContain("setup_register");
		expect(t).toContain("Register 2 webhooks");
	});

	it("a level without a tag doesn't count", () => {
		expect(state({ ...ready, levels: [{ name: "Members", tags: [] }] }).level).toBe("todo");
	});

	it("the sign-in step gives the exact values to paste and the commands, never a secret", () => {
		const t = text(setupPage({ ...blank, domain: "shop.myshopify.com", discovery: "ok" }));
		expect(t).toContain("https://site.test/_emdash/api/auth/redeemid/callback");
		expect(t).toContain(`wrangler secret put ${ENV.clientId}`);
	});

	it("once the steps are done, Try a sign-in links to the member sign-in", () => {
		const t = text(setupPage(ready));
		expect(state(ready).try).toBe("todo");
		expect(t).toContain("/_emdash/api/auth/redeemid/login?return=%2F");
		expect(t).toContain('tag \\"member\\"');
	});

	it("a signed-in member finishes setup; Storefront stays optional", () => {
		const f = { ...ready, signedIn: 1 };
		const page = setupPage(f);
		expect(state(f).try).toBe("done");
		expect(text(page)).toContain("RedeemID is set up");
		expect(text(page)).toContain("Optional");
	});

	it("counts the required steps only", () => {
		expect(text(setupPage(blank))).toContain("0 of 6 steps done");
	});
});

describe("setup facts", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		resetAdminToken();
		delete process.env[ENV.adminClientId];
		delete process.env[ENV.webhookSecret];
	});

	it("reads write_customers as both scopes and counts topics set in the app's configuration once delivered", async () => {
		process.env[ENV.adminClientId] = "admin-client";
		process.env[ENV.webhookSecret] = "admin-secret";
		const origin = "https://site.test";
		vi.stubGlobal("fetch", async (url: string) => {
			if (url.endsWith("/admin/oauth/access_token")) return Response.json({ access_token: "t", expires_in: 86400, scope: "write_customers" });
			if (url.includes("/graphql.json")) {
				const nodes = WEBHOOK_TOPICS.filter((t) => t !== "CUSTOMERS_MERGE" && t !== "CUSTOMER_TAGS_ADDED").map((topic, i) => ({ id: `gid://${i}`, topic, uri: `${origin}${WEBHOOK}` }));
				return Response.json({ data: { webhookSubscriptions: { nodes } } });
			}
			return new Response("no", { status: 404 });
		});
		const { stores: s } = memoryStores();
		await s.deliveries.put("e1", { topic: "customer.tags_added", receivedAt: new Date().toISOString(), outcome: "processed" });
		const f = await setupFacts({ shop: "shop.myshopify.com" }, s, origin);
		expect(f.admin).toBe("ok");
		expect(f.scopes).toContain("read_customers");
		expect(f.webhooksMissing).toEqual(["CUSTOMERS_MERGE"]);
		const page = text(setupPage({ ...f, discovery: "ok" }));
		expect(page).toContain("Connect the webhook app: Done");
		expect(page).toContain("customers/merge");
	});
});
