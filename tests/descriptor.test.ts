import { describe, expect, it } from "vitest";

import { PAGES, redeemidPlugin, TAB_PATHS } from "../src/descriptor.js";

describe("admin pages", () => {
	it("share one RedeemID sidebar folder", () => {
		expect(new Set(PAGES.map((p) => p.group))).toEqual(new Set(["RedeemID"]));
		expect(redeemidPlugin({}).adminPages).toBe(PAGES);
	});

	it("open on Overview, then the day-to-day pages, then the store connection and resources", () => {
		expect(PAGES.map((p) => p.label)).toEqual(["Overview", "Customers", "Products", "Access", "Reports", "Events", "Privacy", "Connection", "Resources"]);
		expect(PAGES.map((p) => p.path).sort()).toEqual(["/access", "/connection", "/customers", "/events", "/overview", "/privacy", "/products", "/reports", "/resources"]);
	});

	it("give each Connection and Events tab its own address", () => {
		expect(TAB_PATHS).toEqual([
			"/connection/status",
			"/connection/store",
			"/connection/environment",
			"/connection/webhooks",
			"/events/webhook",
			"/events/app",
			"/events/health",
		]);
	});

	it("name the plugin RedeemID in EmDash's Plugins list", () => {
		expect(redeemidPlugin({}).displayName).toBe("RedeemID");
		expect(redeemidPlugin({}).description).toBeTruthy();
	});

	it("render in the browser through the admin entry", () => {
		expect(redeemidPlugin({}).adminEntry).toBe("@redeemid/emdash/admin");
	});
});
