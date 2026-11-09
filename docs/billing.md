# Billing (Stripe)

Customers pay on Stripe's own pages (Checkout to buy, the customer portal to change or cancel). The app never sees a card.
The app starts a payment, and then trusts only Stripe's signed messages (webhooks) to change a plan or add minutes.

Billing is **off until `STRIPE_SECRET_KEY` is set**: the pricing section stays hidden and the endpoints answer 503.

## How it works

| Step | What happens |
|---|---|
| Customer clicks Choose / Buy | `POST /billing/checkout` asks Stripe for a Checkout page tied to their account and sends them there |
| They pay | Stripe sends `checkout.session.completed` to `POST /billing/webhook` |
| The app | checks the signature, then sets their plan (subscription) or adds minutes (top-up pack) |
| They return to the app | the page notices the change and says so |
| Plan change, cancel, card update | the customer opens **Manage billing** (Stripe's portal). Stripe's events keep the app in step |
| Cancel | the plan stays until the period ends, then the account drops to Free |
| Card fails | the account shows "past due" and keeps its plan while Stripe retries; if Stripe gives up, it drops to Free |

Every event is handled once (its id is stored first), a failed event is retried by Stripe, and an unsigned or stale request changes nothing.
An account whose plan was set by hand with `npm run admin -- set-plan` is never touched by Stripe events.

Minutes: a plan's minutes are counted per calendar month (UTC) and do not roll over, whether the customer pays monthly or yearly.
A yearly customer pays once but gets each month's minutes as that month comes. Top-up packs are used only after the month's
plan minutes are gone, oldest-expiring first, and last 12 months.

## Setting it up (do it in Stripe's test mode first)

1. **Products and prices.** In the Stripe dashboard create these products and prices (a plan has two prices, a pack has one). The amounts come from `src/plans.js` and `docs/pricing.md`; change them there first if they change.

   | Product | Price | Billing | Env var |
   |---|---|---|---|
   | Creator | $30 | recurring, monthly | `STRIPE_PRICE_CREATOR_MONTHLY` |
   | Creator | $306 | recurring, yearly | `STRIPE_PRICE_CREATOR_ANNUAL` |
   | Pro | $90 | recurring, monthly | `STRIPE_PRICE_PRO_MONTHLY` |
   | Pro | $918 | recurring, yearly | `STRIPE_PRICE_PRO_ANNUAL` |
   | Agency | $300 | recurring, monthly | `STRIPE_PRICE_AGENCY_MONTHLY` |
   | Agency | $3,060 | recurring, yearly | `STRIPE_PRICE_AGENCY_ANNUAL` |
   | 20 minutes | $6 | one-time | `STRIPE_PRICE_PACK_MINI` |
   | 50 minutes | $13 | one-time | `STRIPE_PRICE_PACK_SMALL` |
   | 100 minutes | $23 | one-time | `STRIPE_PRICE_PACK_MEDIUM` |
   | 250 minutes | $50 | one-time | `STRIPE_PRICE_PACK_LARGE` |
   | 500 minutes | $85 | one-time | `STRIPE_PRICE_PACK_BULK` |

   Each price has an id that starts with `price_`. Put it in the env var named in the table. A plan or pack whose id is missing shows "Not on sale yet".

2. **Webhook.** Developers, Webhooks, add an endpoint: `https://YOUR-APP/billing/webhook`, listening for
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`. Copy its signing secret (`whsec_...`).

3. **Customer portal.** Settings, Billing, Customer portal: turn on cancelling (at the end of the period), updating the payment method,
   invoice history and switching plans. Add the three plan products (both prices each) as the plans a customer may switch between.

4. **Failed payments.** Settings, Billing, Subscriptions and emails: keep Smart Retries on, and set the subscription to be cancelled if all retries fail.

5. **Environment (typed into the host's settings, never into chat or git):**

   ```
   STRIPE_SECRET_KEY=sk_test_...        # restricted keys work if they can write Checkout Sessions and Billing Portal Sessions
   STRIPE_WEBHOOK_SECRET=whsec_...
   APP_URL=https://YOUR-APP             # where customers return to after Stripe
   STRIPE_PRICE_...=price_...           # the eight above
   ```

6. **Try it** with Stripe's test card `4242 4242 4242 4242`: buy Creator, see the plan change; buy a pack; open Manage billing and cancel.
   Then repeat with live keys and live price ids.

## Not covered yet

- Refunds and disputes are done in Stripe and do not change the plan or take back top-up minutes by themselves.
- Sales tax / VAT: turn on Stripe Tax in the dashboard if you need it. The app does not compute tax.
- Receipt and invoice emails come from Stripe (turn them on in its settings); the app sends no billing emails.
- This was built and tested against fake Stripe calls and signed fake events, not against Stripe itself. The first test-mode purchase is the real check:
  the request fields and the event shapes follow Stripe's documented API, but nothing here has talked to Stripe yet.
