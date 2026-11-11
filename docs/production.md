# Running in production

## Caching

`redeemidGuard()` keeps every page private for a signed-in visitor or a visitor with a cart: `Cache-Control: private, no-store`, and out of Astro's route cache (it calls `cache.set(false)` after the page sets its own hint). Other visitors all get the same page, so their pages stay cacheable.

Astro's route cache keys pages by URL and serves a stored page without running any code, so whoever asks next gets the same copy. Don't call `Astro.cache.set()` yourself on pages that show entries. Use RedeemID's helpers in the page's frontmatter instead:

```astro
---
import { getEmDashEntry, getEmDashCollection } from "emdash";
import { cacheEntry, cachePage } from "@redeemid/emdash/cache";

// An entry's page: cached only when it reads the same for everyone.
const { entry: post, cacheHint } = await getEmDashEntry("posts", slug);
await cacheEntry(Astro, "posts", post, cacheHint);

// A list, or any page without a gated body.
const { entries, cacheHint: listHint } = await getEmDashCollection("posts");
cachePage(Astro, listHint);
---
```

- **`cacheEntry(Astro, collection, entry, cacheHint)`** caches the page only when no rule covers the entry (content type, terms or its Access panel), it isn't free just until a date, and its body has no Members only part, Sold on its own, Plan or Preferences block. Any other page stays out of the route cache, even if a layout sets a hint afterwards: `redeemidGuard()` takes it out again once the page has rendered. It returns whether the page was cached. `Cache-Control` is left as it was, since a visitor's copy is the same for every visitor.
- **`cachePage(Astro, cacheHint)`** caches a page as the hint says. Use it for lists and pages that show no gated body.
- **`noRouteCache(Astro)`** keeps any page out of the route cache.

RedeemID's own components also keep their page out when what they show depends on the reader, so a route rule (`routeRules` in `astro.config.mjs`) or an old `Astro.cache.set()` can't store one reader's copy: `<Content>` for a locked entry, a Members only part, a Sold on its own block or a free-until window; `<Gate>` with a rule; `<Plan>`; `<MemberCard>`, `<Preferences>` and `<YourData>`. `<AccessBadge>` and `<Account>` don't, so lists and other pages stay cacheable; on a cached page a member sees the visitor's badges and header. Still use the helpers in page frontmatter: they decide before anything renders, and they tag the page for purging.

Both caching helpers add the tag `redeemid` (`CACHE_TAG`). Saving on the Access page or an entry's Access panel purges that tag, so cached pages follow the new rules at once. EmDash purges an entry's own pages when the entry is saved. A page cached by a route rule alone has no `redeemid` tag; add it to the rule (`routeRules: { "/posts/[slug]": { maxAge: 300, tags: ["redeemid"] } }`). A deploy that changes the rules in `astro.config.mjs` purges nothing: purge the tag with your cache provider, or wait for `maxAge`.

A cached page is the same for everyone, signed-in members included, since nothing runs on a hit. Keep member-aware parts of cached pages, such as the header's Account link or a cart count, in the browser with [`window.redeemid`](developer-api.md), or leave those pages out of the cache.

The Status page lists templates that call `Astro.cache.set()` on pages of a gated collection.

## Rate limits

On Cloudflare Workers, `redeemidGuard({ rateLimit: true })` limits how often one visitor can start Sign in, Buy, a cart change or a catalog search (`api/search`), the routes that call Shopify. Add a [Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) named `REDEEMID_RATE_LIMIT`, which sets the limit and period:

```jsonc
"ratelimits": [{ "name": "REDEEMID_RATE_LIMIT", "namespace_id": "1001", "simple": { "limit": 20, "period": 60 } }]
```

Each action counts separately per visitor (by `CF-Connecting-IP`), and Cloudflare's count is approximate. A visitor over the limit goes back to their page with the `too_many_requests` notice; the JSON routes answer `429` with `{ "error": "too_many_requests" }`. If the binding is missing or fails, nothing is limited. Off by default; leave it off on Node.

## Troubleshooting

- **A setting shows Missing on the Status page.** Check the name: the Status page lists any `REDEEMID_` variable it doesn't read. Set it as a runtime secret, not a build variable. On Workers, a deploy can remove plain-text dashboard variables, so use encrypted secrets.
- **Sign-in comes back with a notice.** The code says why; see [notices](reference.md#notices). `sign_in_unavailable` means store discovery failed, usually a wrong `shop`. `not_configured` means the client ID or `shop` is missing.
- **Register webhooks names a refused topic.** The app lacks a scope, such as `read_customer_merge` for `customers/merge`. Add it to the app, have the store accept the new version, and press Register again.
- **Tags changed in Shopify but the site didn't follow.** Check Webhooks → Received and Health, and App events with Problems only. Resync the member from their page, or ask them to press Refresh membership.
- **A member sees the visitor's page.** A cache is serving it. See [caching](#caching).
