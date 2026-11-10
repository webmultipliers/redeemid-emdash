import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("virtual:emdash/config", () => ({ default: {} }));

import { customDomainBlocks } from "../src/plugin.js";

afterEach(() => {
	delete process.env.REDEEMID_SHOPIFY_ADMIN_APP_CLIENT_ID;
	delete process.env.REDEEMID_SHOPIFY_ADMIN_APP_CLIENT_SECRET;
});

describe("Status", () => {
	it("warns when the Admin API app is set up on a custom store domain", () => {
		expect(customDomainBlocks({ shop: "shop.example.com" })).toEqual([]);
		process.env.REDEEMID_SHOPIFY_ADMIN_APP_CLIENT_ID = "id";
		process.env.REDEEMID_SHOPIFY_ADMIN_APP_CLIENT_SECRET = "secret";
		expect(JSON.stringify(customDomainBlocks({ shop: "shop.example.com" }))).toContain("myshopify.com domain");
		expect(customDomainBlocks({ shop: "my-store" })).toEqual([]);
		expect(customDomainBlocks({ shop: "my-store.myshopify.com" })).toEqual([]);
	});
});
