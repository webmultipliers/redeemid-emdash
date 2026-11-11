# Content and templates

EmDash has no content filter hook, so templates decide what to render.

**`<Content>`** renders an entry body. Levels come from the entry's rule (its content type, its terms, or its own Access panel); a Paywall break only says where that rule starts. Everything before the first Paywall break block is shown to everyone, and what follows reaches the page only for readers the rule lets in. With no rule covering the entry, the break changes nothing. A body with no break follows the entry's rule as a whole, and readers it keeps out see the collection's `teaser` if one is set (whole paragraphs, never half of one).

```astro
<Content value={post.data.content} collection="posts" terms={post.data.terms} id={post.id} title={post.data.title}>
	<a slot="locked" href="/join/">Become a member</a>
</Content>
```

Pass `id` on the entry's own page. It lets the meter count the read, and a locked entry gets Google's paywalled-content markup: JSON-LD with `isAccessibleForFree: false` and the wall (`.redeemid-locked`) as the part that isn't free, so search engines can tell a paywall from cloaking. `title` is its headline. Set `schema: false` if an SEO plugin already adds this markup.

**Members only.** A "Members only" block starts a part for the levels picked on it (none picked: the entry's rule, or any signed-in member) that runs to the next "Members only: end" block. Readers who can't read it see the wall in its place and read on after it.

**The wall** is `<LockedPanel>`. It says why the reader is kept out and offers sign-in or the join link, with the wall text of the first level they're missing. `<Content>` and `<Gate>` show it, and their `locked` slot goes on top.

**`<Gate>`** locks any part of a template that isn't the body:

```astro
<Gate levels={["pro"]}><a href="/reports/archive.zip">Download the archive</a></Gate>
```

**`<AccessBadge>`** shows what an entry needs, on cards and on the entry. It shows "Free" for open entries (`free=""` hides it), adds `is-locked` and a lock for readers it keeps out, and puts the level slugs in `data-redeemid-level` for colours (and the first level's `badge` colour in `--redeemid-level-color`):

```astro
<AccessBadge collection="posts" terms={post.data.terms} content={post.data.content} />
```

**`<Notices />`** goes near the top of the layout. It shows the message for a `?redeemid_notice=` code (see [notices](reference.md#notices)) and nothing otherwise.

**`<MemberCard />`** is for an account page: levels with start dates, the renewal or end date and any gift membership that Shopify keeps (see [membership dates](staff.md#membership-dates)), past levels, the meter, and links to the store account, Refresh membership and Sign out. Refresh membership sends a member to the store with no sign-in form; one still signed in there comes straight back with their tags read again. Add `<Preferences />` and `<YourData />` beside it.

**`<Plan>`** sells a membership: a Shopify product's title and price with a button that starts checkout (members check out with their email). Its levels are `levels`, or else the levels whose `products` list the handle. Then the card fits the member: one who holds a level through its own tags sees "You're on this plan." in place of the button; one whose bigger level includes it sees "Included in your Gold membership."; one the plan would move up (its level includes theirs) gets **Upgrade** (`upgradeLabel`); and one who held it before (Shopify has since removed its tag) gets **Renew** (`renewLabel`) instead of `label`. `data-redeemid-state` is `held`, `included`, `upgrade`, `renew` or `join`. The wall does the same: a lapsed member reads "Your Pro membership has ended." with **Renew Pro** and **Already renewed? Refresh**, not the newcomer's join link.

```astro
<Plan handle="gold-membership" label="Join Gold" levels={["gold"]}>
	<p>Shown if the product can't be loaded.</p>
</Plan>
```

**In your own code** (`@redeemid/emdash/access`):

```ts
import { canRead, entryRequirement, readEntry, siteConfig } from "@redeemid/emdash/access";

const verdict = await canRead(Astro, { collection: "posts", terms: post.data.terms, id: post.id });
// verdict.allowed; verdict.reason: open | allowed | sign_in | upgrade | disabled | unconfigured
const read = await readEntry(Astro, { collection: "posts", terms: post.data.terms, id: post.id });
// adds drip (read.opensAt) and the meter (read.meterLeft), and counts a metered read

const config = await siteConfig(Astro.locals);
const needs = await entryRequirement(config, "posts", post.data.terms, post.id);
// e.g. [["gold", "pro"]]: readers pass every clause, each with any one of its levels; null when open
```

**Site search.** EmDash's search API (`/_emdash/api/search`, which its live search box uses) is public and answers with a snippet of the matching text. `redeemidGuard()` checks each result for visitors and members: an entry the reader can't read in full keeps its title but loses its snippet, and stays in the results only when its title holds every searched word, so a search can't show locked text or tell which locked entry contains a word. Staff get every result. A search page that calls EmDash's `search()` in its template filters the same way with `readableResults()`:

```astro
---
import { search } from "emdash";
import { readableResults } from "@redeemid/emdash/search";

const q = Astro.url.searchParams.get("q") ?? "";
const results = q ? await readableResults(Astro, q, (await search(q)).items) : [];
---
```

`siteConfig(Astro.locals)` is the config for this request: your code's config with the Access page's saved settings laid over it. Pass it to the functions that take a `config`, such as `entryRequirement()`, `readPreferences()` and the storefront and catalog calls.

## Replacement text

```ts
text: {
	"Sign in": "Log in",
	"This is for members. {signIn} to read on.": "Members only. {signIn} to keep reading.",
	"This is for {level} members.": "{level} members only.",
},
```

Each key is a string's original English and its value is the new text. Only the strings you name change: there is no find-and-replace, so replacing "Sign in" leaves "Sign in to download this file." alone. `STRINGS` in `@redeemid/emdash/text` lists every string, grouped by where it shows.

A replacement may use its original's placeholders (such as `{level}`, or `{signIn}` for a link) in any order, or not at all, but no others. Text is plain, so HTML shows as typed. A replacement with an unknown placeholder, or for a string RedeemID doesn't show, is ignored and listed on the Status page with the reason. Props you pass (`label`, `title`, Notices `messages`) win over `text`. Staff screens in the admin aren't covered.
