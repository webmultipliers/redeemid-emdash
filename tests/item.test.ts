import { describe, expect, it } from "vitest";

import { holdsItem, soldItem } from "../src/blocks-names.js";

describe("Sold on its own", () => {
	it("reads the tag and the product handle or link", () => {
		expect(soldItem([{ _type: "block" }, { _type: "redeemid-item", tag: " Item-Big ", product: "https://shop.example.com/products/big-story?variant=1" }])).toEqual({ tag: "item-big", product: "big-story" });
		expect(soldItem([{ _type: "redeemid-item", tag: "item-big", product: "big-story" }])).toEqual({ tag: "item-big", product: "big-story" });
		expect(soldItem([{ _type: "redeemid-item", tag: "item-big", product: "not a handle!" }])).toEqual({ tag: "item-big", product: null });
		expect(soldItem([{ _type: "redeemid-item", tag: "" }])).toBeNull();
		expect(soldItem(null)).toBeNull();
	});
	it("matches tags without regard to case", () => {
		const item = { tag: "item-big", product: null };
		expect(holdsItem(item, ["member", "ITEM-BIG"])).toBe(true);
		expect(holdsItem(item, ["member"])).toBe(false);
		expect(holdsItem(null, ["item-big"])).toBe(false);
	});
});
