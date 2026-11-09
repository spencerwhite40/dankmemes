# Pricing

The numbers a customer sees. The plan prices and minutes live in `src/plans.js` (the one place to change them);
this page records the decisions behind them. Charging is built (Stripe Checkout and the customer portal, see `docs/billing.md`) but off until Stripe is set up; until then an admin sets a plan by hand.

## Plans

| Plan | Minutes per month | Monthly | Annual, per month | Annual, billed once |
|---|---|---|---|---|
| Free | 5 (clips carry a watermark, not built yet) | $0 | n/a | n/a |
| Creator | 200 | $30 | $25.50 | $306 |
| Pro | 600 | $90 | $76.50 | $918 |
| Agency | 2,000 | $300 | $255 | $3,060 |

## Top-up packs

| Pack | Minutes | Price | Per minute |
|---|---|---|---|
| Mini | 20 | $6 | $0.30 (worst deal) |
| Small | 50 | $13 | $0.26 |
| Medium | 100 | $23 | $0.23 |
| Large | 250 | $50 | $0.20 |
| Bulk | 500 | $85 | $0.17 (best deal) |

Pack minutes are used after the monthly minutes run out and last 12 months. Each size up is a better rate. Even the best pack
costs a little more per minute than any subscription ($0.15 monthly), so subscribing stays the better buy for regular use. Tests enforce all three rules.
A pack only adds minutes: everything else (video length, storage, API access, runs at once) still follows the account's plan.

## Rules

- **A credit is one minute of source video** (the length of the video submitted), rounded up per run to whole minutes. Failed runs are not billed. Output clip length and machine time do not matter.
- **Monthly minutes do not roll over.** They reset on the 1st (UTC).
- **Floor:** no paid plan sells a minute below $0.15 when paid month by month. Annual is about 15% off.
- **Annual customers get their minutes in 12 monthly grants**, not all at once.
- **Bigger plans differ by minutes, runs at once, storage, API rate and clip caps, not by price per minute.**
- A test (`tests/accounts.test.js`) fails if a paid plan breaks the floor, annual stops being a slight discount, or a bigger plan costs more per minute.

## Not decided yet

- Free-tier watermark and the cap on free caption rewrites are proposals and not built. Pack prices are in `src/plans.js`.
- Real clips per source minute and real cost per minute are unmeasured: run a handful of videos on the real providers before putting a clip count in marketing.
