import { describe, expect, it, vi } from "vitest";

vi.mock("virtual:emdash/config", () => ({ default: {} }));

import { accessLabels, COLUMN_MAX, parseColumnInput } from "../src/access-column.js";
import type { RedeemIDConfig } from "../src/config.js";
import type { Terms } from "../src/access.js";

const config: RedeemIDConfig = {
	levels: [
		{ slug: "members", name: "Members", tags: ["member"] },
		{ slug: "gold", name: "Gold", tags: ["gold"], includes: ["members"] },
	],
	rules: [{ collection: "posts", taxonomy: "category", term: "members", levels: ["members"] }],
	entries: { "posts:e3": { mode: "levels", levels: ["gold"] } },
} as unknown as RedeemIDConfig;

const terms = (byId: Record<string, Terms>) => async (ids: string[]) => new Map(ids.map((id) => [id, byId[id] ?? {}]));

describe("access column", () => {
	it("checks the ask", () => {
		expect(parseColumnInput(null)).toBeNull();
		expect(parseColumnInput({ collection: "../x", ids: [] })).toBeNull();
		expect(parseColumnInput({ collection: "posts", ids: "a" })).toBeNull();
		expect(parseColumnInput({ collection: "posts", ids: ["a", "a", 3, ""] })).toEqual({ collection: "posts", ids: ["a"] });
		const many = Array.from({ length: COLUMN_MAX + 5 }, (_, i) => `id${i}`);
		expect(parseColumnInput({ collection: "posts", ids: many })!.ids).toHaveLength(COLUMN_MAX);
	});

	it("labels each entry by the rule the site enforces", async () => {
		const labels = await accessLabels(config, "posts", ["e1", "e2", "e3"], terms({ e2: { category: [{ slug: "members" }] } }));
		expect(labels.e1).toEqual({ label: "Free", locked: false });
		expect(labels.e2).toEqual({ label: "Members", locked: true });
		expect(labels.e3).toEqual({ label: "Gold", locked: true });
	});

	it("locks everything when saved settings can't be read", async () => {
		const labels = await accessLabels({ ...config, unavailable: true } as unknown as RedeemIDConfig, "posts", ["e1"], terms({}));
		expect(labels.e1!.locked).toBe(true);
	});

	it("asks for nothing without ids", async () => {
		const termsFor = vi.fn();
		expect(await accessLabels(config, "posts", [], termsFor)).toEqual({});
		expect(termsFor).not.toHaveBeenCalled();
	});
});
