import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { STRINGS, text, textParts, textProblem, textProblems } from "../src/text.js";

const ALL = new Set<string>(Object.values(STRINGS).flat());

describe("text", () => {
	it("replaces one string and fills its placeholders", () => {
		const config = { text: { "Sign in": "Log in", "This is for {level} members.": "{level} members only." } };
		expect(text(config, "Sign in")).toBe("Log in");
		expect(text(config, "Sign out")).toBe("Sign out");
		expect(text(config, "This is for {level} members.", { level: "Gold" })).toBe("Gold members only.");
		expect(text(null, "This is for {level} members.", { level: "Gold" })).toBe("This is for Gold members.");
	});

	it("never replaces words inside other strings", () => {
		const config = { text: { "Sign in": "Log in" } };
		expect(text(config, "Sign in to download this file.")).toBe("Sign in to download this file.");
	});

	it("ignores replacements with placeholders the original lacks, and unknown strings", () => {
		expect(textProblem("This is for {level} members.", "For {level} and {name}")).toMatch(/\{name\}/);
		expect(textProblem("Sign in", "Log in {now}")).toMatch(/\{now\}/);
		expect(textProblem("Not a string we show", "x")).toMatch(/doesn't show/);
		expect(textProblem("Includes: {features}", "Comes with")).toBeNull();
		const config = { text: { "Sign in": "Log in {x}", Account: "Portal", nope: "x" } };
		expect(text(config, "Sign in")).toBe("Sign in");
		expect(text(config, "Account")).toBe("Portal");
		expect(textProblems(config).map((p) => p.original)).toEqual(["Sign in", "nope"]);
	});

	it("splits strings with element placeholders into parts", () => {
		const link = { el: "a" };
		expect(textParts(null, "This is for members. {signIn} to read on.", { signIn: link })).toEqual(["This is for members. ", link, " to read on."]);
		expect(textParts({ text: { "{signIn} to see your membership.": "Please {signIn}" } }, "{signIn} to see your membership.", { signIn: link })).toEqual(["Please ", link]);
	});
});

/** String literals passed as the second argument of text()/textParts(), or to files.ts's t(). */
function used(): Set<string> {
	const out = new Set<string>();
	const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]));
	for (const file of walk("src").filter((f) => /\.(ts|astro)$/.test(f) && !f.endsWith("text.ts"))) {
		const src = readFileSync(file, "utf8");
		const calls = file.endsWith("files.ts") ? /\bt\(/g : /\b(?:text|textParts|replace)\(config, /g;
		for (const m of src.matchAll(calls)) {
			let i = (m.index ?? 0) + m[0].length;
			let depth = 0;
			while (i < src.length) {
				const c = src[i];
				if (c === '"') {
					let j = i + 1;
					while (src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
					if (depth === 0 && !src.slice(0, i).endsWith("=== ")) out.add(JSON.parse(src.slice(i, j + 1)) as string);
					i = j + 1;
					continue;
				}
				if (c === "(" || c === "{" || c === "[") depth++;
				else if (c === ")" || c === "}" || c === "]") {
					if (depth === 0) break;
					depth--;
				} else if (c === "," && depth === 0) break;
				i++;
			}
		}
		if (file.endsWith("Notices.astro")) for (const v of src.matchAll(/^\t\w+: (".*"),$/gm)) out.add(JSON.parse(v[1] as string) as string);
	}
	return out;
}

describe("STRINGS", () => {
	it("lists exactly the strings the components show", () => {
		const seen = used();
		expect([...seen].filter((s) => !ALL.has(s))).toEqual([]);
		expect([...ALL].filter((s) => !seen.has(s))).toEqual([]);
	});
});
