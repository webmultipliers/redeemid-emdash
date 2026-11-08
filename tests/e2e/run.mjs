/**
 * End-to-end check of RedeemID on a real EmDash site (the playground) against
 * a fake Shopify store. Run with `pnpm e2e`.
 */
import { spawn } from "node:child_process";
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
	const section = await visitor.go("/posts/members-section");
	check("Members only: visitors read around the part but not inside it", section.text.includes("MS-BEFORE") && section.text.includes("MS-AFTER") && !section.text.includes("MS-INSIDE"));
	check("Members only: the wall shows the level's text and the join link", section.text.includes("PRO-WALL") && section.text.includes('href="/join"'));
	const notice = await visitor.go("/?redeemid_notice=cart_empty");
	check("Notices shows the notice for its code", notice.text.includes('data-redeemid-notice="cart_empty"') && notice.text.includes("Your cart is empty."));
	const openBreak = await visitor.go("/posts/open-break");
	check("a break with no levels changes nothing when no rule covers the post", openBreak.text.includes("OB-INTRO") && openBreak.text.includes("OB-REST"));
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

	// One body with a Paywall break block (levels: Pro): the opening is open, the rest isn't.
	const breakVisitor = await visitor.go("/posts/paywall-break");
	check("paywall break: visitors read the opening", breakVisitor.text.includes("OPEN-INTRO"));
	check("paywall break: visitors don't get the rest", !breakVisitor.text.includes("BREAK-BODY") && breakVisitor.text.includes('data-redeemid-reason="sign_in"'));
	const breakMember = await member.go("/posts/paywall-break");
	check("paywall break: the break's levels apply (Member asked to upgrade)", breakMember.text.includes("OPEN-INTRO") && !breakMember.text.includes("BREAK-BODY") && breakMember.text.includes('data-redeemid-reason="upgrade"'));

	// RedeemID is a registered EmDash plugin with its admin pages and blocks.
	const manifest = await admin.go("/_emdash/api/manifest");
	check("plugin is in the admin manifest with its blocks", manifest.text.includes('"redeemid"') && manifest.text.includes("redeemid-paywall") && manifest.text.includes("redeemid-plan") && manifest.text.includes("redeemid-members-end"), manifest.text.slice(0, 200));
	const adminPage = async (page) =>
		admin.go("/_emdash/api/plugins/redeemid/admin", {
			method: "POST",
			headers: { "content-type": "application/json", "x-emdash-request": "1", origin: SITE },
			body: JSON.stringify({ type: "page_load", page }),
		});
	const membersPage = await adminPage("/");
	check("Members page lists the signed-in member", membersPage.res.status === 200 && membersPage.text.includes(shop.customer.email), `${membersPage.res.status} ${membersPage.text.slice(0, 200)}`);
	const statusPage = await adminPage("/status");
	check("Status page reports sign-in ready", statusPage.text.includes("Sign-in is ready") && statusPage.text.includes("/_emdash/api/auth/redeemid/webhook"), statusPage.text.slice(0, 300));
	const memberAdmin = await member.go("/_emdash/api/plugins/redeemid/admin", {
		method: "POST",
		headers: { "content-type": "application/json", "x-emdash-request": "1", origin: SITE },
		body: JSON.stringify({ type: "page_load", page: "/" }),
	});
	check("members can't open the plugin's admin pages", memberAdmin.res.status === 401 || memberAdmin.res.status === 403, String(memberAdmin.res.status));

	// Staff tools: member detail, resync, tag edits written to Shopify, bulk resync, webhooks, access test.
	const adminAct = async (input) =>
		admin.go("/_emdash/api/plugins/redeemid/admin", {
			method: "POST",
			headers: { "content-type": "application/json", "x-emdash-request": "1", origin: SITE },
			body: JSON.stringify(input),
		});
	const cid = String(shop.customer.id);
	check("Members page has an Open button per member", membersPage.text.includes('"action_id":"member_open"') && membersPage.text.includes("Resync 50 from Shopify"));
	const detail = await adminAct({ type: "block_action", action_id: "member_open", value: cid, page: "/" });
	check("member detail shows levels, tags and the tag form", detail.text.includes("Shopify customer") && detail.text.includes("member_tag_add") && detail.text.includes("Remove in Shopify"), detail.text.slice(0, 300));
	shop.customer.tags = ["member", "supporter"];
	const resynced = await adminAct({ type: "block_action", action_id: "member_resync", value: cid, page: "/" });
	check("Resync reads the customer from Shopify with a client-credentials token", resynced.text.includes("Read again from Shopify.") && resynced.text.includes("supporter") && shop.adminTokens >= 1, resynced.text.slice(0, 300));
	const tokensAfterResync = shop.adminTokens;
	const tagged = await adminAct({ type: "form_submit", action_id: "member_tag_add", block_id: `tags:${cid}`, values: { tags: "pro, vip" }, page: "/" });
	check("adding tags writes them to Shopify and reads them back", shop.tagEdits.at(-1)?.m === "tagsAdd" && JSON.stringify(shop.tagEdits.at(-1)?.tags) === JSON.stringify(["pro", "vip"]) && tagged.text.includes("Tags added in Shopify.") && tagged.text.includes("vip") && shop.adminTokens === tokensAfterResync);
	const untagged = await adminAct({ type: "block_action", action_id: "member_tag_remove", value: { customerId: cid, tag: "vip" }, page: "/" });
	check("removing a tag removes it in Shopify", shop.tagEdits.at(-1)?.m === "tagsRemove" && !shop.customer.tags.includes("vip") && untagged.text.includes("Tag removed in Shopify."));
	const levelEvent = shop.events.find((e) => e.headers["x-redeemid-event"] === "member.levels_changed" && JSON.parse(e.body).data.added.includes("pro"));
	const sig = levelEvent ? createHmac("sha256", EVENTS_SECRET).update(levelEvent.body).digest("hex") : "";
	check("a level change sends a signed member.levels_changed event", Boolean(levelEvent) && levelEvent.headers["x-redeemid-signature"] === `sha256=${sig}`, JSON.stringify(shop.events.map((e) => e.headers["x-redeemid-event"])));
	check("sign-in sent member.signed_in", shop.events.some((e) => e.headers["x-redeemid-event"] === "member.signed_in"));
	check("the meter sent meter.used and meter.exhausted", shop.events.some((e) => e.headers["x-redeemid-event"] === "meter.used") && shop.events.some((e) => e.headers["x-redeemid-event"] === "meter.exhausted"));
	const bulk = await adminAct({ type: "block_action", action_id: "members_resync", page: "/" });
	check("bulk resync reads a batch from Shopify", bulk.text.includes("Read 1 members again"), bulk.text.slice(0, 300));
	const statusNow = await adminPage("/status");
	check("Status lists missing webhooks with a Register button", statusNow.text.includes("webhooks_register") && statusNow.text.includes("Missing"));
	const registered = await adminAct({ type: "block_action", action_id: "webhooks_register", value: "", page: "/status" });
	check("Register adds the 8 topics pointed at this site", shop.subscriptions.length === 8 && shop.subscriptions.every((x) => x.uri === `${SITE}/_emdash/api/auth/redeemid/webhook`) && registered.text.includes("Registered 8 webhooks."), JSON.stringify(shop.subscriptions.slice(0, 2)));
	check("Status lists recent deliveries", statusNow.text.includes("Recent deliveries"));
	const test = await adminAct({ type: "form_submit", action_id: "access_test", values: { collection: "posts", terms: "category:members, category:pro", tags: "member", signed_in: true }, page: "/test" });
	check("access test shows what an entry needs and the verdict", test.text.includes("Member or Pro + Pro") || test.text.includes("Pro"), test.text.slice(0, 400));
	check("access test says a Member is kept out of a Members + Pro post", test.text.includes("This reader is kept out"));
	// Put the store's customer back as the rest of the run expects.
	shop.customer.tags = ["member"];
	await adminAct({ type: "block_action", action_id: "member_resync", value: cid, page: "/" });

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
	check("product page shows variants and marks sold-out ones", tote.text.includes("Navy ($20.00)") && /<option[^>]*disabled[^>]*>\s*Sand/.test(tote.text) && tote.text.includes("Add to cart"));
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
	let cartPage = await shopper.go("/cart");
	check("cart page lists the line, its price and the subtotal", cartPage.text.includes("Harbor tote") && cartPage.text.includes("$20.00 each") && cartPage.text.includes("$40.00") && /private/.test(cartPage.res.headers.get("cache-control") ?? ""));
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

	// Account goes to the member's Shopify customer account.
	check("account box links to the Shopify account", cleared.text.includes("/_emdash/api/auth/redeemid/account"));
	const acct = await member.go("/_emdash/api/auth/redeemid/account?return=%2Fjoin");
	check("Account opens the Shopify customer account", acct.text === "CUSTOMER-ACCOUNT", acct.url.href);
	check("every server call to Shopify sent a User-Agent", shop.blocked.length === 0, shop.blocked.join(", "));

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
	const refreshed = await member.go("/_emdash/api/auth/redeemid/login?refresh=1&return=%2Faccount");
	check("Refresh membership asks the store for no sign-in form", shop.authorizeRequests.at(-1)?.prompt === "none");
	check("Refresh membership comes back with the store's tags", refreshed.url.pathname === "/account" && refreshed.url.searchParams.get("redeemid_notice") === "refreshed" && refreshed.text.includes("Your membership is up to date."), refreshed.url.href);
	check("a level Shopify removed shows under Before", /redeemid-member__past[^]*?data-redeemid-level="pro"/.test(refreshed.text));
	check("the removed level no longer opens Pro posts", !(await member.go("/posts/pro-only")).text.includes("PRO-BODY"));
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
