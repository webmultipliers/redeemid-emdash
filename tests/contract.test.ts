import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { CLIENT, CLIENT_CART, CLIENT_EVENTS, FORM_ROUTES, JSON_ROUTES, MCP_ACTIONS, MCP_TOOLS, MODULES, SERVER_EVENTS } from "../src/contract.js";
import { API_VERSION } from "../src/api-version.js";

const doc = readFileSync("docs/developer-api.md", "utf8");
const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { exports: Record<string, string> };
const client = readFileSync("src/client/redeemid.ts", "utf8");
const plugin = readFileSync("src/plugin.ts", "utf8");
const index = readFileSync("src/index.ts", "utf8");
const events = readFileSync("src/events.ts", "utf8");

/** Names in backticks on the page. */
const prose = doc.replace(/```[\s\S]*?```/g, "");
const named = new Set([...prose.matchAll(/`([^`\n]+)`/g)].flatMap((m) => (m[1] as string).split(/[\s,()]+/)));

describe("developer API contract", () => {
	it("names the API version", () => {
		expect(doc).toContain(`API version **${API_VERSION}**`);
	});

	it("lists only real exports, each on the page", async () => {
		for (const [path, names] of Object.entries(MODULES)) {
			const sub = path === "@redeemid/emdash" ? "." : `./${path.split("/").slice(2).join("/")}`;
			const file = pkg.exports[sub];
			expect(file, `${path} in package.json exports`).toBeTruthy();
			const src = readFileSync(file as string, "utf8");
			for (const name of names) {
				expect(new RegExp(`export (async )?(function|const|class) ${name}\\b|export \\{[^}]*\\b${name}\\b`).test(src), `${path} exports ${name}`).toBe(true);
				expect(named.has(name), `${name} on the page`).toBe(true);
			}
			expect(doc, `${path} on the page`).toContain(`\`${path}\``);
		}
	});

	it("routes match the provider's routes", () => {
		const declared = [...index.matchAll(/pattern: `\$\{BASE\}\/([\w/-]+)`/g)].map((m) => m[1] as string).sort();
		expect([...JSON_ROUTES, ...FORM_ROUTES].sort()).toEqual(declared);
		for (const r of [...JSON_ROUTES, ...FORM_ROUTES]) expect(named.has(r), `route ${r} on the page`).toBe(true);
	});

	it("the browser client matches the list", () => {
		const frozen = /window\.redeemid = Object\.freeze\(\{([\s\S]*?)\}\);/.exec(client)?.[1] ?? "";
		const members = frozen.split(",").map((s) => s.trim().split(":")[0]?.trim()).filter(Boolean);
		expect(members.sort()).toEqual([...CLIENT].sort());
		const cart = /const cart = Object\.freeze\(\{([\s\S]*?)\n\t\}\);/.exec(client)?.[1] ?? "";
		expect([...cart.matchAll(/^\t\t(\w+):/gm)].map((m) => m[1]).sort()).toEqual([...CLIENT_CART].sort());
		const list = /const EVENTS = \[([^\]]*)\]/.exec(client)?.[1] ?? "";
		expect([...list.matchAll(/"(\w+)"/g)].map((m) => m[1])).toEqual([...CLIENT_EVENTS]);
		for (const n of [...CLIENT, ...CLIENT_EVENTS]) expect(named.has(n), `${n} on the page`).toBe(true);
		for (const n of CLIENT_CART) expect(doc).toContain(`${n}(`);
	});

	it("every event the client sends is listed", () => {
		const sent = new Set([...client.matchAll(/send\("(\w+)"/g)].map((m) => m[1]));
		expect([...sent].sort()).toEqual([...CLIENT_EVENTS].sort());
	});

	it("server events match events.ts", () => {
		const type = /export type EventName = ([^;]+);/.exec(events)?.[1] ?? "";
		expect([...type.matchAll(/"([\w.]+)"/g)].map((m) => m[1]).sort()).toEqual([...SERVER_EVENTS].sort());
		for (const e of SERVER_EVENTS) expect(named.has(e), `${e} on the page`).toBe(true);
	});

	it("MCP tools match the plugin", () => {
		const declared = [...plugin.matchAll(/^\t\t(\w+): \{ route: "/gm)].map((m) => m[1] as string);
		const actions = [...plugin.matchAll(/^\t\ttools\.(\w+) = \{/gm)].map((m) => m[1] as string);
		expect(declared.sort()).toEqual([...MCP_TOOLS].sort());
		expect(actions.sort()).toEqual([...MCP_ACTIONS].sort());
		for (const t of [...MCP_TOOLS, ...MCP_ACTIONS]) expect(named.has(t), `${t} on the page`).toBe(true);
	});
});
