#!/usr/bin/env node
/**
 * redeemid-emdash: ask a RedeemID site the questions staff ask in the admin.
 *
 *   npx redeemid-emdash access posts --id my-story --tags gold-member
 *   npx redeemid-emdash member jane@example.com
 *
 * Signs in like EmDash's own CLI: --token or EMDASH_TOKEN, else the token
 * `emdash login` saved for the site. The site comes from --url or EMDASH_URL.
 * The token's user must be an administrator.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const HELP = `Usage: redeemid-emdash <command> [options]

Commands:
  access <collection>     Can a reader read an entry, and why
      --id <id or slug>   the entry (or --terms taxonomy:slug,…)
      --tags a,b          the reader's Shopify tags (or --customer <id>)
      --signed-out        a signed-out visitor
  levels                  Every level and the tags that grant it
  rules                   The paywall rules, meter, features and file rules
  member <id or email>    One synced member
  health                  What's set up (never the values)
  changes --since <date>  Who joined or left a level [--level <slug>]
  products <words>        Search the Shopify catalog for handles and prices
  product <handle>        One product: options, variants, selling plans
  collection <handle>     One collection: its products and filters
  resync <customer id>    Read one member from Shopify again *
  resync-batch            Read the 25 members synced longest ago *
  tags <customer id>      Edit tags in Shopify: --add a,b --remove c *

  * only when the site sets agents: { actions: true }

Options:
  --url <site>      the site (or EMDASH_URL)
  --token <token>   an EmDash API token (or EMDASH_TOKEN, or emdash login)
  -h, --help`;

const { values: o, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		url: { type: "string" },
		token: { type: "string" },
		id: { type: "string" },
		terms: { type: "string" },
		tags: { type: "string" },
		customer: { type: "string" },
		"signed-out": { type: "boolean" },
		since: { type: "string" },
		level: { type: "string" },
		add: { type: "string" },
		remove: { type: "string" },
		help: { type: "boolean", short: "h" },
	},
});

const list = (s) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : undefined);
const [command, arg] = positionals;

function request() {
	switch (command) {
		case "access": {
			if (!arg) throw new Error("access needs a collection");
			const terms = {};
			for (const pair of list(o.terms) ?? []) {
				const [tax, slug] = pair.split(":");
				if (tax && slug) (terms[tax] ??= []).push(slug);
			}
			return ["explain-access", { collection: arg, id: o.id, terms: o.terms ? terms : undefined, tags: list(o.tags), customerId: o.customer, signedIn: o["signed-out"] ? false : undefined }];
		}
		case "levels":
			return ["list-levels", {}];
		case "rules":
			return ["get-rules", {}];
		case "member":
			if (!arg) throw new Error("member needs a customer id or an email");
			return ["get-member", arg.includes("@") ? { email: arg } : { customerId: arg }];
		case "health":
			return ["site-health", {}];
		case "changes":
			if (!o.since) throw new Error("changes needs --since <date>");
			return ["level-changes", { since: o.since, level: o.level }];
		case "products":
			if (!arg) throw new Error("products needs search words");
			return ["find-products", { query: positionals.slice(1).join(" ") }];
		case "product":
			if (!arg) throw new Error("product needs a handle");
			return ["get-product", { handle: arg }];
		case "collection":
			if (!arg) throw new Error("collection needs a handle");
			return ["get-collection", { handle: arg }];
		case "resync":
			if (!arg) throw new Error("resync needs a customer id");
			return ["resync-member", { customerId: arg }];
		case "resync-batch":
			return ["resync-batch", {}];
		case "tags":
			if (!arg || (!o.add && !o.remove)) throw new Error("tags needs a customer id and --add or --remove");
			return ["edit-member-tags", { customerId: arg, add: list(o.add), remove: list(o.remove) }];
		default:
			return null;
	}
}

/** The token: --token, EMDASH_TOKEN, or what `emdash login` saved for this site. */
function token(site) {
	if (o.token) return o.token;
	if (process.env.EMDASH_TOKEN) return process.env.EMDASH_TOKEN;
	try {
		const dir = process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, "emdash") : join(homedir(), ".config", "emdash");
		const saved = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"))[new URL(site).origin];
		if (saved?.accessToken && new Date(saved.expiresAt) > new Date()) return saved.accessToken;
		if (saved?.accessToken) throw new Error("The saved sign-in has expired. Run `npx emdash whoami` (or `emdash login`) for this site, then try again.");
	} catch (e) {
		if (e instanceof Error && e.message.startsWith("The saved")) throw e;
	}
	throw new Error("No token. Pass --token, set EMDASH_TOKEN, or run `npx emdash login --url <site>`.");
}

async function main() {
	const req = o.help || !command ? null : request();
	if (!req) {
		console.log(HELP);
		process.exit(command && !o.help ? 2 : 0);
	}
	const site = (o.url ?? process.env.EMDASH_URL ?? "").replace(/\/+$/, "");
	if (!site) throw new Error("No site. Pass --url or set EMDASH_URL.");
	const [route, body] = req;
	const res = await fetch(`${site}/_emdash/api/plugins/redeemid/${route}`, {
		method: "POST",
		headers: { authorization: `Bearer ${token(site)}`, "content-type": "application/json", "x-emdash-request": "1" },
		body: JSON.stringify(body),
	});
	const text = await res.text();
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		throw new Error(`${res.status} from the site: ${text.slice(0, 200)}`);
	}
	if (res.status === 404) throw new Error(`The site has no "${route}" route. Actions need agents: { actions: true }, and every command needs @redeemid/emdash 0.0.11 or later (products, product and collection need 0.0.18).`);
	if (!res.ok) throw new Error(json?.error?.message ?? `${res.status} from the site`);
	const out = json?.data ?? json;
	if (out && out.ok === false) throw new Error(out.error);
	console.log(JSON.stringify(out?.result ?? out, null, 2));
}

main().catch((e) => {
	console.error(`redeemid-emdash: ${e.message}`);
	process.exit(1);
});
