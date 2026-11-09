import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetAdminToken } from "../src/admin-api.js";
import type { RedeemIDConfig } from "../src/config.js";
import { allowSave, decode, encode, formValues, PreferenceError, resetPreferenceCache, savePreferences, SAVES_PER_MINUTE } from "../src/preferences.js";

const def = (type: string, extra: Partial<{ choices: string[]; min: string; max: string }> = {}) => ({
	key: "p.k",
	name: "K",
	description: null,
	type: type as never,
	choices: extra.choices ?? null,
	min: extra.min ?? null,
	max: extra.max ?? null,
});

describe("encode", () => {
	it("checks choices, lengths and ranges", () => {
		expect(encode(def("single_line_text_field", { choices: ["A", "B"] }), "A")).toEqual({ value: "A" });
		expect(encode(def("single_line_text_field", { choices: ["A", "B"] }), "C")).toEqual({ refused: "invalid_choice" });
		expect(encode(def("single_line_text_field", { max: "3" }), "long")).toEqual({ refused: "invalid_length" });
		expect(encode(def("single_line_text_field"), "two\nlines")).toEqual({ refused: "invalid_type" });
		expect(encode(def("number_integer", { min: "1", max: "5" }), 6)).toEqual({ refused: "invalid_range" });
		expect(encode(def("number_integer"), "1.5")).toEqual({ refused: "invalid_type" });
		expect(encode(def("number_decimal"), "1.5")).toEqual({ value: "1.5" });
		expect(encode(def("date", { max: "2026-12-31" }), "2027-01-01")).toEqual({ refused: "invalid_range" });
		expect(encode(def("date"), "2026-02-30x")).toEqual({ refused: "invalid_type" });
		expect(encode(def("boolean"), "on")).toEqual({ value: "true" });
		expect(encode(def("boolean"), "maybe")).toEqual({ refused: "invalid_type" });
	});
	it("stores lists as JSON, de-duplicated, and treats empty as clear", () => {
		expect(encode(def("list.single_line_text_field", { choices: ["Food", "Travel"] }), ["Food", "Food", " Travel "])).toEqual({ value: '["Food","Travel"]' });
		expect(encode(def("list.single_line_text_field", { choices: ["Food"] }), ["Sport"])).toEqual({ refused: "invalid_choice" });
		expect(encode(def("list.single_line_text_field"), [])).toEqual({ value: null });
		expect(encode(def("single_line_text_field"), "")).toEqual({ value: null });
	});
});

describe("decode", () => {
	it("turns metafield values into what members see", () => {
		expect(decode("list.single_line_text_field", '["a","b"]')).toEqual(["a", "b"]);
		expect(decode("list.single_line_text_field", undefined)).toEqual([]);
		expect(decode("boolean", "true")).toBe(true);
		expect(decode("number_integer", "4")).toBe(4);
		expect(decode("date", null)).toBeNull();
	});
});

describe("formValues", () => {
	const fields = [
		{ key: "p.topics", type: "list.single_line_text_field" as const, editable: true },
		{ key: "p.news", type: "boolean" as const, editable: true },
		{ key: "p.level", type: "number_integer" as const, editable: false },
		{ key: "p.skipped", type: "single_line_text_field" as const, editable: true },
	];
	it("reads present fields only, unchecked boxes as false, and never read-only ones", () => {
		const f = new FormData();
		f.append("present:p.topics", "1");
		f.append("pref:p.topics", "a\nb");
		f.append("present:p.news", "1");
		f.append("present:p.level", "1");
		f.append("pref:p.level", "9");
		expect(formValues(f, fields)).toEqual({ "p.topics": ["a", "b"], "p.news": false });
	});
});

describe("allowSave", () => {
	it("allows 10 saves a minute", () => {
		const now = 1_000_000;
		const full = Array.from({ length: SAVES_PER_MINUTE }, (_, i) => now - i * 1000);
		expect(allowSave({ prefSaves: full }, now)).toBeNull();
		expect(allowSave({ prefSaves: full }, now + 60_000)?.length).toBeLessThanOrEqual(SAVES_PER_MINUTE);
		expect(allowSave({}, now)).toEqual([now]);
	});
});

describe("savePreferences", () => {
	const config: RedeemIDConfig = { shop: "s.myshopify.com", preferences: [{ key: "p.topics" }, { key: "p.level", access: "view" }] };
	const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
	const fetcher = (async (url: string, init: RequestInit) => {
		if (url.endsWith("/access_token")) return Response.json({ access_token: "t", expires_in: 3600 });
		const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
		calls.push(body);
		if (body.query.includes("metafieldDefinitions(")) {
			return Response.json({
				data: {
					metafieldDefinitions: {
						nodes: [
							{ namespace: "p", key: "topics", name: "Topics", description: null, type: { name: "list.single_line_text_field" }, validations: [{ name: "choices", value: '["Food","Travel"]' }] },
							{ namespace: "p", key: "level", name: "Level", description: null, type: { name: "number_integer" }, validations: [] },
						],
					},
				},
			});
		}
		if (body.query.includes("metafieldsSet(")) return Response.json({ data: { metafieldsSet: { userErrors: [] } } });
		return Response.json({ data: { customer: { metafields: { nodes: [{ namespace: "p", key: "topics", value: '["Food"]' }] } } } });
	}) as unknown as typeof fetch;

	beforeEach(() => {
		process.env.REDEEMID_SHOPIFY_ADMIN_APP_CLIENT_ID = "id";
		process.env.REDEEMID_SHOPIFY_ADMIN_APP_CLIENT_SECRET = "secret";
		resetAdminToken();
		resetPreferenceCache();
		calls.length = 0;
	});
	afterEach(() => {
		delete process.env.REDEEMID_SHOPIFY_ADMIN_APP_CLIENT_ID;
		delete process.env.REDEEMID_SHOPIFY_ADMIN_APP_CLIENT_SECRET;
	});

	it("writes to the member's own customer and reads back", async () => {
		const out = await savePreferences(config, "7", { "p.topics": ["Food"] }, fetcher);
		const set = calls.find((c) => c.query.includes("metafieldsSet("));
		expect(set?.variables.metafields).toEqual([{ ownerId: "gid://shopify/Customer/7", namespace: "p", key: "topics", type: "list.single_line_text_field", value: '["Food"]' }]);
		expect(out.changed).toEqual(["p.topics"]);
		expect(out.fields.find((f) => f.key === "p.topics")?.value).toEqual(["Food"]);
	});

	it("refuses read-only and unknown fields and saves nothing", async () => {
		await expect(savePreferences(config, "7", { "p.topics": ["Food"], "p.level": 3, "x.y": "z" }, fetcher)).rejects.toMatchObject({
			fields: { "p.level": "read_only", "x.y": "unknown_field" },
		});
		expect(calls.some((c) => c.query.includes("metafieldsSet("))).toBe(false);
		await expect(savePreferences(config, "7", { "p.level": 3 }, fetcher)).rejects.toBeInstanceOf(PreferenceError);
	});
});
