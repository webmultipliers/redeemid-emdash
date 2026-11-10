import { describe, expect, it, vi } from "vitest";

vi.mock("emdash/api/route-utils", () => ({ getAuthProviderStorage: () => null }));
vi.mock("virtual:emdash/config", () => ({ default: {} }));

import type { RedeemIDConfig } from "../src/config.js";
import { fileAccess, keysFromPath, keysFromUrl, refusal, ruleFor } from "../src/files.js";

describe("keysFromPath", () => {
	it("returns the key after every decoding layer", () => {
		expect(keysFromPath("/_emdash/api/media/file/abc.pdf")).toEqual(["abc.pdf"]);
		expect(keysFromPath("/_emdash/api/media/file/a%2520b")).toEqual(["a%20b", "a b"]);
		expect(keysFromPath("/_emdash/api/media/other")).toBeNull();
		expect(keysFromPath("/_emdash/api/media/file/")).toBeNull();
	});

	it("also gives the key without the slashes the file route drops", () => {
		expect(keysFromPath("/_emdash/api/media/file/abc.pdf/")).toEqual(["abc.pdf/", "abc.pdf"]);
		expect(keysFromPath("/_emdash/api/media/file//abc.pdf")).toContain("abc.pdf");
		expect(keysFromPath("/_emdash/api/media/file/abc.pdf%2F")).toContain("abc.pdf");
	});

	it("finds the file an image-endpoint request names", () => {
		const at = (q: string) => keysFromUrl(new URL(`https://site.example/_image?${q}`));
		expect(at("href=%2F_emdash%2Fapi%2Fmedia%2Ffile%2Fabc.png&w=100")).toEqual(["abc.png"]);
		expect(at("href=https%3A%2F%2Fsite.example%2F_emdash%2Fapi%2Fmedia%2Ffile%2Fabc.png")).toEqual(["abc.png"]);
		expect(at("href=%252F_emdash%252Fapi%252Fmedia%252Ffile%252Fabc.png")).toEqual(["abc.png"]);
		expect(at("href=%2Fphotos%2Fcat.png")).toBeNull();
		expect(keysFromUrl(new URL("https://site.example/_emdash/api/media/file/abc.pdf"))).toEqual(["abc.pdf"]);
		expect(keysFromUrl(new URL("https://site.example/posts/_image"))).toBeNull();
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
		// With file rules set, a request with no database can't be checked: the caller refuses it.
		await expect(fileAccess({ locals: {} }, { files: [{ folder: "Gold", levels: ["gold"] }] }, "k")).rejects.toThrow();
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
