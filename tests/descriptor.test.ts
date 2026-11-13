import { describe, expect, it } from "vitest";

import { PAGES, redeemidPlugin } from "../src/descriptor.js";

describe("admin pages", () => {
	it("share one RedeemID sidebar folder", () => {
		expect(new Set(PAGES.map((p) => p.group))).toEqual(new Set(["RedeemID"]));
		expect(redeemidPlugin({}).adminPages).toBe(PAGES);
	});

	it("keep every page path the admin route handles", () => {
		expect(PAGES.map((p) => p.path).sort()).toEqual(["/", "/access", "/events", "/privacy", "/reports", "/setup", "/status", "/test", "/webhooks"]);
	});
});
