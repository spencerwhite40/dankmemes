# Funding the AI providers

Customers pay us first; the AI providers are paid as the work is done. This page is how to keep each provider funded
as customers buy credits, without loading more than is needed.

## The short answer

Yes. All three providers sell **prepaid credits with auto-reload**: you load a starting balance, and the provider tops it up from a card
whenever it falls below a level you choose, up to a monthly limit you choose. Nothing has to be done by hand each day, and nothing is
bought far ahead of need. The app does not buy credits itself (it holds no payment credentials for the providers, on purpose):
you set the auto-reload once in each provider's dashboard, and the app watches and warns.

| | Google (Gemini) | Anthropic (Claude) | OpenAI (GPT) |
|---|---|---|---|
| Prepaid credits | yes | yes | yes |
| Auto-reload | yes: set the balance that triggers it and the amount | yes: "When credit balance reaches" | yes: auto-recharge threshold |
| Monthly limit on automatic reloads | yes ("monthly auto-charge limit") | a separate monthly spend limit | yes (monthly recharge limit) |
| Smallest purchase | $5 | check the console | $5 |
| Do credits expire? | **yes, 12 months, non-refundable** | not confirmed (see below) | **yes, 1 year, generally non-refundable** |
| When the balance hits $0 | **all keys on the billing account stop**, requests get HTTP 402 | requests fail with a billing error | requests fail (`credit_balance_exhausted`), after a brief lag where the balance can go slightly negative |

Sources: Google's Gemini API billing guide (read in full). Anthropic's and OpenAI's help-center pages could not be opened directly from here,
so their rows come from search-result summaries of those pages: check them in each dashboard before relying on them,
especially Anthropic's expiry rules.

Two things in Google's rules matter early on:
- **Spend caps by tier.** A new paid account is capped (Tier 1: $250 a month) until it has paid $100 and three days have passed (Tier 2: $2,000), then $1,000 and 30 days (Tier 3: $20,000 and up). At launch volumes this is plenty; if you grow fast, move up the tiers by paying in advance rather than waiting.
- **Gemini is the one that must not run dry.** It is the only provider in the chain that watches video, so if its balance reaches $0 no run can be analysed at all. Claude and GPT only write captions, and the app moves to the next one on its own when one is empty.

## Where the money comes from

Customers pay Stripe, and Stripe pays out to your bank on its payout schedule. The providers charge a card. So the first balances
(and the gap between a customer paying and a payout arriving) are funded from your own card or account, then replaced as payouts arrive.
Set Stripe's payouts to the fastest schedule available to you, and use a card with enough limit to cover about two weeks of provider spend.
(Funding the provider cards directly from the Stripe balance may be possible with a business-card product from Stripe: not looked into here.)

## What to set

For each provider, from its average daily spend:

- **Reload when the balance falls below** about 3 days of spend.
- **Reload amount** about 7 days of spend.
- **Monthly auto-reload limit** about 1.5x a normal month. This is the brake: a bug or an abusive account can't drain the card, because automatic reloads stop at the limit.

Do not load months of spend up front: credits expire after a year and are not refunded.

Starting amounts, **estimated** from the pricing model (about $0.06 a source minute after the January 2027 Gemini price change, of which about three
quarters is Gemini and a quarter Claude; GPT only runs when another provider fails). Replace them with measured numbers as soon as real runs exist:

| Source minutes a month | Gemini: reload below / add / monthly limit | Claude: reload below / add / monthly limit |
|---|---|---|
| 1,000 | $5 / $15 / $70 | $5 / $5 / $25 |
| 5,000 | $25 / $55 / $335 | $10 / $20 / $110 |
| 20,000 | $90 / $210 / $1,330 | $30 / $70 / $430 |

## Measuring it for real

```bash
npm run admin -- funding
```

prints, from the usage ledger: source minutes processed, AI spend per provider over 7 and 30 days, the **measured cost per source minute**
(compare it with the pricing assumptions), suggested auto-reload settings per provider from the last week's actual spend, what is owed to customers,
and an ALERT for any provider that refused work in the last day because its balance was empty. Dollars appear only if prices are configured
(`MODEL_PRICES_JSON` or `MODEL_PRICES_FILE`, per 1M tokens, copied from each provider's pricing page); without them it shows tokens and says so.

Run it weekly at first. It is the first real check on every number in the pricing plan.

## What the app does when a balance runs out

- A provider that answers "out of credit" (HTTP 402, or its own wording for it) is set aside for 5 minutes and logged once as `[funding] <provider> is out of credit`. Runs continue on the next provider in the chain; the provider is tried again by itself after the window, so a top-up needs no restart.
- If every provider is empty, the run fails with "The AI account has run out of credit. The site owner needs to top it up." and is not counted against the customer's minutes.
- `npm run admin -- funding` shows an ALERT for it. Watch the logs for `[funding]` (alerting on that line is a good first monitor).

## What is owed to customers

Money taken but not yet "served":
- **Top-up minutes** customers have bought and not used (they never expire, so this only grows until used). The report shows the number; multiply by the cost per minute for the money to keep available for them.
- **Annual plans** are paid up front but used month by month, so cash arrives ahead of cost. Treat the unused months as owed, not as profit.
- **Monthly plans** are paid at the start of the month and used during it.

A simple rule: keep cash and provider balances at least equal to (unused top-up minutes + the rest of this month's included minutes that are likely to be used) times the measured cost per minute.
