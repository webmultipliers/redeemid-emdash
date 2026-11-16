# Changelog

Every version of `@redeemid/emdash`. Each one is also a [GitHub release](https://github.com/webmultipliers/redeemid-emdash/releases) with its exact tarball and checksum, and the same version on npm.

RedeemID is pre-1.0, so any 0.0.x release can change things. Lines marked **Upgrade** need something from you when you update past that version, and **Security** marks a fix you should take. Everything else updates in place.

## Unreleased

## 0.0.38 (2026-11-16)

- Content lists in the admin get an **Access** column: who can read each entry, as **Free** or a badge with its levels, from the same rules the site enforces.
- A **product field widget** for any content type. Give a text field `"widget": "redeemid:product"` and editors search the store and pick a product. The field holds its handle.
- Product entries' own pages get Product structured data in `<EmDashHead>`, through EmDash's `page:metadata` hook, built only from Shopify's fields. Pass `schema={false}` to `<Product heading="h1">` on those pages so there's one product.
- A [Permissions and trust](docs/trust.md) guide: why RedeemID is native, its capabilities, every host it calls, what it keeps and for how long, and how to take it out. A SECURITY.md says how to report a problem.
- This changelog now lives in the repository and the npm package, with **Upgrade** and **Security** lines.
- Releases are staged on npm with provenance, so npm shows which workflow run built each version.

## 0.0.37 (2026-11-16)

- Products is now a sync screen. **Set up products** creates the products content type for you, so nobody edits a seed. Then tick the Shopify products to sync in a list you can search and page through, and press **Save**.
- Unticking a product, or **Stop syncing** on its row, moves its entry to the trash with its story kept. Ticking it again brings the same entry back.
- Clearer names: **Sync every product**, **Update synced products**, and **Automatic updates** for Shopify's product webhooks, with a plain message when the Admin API app lacks `read_products`.

## 0.0.36 (2026-11-16)

- **Upgrade:** the Members page is now Customers, at `/_emdash/admin/plugins/redeemid/customers`. Update any bookmarks or links to `/members`.
- Members is now **Customers**, since your site may call them something else. **Resync all** reads every customer from Shopify 25 at a time, paced and resumable, in place of "Resync 25". Products' Add all and Refresh all run the same way.
- A new **Resources** page collects the guides, references and Shopify screens. Overview links to it.
- Access: a code button on each level and feature opens its code in a dialog. The tabs are now Map, Levels, Features, Sitewide, Content types, Terms, Meter, Files, Test and Code settings, and going back to the code's setting lives only on Code settings.
- Connection is now Status (a card per step), Store (with each Admin API scope and whether it's granted), Environment and Webhooks. There's no webhook address to copy: RedeemID registers it itself.
- App events and webhook deliveries show 25 a page with Previous and Next.

## 0.0.35 (2026-11-15)

- Product entries. Keep the Shopify products your site uses, all of them or the ones you pick, as entries in a `products` collection your site defines. They're in EmDash's search, sitemap, menus and taxonomies, and editors can write a story around each one. Shopify's fields are copied from Shopify and put back if edited. A product Shopify stops selling goes to draft. See [Product entries](https://www.redeemid.com/docs/emdash-shop/#product-entries).
- A new Products page under **Plugins → RedeemID** searches the store, adds products one at a time or all of them 10 per click, refreshes the 10 read longest ago, and turns on Shopify's product webhooks. Those need the Admin API app's `read_products` scope.
- The Product block gets a picker that lists the product entries. You can still type any handle.
- `productSitemap()` takes `exclude`, so products that are already entries aren't listed twice. Developer API 1.6.0.

## 0.0.34 (2026-11-15)

- **Upgrade:** needs EmDash 1.5 or later (`emdash` and `@emdash-cms/blocks` `>=1.5.0`, `@cloudflare/kumo` `>=2.15.0`). On Workers, upgrade `emdash` and `@emdash-cms/cloudflare` together.
- Dialogs, such as Add a level, use EmDash 1.5's dialog design. On phones they open as a sheet from the bottom.
- EmDash's Plugins list shows the plugin as RedeemID, with a line about what it does.
- Overview has its own address, `/_emdash/admin/plugins/redeemid/overview`, so the sidebar highlights only the page you're on. The plugin's main address still opens Overview.
- Health points to Settings → Email (SMTP, new in EmDash 1.5) when no email provider is set up.

## 0.0.33 (2026-11-14)

- The Access map is a diagram of connected nodes instead of a table. Readers are on the left, what they get is on the right, and picking either lights up the lines between them.

## 0.0.32 (2026-11-14)

- Connection is now Status plus one tab per setup step (Store, Sign-in, Admin app, Webhooks, First level, Try it, Storefront), each with a check mark once done, instead of one long Setup tab. It opens on the next step to do.
- A new Events page holds webhook deliveries, app events and webhook health as tabs. Each tab of both pages has its own address.

## 0.0.31 (2026-11-14)

- **Upgrade:** `react`, `@cloudflare/kumo` and `@emdash-cms/blocks` are now peer dependencies. EmDash sites already have them; add them if your package manager complains.
- The admin is rebuilt. Overview comes first, then Members, Access, Reports, Privacy and Connection. Connection holds Status, Setup, Webhooks, Health and App events as tabs, and the old pages of those names are gone.
- Access opens on a Map of who gets what. Levels, features, term rules and protected folders are added and edited in dialogs. Level and feature tabs show the code a theme uses to check them. Access test is the Test tab.
- Member detail is split into Membership, Tags, Account and Privacy tabs. Status shows the addresses for Shopify as fields with copy buttons. The dashboard card has alerts, counts and links.
- The package now has an admin entry, `@redeemid/emdash/admin`, so `react`, `@cloudflare/kumo` and `@emdash-cms/blocks` are peer dependencies. Every EmDash site already has them.

## 0.0.30 (2026-11-13)

- The admin pages sit in one RedeemID folder under Plugins in EmDash's sidebar, instead of loose items among other plugins' pages.

## 0.0.29 (2026-11-13)

- Setup counts the Admin API app's customer scopes when Shopify reports only `write_customers`, and counts webhook topics set in the app's configuration once deliveries arrive, so those steps no longer stay at To do.

## 0.0.28 (2026-11-13)

- Works with the new [redirect theme](https://github.com/webmultipliers/redeemid-emdash-shopify-redirect-theme), a Shopify theme that sends the store's own pages to the site. A page that arrives with `?discount=CODE`, as Shopify's discount links do through the theme, puts the code on the visitor's cart, or keeps it for the first cart made for them.
- A page that arrives with `?logged_in=true` signs the visitor in without a form when they're signed in to the store. If the store session has ended, they stay signed out, with no notice. Both parameters come off the address before the page renders.

## 0.0.27 (2026-11-12)

- `cacheEntry()` accepts entries typed by `emdash types`. Before this, sites with generated collection types got an `astro check` error when they passed a typed entry. Nothing else changes.

## 0.0.26 (2026-11-12)

- Product pages in search. New `productSitemap()` in `@redeemid/emdash/catalog` answers a sitemap of every product the Headless channel sells, because EmDash's own sitemap lists content entries only. The shop guide now shows a product page that takes the product's SEO title and description and answers 404 for a product Shopify doesn't have. Developer API 1.5.0.

## 0.0.25 (2026-11-11)

- Safe route caching. New helpers in `@redeemid/emdash/cache`: `cacheEntry()` caches an entry's page only when it reads the same for everyone, and `cachePage()` caches lists. Use them in place of `Astro.cache.set()`. Saving on the Access page or an entry's Access panel now purges the pages they cached. Locked bodies, Members only parts, plan cards and member pages also keep themselves out of the route cache, even with route rules. The Status page lists templates that still set cache hints by hand on gated pages. Developer API 1.4.0.

## 0.0.24 (2026-11-11)

- **Upgrade:** levels picked on a Paywall break are ignored. Give the entry a rule (content type, terms or its Access panel) if a break used to carry the only levels.
- The Paywall break no longer has its own levels. It marks where the entry's rule starts: everyone reads up to it, and the rest follows the entry's rule from its content type, its terms or its Access panel. Levels an older break saved are ignored. Search snippets, protected files and the access badge follow the same rule, so they agree with the page. Members only blocks keep their own levels.

## 0.0.23 (2026-11-10)

- Levels can include other levels: Gold with Silver included reads everything for Silver, and rules name only the lowest level that may read. A level can also be several tag groups, such as "gold", or "silver" with "annual". Set both under **Access → Levels**: one group per line, `all:` before a line that needs every tag, and tick the included levels. Developer API 1.3.0 adds `topLevels`, `closure` and `simplify`.
- Plan cards fit the member: "You're on this plan", "Included in your Gold membership", Upgrade, Renew or Join. A level's Shopify products tell the card which levels a plan leads to.
- Each level can have a members' home, where its members land after signing in from the home page, and a badge colour for badges, the account box and the member card.
- Staff can link a customer to an existing site user whose email differs, or unlink them, on the member's page.
- `shop/redact` erases members a hundred at a time, so a large shop fits in one request on the Workers free plan. `customers/merge` reads the kept customer's tags at once when the Admin API app is set up. The Status page warns when the Admin API app is set up with a custom store domain, which the Admin API doesn't answer on.

## 0.0.22 (2026-11-10)

- EmDash's site search no longer shows locked text. For visitors and members, a result they can't read in full keeps its title but loses its snippet, and it only shows when its title matches the search, so a search can't reveal which locked entry holds a word. Signed-in members can now use site search too; it used to refuse them. A search page built on EmDash's `search()` can filter the same way with `readableResults()` from `@redeemid/emdash/search`. Developer API 1.2.0.
- A collection's teaser stops at a Members only part, so text inside one is never shown as teaser.
- Plan cards and Buy just this show the price in the visitor's market, the one checkout charges, when `market` is set.
- When Shopify deletes a customer, `member.levels_changed` reports their levels as removed.

## 0.0.21 (2026-11-10)

- Site code can import `siteConfig()` from `@redeemid/emdash/access`, to pass the site's config, with the admin's saved settings, to the storefront, catalog and preference calls. Developer API 1.1.0.
- The README and docs were checked against the code and corrected.

## 0.0.20 (2026-11-10)

- A Setup page in the admin walks through connecting a store, with this site's addresses filled in, the command for each secret, a Register button for the webhooks and a form for the first level. Each step checks the site as it is.
- If the saved access settings can't be read, the site keeps the ones it last read, and with none it locks every entry.
- A member's store sign-in is kept encrypted, disabled members are refused on every route, and product search is rate limited.
- The member card shows renewal, end and gift dates from `membership.*` customer metafields, and a lapsed member is offered Renew instead of Join.
- Outbound events go out after the response and are tried three times. Ones that still fail are kept under App events, where staff can send them again.
- The Status page names templates that render a locked collection's body with `<PortableText>`.
- A Shopify Flow guide with recipes for paid orders, refunds, cancelled subscriptions and passes that end.

## 0.0.19 (2026-11-10)

- **Security:** update if you use `files` on 0.0.10 to 0.0.18.
- Fixes two ways a protected file could be downloaded without access: a URL ending in a slash, and Astro's image route. Sites using `files` on 0.0.10 to 0.0.18 should update.

## 0.0.18 (2026-11-09)

- Members check out signed in, so orders land on their customer record.
- Product options, subscriptions and galleries, collection filters, sorting and pages, product search, recommendations, local prices and a cart drawer.
- A browser API, `window.redeemid`, with events for any analytics tool, JSON routes for state, the cart and search, and MCP tools that look up the catalog.

## 0.0.17 (2026-11-09)

- Access settings in the admin: levels, site rules, content types, taxonomies, features and protected folders, with an Access panel on each entry.
- Webhooks, App events and Reports pages, and a daily webhook health check with email warnings.

## 0.0.16 (2026-11-09)

- Optional rate limits on Sign in, Buy and cart changes on Cloudflare Workers.

## 0.0.15 (2026-11-09)

- When a store customer is refused (a staff email, or an account that's turned off), they're also signed out of the store, so the next Sign in asks for an email again.
- Registering webhooks from the Status page carries on past a topic Shopify refuses and names the scope it needs.

## 0.0.14 (2026-11-09)

- Pages for signed-in members and visitors with a cart stay out of Astro's route cache as well as the browser's.
- Bulk resync reads 25 members a run, which fits the Workers Free limit on database queries.
- Locked entry pages carry `isAccessibleForFree: false` paywall markup for search engines.

## 0.0.12 (2026-11-09)

- The Status page lists any `REDEEMID_` setting that is set but not read, by name only, so a misnamed secret is easy to spot.

## 0.0.11 (2026-11-09)

- Privacy requests: members download or delete their data with a `<YourData>` form. Staff export or delete a member, or ask Shopify to erase them, from the admin, and a Privacy page lists every request. Shopify's privacy webhooks are handled, and a `member.erased` event says when a member's data is deleted.
- AI agents and the command line: staff ask the same questions the admin answers, such as whether a reader can read an entry, through EmDash's MCP server or the `redeemid-emdash` command. They're read-only unless `agents.actions` is on, which adds resyncs and tag edits written to Shopify.
- Sell one entry on its own: a Sold on its own block names a tag and a Shopify product. Members holding the tag read the whole entry, and the wall offers the product to everyone else.

## 0.0.10 (2026-11-09)

- Member preferences: members see and change customer fields you define in Shopify, with a `<Preferences>` form or its block. Answers are saved on the Shopify customer, and the `preferences.saved` event names the fields changed, never the answers.
- Protected files: uploads in a media folder named in `files` reach only the levels or features its rule names, or whoever can read an entry that uses the file. Every download is checked, and allowed ones are never cached.
- Replacement text: put any string members and visitors see in your own words, one string at a time, with `text`. A replacement that uses a placeholder its original lacks is ignored and listed on the Status page.

## 0.0.9 (2026-11-09)

- Staff tools in the admin. Open a member to resync them from Shopify or to add and remove tags, which are written to Shopify and read back. A bulk resync reads the 50 members synced longest ago each time staff run it.
- The Status page lists the store's webhook subscriptions and registers missing ones, and shows recent deliveries. A new Access test page shows what an entry needs and whether a reader with some tags gets in.
- Member features from levels or tags, with a `<Feature>` component, shown on the member card.
- Signed event webhooks: `member.signed_in`, `member.levels_changed`, `meter.used` and `meter.exhausted`. No event carries an email address.

## 0.0.8 (2026-11-08)

- Product pages, collection grids, a cart page with quantities and discount codes, and pay-what-you-want contributions, each with an editor block. A cart notes the page its first item was added on.

## 0.0.7 (2026-11-08)

- The member account card: levels with when each started, past levels, meter use, and Refresh membership. Plan cards tell members which plan they're on.

## 0.0.6 (2026-11-08)

- The meter and drip. A rule can opt out of the meter.

## 0.0.5 (2026-11-08)

- Members only blocks for a members part in the middle of a body. The wall names each level's offer and links to joining, and sign-in, cart and account messages show on the page they return to. Leak tests cover EmDash's content and search APIs, feeds and sitemaps.

## 0.0.4 (2026-11-08)

- Several matching term rules must all pass, rules cover child terms, terms can open entries to everyone, and there's a site default and a built-in signed-in level. Teasers and access badges.

## 0.0.3 (2026-11-08)

- Sign-in works on Cloudflare Workers. The Shopify cart, checkout and account link, the admin's Members and Status pages, and the Paywall break and Plan blocks.

## 0.0.2 (2026-11-08)

- First release: sign-in with the Shopify customer account, the tag mirror, webhooks, levels and rules.
