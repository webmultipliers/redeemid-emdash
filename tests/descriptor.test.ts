import { describe, expect, it } from "vitest";

import { PAGES, redeemidPlugin } from "../src/descriptor.js";

describe("admin pages", () => {
	it("share one RedeemID sidebar folder", () => {
		expect(new Set(PAGES.map((p) => p.group))).toEqual(new Set(["RedeemID"]));
		expect(redeemidPlugin({}).adminPages).toBe(PAGES);
	});

	it("open on Overview, then the day-to-day pages, then the store connection", () => {
		expect(PAGES.map((p) => p.label)).toEqual(["Overview", "Members", "Access", "Reports", "Privacy", "Webhooks", "App events", "Status", "Setup"]);
		expect(PAGES.map((p) => p.path).sort()).toEqual(["/", "/access", "/events", "/members", "/privacy", "/reports", "/setup", "/status", "/webhooks"]);
	});

	it("render in the browser through the admin entry", () => {
		expect(redeemidPlugin({}).adminEntry).toBe("@redeemid/emdash/admin");
	});
});
