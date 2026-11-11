# Running in production

## Caching

`redeemidGuard()` keeps every page private for a signed-in visitor or a visitor with a cart: `Cache-Control: private, no-store`, and out of Astro's route cache (it calls `cache.set(false)` after the page sets its own hint). Other visitors all get the same page, so their pages stay cacheable.

A route cache keys pages by URL alone and serves stored pages without running any code. If you turn on Astro's route cache, don't cache pages that render `<Content>` or `<Gate>` for locked entries, or a member would get the visitor's copy, wall included. Call `Astro.cache.set(hint)` only on pages whose entries no rule covers. Saving on the Access page or an entry's Access panel doesn't purge the route cache either, so a page cached before the change keeps its old copy until it expires.

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
