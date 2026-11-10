import { describe, expect, it } from "vitest";
import type { RedeemIDConfig } from "../src/config.js";
import { gatedFindings, scanTemplate } from "../src/template-scan.js";

const page = `---
import { getEmDashEntry } from "emdash";
import { PortableText } from "emdash/ui";
const { entry } = await getEmDashEntry("pages", slug);
---
<article>
	<PortableText value={entry.data.content} />
</article>`;

const base: RedeemIDConfig = { shop: "s.myshopify.com", levels: [{ slug: "member", name: "Member", tags: ["member"] }] } as RedeemIDConfig;

describe("template scan", () => {
	it("finds <PortableText> from emdash/ui with its line and collection", () => {
		expect(scanTemplate("src/pages/[slug].astro", page)).toEqual({ file: "src/pages/[slug].astro", lines: [7], collections: ["pages"] });
	});

	it("ignores a file that only imports it, and RedeemID's Content", () => {
		expect(scanTemplate("a.astro", page.replace("<PortableText value={entry.data.content} />", "<Content value={entry.data.content} />"))).toBeNull();
		expect(scanTemplate("b.astro", `<PortableText value={x} />`)).toBeNull();
	});

	it("lists every collection the file loads", () => {
		const two = page.replace("---\n<article>", `const list = await getEmDashCollection('posts');\n---\n<article>`);
		expect(scanTemplate("c.astro", two)?.collections).toEqual(["pages", "posts"]);
	});
});

describe("gated findings", () => {
	const found = [scanTemplate("src/pages/[slug].astro", page)!, { file: "src/components/Body.astro", lines: [3], collections: [] }];

	it("nothing to say when no rule locks anything", () => {
		expect(gatedFindings(found, base)).toEqual([]);
		expect(gatedFindings(found, { ...base, rules: [{ collection: "pages", levels: [], open: true }] })).toEqual([]);
	});

	it("a collection rule flags the template, and an unknown collection is listed to check", () => {
		const out = gatedFindings(found, { ...base, rules: [{ collection: "pages", levels: ["member"] }] });
		expect(out.map((f) => [f.file, f.gated])).toEqual([
			["src/pages/[slug].astro", ["pages"]],
			["src/components/Body.astro", []],
		]);
	});

	it("a rule on another collection flags only the unknown one", () => {
		const out = gatedFindings(found, { ...base, rules: [{ collection: "posts", taxonomy: "category", term: "pro", levels: ["member"] }] });
		expect(out.map((f) => f.file)).toEqual(["src/components/Body.astro"]);
	});

	it("the site default covers every collection", () => {
		expect(gatedFindings(found, { ...base, rules: [{ collection: "*", levels: [] }] })[0]?.gated).toEqual(["pages"]);
	});

	it("an entry's own rule gates its collection", () => {
		const entries = { "pages:1": { kind: "entry" as const, collection: "pages", entryId: "1", mode: "levels" as const, levels: ["member"] } };
		expect(gatedFindings(found, { ...base, entries })[0]?.gated).toEqual(["pages"]);
		expect(gatedFindings(found, { ...base, entries: { "pages:1": { ...entries["pages:1"], mode: "open" as const } } })).toEqual([]);
	});
});
