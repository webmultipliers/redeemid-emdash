# Staff tools, webhooks and privacy

## Staff tools

With `REDEEMID_SHOPIFY_ADMIN_APP_CLIENT_ID` set, RedeemID gets an Admin API token for the webhook app with the client credentials grant. The app must be in the same Shopify organization as the store, as Dev Dashboard apps are, and needs `read_customers` and `write_customers`. Then, under **Plugins → RedeemID**:

- **Member detail.** Levels, tags and features; resync from Shopify; add and remove tags. Tag edits are made in Shopify and read back. Nothing is granted on the site.
- **Site user.** Signing in links a customer to the site user with the same verified email. When the emails differ, staff link the customer to an existing Subscriber by that user's email on the member's page (never a staff account, never a user linked to another customer), or unlink them. This part needs no Admin API app.
- **Bulk resync.** Reads the 25 members synced longest ago, few enough for the Workers free limit of 50 database queries a request. Press it again for the next 25. It never runs on its own.
- **Webhook subscriptions.** Webhooks → Setup lists the store's subscriptions to this site and registers any that are missing. A topic Shopify refuses, such as `customers/merge` without `read_customer_merge`, is named with the reason and doesn't stop the others. `customers/redact` stays in the app's own settings.
- **Access test.** A collection, an entry, terms and a reader's tags in; the verdict out.

Resync updates email, name, tags, email marketing consent and the membership dates. Enabled or disabled status comes only from the enable and disable webhooks. With the app set up, two more things read the customer from the Admin API as it is now: every sign-in (and Refresh membership), and every `customer.tags_added` or `customer.tags_removed` webhook. Those topics carry only the change and can arrive out of order, so reading the current tags keeps the mirror right. Without the app, or when the read fails, the webhook's change is applied as sent.

### Membership dates

A subscription app or Shopify Flow can keep these customer metafields, as dates (`YYYY-MM-DD`):

| Metafield | Shown |
| --- | --- |
| `membership.member_since` | As the start date on the member card, in place of when the tag arrived |
| `membership.renews_on` | "Renews on ..." |
| `membership.ends_on` | "Ends on ...", for a pass that doesn't renew |
| `membership.gift_until` | "Gift membership until ...", while it's in the future |

RedeemID reads them with the Admin API (resync, sign-in, tag webhooks), so they need the Admin API app. They're for display only: access still comes from tags alone, and nothing on the site ends access on these dates. Time-boxed access is a Flow that waits and removes the tag (see [Shopify Flow recipes](shopify-flow.md)).

## Webhooks, app events and reports

Members gain and lose access only when Shopify sends tag changes, so RedeemID shows what arrived and warns when deliveries stop.

- **Webhooks → Received.** Each delivery's topic, what became of it (processed, skipped, older than what's stored, not used) and the customer ID, with counts of deliveries turned away (bad signature) and failed (storage errors; Shopify sends those again).
- **Webhooks → Health.** Once a day RedeemID registers again any subscription Shopify dropped (with the Admin API app), and warns when no webhook has come in for a number of days (3 by default, 0 turns it off), or when deliveries were turned away or failed in the last day. **Check now** runs it at once. Warnings show on the page and the dashboard widget. If you enter an address on the Health tab and the site has an EmDash email provider, they also go by email: once when problems start or change, then once a week while they last.
- **Webhooks → Setup.** The endpoint, whether signatures can be checked, and the subscriptions.
- **App events.** What RedeemID did and what came of it: webhooks received, turned away and failed, sign-ins and refusals (by reason), Admin API calls (by operation, with timings), resyncs, tag edits, webhook registrations, settings saves, outbound events that failed, metered reads and the health checks. Filter by event or show problems only. Entries hold ids, labels and outcomes, never bodies, tokens or emails. Failed outbound events also keep the event body (ids and levels, never an email or a name) so they can be sent again.
- **Reports.** Members on each level, who joined and left in the last 30 days and by week for 12 weeks (from each member's tag dates), sign-ins and metered reads.

App events and delivery records are kept 30 days. The daily check runs from EmDash's scheduler: on Node it runs by itself; on Cloudflare Workers, add a Cron Trigger to the site's Worker as EmDash's deployment guide describes. The plugin asks for `email:send` only to send these warnings.

## AI agents and the command line

Staff questions as data, for AI agents and scripts. Every one needs an administrator, reads what the site has synced, and never grants access, edits a rule or returns a secret.

| MCP tool | Command | What it answers |
| --- | --- | --- |
| `explain_access` | `access <collection>` | Can this reader read this entry, and why. Give the entry by `id` or `terms`, and the reader by `tags`, `customerId` or `signedIn: false`. |
| `list_levels` | `levels` | Every level, its tag groups, the levels it includes, wall text and join link |
| `get_rules` | `rules` | How rules combine, every rule, the meter, teasers, features and file rules |
| `get_member` | `member <id or email>` | One member: status, tags, levels with start dates, past levels, features, last sync |
| `site_health` | `health` | Each setting (set or not, never a value), the last webhook, open privacy requests, ignored text replacements |
| `level_changes` | `changes --since <date>` | Who joined or left a level since a date |
| `find_products` | `products <words>` | Search the Shopify catalog: handles, titles, prices, stock |
| `get_product` | `product <handle>` | One product: options, variants, prices, selling plans |
| `get_collection` | `collection <handle>` | One collection: its products and the filters Shopify offers |

With `agents: { actions: true }`, three actions are offered too: `resync_member` (`resync <customer id>`), `resync_batch` (`resync-batch`, 25 members) and `edit_member_tags` (`tags <customer id> --add a,b --remove c`, marked destructive for agents).

**Agents** use EmDash's MCP server at `/_emdash/api/mcp` with an API token that has the `mcp:tools` or `mcp:tools:redeemid` scope. The tools stay off until an administrator turns them on for RedeemID under **Plugins**, and a release that changes the list needs approving again. Names carry the prefix, such as `redeemid__explain_access`.

**The command line** signs in the way EmDash's CLI does: `--token`, `EMDASH_TOKEN`, or the token `emdash login` saved. The site comes from `--url` or `EMDASH_URL`. Output is JSON.

```sh
npx -p @redeemid/emdash redeemid-emdash access posts --id my-story --tags gold-member --url https://example.com
npx -p @redeemid/emdash redeemid-emdash member jane@example.com
```

Each command POSTs JSON to a staff-only route under `/_emdash/api/plugins/redeemid/`, named after its tool with hyphens (`explain_access` is `explain-access`). Scripts can call those routes directly.

## Privacy requests

What RedeemID keeps about a member: the synced record (Shopify customer ID, email, name, tags and when each started, account status, first sign-in, last sync, whether the email was verified, email and SMS marketing consent, and the membership dates) and their meter. Preference answers stay on the Shopify customer, and webhook deliveries keep only a topic and a time. Erasing on the site never erases Shopify data; it can only ask Shopify to.

| Started by | What happens |
| --- | --- |
| A member, with `<YourData>` | **Download my data** returns their record and meter as JSON. **Delete my data** needs a ticked box, erases both, and signs them out. |
| Staff, on a member's page | **Export data**, **Erase site data**, and **Also request erasure in Shopify** (orders included, after Shopify's wait; **Cancel the Shopify erasure** withdraws it). The Shopify request needs the `write_customer_data_erasure` scope. |
| Shopify `customers/data_request` | An open request on the **Privacy** page. Press **Export and mark done**, then send the export to the store owner. |
| Shopify `customers/redact` | The member's record and meter are erased. |
| Shopify `shop/redact` | Every member record and meter is erased, a hundred at a time, so even a large shop fits in one request on the Workers Free plan. |

The Privacy page shows each request's source and Shopify customer ID, never an email or a name. The daily check deletes finished requests after a year; open ones stay until staff mark them done. An erase sends the `member.erased` event so a CRM can delete its copy too. The site's own user account stays; delete it under Users if the person asks. The JSON route is `/_emdash/api/auth/redeemid/privacy`: `GET` downloads, `POST` with `confirm=yes` erases, only for the signed-in member and only from the site's own origin.
