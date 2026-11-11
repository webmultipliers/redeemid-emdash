# Shopify Flow recipes

RedeemID never grants access itself. A member's levels come from tags on their Shopify customer, and something in Shopify has to put those tags on and take them off. That is usually [Shopify Flow](https://help.shopify.com/manual/shopify-flow), which comes free with every Shopify plan, or a subscription app.

When a tag changes, Shopify sends a `customer.tags_added` or `customer.tags_removed` webhook. With the Admin API app's client ID set, RedeemID reads the customer's tags as they are now; without it, it applies the change the webhook carries. Access follows within seconds, and nobody has to sign in again.

Each recipe below is one Flow workflow. In Flow, open **Create workflow**, pick the trigger, add the condition, then add the action. The trigger and action names here are the ones Flow shows in English. The field paths in conditions can read slightly differently in Flow's picker. Subscription triggers come from your subscription app, so their names depend on the app.

The examples use a product called "Membership" and the tag `member`. Use your own product and the tag your level maps to, which you can see under **Plugins → RedeemID → Access**.

## 1. A paid order adds the tag

- **Trigger:** Order paid
- **Condition:** at least one of `order.lineItems` has `product.title` equal to `Membership`. If you sell several plans, match the product ID or a product tag such as `plan-member` instead, which keeps working after a rename.
- **Action:** Add customer tags, with `member`.

Use **Order paid** rather than Order created, so an unpaid order (for example, a payment that's still pending) doesn't open anything. Also add `order.customer` exists to the condition. A checkout always has an email, but a draft order may not have a customer.

If the plan is meant to show as a gift, also add an **Update customer metafield** action that sets `membership.gift_until` (type date). See [membership dates](staff.md#membership-dates).

## 2. A refund removes it

- **Trigger:** Refund created
- **Condition:** at least one of `refund.refundLineItems` has `lineItem.product.title` equal to `Membership`.
- **Action:** Remove customer tags, with `member`.

A partial refund of something else in the same order matches nothing, so the tag stays. Shipping-only refunds match nothing either.

## 3. A cancelled subscription removes it

Subscription apps that work with Flow add their own triggers, such as "Subscription contract cancelled" or "Subscription contract status updated". The names vary by app, so check your app's Flow listing.

- **Trigger:** your app's cancel trigger. If the app only offers a status-changed trigger, add the condition status is `CANCELLED`, and treat `EXPIRED` the same way.
- **Action:** Remove customer tags, with `member`.

Many apps can tag customers themselves (for example, "tag active subscribers"). If you use that, don't also run recipes 1 and 3 for the same tag, or one will undo the other.

To show the next billing date, add **Update customer metafield** to the app's "billing attempt succeeded" (or renewal) trigger, setting `membership.renews_on` to the next billing date.

## 4. A pass that ends: wait, then remove

For a fixed-term pass that doesn't renew, such as a 30-day pass:

- **Trigger:** Order paid
- **Condition:** the order contains the pass product, as in recipe 1.
- **Actions:**
  1. Add customer tags, with `pass`.
  2. Update customer metafield `membership.ends_on`, set to the order date plus 30 days. This step is optional and is only used for display.
  3. Wait 30 days.
  4. Remove customer tags, with `pass`.

The wait lives in Flow, not on the site. RedeemID doesn't end access on the `ends_on` date. It only shows that date, so the tag is still what decides access.

If a member buys a second pass while the first is still running, the first workflow's removal takes the tag away early. Give each length its own tag (`pass-30`, `pass-90`), or make the last step check the newest order before it removes the tag.

## 5. A member's own Shopify account

None of these recipes need anything from RedeemID. A customer who buys while signed out is tagged on their customer record by email. The next time they sign in on the site, the tag is already there.

When a member buys while signed in, RedeemID opens the checkout signed in as them, so the order goes on the same customer record.

After a purchase, **Refresh membership** on the member card reads their tags again straight away. That helps if Flow ran before the member got back to the site.

## Check a recipe

1. Under **Plugins → RedeemID → Webhooks → Setup**, make sure `customer.tags_added` and `customer.tags_removed` show as Registered. The Setup page registers them for you.
2. Buy the product with a test customer, using Shopify's Bogus Gateway or a 100% discount code.
3. In Flow, open the workflow's **Recent runs**. The run should show the tag added.
4. Open **Plugins → RedeemID → Members**, then the customer. The tag and level should be there.
5. Refund the order. The tag and the level should both go.
