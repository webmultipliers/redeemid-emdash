# Security policy

## Reporting a problem

Please report security problems privately, not in a public issue or pull request:

1. Open [a new security advisory](https://github.com/webmultipliers/redeemid-emdash/security/advisories/new) on this repository (the **Security** tab, then **Report a vulnerability**).
2. Say which version you tested, what you did, and what a reader, member or visitor could see or do that they shouldn't.

You'll get an answer on the advisory. Once a fix is out, the advisory is published with credit to you, unless you'd rather not be named.

## Supported versions

RedeemID is pre-1.0. Only the latest release on npm gets fixes, so the fix for a problem is always a new 0.0.x version. Each release notes security fixes in [CHANGELOG.md](CHANGELOG.md) with a **Security** line naming the versions affected.

## What counts

Anything that breaks one of the [guarantees](README.md#guarantees) is a security problem. For example:

- a reader getting locked text, files or search snippets their levels don't open;
- access, a level or a feature that comes from anywhere but the customer's Shopify tags;
- a webhook, sign-in or checkout request accepted without the right signature or session;
- a secret, token, email address or other personal data in a log, an event, a page or an API answer it shouldn't be in;
- a store customer signing in as staff, or a staff account being reached through the store.

Problems in EmDash itself go to [EmDash's security policy](https://github.com/emdash-cms/emdash/blob/main/SECURITY.md), and problems in Shopify to [Shopify's bug bounty](https://hackerone.com/shopify).

## How RedeemID runs

RedeemID is a native EmDash plugin, so it runs inside your site with the same access as your own code. [Permissions and trust](docs/trust.md) lists what it reads and writes, the hosts it calls and the data it keeps.
