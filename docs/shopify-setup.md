# Connect a store

What to set up in Shopify, and on the site, to run RedeemID on an EmDash site. One store can serve a WordPress site and an EmDash site at the same time: each site gets its own Headless storefront for sign-in, and both receive webhooks.

## 1. Sign-in: a Headless storefront

1. In Shopify admin, open **Sales channels → Headless** (add the channel if it isn't there) and **Create storefront**. Name it after the site, for example "EmDash demo".
2. Open the storefront's **Customer Account API** settings.
3. Pick a **Client type**. Both work, because sign-in runs on the server with PKCE either way:
   - **Confidential** gives a client secret, which the site sends with the token request.
   - **Public** has no secret. Shopify checks the request's origin instead, so register the site as a JavaScript origin.
4. Under **Application setup**, add:
   - **Callback URI:** `https://<site>/_emdash/api/auth/redeemid/callback`
   - **JavaScript origin:** `https://<site>` (public clients)
   - **Logout URI:** `https://<site>/` (members land here after signing out)
5. Copy the **Client ID**, and the **Client secret** if the client is confidential.

The Authorization, Token and Logout endpoints Shopify lists need no setting: RedeemID reads them from the store's discovery documents, and they already follow a custom customer-account domain.

Shopify only accepts `https` callback URIs, so a local `astro dev` site needs a tunnel (for example `cloudflared tunnel`) to sign in for real. The end-to-end test uses a fake store instead.

The store must use the new customer accounts (Settings → Customer accounts). Classic accounts have no Customer Account API.

## 2. Webhooks

RedeemID keeps tags and status current from webhooks. Point these topics at `https://<site>/_emdash/api/auth/redeemid/webhook`:

`customers/create`, `customers/update`, `customers/delete`, `customers/disable`, `customers/enable`, `customers/merge`, `customer.tags_added`, `customer.tags_removed`, `customers/redact`

Subscribe them from the same Shopify app the WordPress site already uses (Dev Dashboard app with an Admin API token). Add the EmDash URL as extra subscriptions; the WordPress ones stay as they are. `customers/merge` needs the `read_customer_merge` scope. Shopify signs every webhook with that app's **client secret**, which is the site's webhook secret.

## 3. The site

Add the package and config as in the [README](../README.md#install), with `shop` set to the store's domain. A custom customer-account domain works as well as `*.myshopify.com`.

Set the secrets. On Cloudflare Workers:

```sh
npx wrangler secret put REDEEMID_SHOPIFY_STORE_DOMAIN                   # e.g. my-store.myshopify.com, unless `shop` is in the config
npx wrangler secret put REDEEMID_SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID     # Customer Account API client ID
npx wrangler secret put REDEEMID_SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_SECRET # confidential clients only
npx wrangler secret put REDEEMID_SHOPIFY_ADMIN_APP_CLIENT_SECRET        # the webhook app's client secret
```

The Workers free plan is enough: RedeemID is a native plugin and doesn't need sandboxing. Worker secrets reach the code through `nodejs_compat`, which EmDash's Cloudflare templates turn on.

## 4. Try it

1. Finish EmDash setup as staff first. Store customers can't create the first account.
2. Tag a test customer in Shopify (for example `member`) and visit a locked post.
3. Click **Sign in**, sign in with that customer's email, and you come back to the post, unlocked.
4. Add or remove the tag in Shopify; the post opens or locks again once the webhook arrives.

If sign-in sends you back with `?redeemid_notice=…`, the code says why: `not_configured` (secrets or `shop` missing), `sign_in_unavailable` (store discovery failed), `sign_in_expired`, `staff_account`, `site_not_ready`, `email_required`, `token_failed`, `bad_id_token`, `identity_failed`.
