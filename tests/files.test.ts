import { describe, expect, it, vi } from "vitest";

vi.mock("emdash/api/route-utils", () => ({ getAuthProviderStorage: () => null }));
vi.mock("virtual:emdash/config", () => ({ default: {} }));

import type { RedeemIDConfig } from "../src/config.js";
import { fileAccess, keysFromPath, refusal, ruleFor } from "../src/files.js";

describe("keysFromPath", () => {
	it("returns the key after every decoding layer", () => {
		expect(keysFromPath("/_emdash/api/media/file/abc.pdf")).toEqual(["abc.pdf"]);
		expect(keysFromPath("/_emdash/api/media/file/a%2520b")).toEqual(["a%20b", "a b"]);
		expect(keysFromPath("/_emdash/api/media/other")).toBeNull();
		expect(keysFromPath("/_emdash/api/media/file/")).toBeNull();
	});
});

describe("ruleFor", () => {
	const config: RedeemIDConfig = { files: [{ folder: "Gold Downloads", levels: ["gold"] }] };
	it("matches folder names case-insensitively", () => {
		expect(ruleFor(config, "gold downloads")?.levels).toEqual(["gold"]);
		expect(ruleFor(config, "Other")).toBeNull();
		expect(ruleFor(config, null)).toBeNull();
		expect(ruleFor({}, "Gold Downloads")).toBeNull();
	});
});

describe("fileAccess", () => {
	it("leaves files alone when no folder is protected", async () => {
		expect(await fileAccess({ locals: {} }, {}, "k")).toEqual({ protected: false });
	});
});

describe("refusal", () => {
	it("is private and says why", async () => {
		const out = refusal("sign_in", "/_emdash/api/auth/redeemid/login?return=%2F");
		expect(out.status).toBe(401);
		expect(out.headers.get("cache-control")).toBe("private, no-store");
		expect(await out.text()).toContain("Sign in");
		expect(refusal("denied", "/").status).toBe(403);
	});
});
