# Access: levels, rules and the meter

Who reads what. Shopify decides who holds which tags; everything here only says what each tag opens.

## Rules

Each rule names a collection and the levels, any of which may read. An empty `levels` list, or the built-in `signed-in` level, means any signed-in member.

| Rule | Covers |
| --- | --- |
| `{ collection: "reports", levels: ["gold"] }` | Every entry in the collection |
| `{ collection: "posts", taxonomy: "category", term: "investigations", levels: ["gold"] }` | Entries with that term, or a child of it in a hierarchical taxonomy. A child's own rule wins over its parent's. |
| `{ collection: "posts", taxonomy: "tag", term: "free-to-read", levels: [], open: true }` | Opens entries with that term to everyone, whatever else covers them |
| `{ collection: "pages", levels: [], open: true }` | Opens a whole collection to everyone, unless a term rule locks an entry |
| `{ collection: "*", taxonomy: "category", term: "members", levels: ["member"] }` | That term in every collection, new ones included. A rule for the same term and a named collection wins there. |
| `{ collection: "*", levels: [] }` | The site default, for collections with no rule of their own |
| `{ collection: "posts", taxonomy: "category", term: "archive", levels: ["member"], drip: 30 }` | Drip: members read these entries 30 days after their level started |
| `{ collection: "posts", taxonomy: "category", term: "exclusive", levels: ["pro"], meter: false }` | The meter never opens these entries |

Term rules beat the collection's rule, which beats the site default. When several term rules cover one entry (a story in Investigations, which needs Gold, and Culture, which needs Silver), readers must pass every one of them, so only members with both read it. Set `combine: "any"` to let one be enough.

## Levels

A level is a name for customers who hold some Shopify tags. `tags` is one group: any one of them grants the level, or every one with `match: "all"`. `groups` adds more groups, and any one group is enough:

```js
levels: [
	{ slug: "silver", name: "Silver", tags: ["silver"] },
	// "gold", or "silver" with "annual".
	{ slug: "gold", name: "Gold", tags: ["gold"], groups: [{ tags: ["silver", "annual"], match: "all" }], includes: ["silver"] },
],
```

`includes` lists levels this one also opens: Gold members read everything for Silver, and inclusion carries on (Gold includes Silver includes Members). So a rule names only the lowest level that may read, and an entry that needs Silver and Gold needs Gold once. Members hold the levels their tags grant and every level those include; the account box and member card show only the top one ("Gold", not "Gold, Silver"), and `member.levels_changed` lists them all.

The rest of a level is how it looks and where it leads:

| Key | What it does |
| --- | --- |
| `wall` | What the wall says to readers this level would let in |
| `joinUrl` | Where the wall's join link goes for this level (else `join.href`) |
| `products` | Handles of the Shopify products whose purchase leads to the level. Display only: plan cards use it (see [`<Plan>`](content.md)). It grants nothing. |
| `home` | Members' home: the same-site path a member lands on after signing in from the home page or a plain sign-in link (their top level's, in level order). Signing in from an entry returns them to it. |
| `badge` | A hex colour, set as `--redeemid-level-color` on badges, the account box and the member card. Badges always show the name too. |

## Access settings in the admin

Everything about who reads what can be set in the EmDash admin, so a new content type, taxonomy or level never needs a code change. Under **Plugins → RedeemID → Access**:

- **Levels.** Add, rename and remove levels and the Shopify tags that grant them: one group per line, commas between tags, and `all:` before a line that needs every tag on it. Tick the levels each one includes, and set its plan products, members' home and badge colour. Name them anything; the slug is made from the name. A level that rules, features or folders still use can't be removed; removing one drops it from other levels' includes.
- **Site rules.** The site default, how term rules combine, the meter and the wall's join link.
- **Content types.** Who can read each collection, with drip, the meter and the teaser. Every collection on the site is listed, including ones made after RedeemID was set up.
- **Taxonomies.** Rules for terms in every taxonomy, for one collection or every collection the taxonomy is on.
- **Features** and **Protected files.**

The first save of a setting copies its value from your code config, so nothing is lost, and from then on the admin's value is used. **Use the code's setting** removes the admin's copy. Saved settings are kept in the site's database. Each server keeps the last ones it read and checks one small record per request to see whether anyone saved since, so the whole set is read again only after a save. If the database can't be read, the settings last read stand; a server that has read none yet locks every entry (and refuses files in any media folder) until it can, rather than falling back to the code's settings and opening what the admin locked.

Each saved entry also gets an **Access** panel in the editor. It shows who can read the entry right now and which rule says so, and sets the entry's own rule:

| Choice | Readers need |
| --- | --- |
| Follow the site rules | What the rules say (the default) |
| Free to everyone | Nothing |
| Only some levels | One of the levels ticked (none ticked: any signed-in member) |
| Site rules plus a level | What the rules say and one of the levels ticked |

The panel can also hold the entry back for some days of membership, keep the meter off it, lock it until a date and then open it, or keep it free until a date and then lock it. Pass the entry's `id` (or slug) to `<Content>`, `<AccessBadge>` and `<Gate>` so its own rule applies there.

Moving an entry to the trash keeps its rule for a restore but frees its slug, so a new entry that takes the slug doesn't inherit the rule.

## Meter and drip

```ts
meter: { limit: 3, period: "month", collections: ["posts"] },
teaser: { posts: 40 },
```

The meter lets a signed-in reader open a locked entry anyway, `limit` entries per `period` (`"month"`, the default, or `"week"`, in UTC). Each entry counts once per period, when its own page renders through `<Content>` with an `id`. Lists, feeds, search and the content API never count. Visitors get the wall and a nudge to sign in. While it runs, `<Content>` says how many free reads are left, and when it runs out the wall says so. Rules with `meter: false` are never metered, and the meter never opens an entry a member is waiting on by drip.

Drip holds a rule's entries back from members who pass it until they've held their level for `drip` days. A level starts when the customer first had a tag of its group (for a `match: "all"` group, the last of its tags); a level held through another's `includes` starts with that one. With several levels the earliest counts, and with none known, the first sign-in. RedeemID notes when each tag first arrives and forgets it when Shopify removes it. The wall shows the date the entry opens.

## Selling one entry on its own

Add the **Sold on its own** block anywhere in an entry's body. Give it the Shopify customer tag buyers get, such as `item-big-story`, and the product that sells it (its handle, or a link to it). Then:

- A reader holding that tag reads the whole entry. Its rule, Paywall break, Members only parts and drip don't apply, and the meter isn't used.
- Locked readers see **Buy just this** on the wall with the product's price, beside the level's offer.
- `<AccessBadge>` drops the lock for buyers, and protected files in an `entries: true` folder that the entry uses reach them too.

Shopify adds the tag when the order is paid, usually with a Flow workflow (Order paid → the line item is that product → add the customer tag). A refund workflow that removes the tag takes the entry away again.

## Features

```ts
features: [
	{ slug: "ad-free", name: "Ad-free", levels: ["gold", "premium"] },
	{ slug: "supporter", name: "Supporter", tags: ["supporter"] },
],
```

A member holds a feature through any of its levels or tags. `<MemberCard>` lists them under the member's levels.

```astro
---
import Feature from "@redeemid/emdash/components/Feature.astro";
import { hasFeature } from "@redeemid/emdash/features";
---
<Feature slug="supporter"><p>Thanks for your support.</p><p slot="else">Become a supporter.</p></Feature>
{!(await hasFeature(Astro, "ad-free")) && <aside class="ad">…</aside>}
```

## Protected files

```ts
files: [
	{ folder: "Gold downloads", levels: ["gold"] },
	{ folder: "Member downloads", levels: [] },             // any signed-in member
	{ folder: "Supporter extras", features: ["supporter"] },
	{ folder: "Story files", entries: true },               // whoever can read an entry that uses it
],
```

Upload files into a folder in the EmDash media library (names match without regard to case). Every request for one at `/_emdash/api/media/file/…` is checked before EmDash serves it:

- **Allowed:** the file, with `Cache-Control: private, no-store`.
- **Signed out:** a 401 page with a sign-in link that comes back to the file.
- **Signed in without access:** a 403 page.

A rule lets in members who hold any of its `levels` or `features`. With `entries: true` it also lets in whoever can read a published entry that uses the file. Staff can always download, disabled members can't, and a file that can't be checked isn't served.

Limits: only EmDash's file route is checked, so don't give the storage bucket a public URL. Image services that fetch without the reader's cookies, such as a CDN resizer, are refused. Moving a file out of the folder makes it public again.
