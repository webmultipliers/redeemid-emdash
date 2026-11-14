import { describe, expect, it } from "vitest";

import { PAGES, redeemidPlugin, TAB_PATHS } from "../src/descriptor.js";

describe("admin pages", () => {
	it("share one RedeemID sidebar folder", () => {
		expect(new Set(PAGES.map((p) => p.group))).toEqual(new Set(["RedeemID"]));
		expect(redeemidPlugin({}).adminPages).toBe(PAGES);
	});

	it("open on Overview, then the day-to-day pages, then the store connection", () => {
		expect(PAGES.map((p) => p.label)).toEqual(["Overview", "Members", "Access", "Reports", "Events", "Privacy", "Connection"]);
		expect(PAGES.map((p) => p.path).sort()).toEqual(["/", "/access", "/connection", "/events", "/members", "/privacy", "/reports"]);
	});

	it("give each Connection and Events tab its own address", () => {
		expect(TAB_PATHS).toEqual([
			"/connection/status",
			"/connection/store",
			"/connection/sign-in",
			"/connection/app",
			"/connection/webhooks",
			"/connection/level",
			"/connection/try",
			"/connection/storefront",
			"/events/webhook",
			"/events/app",
			"/events/health",
		]);
	});

	it("render in the browser through the admin entry", () => {
		expect(redeemidPlugin({}).adminEntry).toBe("@redeemid/emdash/admin");
	});
});
