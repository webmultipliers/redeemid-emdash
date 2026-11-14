import { describe, expect, it } from "vitest";

import { PAGES, redeemidPlugin, TAB_PATHS } from "../src/descriptor.js";

describe("admin pages", () => {
	it("share one RedeemID sidebar folder", () => {
		expect(new Set(PAGES.map((p) => p.group))).toEqual(new Set(["RedeemID"]));
		expect(redeemidPlugin({}).adminPages).toBe(PAGES);
	});

	it("open on Overview, then the day-to-day pages, then the store connection", () => {
		expect(PAGES.map((p) => p.label)).toEqual(["Overview", "Members", "Access", "Reports", "Privacy", "Connection"]);
		expect(PAGES.map((p) => p.path).sort()).toEqual(["/", "/access", "/connection", "/members", "/privacy", "/reports"]);
	});

	it("give each Connection tab its own address", () => {
		expect(TAB_PATHS).toEqual(["/connection/status", "/connection/setup", "/connection/webhooks", "/connection/health", "/connection/events"]);
	});

	it("render in the browser through the admin entry", () => {
		expect(redeemidPlugin({}).adminEntry).toBe("@redeemid/emdash/admin");
	});
});
