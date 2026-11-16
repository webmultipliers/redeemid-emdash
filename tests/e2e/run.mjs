/**
 * End-to-end check of RedeemID on a real EmDash site (the playground) against
 * a fake Shopify store. Run with `pnpm e2e`.
 */
import { execFile, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
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
const EVENTS_SECRET = "e2e-events-secret";

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

const shop = await startFakeShop({ port: SHOP_PORT, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, logoutUris: [`${SITE}/`], adminClientId: "admin-client", adminSecret: WEBHOOK_SECRET });
const site = spawn("pnpm", ["exec", "astro", "dev", "--port", String(SITE_PORT), "--host", "127.0.0.1", "--ignore-lock"], {
	cwd: join(root, "playground"),
	env: {
		...process.env,
		REDEEMID_SHOPIFY_STORE_DOMAIN: shop.origin,
		REDEEMID_SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID: CLIENT_ID,
		REDEEMID_SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_SECRET: CLIENT_SECRET,
		REDEEMID_SHOPIFY_ADMIN_APP_CLIENT_SECRET: WEBHOOK_SECRET,
		REDEEMID_SHOPIFY_ADMIN_APP_CLIENT_ID: "admin-client",
		REDEEMID_EVENTS_SECRET: EVENTS_SECRET,
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
	check("replacement text changes that one wall string, link kept", /Members only\. <a href="[^"]*login[^"]*">Sign in<\/a> to keep reading\./.test(locked.text) && !locked.text.includes("to read on"), (locked.text.match(/Members only[^]{0,200}/) ?? [""])[0]);
	check("locked page shows the excerpt teaser", locked.text.includes("Open to every member level."));
	check("badge names the levels and shows the lock", /class="redeemid-badge is-locked"[^>]*data-redeemid-level="member pro"/.test(locked.text) && locked.text.includes("Member or Pro"), (locked.text.match(/<span class="redeemid-badge[^]*?<\/span>\s*<\/span>|<span class="redeemid-badge[^>]*>[^<]*/) ?? [""])[0]);
	const openBadge = await visitor.go("/posts/welcome");
	check("open post's badge reads Free", /class="redeemid-badge"[^>]*data-redeemid-level="free"[^>]*>\s*Free/.test(openBadge.text));
	const both = await visitor.go("/posts/both-rules");
	check("word-count teaser shows the paragraphs within 5 words", both.text.includes("TEASE-OPEN") && !both.text.includes("BOTH-BODY"));
	check("teaser leaves out a longer first paragraph", !locked.text.includes("MEMBER-BODY"));
	for (const path of ["/_emdash/api/content/posts", "/_emdash/api/content/posts/pro-only", "/_emdash/api/search?q=PRO-BODY", "/_emdash/api/search?q=MEMBER-BODY", "/rss.xml", "/sitemap.xml", "/search?q=PRO-BODY", "/_emdash/api/search?q=MS-INSIDE", "/_emdash/api/content/posts/members-section", "/search?q=MS-INSIDE"]) {
		const r = await visitor.go(path);
		check(`visitors get no locked text from ${path}`, !r.text.includes("PRO-BODY") && !r.text.includes("MEMBER-BODY") && !r.text.includes("BREAK-BODY") && !r.text.includes("MS-INSIDE"), `${r.res.status} ${r.text.slice(0, 160)}`);
	}
	const searchItems = async (b, q) => {
		const r = await b.go(`/_emdash/api/search?q=${encodeURIComponent(q)}`);
		try {
			return { status: r.res.status, items: JSON.parse(r.text).data?.items ?? [] };
		} catch {
			return { status: r.res.status, items: [] };
		}
	};
	const bodyHit = await searchItems(visitor, "PRO-BODY");
	check("site search doesn't tell visitors which locked post holds a word", bodyHit.status === 200 && !bodyHit.items.some((i) => i.slug === "pro-only"), JSON.stringify(bodyHit.items));
	const titleHit = await searchItems(visitor, "Pro only");
	const proTitle = titleHit.items.find((i) => i.slug === "pro-only");
	check("site search still finds a locked post by its title, without a snippet", Boolean(proTitle) && !("snippet" in proTitle), JSON.stringify(titleHit.items));
	const openHit = await searchItems(visitor, "starter");
	check("site search keeps open posts and their snippets", openHit.items.some((i) => i.slug === "welcome" && typeof i.snippet === "string"), JSON.stringify(openHit.items));
	const section = await visitor.go("/posts/members-section");
	check("Members only: visitors read around the part but not inside it", section.text.includes("MS-BEFORE") && section.text.includes("MS-AFTER") && !section.text.includes("MS-INSIDE"));
	check("Members only: the wall shows the level's text and the join link", section.text.includes("PRO-WALL") && section.text.includes('href="/join"'));
	const notice = await visitor.go("/?redeemid_notice=cart_empty");
	check("Notices shows the notice for its code", notice.text.includes('data-redeemid-notice="cart_empty"') && notice.text.includes("Your cart is empty."));
	const openBreak = await visitor.go("/posts/open-break");
	check("a break changes nothing when no rule covers the post", openBreak.text.includes("OB-INTRO") && openBreak.text.includes("OB-REST"));
	const ld = (t) => [...t.matchAll(/<script type="application\/ld\+json">([^<]*)<\/script>/g)].map((m) => JSON.parse(m[1])).find((d) => "isAccessibleForFree" in d);
	const lockedLd = ld(locked.text);
	check("a locked post carries the paywall markup pointing at the wall", lockedLd?.isAccessibleForFree === false && lockedLd?.hasPart?.cssSelector === ".redeemid-locked" && typeof lockedLd?.headline === "string" && lockedLd.url.endsWith("/posts/members-only"), JSON.stringify(lockedLd));
	check("a Members only part is marked too", ld(section.text)?.isAccessibleForFree === false);
	check("an open post has no paywall markup", !ld(open.text) && !ld(openBreak.text));
	check("visitor page stays cacheable", !/private/.test(locked.res.headers.get("cache-control") ?? ""), locked.res.headers.get("cache-control"));

	// Member signs in through the store and comes back to the post.
	const member = new Browser();
	const signIn = await member.go("/_emdash/api/auth/redeemid/login?return=/posts/members-only");
	check("sign-in returns to the post", signIn.url.pathname === "/posts/members-only", signIn.url.href);
	check("member reads the members post", signIn.text.includes("MEMBER-BODY"), signIn.text.slice(0, 300));
	check("member page is private", /private/.test(signIn.res.headers.get("cache-control") ?? ""), signIn.res.headers.get("cache-control"));
	const memberOpen = await member.go("/posts/welcome");
	check("a member's open page is private too", memberOpen.res.headers.get("cache-control") === "private, no-store", memberOpen.res.headers.get("cache-control"));
	check("token request used Basic auth and PKCE", shop.tokenRequests.at(-1)?.form.code_verifier?.length >= 43);
	check("token request sent the site origin", shop.tokenRequests.at(-1)?.origin === SITE);
	check("account box shows the member level", signIn.text.includes("redeemid-account__levels") && signIn.text.includes("Member"));
	for (const path of ["/_emdash/api/content/posts", "/_emdash/api/content/posts/pro-only"]) {
		const r = await member.go(path);
		check(`member can't read ${path}`, r.res.status === 403 && !r.text.includes("PRO-BODY"), `${r.res.status} ${r.text.slice(0, 120)}`);
	}
	const memberSearch = await searchItems(member, "MEMBER-BODY");
	check("site search works for members and finds what they can read", memberSearch.status === 200 && memberSearch.items.some((i) => i.slug === "members-only" && typeof i.snippet === "string"), `${memberSearch.status} ${JSON.stringify(memberSearch.items)}`);
	const memberPro = await searchItems(member, "PRO-BODY");
	check("site search hides a level's posts from members without it", memberPro.status === 200 && !memberPro.items.some((i) => i.slug === "pro-only"), JSON.stringify(memberPro.items));
	const adminUi = await member.go("/_emdash/admin");
	check("member is sent home from the admin", adminUi.url.pathname === "/", adminUi.url.href);
	const staffApi = await admin.go("/_emdash/api/content/posts");
	check("staff still use the content API", staffApi.res.status === 200, String(staffApi.res.status));
	const pro = await member.go("/posts/pro-only");
	check("Pro post asks a member to upgrade", !pro.text.includes("PRO-BODY") && pro.text.includes('data-redeemid-reason="upgrade"'));
	const sectionMember = await member.go("/posts/members-section");
	check("Members only: a Member sees the Pro wall in place", !sectionMember.text.includes("MS-INSIDE") && sectionMember.text.includes("This is for Pro members.") && sectionMember.text.includes("MS-AFTER"));
	const bothMember = await member.go("/posts/both-rules");
	check("two term rules both apply (Member can't read a Members + Pro post)", !bothMember.text.includes("BOTH-BODY") && bothMember.text.includes('data-redeemid-reason="upgrade"'));
	const insiderMember = await member.go("/posts/insider");
	check("a child term takes its parent's rule (Insider needs Pro)", !insiderMember.text.includes("INSIDER-BODY") && insiderMember.text.includes('data-redeemid-reason="upgrade"'));

	// The meter (one a month) opens a locked Reports post, never a Pro post (meter: false).
	const reportOne = await member.go("/posts/report-one");
	check("meter opens a locked post for a signed-in reader", reportOne.text.includes("REPORT-ONE-BODY") && reportOne.text.includes("This is your last free read this month."), reportOne.text.slice(0, 200));
	const reportAgain = await member.go("/posts/report-one");
	check("a metered post reads again for free", reportAgain.text.includes("REPORT-ONE-BODY"));
	const reportTwo = await member.go("/posts/report-two");
	check("the meter stops at its limit", !reportTwo.text.includes("REPORT-TWO-BODY") && /You('|&#39;)ve used your free reads\s*this month\./.test(reportTwo.text));
	const reportVisitor = await visitor.go("/posts/report-one");
	check("the meter never opens a post for visitors", !reportVisitor.text.includes("REPORT-ONE-BODY") && reportVisitor.text.includes('data-redeemid-reason="sign_in"'));
	// Drip: Updates open 30 days after the member's level started (just now).
	const drip = await member.go("/posts/drip-update");
	check("drip holds a post until the member has been in long enough", !drip.text.includes("DRIP-BODY") && drip.text.includes('data-redeemid-reason="drip"') && drip.text.includes("This opens for you on"), drip.text.slice(0, 200));

	// One body with a Paywall break block in a Pro post: the opening is open, the rest follows the post's rule.
	// The break still carries levels from before 0.0.24 (Member); they're ignored.
	const breakVisitor = await visitor.go("/posts/paywall-break");
	check("paywall break: visitors read the opening", breakVisitor.text.includes("OPEN-INTRO"));
	check("paywall break: visitors don't get the rest", !breakVisitor.text.includes("BREAK-BODY") && breakVisitor.text.includes('data-redeemid-reason="sign_in"'));
	const breakMember = await member.go("/posts/paywall-break");
	check("paywall break: the post's rule applies after it, not old levels on the break (Member asked to upgrade)", breakMember.text.includes("OPEN-INTRO") && !breakMember.text.includes("BREAK-BODY") && breakMember.text.includes('data-redeemid-reason="upgrade"'));

	// RedeemID is a registered EmDash plugin with its admin pages and blocks.
	const manifest = await admin.go("/_emdash/api/manifest");
	check("plugin is in the admin manifest with its blocks", manifest.text.includes('"redeemid"') && manifest.text.includes("redeemid-paywall") && manifest.text.includes("redeemid-plan") && manifest.text.includes("redeemid-members-end"), manifest.text.slice(0, 200));
	const adminPage = async (page) =>
		admin.go("/_emdash/api/plugins/redeemid/admin", {
			method: "POST",
			headers: { "content-type": "application/json", "x-emdash-request": "1", origin: SITE },
			body: JSON.stringify({ type: "page_load", page }),
		});
	const overview = await adminPage("/overview");
	check("Overview comes first with status cards, members by level and recent activity", overview.res.status === 200 && overview.text.includes('"type":"redeemid_cards"') && overview.text.includes("Explore the access map") && overview.text.includes("Recent activity"), overview.text.slice(0, 300));
	const dashCard = await adminPage("widget:status");
	check("the dashboard card counts customers and links into RedeemID", dashCard.text.includes('"label":"Customers"') && dashCard.text.includes('"path":"/customers"') && dashCard.text.includes('"path":"/overview"'), dashCard.text.slice(0, 300));
	check("Overview points to Resources instead of listing them", overview.text.includes('"path":"/resources"') && !overview.text.includes("Report a problem"), overview.text.slice(0, 300));
	const resources = await adminPage("/resources");
	check("Resources lists the guides and the store's own screens", resources.res.status === 200 && resources.text.includes("Developer API") && resources.text.includes("In your Shopify admin"), resources.text.slice(0, 300));
	const membersPage = await adminPage("/customers");
	check("Customers page lists the signed-in customer", membersPage.res.status === 200 && membersPage.text.includes('"text":"Customers"') && membersPage.text.includes(shop.customer.email), `${membersPage.res.status} ${membersPage.text.slice(0, 200)}`);
	const statusPage = await adminPage("/connection/environment");
	check("Environment lists the ignored replacement", statusPage.text.includes("1 in use, 1 ignored") && statusPage.text.includes("text_problems"));
	check("an ignored replacement leaves the original", signIn.text.includes(">Sign out</button>") && !signIn.text.includes("Leave,"));
	check("Environment finds no template showing a gated body in full", statusPage.text.includes("Templates: none renders a gated collection") && !statusPage.text.includes("template_findings"), statusPage.text.slice(0, 300));
	check("Connection never shows the webhook endpoint to copy", !statusPage.text.includes("/_emdash/api/auth/redeemid/webhook") && statusPage.text.includes('"label":"Store"') && statusPage.text.includes('"label":"Environment"'), statusPage.text.slice(0, 300));
	const memberAdmin = await member.go("/_emdash/api/plugins/redeemid/admin", {
		method: "POST",
		headers: { "content-type": "application/json", "x-emdash-request": "1", origin: SITE },
		body: JSON.stringify({ type: "page_load", page: "/overview" }),
	});
	check("members can't open the plugin's admin pages", memberAdmin.res.status === 401 || memberAdmin.res.status === 403, String(memberAdmin.res.status));

	// Access settings in the admin: levels named by the site, rules for any content type, an entry's own rule.
	const accessCall = async (input) =>
		admin.go("/_emdash/api/plugins/redeemid/admin", {
			method: "POST",
			headers: { "content-type": "application/json", "x-emdash-request": "1", origin: SITE },
			body: JSON.stringify(input),
		});
	const accessPage = await accessCall({ type: "page_load", page: "/access" });
	check("Access page lists levels, content types and taxonomies from the site", accessPage.res.status === 200 && accessPage.text.includes('"label":"Content types"') && accessPage.text.includes('"label":"Sitewide"') && accessPage.text.includes('"label":"Meter"') && accessPage.text.includes('"label":"Code settings"') && accessPage.text.includes("Posts") && accessPage.text.includes("Categories"), accessPage.text.slice(0, 300));
	check("each level has a code button that opens its snippet", accessPage.text.includes('"icon":"code"') && accessPage.text.includes("in your site"), accessPage.text.slice(0, 300));
	const addLevel = await accessCall({ type: "form_submit", action_id: "level_save", block_id: "level:new", values: { name: "Patrons of the Arts", tags: "patron", match: "any" } });
	check("staff add a level with their own name", addLevel.text.includes("Level added.") && addLevel.text.includes("patrons-of-the-arts"), addLevel.text.slice(0, 300));
	const manifestAfter = await admin.go("/_emdash/api/manifest");
	check("the editor's level pickers offer the new level", manifestAfter.text.includes("Patrons of the Arts"));
	const welcomeApi = await admin.go("/_emdash/api/content/posts/welcome");
	const welcomeId = (welcomeApi.text.match(/"id":"([0-9A-Z]{20,})"/) ?? [])[1];
	// The Access column in content lists: one ask for the page's rows.
	const proApi = await admin.go("/_emdash/api/content/posts/pro-only");
	const proId = (proApi.text.match(/"id":"([0-9A-Z]{20,})"/) ?? [])[1];
	const column = async (who) => who.go("/_emdash/api/plugins/redeemid/access-list", { method: "POST", headers: { "content-type": "application/json", "x-emdash-request": "1", origin: SITE }, body: JSON.stringify({ collection: "posts", ids: [welcomeId, proId] }) });
	const columnAsk = await column(admin);
	const columnLabels = (() => { try { return JSON.parse(columnAsk.text).data?.labels ?? {}; } catch { return {}; } })();
	check("the Access column labels each post: Free, or its level as a lock", columnLabels[welcomeId]?.label === "Free" && columnLabels[welcomeId]?.locked === false && columnLabels[proId]?.locked === true && columnLabels[proId]?.label === "Pro", columnAsk.text.slice(0, 300));
	const columnMember = await column(member);
	check("members can't ask for the Access column", columnMember.res.status === 401 || columnMember.res.status === 403, String(columnMember.res.status));
	const panel = async (body) =>
		admin.go(`/_emdash/api/content/posts/${welcomeId}/plugin-extensions/redeemid/panel/access`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-emdash-request": "1", origin: SITE },
			body: JSON.stringify(body),
		});
	const panelLoad = await panel({ type: "panel_load" });
	check("the editor's Access panel shows who can read the entry", Boolean(welcomeId) && panelLoad.text.includes("Right now: free to everyone."), `${welcomeId} ${panelLoad.res.status} ${panelLoad.text.slice(0, 300)}`);
	const panelSave = await panel({ type: "form_submit", action_id: "entry_save", block_id: "entry", values: { mode: "levels", levels: ["patrons-of-the-arts"], drip: 0, no_meter: false } });
	check("the panel saves the entry's own rule", panelSave.text.includes("Access saved.") && panelSave.text.includes("Patrons of the Arts"), panelSave.text.slice(0, 300));
	const ownVisitor = await visitor.go("/posts/welcome");
	check("an entry's own rule locks it for visitors", !ownVisitor.text.includes("starter post") && ownVisitor.text.includes('data-redeemid-reason="sign_in"') && ownVisitor.text.includes("Patrons of the Arts"), ownVisitor.text.slice(0, 200));
	const ownMember = await member.go("/posts/welcome");
	check("a member without the level is asked to upgrade", ownMember.text.includes('data-redeemid-reason="upgrade"'));
	await panel({ type: "form_submit", action_id: "entry_save", block_id: "entry", values: { mode: "inherit", drip: 0, no_meter: false } });
	const backOpen = await visitor.go("/posts/welcome");
	check("back to the site rules, the entry is open again", backOpen.text.includes("starter post"));
	const typeRule = await accessCall({ type: "form_submit", action_id: "type_save", block_id: "type:pages", values: { who: "signed-in", drip: 0, no_meter: false, teaser: 0 } });
	check("staff set a rule for a whole content type", typeRule.text.includes("Saved."), typeRule.text.slice(0, 200));
	const statusTemplates = await adminPage("/connection/environment");
	check("with a Pages rule, Environment names the template that renders Pages with PortableText", statusTemplates.text.includes("A template shows locked bodies in full") && statusTemplates.text.includes("src/pages/[slug].astro") && statusTemplates.text.includes('"collections":"pages"'), statusTemplates.text.slice(0, 300));
	await accessCall({ type: "form_submit", action_id: "type_save", block_id: "type:pages", values: { who: "none", drip: 0, no_meter: false, teaser: 0 } });
	const levelGone = await accessCall({ type: "block_action", action_id: "level_menu", value: "remove:patrons-of-the-arts" });
	check("an unused level can be removed", levelGone.text.includes("Level removed."), levelGone.text.slice(0, 200));
	const backToCode = await accessCall({ type: "block_action", action_id: "reset", value: "levels" });
	check("levels go back to the code's, from the Code settings tab", backToCode.text.includes("Using the code's levels again.") && backToCode.text.includes('"default_tab":9'));

	// Staff tools: member detail, resync, tag edits written to Shopify, bulk resync, webhooks, access test.
	const adminAct = async (input) =>
		admin.go("/_emdash/api/plugins/redeemid/admin", {
			method: "POST",
			headers: { "content-type": "application/json", "x-emdash-request": "1", origin: SITE },
			body: JSON.stringify(input),
		});
	const cid = String(shop.customer.id);
	check("Customers page has an Open button per customer and Resync all", membersPage.text.includes('"action_id":"member_open"') && membersPage.text.includes("Resync all from Shopify") && !membersPage.text.includes("Resync 25"));
	const detail = await adminAct({ type: "block_action", action_id: "member_open", value: cid, page: "/customers" });
	check("member detail shows levels, tags and the tag form", detail.text.includes("Shopify customer") && detail.text.includes("member_tag_add") && detail.text.includes('"action_id":"member_tag_remove"') && detail.text.includes('"label":"Membership"'), detail.text.slice(0, 300));
	shop.customer.tags = ["member", "supporter"];
	const resynced = await adminAct({ type: "block_action", action_id: "member_resync", value: cid, page: "/customers" });
	check("Resync reads the customer from Shopify with a client-credentials token", resynced.text.includes("Read again from Shopify.") && resynced.text.includes("supporter") && shop.adminTokens >= 1, resynced.text.slice(0, 300));
	const tokensAfterResync = shop.adminTokens;
	const tagged = await adminAct({ type: "form_submit", action_id: "member_tag_add", block_id: `tags:${cid}`, values: { tags: "pro, vip" }, page: "/customers" });
	check("adding tags writes them to Shopify and reads them back", shop.tagEdits.at(-1)?.m === "tagsAdd" && JSON.stringify(shop.tagEdits.at(-1)?.tags) === JSON.stringify(["pro", "vip"]) && tagged.text.includes("Tags added in Shopify.") && tagged.text.includes("vip") && shop.adminTokens === tokensAfterResync);
	const untagged = await adminAct({ type: "block_action", action_id: "member_tag_remove", value: { customerId: cid, tag: "vip" }, page: "/customers" });
	check("removing a tag removes it in Shopify", shop.tagEdits.at(-1)?.m === "tagsRemove" && !shop.customer.tags.includes("vip") && untagged.text.includes("Tag removed in Shopify."));
	const levelEvent = shop.events.find((e) => e.headers["x-redeemid-event"] === "member.levels_changed" && JSON.parse(e.body).data.added.includes("pro"));
	const sig = levelEvent ? createHmac("sha256", EVENTS_SECRET).update(levelEvent.body).digest("hex") : "";
	check("a level change sends a signed member.levels_changed event", Boolean(levelEvent) && levelEvent.headers["x-redeemid-signature"] === `sha256=${sig}`, JSON.stringify(shop.events.map((e) => e.headers["x-redeemid-event"])));
	check("sign-in sent member.signed_in", shop.events.some((e) => e.headers["x-redeemid-event"] === "member.signed_in"));
	check("the meter sent meter.used and meter.exhausted", shop.events.some((e) => e.headers["x-redeemid-event"] === "meter.used") && shop.events.some((e) => e.headers["x-redeemid-event"] === "meter.exhausted"));
	// Events go out after the response: a slow receiver doesn't hold up sign-in.
	shop.eventsDelayMs = 2500;
	const slowStart = Date.now();
	await member.go("/_emdash/api/auth/redeemid/login?refresh=1&return=%2Faccount");
	const slowTook = Date.now() - slowStart;
	check("a slow event receiver doesn't slow sign-in", slowTook < 2000, `${slowTook} ms`);
	shop.eventsDelayMs = 0;
	await new Promise((r) => setTimeout(r, 2700));
	// A receiver that's down: three tries, then the event waits under App events for staff.
	shop.eventsDown = true;
	shop.eventsRefused = 0;
	await member.go("/_emdash/api/auth/redeemid/login?refresh=1&return=%2Faccount");
	await new Promise((r) => setTimeout(r, 7500));
	check("a failed event is tried three times", shop.eventsRefused === 3, String(shop.eventsRefused));
	shop.eventsDown = false;
	const failedList = await adminPage("/events/app");
	const failedId = /"action_id":"failed_resend","label":"Send again","style":"primary","value":"([^"]+)"/.exec(failedList.text)?.[1];
	check("App events lists the failed event with Send again", failedList.text.includes("Failed events") && failedList.text.includes('"event":"member.signed_in"') && Boolean(failedId), failedList.text.slice(0, 600));
	const eventsBefore = shop.events.length;
	const resent = await adminAct({ type: "block_action", action_id: "failed_resend", value: failedId, page: "/events" });
	check("Send again delivers it with its delivery id and takes it off the list", resent.text.includes("Sent.") && !resent.text.includes("Failed events") && shop.events.length === eventsBefore + 1 && shop.events.at(-1).headers["x-redeemid-delivery"] === failedId, resent.text.slice(0, 300));
	const bulkStart = await adminAct({ type: "block_action", action_id: "customers_resync_start", value: "new", page: "/customers" });
	check("Resync all starts a run over every customer", bulkStart.text.includes('"type":"redeemid_run"') && bulkStart.text.includes('"state":"running"') && bulkStart.text.includes('"total":1'), bulkStart.text.slice(0, 300));
	const bulkStep = await adminAct({ type: "block_action", action_id: "customers_resync_next", page: "/customers" });
	const bulkEnd = await adminAct({ type: "block_action", action_id: "customers_resync_next", page: "/customers" });
	check("each batch reads the next customers, and the run finishes", bulkStep.text.includes('"done":1') && bulkEnd.text.includes('"state":"finished"'), `${bulkStep.text.slice(0, 200)} ${bulkEnd.text.slice(0, 200)}`);
	const bulkDone = await adminAct({ type: "block_action", action_id: "customers_resync_done", page: "/customers" });
	check("the finished run reloads Customers with what it did", bulkDone.text.includes("1 customers read") && bulkDone.text.includes('"text":"Customers"'), bulkDone.text.slice(0, 300));
	const setupBefore = await adminPage("/connection");
	check("Connection opens on Status cards, with the next step named", setupBefore.text.includes("5 of 6 steps done") && setupBefore.text.includes('"default_tab":0') && setupBefore.text.includes('"type":"redeemid_cards"') && setupBefore.text.includes("Register the webhooks: To do") && setupBefore.text.includes("Register 8 webhooks") && setupBefore.text.includes("setup_register") && setupBefore.text.includes('"scope":"write_customers"'), setupBefore.text.slice(0, 400));
	const hooksNow = await adminPage("/connection/webhooks");
	check("the Webhooks tab lists the missing subscriptions under its one Register button", hooksNow.text.includes("Missing") && hooksNow.text.includes('"text":"Subscriptions"') && !hooksNow.text.includes("webhooks_register"), hooksNow.text.slice(0, 300));
	const registered = await adminAct({ type: "block_action", action_id: "webhooks_register", value: "", page: "/connection" });
	check("Register adds the 8 topics pointed at this site", shop.subscriptions.length === 8 && shop.subscriptions.every((x) => x.uri === `${SITE}/_emdash/api/auth/redeemid/webhook`) && registered.text.includes("Registered 8 webhooks.") && registered.text.includes('"default_tab":3'), JSON.stringify(shop.subscriptions.slice(0, 2)));
	const statusLinks = (await adminPage("/connection/status")).text;
	check("Connection is Status, Store, Environment and Webhooks", ['"label":"Status"', '"label":"Store"', '"label":"Environment"', '"label":"Webhooks"', '"text":"Connection"', '"type":"redeemid_copy"'].every((x) => statusLinks.includes(x)) && !statusLinks.includes('"label":"App events"'), statusLinks.slice(0, 300));
	const setupAfter = await adminPage("/connection");
	check("once the webhooks are in and a customer has signed in, Status says connected", setupAfter.text.includes('"default_tab":0') && !setupAfter.text.includes("steps done") && setupAfter.text.includes('"title":"Connected"') && setupAfter.text.includes("Register the webhooks: Done"), setupAfter.text.slice(0, 400));
	const setupAgain = await adminAct({ type: "block_action", action_id: "setup_register", page: "/connection" });
	check("Setup's Register says nothing was missing", setupAgain.text.includes("Nothing was missing.") && shop.subscriptions.length === 8, setupAgain.text.slice(0, 300));

	const test = await adminAct({ type: "form_submit", action_id: "access_test", values: { collection: "posts", terms: "category:members, category:pro", tags: "member", signed_in: true }, page: "/access" });
	check("access test shows what an entry needs and the verdict", test.text.includes("Member or Pro + Pro") || test.text.includes("Pro"), test.text.slice(0, 400));
	check("access test says a Member is kept out of a Members + Pro post", test.text.includes("This reader is kept out"));
	check("access test answers on the Access page's Test tab", test.text.includes('"label":"Test"') && test.text.includes('"default_tab":8'));
	// Member preferences: read from and saved to the member's own Shopify customer.
	const prefsPage = await member.go("/account");
	check("Preferences shows the member's fields, not the membership namespace", prefsPage.text.includes("Topics") && prefsPage.text.includes("Weekly newsletter") && prefsPage.text.includes("Reader level:") && !prefsPage.text.includes("Member since"), prefsPage.text.slice(0, 300));
	const prefBody = new URLSearchParams([["return", "/account"], ["present:preferences.topics", "1"], ["pref:preferences.topics", "Food"], ["pref:preferences.topics", "Travel"], ["present:preferences.newsletter", "1"], ["pref:preferences.newsletter", "true"]]);
	const savedPrefs = await member.go("/_emdash/api/auth/redeemid/preferences", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: prefBody.toString() });
	check("saving the form writes the answers to the Shopify customer", shop.metafields["preferences.topics"] === '["Food","Travel"]' && shop.metafields["preferences.newsletter"] === "true" && savedPrefs.text.includes("Your preferences are saved."), JSON.stringify(shop.metafields));
	const prefEvent = shop.events.find((e) => e.headers["x-redeemid-event"] === "preferences.saved");
	check("preferences.saved names the fields, never the answers", Boolean(prefEvent) && !prefEvent.body.includes("Travel") && JSON.parse(prefEvent.body).data.fields.includes("preferences.topics"));
	const writes = shop.metafieldWrites.length;
	const prefRefused = await member.go("/_emdash/api/auth/redeemid/preferences", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ values: { "preferences.topics": ["Sport"], "preferences.level": 5, "membership.since": "2020-01-01" } }) });
	check("bad answers are refused and nothing is saved", prefRefused.res.status === 400 && prefRefused.text.includes("invalid_choice") && prefRefused.text.includes("read_only") && prefRefused.text.includes("unknown_field") && shop.metafieldWrites.length === writes, prefRefused.text.slice(0, 200));
	const prefCleared = await member.go("/_emdash/api/auth/redeemid/preferences", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ values: { "preferences.topics": [] } }) });
	check("an empty answer clears the field", prefCleared.res.status === 200 && !("preferences.topics" in shop.metafields) && shop.metafieldWrites.at(-1)?.m === "metafieldsDelete");
	const visitorPrefs = await visitor.go("/_emdash/api/auth/redeemid/preferences");
	check("visitors can't read preferences", visitorPrefs.res.status === 401, String(visitorPrefs.res.status));

	// Protected files: a file in the "Pro downloads" folder only reaches Pro members and staff.
	const staffHeaders = { "x-emdash-request": "1", origin: SITE };
	const folder = await admin.go("/_emdash/api/media/folders", { method: "POST", headers: { ...staffHeaders, "content-type": "application/json" }, body: JSON.stringify({ name: "Pro downloads" }) });
	const folderId = JSON.parse(folder.text)?.data?.id ?? JSON.parse(folder.text)?.data?.item?.id ?? JSON.parse(folder.text)?.data?.folder?.id;
	const upload = async (name, inFolder) => {
		const form = new FormData();
		form.append("file", new Blob([`%PDF-1.4\n% PROTECTED-${name}\n%%EOF\n`], { type: "application/pdf" }), name);
		if (inFolder) form.append("folderId", folderId);
		const r = await admin.go("/_emdash/api/media", { method: "POST", headers: staffHeaders, body: form });
		const item = JSON.parse(r.text)?.data?.item ?? JSON.parse(r.text)?.data;
		return { status: r.res.status, key: item?.storageKey, text: r.text };
	};
	const proFile = await upload("pro-guide.pdf", true);
	const openUp = await upload("open-guide.pdf", false);
	check("staff can file uploads in a media folder", Boolean(folderId) && Boolean(proFile.key) && Boolean(openUp.key), `${folder.text.slice(0, 200)} ${proFile.text.slice(0, 200)}`);
	const fileUrl = (k) => `/_emdash/api/media/file/${encodeURIComponent(k)}`;
	const asVisitor = await visitor.go(fileUrl(proFile.key));
	check("a visitor is asked to sign in for a protected file", asVisitor.res.status === 401 && !asVisitor.text.includes("PROTECTED-") && asVisitor.res.headers.get("cache-control") === "private, no-store", `${asVisitor.res.status}`);
	const doubled = await visitor.go(`/_emdash/api/media/file/${encodeURIComponent(encodeURIComponent(proFile.key))}`);
	check("an encoded key doesn't get past the check", !doubled.text.includes("PROTECTED-"), `${doubled.res.status}`);
	for (const path of [`${fileUrl(proFile.key)}/`, `${fileUrl(proFile.key)}%2F`, `/_emdash/api/media/file//${encodeURIComponent(proFile.key)}`, `/_image?href=${encodeURIComponent(`/_emdash/api/media/file/${proFile.key}`)}&w=100&f=webp`, `/_image?href=${encodeURIComponent(`${SITE}/_emdash/api/media/file/${proFile.key}/`)}`]) {
		const r = await visitor.go(path);
		check(`a visitor gets no protected file from ${path.slice(0, 60)}`, !r.text.includes("PROTECTED-") && !/public/.test(r.res.headers.get("cache-control") ?? ""), `${r.res.status} ${r.res.headers.get("cache-control")}`);
	}
	shop.customer.tags = ["member"];
	await adminAct({ type: "block_action", action_id: "member_resync", value: cid, page: "/customers" });
	const asMember = await member.go(fileUrl(proFile.key));
	check("a member without the level is refused the file", asMember.res.status === 403 && !asMember.text.includes("PROTECTED-"), `${asMember.res.status}`);
	shop.customer.tags = ["member", "pro"];
	await adminAct({ type: "block_action", action_id: "member_resync", value: cid, page: "/customers" });
	const asPro = await member.go(fileUrl(proFile.key));
	check("a Pro member downloads it, never cached", asPro.res.status === 200 && asPro.text.includes("PROTECTED-pro-guide.pdf") && asPro.res.headers.get("cache-control") === "private, no-store", `${asPro.res.status} ${asPro.res.headers.get("cache-control")}`);
	const asStaff = await admin.go(fileUrl(proFile.key));
	check("staff can always download it", asStaff.res.status === 200 && asStaff.text.includes("PROTECTED-"));
	// "entries": a file used in a Pro post reaches whoever can read that post.
	const storyFolder = await admin.go("/_emdash/api/media/folders", { method: "POST", headers: { ...staffHeaders, "content-type": "application/json" }, body: JSON.stringify({ name: "Story files" }) });
	const storyFolderId = JSON.parse(storyFolder.text)?.data?.item?.id;
	const storyForm = new FormData();
	storyForm.append("file", new Blob(["%PDF-1.4\n% PROTECTED-story.pdf\n%%EOF\n"], { type: "application/pdf" }), "story.pdf");
	storyForm.append("folderId", storyFolderId);
	const storyUp = JSON.parse((await admin.go("/_emdash/api/media", { method: "POST", headers: staffHeaders, body: storyForm })).text)?.data?.item;
	const created = await admin.go("/_emdash/api/content/posts", {
		method: "POST",
		headers: { ...staffHeaders, "content-type": "application/json" },
		body: JSON.stringify({ data: { title: "Pro files", content: [{ _type: "block", _key: "a", style: "normal", markDefs: [], children: [{ _type: "span", _key: "b", text: "Attached." }] }, { _type: "image", _key: "c", asset: { _ref: storyUp?.id } }] }, taxonomies: { category: ["pro"] } }),
	});
	const postId = JSON.parse(created.text)?.data?.item?.id;
	const published = await admin.go(`/_emdash/api/content/posts/${postId}/publish`, { method: "POST", headers: staffHeaders });
	check("a Pro post using a Story file is published", Boolean(storyUp?.storageKey) && published.res.status === 200, `${created.text.slice(0, 200)} ${published.text.slice(0, 200)}`);
	let storyAsPro;
	for (let i = 0; i < 20; i++) {
		storyAsPro = await member.go(fileUrl(storyUp.storageKey));
		if (storyAsPro.res.status === 200) break;
		await new Promise((r) => setTimeout(r, 250));
	}
	check("a reader of the post downloads the file it uses", storyAsPro.res.status === 200 && storyAsPro.text.includes("PROTECTED-story.pdf"), String(storyAsPro.res.status));
	shop.customer.tags = ["member"];
	await adminAct({ type: "block_action", action_id: "member_resync", value: cid, page: "/customers" });
	const storyAsMember = await member.go(fileUrl(storyUp.storageKey));
	check("a member who can't read the post is refused its file", storyAsMember.res.status === 403, String(storyAsMember.res.status));
	const openFile = await visitor.go(fileUrl(openUp.key));
	check("files outside protected folders stay public", openFile.res.status === 200 && openFile.text.includes("PROTECTED-open-guide.pdf"));

	// Put the store's customer back as the rest of the run expects.
	shop.customer.tags = ["member"];
	await adminAct({ type: "block_action", action_id: "member_resync", value: cid, page: "/customers" });

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
	check("a member's checkout opens signed in as their customer", bought.url.searchParams.get("customer") === String(shop.customer.id) && shop.identityUpdates.at(-1)?.ok === true, bought.url.href);
	const memberState = await member.go("/_emdash/api/auth/redeemid/api/state");
	const ms = JSON.parse(memberState.text);
	check("api/state for a member: levels and features, never an email or tags", ms.signedIn && ms.linked && ms.levels.includes("member") && !memberState.text.includes("@") && !memberState.text.includes('"tags"') && memberState.res.headers.get("cache-control") === "private, no-store", memberState.text);
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

	// The cart is the member's Shopify cart: it keeps lines and leads to checkout.
	const withCart = await member.go("/join");
	check("Cart link shows the Shopify cart count", withCart.text.includes('data-redeemid-cart-count="1"'));
	await member.go("/_emdash/api/auth/redeemid/buy", {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: "plan=pro-plan&return=%2Fjoin",
	});
	const cartId = [...shop.cartsById.keys()].at(-1);
	check("a second Buy adds to the same Shopify cart", shop.carts.length === 1 && shop.cartsById.get(cartId)?.lines[0]?.quantity === 2, String(shop.carts.length));
	check("the cart notes the page the sale came from", JSON.stringify(shop.cartsById.get(cartId)?.attributes) === JSON.stringify([{ key: "_redeemid_page", value: "/join" }]), JSON.stringify(shop.cartsById.get(cartId)?.attributes));
	const toCart = await member.go("/_emdash/api/auth/redeemid/cart?return=%2Fjoin");
	check("Cart goes to that cart's checkout", toCart.text === "CHECKOUT" && toCart.url.searchParams.get("cart") === cartId, toCart.url.href);
	await fetch(`http://127.0.0.1:${SHOP_PORT}/checkout?cart=${encodeURIComponent(cartId)}&complete=1`);
	const done = await member.go("/_emdash/api/auth/redeemid/cart?return=%2Fjoin");
	check("a completed checkout empties the cart", done.url.searchParams.get("redeemid_notice") === "cart_empty", done.url.href);
	const cleared = await member.go("/join");
	check("Cart count resets after checkout", cleared.text.includes('data-redeemid-cart-count="0"'));

	// Commerce: a collection, product pages, a cart page and a contribution.
	const shopper = new Browser();
	const shopPage = await shopper.go("/shop/");
	check("collection lists its products with links and prices", shopPage.text.includes('href="/shop/harbor-tote/"') && shopPage.text.includes("From $20.00") && shopPage.text.includes("Support the newsroom"));
	check("missing collection shows the fallback", (await shopper.go("/shop/")).text.includes("redeemid-collection") && !(await shopper.go("/shop/no-such/")).text.includes("redeemid-collection"));
	const tote = await shopper.go("/shop/harbor-tote/");
	check("product page offers its options and marks sold-out ones", tote.text.includes('name="option.Color"') && /<option[^>]*disabled[^>]*>\s*Sand/.test(tote.text) && tote.text.includes("$20.00") && tote.text.includes("Add to cart"));
	check("a product's own page has Product structured data", /"@type":"Product".*"priceCurrency":"USD"/.test(tote.text));
	check("a product's own page is titled with the product", /<title>[^<]*Harbor tote/i.test(tote.text), (tote.text.match(/<title>[^<]*/) ?? [""])[0]);
	const noProduct = await shopper.go("/shop/no-such-product/");
	check("an unknown product answers 404 with the fallback", noProduct.res.status === 404 && noProduct.text.includes("PRODUCT-FALLBACK"), String(noProduct.res.status));
	const productMap = await shopper.go("/sitemap-products.xml");
	check("the product sitemap lists each product page", productMap.res.status === 200 && productMap.text.includes("<urlset") && productMap.text.includes("/shop/harbor-tote/</loc>") && productMap.text.includes("<lastmod>2026-11-01"), productMap.text.slice(0, 300));
	check("product page shows Shopify's recommendations", tote.text.includes("You may also like") && tote.text.includes('href="/shop/support/"'));
	check("the layout loads the browser client and the cart drawer", tote.text.includes('id="redeemid-client-config"') && tote.text.includes("data-redeemid-cart-drawer") && tote.text.includes("data-redeemid-cart-link"));
	const edit = (fields) =>
		shopper.go("/_emdash/api/auth/redeemid/cart-edit", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams(fields).toString(),
		});
	const addedTote = await edit({ action: "add", product: "harbor-tote", variant: "gid://shopify/ProductVariant/501", quantity: "2", return: "/shop/harbor-tote/" });
	check("Add to cart comes back with a notice", addedTote.url.pathname === "/shop/harbor-tote/" && addedTote.url.searchParams.get("redeemid_notice") === "cart_added", addedTote.url.href);
	const soldOut = await edit({ action: "add", product: "harbor-tote", variant: "gid://shopify/ProductVariant/502", return: "/shop/harbor-tote/" });
	check("a sold-out variant isn't added", soldOut.url.searchParams.get("redeemid_notice") === "plan_unavailable");
	const foreign = await edit({ action: "add", product: "harbor-tote", variant: "gid://shopify/ProductVariant/42", return: "/shop/harbor-tote/" });
	check("a variant from another product isn't added", foreign.url.searchParams.get("redeemid_notice") === "plan_unavailable");
	const byOption = await edit({ action: "add", product: "harbor-tote", "option.Color": "Navy", quantity: "1", return: "/shop/harbor-tote/" });
	check("Add to cart picks the variant from the chosen options", byOption.url.searchParams.get("redeemid_notice") === "cart_added" && [...shop.cartsById.values()].at(-1)?.lines.find((l) => l.merchandiseId === "gid://shopify/ProductVariant/501")?.quantity === 3);
	const noCombo = await edit({ action: "add", product: "harbor-tote", "option.Color": "Plaid", return: "/shop/harbor-tote/" });
	check("an option value the product doesn't have isn't added", noCombo.url.searchParams.get("redeemid_notice") === "plan_unavailable");
	const coffee = await shopper.go("/shop/coffee-club/");
	check("a product with selling plans offers one-time or subscription", coffee.text.includes("Purchase options") && coffee.text.includes("One-time purchase") && coffee.text.includes("Subscribe: Every month"));
	const badPlanId = await edit({ action: "add", product: "coffee-club", selling_plan: "gid://shopify/SellingPlan/999", return: "/shop/coffee-club/" });
	check("a selling plan from elsewhere isn't added", badPlanId.url.searchParams.get("redeemid_notice") === "plan_unavailable");
	await edit({ action: "add", product: "coffee-club", selling_plan: "gid://shopify/SellingPlan/91", return: "/shop/coffee-club/" });
	const subLine = [...shop.cartsById.values()].at(-1)?.lines.find((l) => l.merchandiseId === "gid://shopify/ProductVariant/801");
	check("a subscription line carries its selling plan", subLine?.sellingPlanId === "gid://shopify/SellingPlan/91", JSON.stringify(subLine));
	const subCart = await shopper.go("/cart");
	check("the cart names the line's selling plan", subCart.text.includes("Every month"));
	// Put the cart back to two totes for the checks below.
	const liveLines = [...shop.cartsById.values()].at(-1)?.lines ?? [];
	await edit({ action: "remove", line: liveLines.find((l) => l.merchandiseId === "gid://shopify/ProductVariant/801")?.id ?? "", return: "/cart" });
	await edit({ action: "update", line: liveLines.find((l) => l.merchandiseId === "gid://shopify/ProductVariant/501")?.id ?? "", quantity: "2", return: "/cart" });

	// Browsing: filters, sorting and pages from the URL, quick add, search and JSON.
	const browse = await shopper.go("/shop/");
	check("a browsable collection offers Shopify's filters, sorting and a next page", browse.text.includes("In stock (") && browse.text.includes('name="sort"') && /rel="next" href="\/shop\/\?after=3"/.test(browse.text), browse.text.match(/rel="next"[^>]*/)?.[0]);
	check("cards that need no choice get Add to cart", /data-redeemid-product="support"[^]*?name="variant" value="gid:\/\/shopify\/ProductVariant\/601"/.test(browse.text));
	const page2 = await shopper.go("/shop/?after=3");
	check("the next page lists the rest and links back", page2.text.includes("Coffee club") && page2.text.includes('rel="prev"'));
	const found = await shopper.go("/shop/search?q=tote");
	check("search lists Shopify's matches with filters", found.text.includes("1 result for “tote”") && found.text.includes("Harbor tote") && found.text.includes("Ledger (1)"));
	const sorted = await shopper.go(`/shop/search?q=*&sort=price-desc&filter=${encodeURIComponent('{"productVendor":"Ledger"}')}`);
	const lastSearch = shop.searches.at(-1);
	check("search passes the sort and filter to Shopify", lastSearch?.sortKey === "PRICE" && lastSearch?.reverse === true && lastSearch?.filters?.[0]?.productVendor === "Ledger" && sorted.text.includes("Clear filters"), JSON.stringify(lastSearch));
	const suggestions = await (await fetch(`${SITE}/_emdash/api/auth/redeemid/api/search?q=sup&suggest=1`)).json();
	check("api/search suggests products as you type", suggestions.products?.[0]?.handle === "support", JSON.stringify(suggestions));
	const jsonSearch = await fetch(`${SITE}/_emdash/api/auth/redeemid/api/search?collection=shop&first=2`);
	check("api/search pages a collection, cacheable", (await jsonSearch.json()).pageInfo?.hasNextPage === true && /public/.test(jsonSearch.headers.get("cache-control") ?? ""));
	const viaJson = await shopper.go("/_emdash/api/auth/redeemid/api/cart", {
		method: "POST",
		headers: { "content-type": "application/json", origin: SITE },
		body: JSON.stringify({ action: "add", product: "support", quantity: 2 }),
	});
	const viaBody = JSON.parse(viaJson.text);
	check("api/cart adds and answers the whole cart", viaBody.notice === "cart_added" && viaBody.cart?.lines.some((l) => l.productHandle === "support" && l.quantity === 2) && viaBody.added?.product === "support", viaJson.text.slice(0, 300));
	const crossSiteCart = await shopper.go("/_emdash/api/auth/redeemid/api/cart", {
		method: "POST",
		headers: { "content-type": "application/json", origin: "https://evil.example" },
		body: JSON.stringify({ action: "add", product: "support" }),
	});
	check("api/cart refuses another site's request", crossSiteCart.res.status === 403, String(crossSiteCart.res.status));
	const jsonUnavailable = await shopper.go("/_emdash/api/auth/redeemid/api/cart", {
		method: "POST",
		headers: { "content-type": "application/json", origin: SITE },
		body: JSON.stringify({ action: "add", product: "harbor-tote", options: { Color: "Sand" } }),
	});
	check("api/cart answers 422 for a sold-out choice", jsonUnavailable.res.status === 422 && JSON.parse(jsonUnavailable.text).notice === "plan_unavailable");
	const guestState = JSON.parse((await shopper.go("/_emdash/api/auth/redeemid/api/state")).text);
	check("api/state for a guest: signed out, with the cart count", guestState.signedIn === false && guestState.cart.count > 0 && guestState.apiVersion === "1.6.0", JSON.stringify(guestState));
	const guestCheckout = JSON.parse(
		(await shopper.go("/_emdash/api/auth/redeemid/api/cart", { method: "POST", headers: { "content-type": "application/json", origin: SITE }, body: JSON.stringify({ action: "checkout" }) })).text,
	);
	check("api/cart checkout gives a guest the cart's own checkout", typeof guestCheckout.checkoutUrl === "string" && !guestCheckout.checkoutUrl.includes("customer="), JSON.stringify(guestCheckout));
	await edit({ action: "remove", line: viaBody.cart?.lines.find((l) => l.productHandle === "support")?.id ?? "", return: "/cart" });
	let cartPage = await shopper.go("/cart");
	check("cart page lists the line, its price and the subtotal", cartPage.text.includes("Harbor tote") && cartPage.text.includes("$20.00 each") && cartPage.text.includes("$40.00") && /private/.test(cartPage.res.headers.get("cache-control") ?? ""));
	const cartHolder = await shopper.go("/posts/welcome");
	check("any page is private while the visitor has a cart", cartHolder.res.headers.get("cache-control") === "private, no-store", cartHolder.res.headers.get("cache-control"));
	const lineId = (cartPage.text.match(/data-redeemid-line="([^"]+)"/) ?? [])[1];
	await edit({ action: "update", line: lineId, quantity: "3", return: "/cart" });
	cartPage = await shopper.go("/cart");
	check("changing the quantity updates the cart", cartPage.text.includes("$60.00") && cartPage.text.includes('data-redeemid-cart-count="3"'));
	const bad = await edit({ action: "discount", code: "NOPE", return: "/cart" });
	check("a code that doesn't apply says so", bad.url.searchParams.get("redeemid_notice") === "discount_not_applicable");
	const good = await edit({ action: "discount", code: "HARBOR10", return: "/cart" });
	check("a discount code applies and the total drops", good.url.searchParams.get("redeemid_notice") === "discount_applied" && good.text.includes("$54.00"), good.url.href);
	await edit({ action: "update", line: "gid://shopify/CartLine/999", quantity: "50", return: "/cart" });
	check("a line from another cart is ignored", (await shopper.go("/cart")).text.includes('data-redeemid-cart-count="3"'));
	await edit({ action: "remove", line: lineId, return: "/cart" });
	check("Remove empties the cart", (await shopper.go("/cart")).text.includes("Your cart is empty."));
	const support = await shopper.go("/support");
	check("contribution offers amounts for a 1.00 product", support.text.includes("$5") && support.text.includes("Another amount (USD)"));
	const gave = await edit({ action: "add", product: "support", quantity: "15", then: "checkout", return: "/support" });
	const gift = [...shop.cartsById.values()].at(-1);
	check("a contribution of 15 checks out 15 units of the 1.00 product", gave.text === "CHECKOUT" && gift?.lines.some((l) => l.merchandiseId === "gid://shopify/ProductVariant/601" && l.quantity === 15), JSON.stringify(gift?.lines));

	// From the store's redirect theme: a discount link's code waits for the first cart.
	const linked = new Browser();
	const linkLanded = await linked.go("/shop/harbor-tote/?discount=HARBOR10");
	check("a discount link lands on the clean page", linkLanded.url.pathname === "/shop/harbor-tote/" && linkLanded.url.search === "" && linkLanded.res.status === 200, linkLanded.url.href);
	const linkedEdit = (fields) =>
		linked.go("/_emdash/api/auth/redeemid/cart-edit", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
	await linkedEdit({ action: "add", product: "harbor-tote", variant: "gid://shopify/ProductVariant/501", quantity: "1", return: "/cart" });
	const linkedCart = await linked.go("/cart");
	check("the first cart carries the discount link's code", [...shop.cartsById.values()].at(-1)?.codes.includes("HARBOR10") && linkedCart.text.includes("$18.00"), JSON.stringify([...shop.cartsById.values()].at(-1)?.codes));
	const quiet = await new Browser().go("/posts/welcome?logged_in=true", {}, 1);
	check("a store-signed-in visitor is signed in without a form", (quiet.res.headers.get("location") ?? "").startsWith("/_emdash/api/auth/redeemid/login?quiet=1&return=%2Fposts%2Fwelcome"), quiet.res.headers.get("location"));

	// Account goes to the member's Shopify customer account.
	check("account box links to the Shopify account", cleared.text.includes("/_emdash/api/auth/redeemid/account"));
	const acct = await member.go("/_emdash/api/auth/redeemid/account?return=%2Fjoin");
	check("Account opens the Shopify customer account", acct.text === "CUSTOMER-ACCOUNT", acct.url.href);
	check("every server call to Shopify sent a User-Agent", shop.blocked.length === 0, shop.blocked.join(", "));

	// Shopify tags the customer Pro (Flow or an app would do this).
	const gid = `gid://shopify/Customer/${shop.customer.id}`;
	shop.customer.tags = [...shop.customer.tags, "pro"];
	const added = await webhook("customer.tags_added", { customerId: gid, tags: ["pro"] }, { id: "evt-1" });
	check("signed tag webhook is processed", added.status === 200 && added.text === "processed", JSON.stringify(added));
	const dup = await webhook("customer.tags_added", { customerId: gid, tags: ["pro"] }, { id: "evt-1" });
	check("repeated delivery is dropped", dup.status === 200 && dup.text === "Duplicate", JSON.stringify(dup));
	const forged = await webhook("customer.tags_added", { customerId: gid, tags: ["vip"] }, { badSig: true });
	check("unsigned webhook is refused", forged.status === 401, JSON.stringify(forged));
	const proNow = await member.go("/posts/pro-only");
	check("Pro post opens after the tag webhook", proNow.text.includes("PRO-BODY"));

	// Events (Webhook, App, Health) and Reports, like the WordPress plugin's pages.
	const received = await adminPage("/events/webhook");
	check("Events → Webhook lists the delivery with its result and customer", received.text.includes("customer.tags_added") && received.text.includes(`"topic":"customer.tags_added","result":"Processed","customer":"${shop.customer.id}"`), received.text.slice(0, 400));
	const checked = await adminAct({ type: "block_action", action_id: "health_check", page: "/events" });
	check("Check now checks with Shopify and shows the turned-away delivery on Events → Health", checked.text.includes("Checked") && checked.text.includes("turned away") && checked.text.includes('"default_tab":2') && checked.text.includes('"text":"Events"'), checked.text.slice(0, 400));
	const savedMonitor = await adminAct({ type: "form_submit", action_id: "monitor_save", block_id: "monitor", values: { quiet_days: 5, alert_email: "" }, page: "/events" });
	check("Health saves when to warn", savedMonitor.text.includes('"initial_value":5') && savedMonitor.text.includes("Saved."), savedMonitor.text.slice(0, 300));
	const appEvents = await adminPage("/events/app");
	check("App events lists the newest first", appEvents.text.includes('"event":"Webhook received","about":"customer.tags_added"') && appEvents.text.includes("Webhook rejected"), appEvents.text.slice(0, 600));
	const kinds = {};
	for (const [event, text] of [["member.signed_in", '"event":"Sign-in"'], ["shopify.admin", '"event":"Admin API call","about":"Customers"'], ["staff.resync", '"event":"Resync"'], ["staff.tags", '"event":"Tag edit","about":"added"'], ["staff.webhooks", '"event":"Webhook registration","about":"register"'], ["settings.saved", '"event":"Settings saved","about":"access'], ["meter.exhausted", '"event":"Metered read, meter used up"']]) {
		kinds[event] = (await adminAct({ type: "block_action", action_id: "events_show", value: event, page: "/events" })).text.includes(text);
	}
	check("App events records sign-ins, Admin API calls, staff actions, settings saves and the meter", Object.values(kinds).every(Boolean), JSON.stringify(kinds));
	check("App events never show an email", !appEvents.text.includes(shop.customer.email));
	const problems = await adminAct({ type: "form_submit", action_id: "events_filter", block_id: "events_filter", values: { event: "", problems: true }, page: "/events" });
	check("Problems only shows warnings and errors", problems.text.includes("Webhook rejected") && !problems.text.includes('"event":"Webhook received","about":"customer.tags_added"'), problems.text.slice(0, 400));
	const reports = await adminPage("/reports");
	check("Reports count members by level, joins and sign-ins", reports.text.includes("On a level") && reports.text.includes('"chart_type":"custom"') && reports.text.includes("Sign-ins"), reports.text.slice(0, 400));
	const widget = await adminPage("widget:status");
	check("the dashboard widget shows webhook health", widget.text.includes("Webhooks"), widget.text.slice(0, 200));
	const breakPro = await member.go("/posts/paywall-break");
	check("paywall break opens for Pro", breakPro.text.includes("OPEN-INTRO") && breakPro.text.includes("BREAK-BODY"));
	check("Members only part opens for Pro", (await member.go("/posts/members-section")).text.includes("MS-INSIDE"));
	check("Members + Pro post opens for a member with both", (await member.go("/posts/both-rules")).text.includes("BOTH-BODY"));
	check("child term post opens for Pro", (await member.go("/posts/insider")).text.includes("INSIDER-BODY"));

	// Member tools: the account card, plans that know who holds them, Refresh membership.
	const card = await member.go("/account");
	check("account card lists the member's levels with their start dates", /data-redeemid-level="member"[^]*?since <time/.test(card.text) && card.text.includes("<strong>Pro</strong>"), (card.text.match(/<section class="redeemid-member[^]*?<\/section>/) ?? [""])[0].slice(0, 400));
	check("account card links to Refresh membership", card.text.includes("/_emdash/api/auth/redeemid/login?refresh=1&amp;return=%2Faccount"));
	const joinPro = await member.go("/join");
	check("a plan the member holds says so instead of Buy", joinPro.text.includes("You&#39;re on this plan.") || joinPro.text.includes("You're on this plan."));
	shop.customer.tags = ["member"];
	// The membership.* metafields a subscription app or Flow keeps; signing in reads them with the Admin API.
	shop.customer.dates = { renews: "2027-01-15", gift: "2099-12-31", since: "2025-03-01" };
	const refreshed = await member.go("/_emdash/api/auth/redeemid/login?refresh=1&return=%2Faccount");
	check("the account card shows Shopify's renewal and gift dates", refreshed.text.includes('data-redeemid-date="renews"') && refreshed.text.includes("January 15, 2027") && refreshed.text.includes("Gift membership until") && refreshed.text.includes("March 1, 2025"), (refreshed.text.match(/<section class="redeemid-member[^]*?<\/section>/) ?? [""])[0].slice(0, 600));
	check("Refresh membership asks the store for no sign-in form", shop.authorizeRequests.at(-1)?.prompt === "none");
	check("Refresh membership comes back with the store's tags", refreshed.url.pathname === "/account" && refreshed.url.searchParams.get("redeemid_notice") === "refreshed" && refreshed.text.includes("Your membership is up to date."), refreshed.url.href);
	check("a level Shopify removed shows under Before", /redeemid-member__past[^]*?data-redeemid-level="pro"/.test(refreshed.text));
	const lapsedPost = await member.go("/posts/pro-only");
	check("the removed level no longer opens Pro posts", !lapsedPost.text.includes("PRO-BODY"));
	check("a lapsed member's wall offers Renew, not Join", lapsedPost.text.includes("Your Pro membership has ended.") && lapsedPost.text.includes("Renew Pro") && !lapsedPost.text.includes("Become a member"), (lapsedPost.text.match(/<div class="redeemid-locked[^]*?<\/div>/) ?? [""])[0].slice(0, 500));
	const renewPlan = await member.go("/join");
	check("a lapsed member's plan card says Renew", /data-redeemid-plan="pro-plan" data-redeemid-state="renew"[^]*?<button type="submit">Renew<\/button>/.test(renewPlan.text), (renewPlan.text.match(/<div class="redeemid-plan[^]*?<\/div>/) ?? [""])[0].slice(0, 400));
	shop.customer.dates = {};
	shop.storeSession = false;
	const before = shop.authorizeRequests.length;
	const fallback = await member.go("/_emdash/api/auth/redeemid/login?refresh=1&return=%2Faccount");
	shop.storeSession = true;
	check("with no store session, Refresh falls back to the usual sign-in", fallback.url.pathname === "/account" && shop.authorizeRequests.length === before + 2 && !shop.authorizeRequests.at(-1)?.prompt && !fallback.url.search.includes("sign_in_cancelled"), fallback.url.href);
	shop.customer.tags = ["member", "pro"];
	await member.go("/_emdash/api/auth/redeemid/login?refresh=1&return=%2Faccount");

	// Shopify turns the account off, then on again.
	await webhook("customers/disable", { id: shop.customer.id, updated_at: "2026-11-08T10:00:00Z" });
	const off = await member.go("/posts/members-only");
	check("disabled account loses access", !off.text.includes("MEMBER-BODY") && off.text.includes('data-redeemid-reason="disabled"'));
	await webhook("customers/enable", { id: shop.customer.id, updated_at: "2026-11-08T11:00:00Z" });
	const on = await member.go("/posts/members-only");
	check("re-enabled account gets access back", on.text.includes("MEMBER-BODY"));

	const original = shop.customer;
	// A store customer with a staff email can't take over the staff account.
	shop.customer = { id: 2002, email: "dev@emdash.local", firstName: "Not", lastName: "Staff", tags: ["pro"] };
	const intruder = new Browser();
	const logoutsBefore = shop.logouts ?? 0;
	const refused = await intruder.go("/_emdash/api/auth/redeemid/login?return=/posts/pro-only");
	check("staff email is refused", refused.url.searchParams.get("redeemid_notice") === "staff_account", refused.url.href);
	check("a refused sign-in ends the store session and comes back to the page", (shop.logouts ?? 0) === logoutsBefore + 1 && refused.url.pathname === "/posts/pro-only", refused.url.href);
	const home = await intruder.go("/");
	check("the refusal notice shows once", home.url.pathname === "/" && !home.url.searchParams.has("redeemid_notice"), home.url.href);
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

	// Privacy: the member downloads and deletes their data; Shopify's compliance topics are logged.
	shop.customer = original;
	const reader = new Browser();
	await reader.go("/_emdash/api/auth/redeemid/login?return=/account");
	const account = await reader.go("/account");
	check("account page offers Download and Delete my data", account.text.includes("Download my data") && account.text.includes("Delete my data"));
	const mine = await reader.go("/_emdash/api/auth/redeemid/privacy");
	const exported = JSON.parse(mine.text);
	check("Download my data is the member's own record, as an attachment", exported.format === "redeemid-member-export" && exported.member?.customerId === String(original.id) && /attachment/.test(mine.res.headers.get("content-disposition") ?? ""), mine.text.slice(0, 200));
	const form = (extra) => ({ method: "POST", headers: { origin: SITE, "content-type": "application/x-www-form-urlencoded" }, body: `return=%2Faccount${extra}` });
	const unconfirmed = await reader.go("/_emdash/api/auth/redeemid/privacy", form(""));
	check("Delete my data needs the box ticked", unconfirmed.url.searchParams.get("redeemid_notice") === "erase_unconfirmed", unconfirmed.url.href);
	const crossSite = await reader.go("/_emdash/api/auth/redeemid/privacy", { ...form("&confirm=yes"), headers: { origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" } });
	check("Delete my data refuses another origin", crossSite.res.status === 403, String(crossSite.res.status));
	const erased = await reader.go("/_emdash/api/auth/redeemid/privacy", form("&confirm=yes"));
	check("Delete my data erases and signs out", erased.url.searchParams.get("redeemid_notice") === "data_erased" && erased.text.includes("Your data on this site is deleted"), erased.url.href);
	const goneMembers = await adminPage("/overview");
	check("the erased member is gone from Members", !goneMembers.text.includes(`"${original.id}"`) && !goneMembers.text.includes(original.email));
	const afterErase = await reader.go("/posts/members-only");
	check("the erased member reads as signed out", !afterErase.text.includes("MEMBER-BODY"));
	await webhook("customers/data_request", { customer: { id: 4242, email: "x@example.com" }, data_request: { id: 9001 }, shop_domain: "s" });
	const privacy = await adminPage("/privacy");
	check("Privacy page lists the member's erase and Shopify's open data request", privacy.text.includes("Customer, on the site") && privacy.text.includes("request 9001") && privacy.text.includes("privacy_done") && !privacy.text.includes("x@example.com"), privacy.text.slice(0, 300));
	const back = await reader.go("/_emdash/api/auth/redeemid/login?return=/posts/members-only");
	check("signing in again links the member again", back.text.includes("MEMBER-BODY"), back.url.href);

	// AI agents and the CLI: staff-only JSON routes, offered as MCP tools once staff turn them on.
	const made = await admin.go("/_emdash/api/admin/api-tokens", {
		method: "POST",
		headers: { "content-type": "application/json", "x-emdash-request": "1", origin: SITE },
		body: JSON.stringify({ name: "e2e", scopes: ["admin", "mcp:tools", "mcp:tools:redeemid"] }),
	});
	const apiToken = JSON.parse(made.text)?.data?.token;
	check("staff can make an API token", typeof apiToken === "string", made.text.slice(0, 200));
	const cli = (...args) =>
		new Promise((done) =>
			execFile("node", [fileURLToPath(new URL("../../bin/redeemid-emdash.mjs", import.meta.url)), ...args, "--url", SITE], { env: { ...process.env, EMDASH_TOKEN: apiToken } }, (err, stdout, stderr) =>
				done({ code: err ? (err.code ?? 1) : 0, stdout, stderr }),
			),
		);
	const levelsOut = await cli("levels");
	check("CLI lists the levels", levelsOut.code === 0 && JSON.parse(levelsOut.stdout).some((l) => l.slug === "pro"), levelsOut.stderr || levelsOut.stdout.slice(0, 200));
	const accessOut = await cli("access", "posts", "--terms", "category:pro", "--tags", "member");
	const access = accessOut.code === 0 ? JSON.parse(accessOut.stdout) : {};
	check("CLI explains access like the Access test", access.canRead === false && access.reason === "upgrade" && access.needs === "Pro", accessOut.stderr || accessOut.stdout.slice(0, 300));
	const visitorOut = await cli("access", "posts", "--terms", "category:pro", "--signed-out");
	check("CLI explains a visitor is asked to sign in", visitorOut.code === 0 && JSON.parse(visitorOut.stdout).reason === "sign_in", visitorOut.stderr);
	const memberOut = await cli("member", original.email);
	check("CLI reads a member by email", memberOut.code === 0 && JSON.parse(memberOut.stdout).customerId === String(original.id), memberOut.stderr || memberOut.stdout.slice(0, 200));
	const healthOut = await cli("health");
	check("CLI health shows yes or no, never a secret", healthOut.code === 0 && JSON.parse(healthOut.stdout).webhookSecret === true && !healthOut.stdout.includes(WEBHOOK_SECRET), healthOut.stderr);
	const tagsOut = await cli("tags", String(original.id), "--add", "cli-added");
	check("CLI action edits tags in Shopify and reads them back", tagsOut.code === 0 && JSON.parse(tagsOut.stdout).tags.includes("cli-added"), tagsOut.stderr || tagsOut.stdout.slice(0, 200));
	const noToken = await new Promise((done) => execFile("node", [fileURLToPath(new URL("../../bin/redeemid-emdash.mjs", import.meta.url)), "levels", "--url", SITE, "--token", "nope"], (err, _o, stderr) => done({ code: err?.code ?? 0, stderr })));
	check("CLI with a bad token is refused", noToken.code !== 0, noToken.stderr);
	const memberCall = await reader.go("/_emdash/api/plugins/redeemid/list-levels", { method: "POST", headers: { "content-type": "application/json", "x-emdash-request": "1", origin: SITE }, body: "{}" });
	check("members can't call the staff routes", memberCall.res.status === 401 || memberCall.res.status === 403, String(memberCall.res.status));

	// Sold on its own: a Pro post its buyers read whatever their level.
	const singleVisitor = await new Browser().go("/posts/single-story");
	check("a post sold on its own stays locked for visitors", !singleVisitor.text.includes("SINGLE-BODY") && singleVisitor.text.includes("Buy just this") && singleVisitor.text.includes("$3.00"), singleVisitor.text.slice(0, 200));
	shop.customer = { id: 3003, email: "single@example.com", firstName: "Sam", lastName: "Single", tags: ["member"] };
	const buyer = new Browser();
	await buyer.go("/_emdash/api/auth/redeemid/login?return=/posts/single-story");
	const notYet = await buyer.go("/posts/single-story");
	check("a member without the item is offered Buy just this beside the upgrade", !notYet.text.includes("SINGLE-BODY") && notYet.text.includes('data-redeemid-reason="upgrade"') && notYet.text.includes('name="plan" value="single-story"'), notYet.text.slice(0, 200));
	shop.customer.tags = ["member", "item-single-story"];
	await webhook("customer.tags_added", { customerId: "gid://shopify/Customer/3003", tags: ["item-single-story"] });
	const itemOpen = await buyer.go("/posts/single-story");
	check("the item's tag opens the whole post", itemOpen.text.includes("SINGLE-BODY") && !itemOpen.text.includes("Buy just this"), itemOpen.text.slice(0, 200));
	const explainedItem = await cli("access", "posts", "--id", "single-story", "--customer", "3003");
	check("CLI explains the item", explainedItem.code === 0 && JSON.parse(explainedItem.stdout).soldOnItsOwn?.held === true && JSON.parse(explainedItem.stdout).canRead === true, explainedItem.stderr || explainedItem.stdout.slice(0, 300));
	shop.customer = original;

	// Tag groups and includes: "silver" + "annual" grants Gold, and Gold includes Pro.
	shop.customer = { id: 4004, email: "gold@example.com", firstName: "Gale", lastName: "Gold", tags: ["silver", "annual"] };
	const gold = new Browser();
	const landed = await gold.go("/_emdash/api/auth/redeemid/login?return=/");
	check("a member signing in from the home page lands on their level's home", landed.url.pathname === "/posts/pro-only", landed.url.href);
	check("silver plus annual grants Gold, and Gold reads what Pro reads", landed.text.includes("PRO-BODY"), landed.text.slice(0, 200));
	const levelsBox = (landed.text.match(/redeemid-account__levels[^]*?<\/span>\s*<\/span>/) ?? [""])[0];
	check("the account box names only the top level, in its colour", levelsBox.includes('data-redeemid-level="gold"') && levelsBox.includes("--redeemid-level-color: #c9a227") && !levelsBox.includes("Pro"), levelsBox);
	const goldJoin = await gold.go("/join");
	check("a plan a bigger level includes says so", goldJoin.text.includes('data-redeemid-state="included"') && goldJoin.text.includes("Included in your Gold membership."), (goldJoin.text.match(/redeemid-plan[^]{0,400}/) ?? [""])[0]);
	const fromPost = await new Browser().go("/_emdash/api/auth/redeemid/login?return=/posts/members-only");
	check("signing in from a post still returns to it", fromPost.url.pathname === "/posts/members-only", fromPost.url.href);
	shop.customer = { id: 4005, email: "silver@example.com", firstName: "Sil", lastName: "Ver", tags: ["silver"] };
	const silverOnly = new Browser();
	const noGold = await silverOnly.go("/_emdash/api/auth/redeemid/login?return=/posts/pro-only");
	check("one tag of an all-group isn't enough", !noGold.text.includes("PRO-BODY") && noGold.text.includes('data-redeemid-reason="upgrade"'), noGold.text.slice(0, 200));
	shop.customer = original;

	const mcp = async (method, params) => {
		const res = await fetch(`${SITE}/_emdash/api/mcp`, {
			method: "POST",
			headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
		});
		const text = await res.text();
		const line = text.split("\n").find((l) => l.startsWith("data: "));
		try {
			return JSON.parse(line ? line.slice(6) : text);
		} catch {
			return { raw: `${res.status} ${text.slice(0, 300)}` };
		}
	};
	const toolsBefore = await mcp("tools/list", {});
	check("MCP offers no RedeemID tools until staff turn them on", Array.isArray(toolsBefore.result?.tools) && !toolsBefore.result.tools.some((t) => t.name.startsWith("redeemid__")), JSON.stringify(toolsBefore).slice(0, 300));
	const mcpOn = await admin.go("/_emdash/api/admin/plugins/redeemid/mcp", {
		method: "PUT",
		headers: { "content-type": "application/json", "x-emdash-request": "1", origin: SITE },
		body: JSON.stringify({ enabled: true }),
	});
	check("staff turn on RedeemID's MCP tools", mcpOn.res.status === 200 && mcpOn.text.includes("explain_access") && mcpOn.text.includes("edit_member_tags"), mcpOn.text.slice(0, 300));
	const listed = await mcp("tools/list", {});
	const names = (listed.result?.tools ?? []).map((t) => t.name);
	check("MCP lists RedeemID's tools, the tag edit marked destructive", names.includes("redeemid__explain_access") && names.includes("redeemid__get_member") && listed.result.tools.find((t) => t.name === "redeemid__edit_member_tags")?.annotations?.destructiveHint === true, names.join(", "));
	const called = await mcp("tools/call", { name: "redeemid__explain_access", arguments: { collection: "posts", terms: { category: ["pro"] }, tags: ["pro"] } });
	const callText = called.result?.content?.[0]?.text ?? "";
	check("an agent's explain_access answers like the CLI", callText.includes('"canRead": true'), JSON.stringify(called).slice(0, 400));
	{
		// Product entries: staff pick Shopify products to keep as entries; Shopify's fields follow Shopify.
		const unset = await adminPage("/products");
		check("Products offers to set up products, with no seed to edit", unset.text.includes('"action_id":"products_setup"') && unset.text.includes("Set up products") && !/seed/i.test(unset.text), unset.text.slice(0, 400));
		const setUp = await adminAct({ type: "block_action", action_id: "products_setup", page: "/products" });
		const schemaApi = JSON.parse((await admin.go("/_emdash/api/schema/collections/products/fields")).text);
		const fieldSlugs = (schemaApi.data?.items ?? schemaApi.data ?? []).map((f) => f.slug);
		check("Set up products creates the content type with every Shopify field and a story", setUp.text.includes("Products are set up") && ["title", "handle", "shopify_id", "price", "listed", "synced_at", "content"].every((f) => fieldSlugs.includes(f)) && setUp.text.includes('"label":"Synced","value":"0"') && setUp.text.includes("Turn on automatic updates"), `${setUp.text.slice(0, 300)} ${fieldSlugs.join(",")}`);
		const pickKey = (t) => (t.match(/"action_id":"(pick_[a-z0-9]+)"/) ?? [])[1];
		check("the picker lists the store's products as checkboxes", setUp.text.includes('"type":"checkbox"') && setUp.text.includes("Harbor tote") && pickKey(setUp.text), setUp.text.slice(0, 400));
		const found = await adminAct({ type: "form_submit", action_id: "products_browse", values: { query: "tote" }, page: "/products" });
		check("staff search the store by name", found.text.includes("Harbor tote") && !found.text.includes("Pro plan") && found.text.includes('"label":"Show all"'), found.text.slice(0, 400));
		const toteId = shop.products["harbor-tote"].id;
		const addedTote = await adminAct({ type: "form_submit", action_id: "products_pick", values: { [pickKey(found.text)]: [toteId] }, page: "/products" });
		check("ticking a product and saving syncs it as a published entry from Shopify's fields", addedTote.text.includes("1 synced") && addedTote.text.includes('"label":"Synced","value":"1"') && addedTote.text.includes("20.0 USD") && addedTote.text.includes(`"initial_value":["${toteId}"]`), addedTote.text.slice(0, 400));
		const toteApi = JSON.parse((await admin.go("/_emdash/api/content/products/harbor-tote")).text);
		const tote = toteApi.data?.item ?? toteApi.item ?? toteApi.data;
		check("the entry is in EmDash's content, published, with the handle as its slug", tote?.status === "published" && tote?.slug === "harbor-tote" && tote?.data?.shopify_id === shop.products["harbor-tote"].id, JSON.stringify(toteApi).slice(0, 300));
		const editTote = await admin.go(`/_emdash/api/content/products/${tote?.id}`, {
			method: "PUT",
			headers: { "content-type": "application/json", "x-emdash-request": "1", origin: SITE },
			body: JSON.stringify({ data: { title: "Cheap tote", price: "1.0", content: [{ _type: "block", _key: "s1", style: "normal", children: [{ _type: "span", _key: "s1a", text: "STORY-OF-THE-TOTE", marks: [] }], markDefs: [] }] } }),
		});
		const toteAfterEdit = JSON.parse((await admin.go("/_emdash/api/content/products/harbor-tote")).text);
		const edited = toteAfterEdit.data?.item ?? toteAfterEdit.item ?? toteAfterEdit.data;
		check("an editor's save keeps their story and puts Shopify's title and price back", editTote.res.status < 300 && edited?.data?.title === "Harbor tote" && edited?.data?.price === "20.0" && JSON.stringify(edited?.data?.content ?? "").includes("STORY-OF-THE-TOTE"), `${editTote.res.status} ${editTote.text.slice(0, 200)} ${JSON.stringify(edited?.data ?? {}).slice(0, 300)}`);
		const storyPage = await visitor.go("/shop/harbor-tote/");
		check("the product page sells it live with the entry's story under it", storyPage.text.includes("data-redeemid-product") && storyPage.text.includes("STORY-OF-THE-TOTE"), storyPage.text.slice(0, 200));
		const productLd = [...storyPage.text.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([^<]*)<\/script>/g)].map((m) => { try { return JSON.parse(m[1]); } catch { return null; } }).filter((d) => d?.["@type"] === "Product");
		check("a product entry's page gets one Product in the head, from Shopify's fields", productLd.length === 1 && productLd[0].productID === "harbor-tote" && productLd[0].offers?.priceCurrency && !JSON.stringify(productLd[0]).includes("STORY-OF-THE-TOTE"), JSON.stringify(productLd).slice(0, 300));
		const staffRoute = (route, body, who = admin) => who.go(`/_emdash/api/plugins/redeemid/${route}`, { method: "POST", headers: { "content-type": "application/json", "x-emdash-request": "1", origin: SITE }, body: JSON.stringify(body) });
		const picker = await staffRoute("product-picker", { query: "tote" });
		check("the product field widget searches the store", picker.res.status === 200 && picker.text.includes('"handle":"harbor-tote"'), picker.text.slice(0, 200));
		const hooksOn = await adminAct({ type: "block_action", action_id: "products_webhooks", page: "/products" });
		check("Turn on automatic updates registers products/create, update and delete", shop.subscriptions.filter((x) => x.topic.startsWith("PRODUCTS_")).length === 3 && hooksOn.text.includes("Automatic updates are on") && hooksOn.text.includes("stay current on their own"), hooksOn.text.slice(0, 300));
		shop.products["harbor-tote"].title = "Harbor tote, waxed";
		const hookUpdate = await webhook("products/update", { id: 1, admin_graphql_api_id: shop.products["harbor-tote"].id, handle: "harbor-tote" });
		const toteAfterHook = JSON.parse((await admin.go("/_emdash/api/content/products/harbor-tote")).text);
		check("products/update reads Shopify again and updates the entry", hookUpdate.text === "updated" && JSON.stringify(toteAfterHook).includes("Harbor tote, waxed"), `${hookUpdate.status} ${hookUpdate.text}`);
		const hookOther = await webhook("products/update", { id: 2, admin_graphql_api_id: shop.products["pro-plan"].id, handle: "pro-plan" });
		check("a product staff didn't pick isn't added by a webhook", hookOther.text === "absent", hookOther.text);
		// A run: start, then batches until it finishes (the admin page paces them).
		const runAll = async (prefix) => {
			let out = await adminAct({ type: "block_action", action_id: `${prefix}_start`, value: "new", page: "/products" });
			for (let n = 0; n < 20 && out.text.includes('"state":"running"'); n++) out = await adminAct({ type: "block_action", action_id: `${prefix}_next`, page: "/products" });
			const finished = out.text.includes('"state":"finished"');
			const page = await adminAct({ type: "block_action", action_id: `${prefix}_done`, page: "/products" });
			return { finished, text: page.text };
		};
		const all1 = await runAll("products_all");
		const catalog = await visitor.go("/shop/catalog");
		check("Sync every product syncs everything the channel sells, and the catalog page lists them from EmDash", all1.finished && all1.text.includes("products read") && catalog.text.includes("Harbor tote, waxed") && !catalog.text.includes("CATALOG-EMPTY") && !catalog.text.includes("Pro plan"), `${all1.text.slice(0, 300)} ${catalog.text.slice(0, 200)}`);
		const pickManifest = await admin.go("/_emdash/api/manifest");
		check("the Product block's catalog picker lists the entries", pickManifest.text.includes('"action_id":"pick"') && pickManifest.text.includes("harbor-tote"), (pickManifest.text.match(/"action_id":"pick".{0,300}/) ?? [""])[0]);
		const productMap = await visitor.go("/sitemap-products.xml");
		check("the product sitemap leaves out products EmDash's sitemap already lists", productMap.res.status === 200 && !productMap.text.includes("/shop/harbor-tote/"), productMap.text.slice(0, 300));
		const savedTote = shop.products["harbor-tote"];
		delete shop.products["harbor-tote"];
		const hookDelete = await webhook("products/delete", { id: 1, admin_graphql_api_id: savedTote.id });
		const toteGone = JSON.parse((await admin.go("/_emdash/api/content/products/harbor-tote")).text);
		const gone = toteGone.data?.item ?? toteGone.item ?? toteGone.data;
		check("products/delete takes the entry off sale (draft) and keeps the story", hookDelete.text === "delisted" && gone?.status === "draft" && !gone?.data?.listed && JSON.stringify(gone?.data?.content ?? "").includes("STORY-OF-THE-TOTE"), `${hookDelete.text} ${gone?.status} listed=${JSON.stringify(gone?.data?.listed)}`);
		shop.products["harbor-tote"] = { ...savedTote, title: "Harbor tote" };
		const refreshed = await runAll("products_refresh");
		const toteBack = JSON.parse((await admin.go("/_emdash/api/content/products/harbor-tote")).text);
		check("Update synced products brings back a product Shopify sells again", refreshed.finished && refreshed.text.includes("changed") && (toteBack.data?.item ?? toteBack.item ?? toteBack.data)?.status === "published", refreshed.text.slice(0, 300));
		const backTote = toteBack.data?.item ?? toteBack.item ?? toteBack.data;
		const stopped = await adminAct({ type: "block_action", action_id: "products_stop", value: backTote?.id, page: "/products" });
		const stoppedApi = await admin.go("/_emdash/api/content/products/harbor-tote");
		const stoppedHook = await webhook("products/update", { id: 1, admin_graphql_api_id: toteId, handle: "harbor-tote" });
		check("Stop syncing moves the entry to the trash, and webhooks leave it alone", stopped.text.includes("No longer synced") && stoppedApi.res.status === 404 && stoppedHook.text === "absent", `${stopped.text.slice(0, 200)} ${stoppedApi.res.status} ${stoppedHook.text}`);
		const again = await adminAct({ type: "form_submit", action_id: "products_browse", values: { query: "tote" }, page: "/products" });
		await adminAct({ type: "form_submit", action_id: "products_pick", values: { [pickKey(again.text)]: [toteId] }, page: "/products" });
		const restored = JSON.parse((await admin.go("/_emdash/api/content/products/harbor-tote")).text);
		const r2 = restored.data?.item ?? restored.item ?? restored.data;
		check("ticking it again brings the entry back with its story", r2?.id === backTote?.id && r2?.status === "published" && JSON.stringify(r2?.data?.content ?? "").includes("STORY-OF-THE-TOTE"), JSON.stringify(r2 ?? {}).slice(0, 300));
		const unpick = await adminAct({ type: "form_submit", action_id: "products_pick", values: { [pickKey((await adminAct({ type: "form_submit", action_id: "products_browse", values: { query: "tote" }, page: "/products" })).text)]: [] }, page: "/products" });
		check("unticking a synced product and saving stops syncing it", unpick.text.includes("1 no longer synced"), unpick.text.slice(0, 300));
	}
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
