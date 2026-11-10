import { describe, expect, it } from "vitest";

import { limitedAction, rateLimited, type RateLimiter } from "../src/rate-limit.js";

function limiter(allow: boolean, keys: string[] = []): RateLimiter {
	return {
		async limit({ key }) {
			keys.push(key);
			return { success: allow };
		},
	};
}

describe("rate limits", () => {
	it("covers Sign in, Buy, cart changes and catalog search only", () => {
		expect(limitedAction("GET", "/_emdash/api/auth/redeemid/api/search")).toBe("search");
		expect(limitedAction("GET", "/_emdash/api/auth/redeemid/login")).toBe("login");
		expect(limitedAction("POST", "/_emdash/api/auth/redeemid/buy")).toBe("buy");
		expect(limitedAction("POST", "/_emdash/api/auth/redeemid/cart-edit/")).toBe("cart");
		expect(limitedAction("GET", "/_emdash/api/auth/redeemid/callback")).toBeNull();
		expect(limitedAction("POST", "/_emdash/api/auth/redeemid/webhook")).toBeNull();
		expect(limitedAction("GET", "/posts/a")).toBeNull();
	});

	it("keys by action and visitor, and lets allowed requests through", async () => {
		const keys: string[] = [];
		const req = new Request("https://site.test/_emdash/api/auth/redeemid/login?return=/posts/a", { headers: { "cf-connecting-ip": "203.0.113.9" } });
		expect(await rateLimited(limiter(true, keys), req)).toBeNull();
		expect(keys).toEqual(["login:203.0.113.9"]);
	});

	it("sends a limited reader back to their page with a notice", async () => {
		const login = await rateLimited(limiter(false), new Request("https://site.test/_emdash/api/auth/redeemid/login?return=/posts/a"));
		expect(login?.status).toBe(303);
		expect(login?.headers.get("location")).toBe("/posts/a?redeemid_notice=too_many_requests");
		const buy = await rateLimited(limiter(false), new Request("https://site.test/_emdash/api/auth/redeemid/buy", { method: "POST", headers: { referer: "https://site.test/join?x=1" } }));
		expect(buy?.headers.get("location")).toBe("/join?x=1&redeemid_notice=too_many_requests");
		const offsite = await rateLimited(limiter(false), new Request("https://site.test/_emdash/api/auth/redeemid/buy", { method: "POST", headers: { referer: "https://evil.test/x" } }));
		expect(offsite?.headers.get("location")).toBe("/?redeemid_notice=too_many_requests");
	});

	it("never blocks without a limiter or when it fails", async () => {
		const req = new Request("https://site.test/_emdash/api/auth/redeemid/login");
		expect(await rateLimited(undefined, req)).toBeNull();
		expect(await rateLimited({ limit: async () => { throw new Error("down"); } }, req)).toBeNull();
	});
});
