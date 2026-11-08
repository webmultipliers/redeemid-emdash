import { describe, expect, it, vi } from "vitest";

vi.mock("astro:middleware", () => ({ defineMiddleware: (f: unknown) => f }));
vi.mock("virtual:emdash/config", () => ({ default: {} }));

import { memberMayUse } from "../src/guard.js";

describe("member guard", () => {
	it("refuses EmDash's content API and admin to members", () => {
		for (const p of ["/_emdash/api/content/posts", "/_emdash/api/search", "/_emdash/admin", "/_emdash/api/mcp"]) {
			expect(memberMayUse(p)).toBe(false);
		}
	});

	it("keeps site pages, sign-in, media and extra paths open", () => {
		for (const p of ["/", "/posts/a", "/_emdash/api/auth/redeemid/logout", "/_emdash/api/media/file/x.jpg", "/_emdash/api/comments/posts/1"]) {
			expect(memberMayUse(p)).toBe(true);
		}
		expect(memberMayUse("/_emdash/api/search", ["/_emdash/api/search"])).toBe(true);
		expect(memberMayUse("/_emdash/api/contentx")).toBe(false);
	});
});
