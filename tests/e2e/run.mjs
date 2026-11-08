/**
 * End-to-end check of RedeemID on a real EmDash site (the playground) against
 * a fake Shopify store. Run with `pnpm e2e`.
 */
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { startFakeShop } from "./fake-shop.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const tmp = join(here, ".tmp");
const SHOP_PORT = 4555;
const SITE_PORT = 4329;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const CLIENT_ID = "e2e-client";
const CLIENT_SECRET = "e2e-secret";
const WEBHOOK_SECRET = "e2e-webhook-secret";

let failures = 0;
function check(name, ok, detail = "") {
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`);
	if (!ok) failures++;
}

/** fetch with a cookie jar that follows redirects across hosts. */
class Browser {
	cookies = new Map();
	async go(url, init = {}, hops = 10) {
		let res;
		let current = new URL(url, SITE);
		let method = init.method ?? "GET";
		let body = init.body;
		for (let i = 0; i < hops; i++) {
			const headers = { ...(init.headers ?? {}) };
			if (current.origin === SITE && this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
			res = await fetch(current, { method, body, headers, redirect: "manual" });
			if (current.origin === SITE) {
				for (const c of res.headers.getSetCookie()) {
					const [pair] = c.split(";");
					const [k, ...v] = pair.split("=");
					if (/max-age=0|expires=thu, 01 jan 1970/i.test(c)) this.cookies.delete(k.trim());
					else this.cookies.set(k.trim(), v.join("="));
				}
			}
			const loc = res.headers.get("location");
			if (res.status < 300 || res.status >= 400 || !loc) break;
			current = new URL(loc, current);
			method = "GET";
			body = undefined;
		}
		return { res, url: current, text: await res.text() };
	}
}

async function signWebhook(body) {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))).toString("base64");
}

async function webhook(topic, payload, { id = crypto.randomUUID(), badSig = false } = {}) {
	const body = JSON.stringify(payload);
	const res = await fetch(`${SITE}/_emdash/api/auth/redeemid/webhook`, {
		method: "POST",
		body,
		headers: {
			"content-type": "application/json",
			"x-shopify-topic": topic,
			"x-shopify-event-id": id,
			"x-shopify-hmac-sha256": badSig ? "AAAA" : await signWebhook(body),
		},
	});
	return { status: res.status, text: await res.text() };
}

async function waitFor(url, ms = 90_000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		try {
			const r = await fetch(url, { redirect: "manual" });
			if (r.status < 500) return;
		} catch {}
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error(`Timed out waiting for ${url}`);
}

rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

const shop = await startFakeShop({ port: SHOP_PORT, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, logoutUris: [`${SITE}/`] });
const site = spawn("pnpm", ["exec", "astro", "dev", "--port", String(SITE_PORT), "--host", "127.0.0.1", "--ignore-lock"], {
	cwd: join(root, "playground"),
	env: {
		...process.env,
		REDEEMID_SHOPIFY_STORE_DOMAIN: shop.origin,
		REDEEMID_SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID: CLIENT_ID,
		REDEEMID_SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_SECRET: CLIENT_SECRET,
		REDEEMID_SHOPIFY_ADMIN_APP_CLIENT_SECRET: WEBHOOK_SECRET,
		REDEEMID_SHOPIFY_STOREFRONT_PRIVATE_TOKEN: "storefront-private",
		REDEEMID_DB: join(tmp, "data.db"),
		EMDASH_SITE_URL: SITE,
	},
	stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
site.stdout.on("data", (d) => (log += d));
site.stderr.on("data", (d) => (log += d));

try {
	await waitFor(`${SITE}/`);

	// Setup: dev bypass applies the seed, including the members-only posts.
	const admin = new Browser();
	const setup = await admin.go("/_emdash/api/setup/dev-bypass?content=1&redirect=/");
	check("site setup finishes with sample content", setup.res.status === 200, `${setup.res.status} ${setup.text.slice(0, 200)}`);

	// Visitors.
	const visitor = new Browser();
	const open = await visitor.go("/posts/welcome");
	check("uncovered post is open to visitors", open.res.status === 200 && open.text.includes("starter post"));
	const locked = await visitor.go("/posts/members-only");
	check("members post is locked for visitors", locked.res.status === 200 && !locked.text.includes("MEMBER-BODY") && locked.text.includes('data-redeemid-reason="sign_in"'));
	check("locked page shows the excerpt teaser", locked.text.includes("Open to every member level."));
	check("visitor page stays cacheable", !/private/.test(locked.res.headers.get("cache-control") ?? ""), locked.res.headers.get("cache-control"));

	// Member signs in through the store and comes back to the post.
	const member = new Browser();
	const signIn = await member.go("/_emdash/api/auth/redeemid/login?return=/posts/members-only");
	check("sign-in returns to the post", signIn.url.pathname === "/posts/members-only", signIn.url.href);
	check("member reads the members post", signIn.text.includes("MEMBER-BODY"), signIn.text.slice(0, 300));
	check("member page is private", /private/.test(signIn.res.headers.get("cache-control") ?? ""), signIn.res.headers.get("cache-control"));
	check("token request used Basic auth and PKCE", shop.tokenRequests.at(-1)?.form.code_verifier?.length >= 43);
	check("token request sent the site origin", shop.tokenRequests.at(-1)?.origin === SITE);
	check("account box shows the member level", signIn.text.includes("redeemid-account__levels") && signIn.text.includes("Member"));
	for (const path of ["/_emdash/api/content/posts", "/_emdash/api/content/posts/pro-only", "/_emdash/api/search?q=PRO-BODY"]) {
		const r = await member.go(path);
		check(`member can't read ${path}`, r.res.status === 403 && !r.text.includes("PRO-BODY"), `${r.res.status} ${r.text.slice(0, 120)}`);
	}
	const adminUi = await member.go("/_emdash/admin");
	check("member is sent home from the admin", adminUi.url.pathname === "/", adminUi.url.href);
	const staffApi = await admin.go("/_emdash/api/content/posts");
	check("staff still use the content API", staffApi.res.status === 200, String(staffApi.res.status));
	const pro = await member.go("/posts/pro-only");
	check("Pro post asks a member to upgrade", !pro.text.includes("PRO-BODY") && pro.text.includes('data-redeemid-reason="upgrade"'));

	// The Join page shows Shopify's plan and starts a checkout for the member.
	const join = await member.go("/join");
	check("plan card shows Shopify's title and price", join.text.includes("Pro plan") && join.text.includes("$12.00"));
	check("missing plan shows the fallback", join.text.includes("PLAN-FALLBACK"));
	const bought = await member.go("/_emdash/api/auth/redeemid/buy", {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: "plan=pro-plan&return=%2Fjoin",
	});
	const cart = shop.carts.at(-1);
	check("Buy goes to Shopify checkout", bought.text === "CHECKOUT", bought.url.href);
	check(
		"cart has the plan's variant, the member's email and the private token",
		cart?.input.lines[0]?.merchandiseId === "gid://shopify/ProductVariant/42" &&
			cart?.input.buyerIdentity?.email === shop.customer.email &&
			cart?.privateToken === "storefront-private",
		JSON.stringify(cart),
	);
	const badPlan = await member.go("/_emdash/api/auth/redeemid/buy", {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: "plan=no-such-plan&return=%2Fjoin",
	});
	check("unknown plan returns with a notice", badPlan.url.search.includes("redeemid_notice=plan_unavailable"));

	// Shopify tags the customer Pro (Flow or an app would do this).
	const gid = `gid://shopify/Customer/${shop.customer.id}`;
	const added = await webhook("customer.tags_added", { customerId: gid, tags: ["pro"] }, { id: "evt-1" });
	check("signed tag webhook is processed", added.status === 200 && added.text === "processed", JSON.stringify(added));
	const dup = await webhook("customer.tags_added", { customerId: gid, tags: ["pro"] }, { id: "evt-1" });
	check("repeated delivery is dropped", dup.status === 200 && dup.text === "Duplicate", JSON.stringify(dup));
	const forged = await webhook("customer.tags_added", { customerId: gid, tags: ["vip"] }, { badSig: true });
	check("unsigned webhook is refused", forged.status === 401, JSON.stringify(forged));
	const proNow = await member.go("/posts/pro-only");
	check("Pro post opens after the tag webhook", proNow.text.includes("PRO-BODY"));

	// Shopify turns the account off, then on again.
	await webhook("customers/disable", { id: shop.customer.id, updated_at: "2026-11-08T10:00:00Z" });
	const off = await member.go("/posts/members-only");
	check("disabled account loses access", !off.text.includes("MEMBER-BODY") && off.text.includes('data-redeemid-reason="disabled"'));
	await webhook("customers/enable", { id: shop.customer.id, updated_at: "2026-11-08T11:00:00Z" });
	const on = await member.go("/posts/members-only");
	check("re-enabled account gets access back", on.text.includes("MEMBER-BODY"));

	// A store customer with a staff email can't take over the staff account.
	shop.customer = { id: 2002, email: "dev@emdash.local", firstName: "Not", lastName: "Staff", tags: ["pro"] };
	const intruder = new Browser();
	const refused = await intruder.go("/_emdash/api/auth/redeemid/login?return=/posts/pro-only");
	check("staff email is refused", refused.url.searchParams.get("redeemid_notice") === "staff_account", refused.url.href);
	check("refused customer stays signed out", !refused.text.includes("PRO-BODY"));

	// Sign out ends the site session and the store session.
	const out = await member.go("/_emdash/api/auth/redeemid/logout?return=/posts/members-only", {
		method: "POST",
		headers: { origin: SITE, "content-type": "application/x-www-form-urlencoded" },
		body: "",
	});
	check("sign out ends the store session and lands on the registered logout URI", out.url.href === `${SITE}/` && out.res.status === 200, out.url.href);
	const after = await member.go("/posts/members-only");
	check("signed-out member is locked again", !after.text.includes("MEMBER-BODY") && after.text.includes('data-redeemid-reason="sign_in"'));
	const getLogout = await new Browser().go("/_emdash/api/auth/redeemid/logout");
	check("sign out refuses GET", getLogout.res.status === 405 || getLogout.res.status === 404, String(getLogout.res.status));
} catch (e) {
	failures++;
	console.error(e);
} finally {
	site.kill("SIGTERM");
	await shop.close();
	if (failures) console.log(`\n--- site log (tail) ---\n${log.split("\n").slice(-60).join("\n")}`);
}

console.log(failures ? `\n${failures} failed` : "\nAll end-to-end checks passed");
process.exit(failures ? 1 : 0);
