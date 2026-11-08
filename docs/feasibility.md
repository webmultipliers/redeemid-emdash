# Feasibility findings

The five questions from the plan, answered against EmDash 1.4.0 (`emdash-cms/emdash` at dbcf9f4) on 2026-11-08. "Tested" means the end-to-end run (`pnpm e2e`): the playground EmDash site on Node with SQLite, against a fake Shopify store that speaks OIDC, PKCE, JWKS and the Customer Account API.

## 1. Can members sign in from the public site? Yes (tested)

An EmDash auth provider can inject its own Astro routes. RedeemID's login and callback routes run the customer account sign-in, link or create an EmDash user with the Subscriber role through `findOrCreateOAuthUser`, set the Astro session and send the member back to the page they came from. Members never touch the `/_emdash` login page. The provider has no `adminEntry`, so no store button appears on the staff login page.

Guards added on the way:

- EmDash's helper links an existing user by verified email. Without a guard, a store customer with a staff email would sign into the staff account. The callback refuses any user above Subscriber (`staff_account`), tested.
- EmDash lets a provider create the first, admin user. The callback refuses until setup is finished.
- Sign-out is POST only, and ends the store session through its end-session endpoint.

## 2. Can page code read the member mirror? Yes, with one workaround (tested)

Plugin storage has no public API for page code, but auth-provider storage does (`getAuthProviderStorage`). The mirror lives there, under `auth:redeemid`, so the callback, the webhook route and templates share it.

The workaround: on EmDash's anonymous fast path `locals.emdash` carries no config or database. Visitor checks read the rules from EmDash's `virtual:emdash/config` module instead. That module is internal, so an EmDash upgrade could move it. Worth asking upstream for a public way to read provider config.

## 3. Shopify webhooks on EmDash? Yes (tested on Node)

The webhook is a provider route, so it gets the raw body: HMAC-SHA256 over the exact bytes with WebCrypto, duplicate deliveries dropped with an atomic create-if-absent on the event ID, and a storage failure answers 500 and releases the event ID so Shopify retries. Out-of-order profile and status webhooks are dropped by `updated_at`. Not yet measured: response time on Workers against Shopify's 5-second limit.

## 4. A gate block in the editor? Partly: a marker, not a wrapper

Plugin Portable Text blocks are a Block Kit form (scalar fields) with an Astro renderer. They can't hold nested rich text, so a block that wraps locked content isn't possible. A "paywall break" marker is: everything after it is locked. Registering it needs a native `definePlugin` with a Portable Text block and an Astro component. Not built in this PR.

## 5. Does the native package need Workers Paid? No, by design (not deployed)

Native plugins run in the site process; only sandboxed plugins need the Worker Loader binding. The package uses Web APIs, `jose`, and `process.env` (on Workers that needs `nodejs_compat`, which EmDash's Cloudflare templates enable). Not deployed to Workers yet.

## Found on the way: members could read every post through EmDash's API (fixed, tested)

EmDash's Subscriber role holds `content:read`, so any signed-in member could fetch every published body from `/_emdash/api/content/...`, whatever their level. The e2e probe showed a Member-level account reading the Pro post's body there. `redeemidGuard()` adds an Astro middleware, after EmDash's auth, that refuses Subscribers on every `/_emdash` path except sign-in, sign-out, media files, comments and plugin routes, and sends them home from `/_emdash/admin`. Staff are unaffected. Sites can allow more paths with `memberPaths`.

This guard is also why members are best kept as Subscribers rather than given any higher role.

## Still to do

- A live run against the demo store (needs a Headless customer account client for a test site).
- Workers deploy and webhook timing.
- Admin pages (member list, health, manual paced resync), MCP tools, privacy export and erase.
- Paywall-break block, plan cards, buy buttons and cart from the Storefront API.
- Re-reading tags from the Admin API on `customer.tags_*` events (the WordPress plugin does this when an Admin token is set; here the event's tags are applied directly).
