# Connect a store

What to set up in Shopify, and on the site, to run RedeemID on an EmDash site. One store can serve a WordPress site and an EmDash site at the same time: each site gets its own Headless storefront for sign-in, and both receive webhooks.

## 1. Sign-in: a Headless storefront

1. In Shopify admin, open **Sales channels → Headless** (add the channel if it isn't there) and **Create storefront**. Name it after the site, for example "EmDash demo".
2. Open the storefront's **Customer Account API** settings.
3. Set **Client type** to **Confidential**.
4. Under **Application setup**, add:
   - **Callback URI:** `https://<site>/_emdash/api/auth/redeemid/callback`
   - **Logout URI:** `https://<site>/` (members land here after signing out)
   - JavaScript origins: none needed. Sign-in runs on the server.
5. Copy the **Client ID** and **Client secret**.

Shopify only accepts `https` callback URIs, so a local `astro dev` site needs a tunnel (for example `cloudflared tunnel`) to sign in for real. The end-to-end test uses a fake store instead.

The store must use the new customer accounts (Settings → Customer accounts). Classic accounts have no Customer Account API.

## 2. Webhooks

RedeemID keeps tags and status current from webhooks. Point these topics at `https://<site>/_emdash/api/auth/redeemid/webhook`:

`customers/create`, `customers/update`, `customers/delete`, `customers/disable`, `customers/enable`, `customers/merge`, `customer.tags_added`, `customer.tags_removed`, `customers/redact`

Subscribe them from the same Shopify app the WordPress site already uses (Dev Dashboard app with an Admin API token). Add the EmDash URL as extra subscriptions; the WordPress ones stay as they are. `customers/merge` needs the `read_customer_merge` scope. Shopify signs every webhook with that app's **client secret**, which is the site's webhook secret.

## 3. The site

Add the package and config as in the [README](../README.md#install), with `shop` set to the store's domain. A custom customer-account domain works as well as `*.myshopify.com`.

Set three secrets. On Cloudflare Workers:

```sh
npx wrangler secret put REDEEMID_CLIENT_ID       # Headless storefront client ID
npx wrangler secret put REDEEMID_CLIENT_SECRET   # Headless storefront client secret
npx wrangler secret put REDEEMID_WEBHOOK_SECRET  # the webhook app's client secret
```

The Workers free plan is enough: RedeemID is a native plugin and doesn't need sandboxing. Worker secrets reach the code through `nodejs_compat`, which EmDash's Cloudflare templates turn on.

## 4. Try it

1. Finish EmDash setup as staff first. Store customers can't create the first account.
2. Tag a test customer in Shopify (for example `member`) and visit a locked post.
3. Click **Sign in**, sign in with that customer's email, and you come back to the post, unlocked.
4. Add or remove the tag in Shopify; the post opens or locks again once the webhook arrives.

If sign-in sends you back with `?redeemid_notice=…`, the code says why: `not_configured` (secrets or `shop` missing), `sign_in_unavailable` (store discovery failed), `sign_in_expired`, `staff_account`, `site_not_ready`, `email_required`, `token_failed`, `bad_id_token`, `identity_failed`.
