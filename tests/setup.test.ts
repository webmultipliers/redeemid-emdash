import { describe, expect, it } from "vitest";
import { ENV } from "../src/config.js";
import { setupPage, setupSteps, type SetupFacts } from "../src/setup.js";

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
