# Pricing

The numbers a customer sees. The plan prices and minutes live in `src/plans.js` (the one place to change them);
this page records the decisions behind them. Charging is built (Stripe Checkout and the customer portal, see `docs/billing.md`) but off until Stripe is set up; until then an admin sets a plan by hand.

## Plans

| Plan | Minutes per month | Monthly | Annual, per month | Annual, billed once | Watermark |
|---|---|---|---|---|---|
| Free | 5 | $0 | n/a | n/a | yes |
| Starter | 100 | $15 | $12.75 | $153 | yes |
| Creator | 200 | $30 | $25.50 | $306 | no |
| Pro | 600 | $90 | $76.50 | $918 | no |
| Agency | 2,000 | $300 | $255 | $3,060 | no |

**The watermark** is on every clip made on the Free and Starter plans. It is drawn into the picture while the clip is rendered
(text from `WATERMARK_TEXT`, default "made with dankmemes"), moves between four spots every three seconds, and no clean copy is stored,
so there is nothing to download without it. Re-rendering a caption on those plans adds it again. Clips made on a higher plan have none.
Clips made before an upgrade keep the mark until they are re-made.

## Top-up packs

| Pack | Minutes | Price | Per minute |
|---|---|---|---|
| Mini | 20 | $6 | $0.30 (worst deal) |
| Small | 50 | $13 | $0.26 |
| Medium | 100 | $23 | $0.23 |
| Large | 250 | $50 | $0.20 |
| Bulk | 500 | $85 | $0.17 (best deal) |

Packs are sold to **subscribers only** (a paid plan that is active: not cancelling, not past due, not locked). Pack minutes are used after the monthly minutes run out and **never expire**. Monthly plan minutes still do not roll over. Each size up is a better rate. Even the best pack
costs a little more per minute than any subscription ($0.15 monthly), so subscribing stays the better buy for regular use. Tests enforce all three rules.
A pack only adds minutes: everything else (video length, storage, API access, runs at once) still follows the account's plan.

## Rules

- **A credit is one minute of source video** (the length of the video submitted), rounded up per run to whole minutes. Failed runs are not billed. Output clip length and machine time do not matter.
- **Monthly minutes do not roll over.** They reset on the 1st (UTC).
- **Cancelling locks the account.** When a paid subscription ends, the account drops to Free and is locked: its runs, clips, API keys and top-up minutes are kept untouched but cannot be reached (page, API keys and playback links all refuse), and the retention sweep skips it. Subscribing again unlocks everything. An account that was always free is never locked.
- **The offer to stay.** A monthly subscriber who starts to cancel is offered a free top-up pack, sized by plan (`retentionPack` in `src/plans.js`: Starter 20 minutes, Creator 50, Pro 100, Agency 500; a test caps it at a quarter of the plan's minutes). It is added when their next monthly payment succeeds, so staying is what earns it, once per 180 days. Annual subscribers see a plain confirmation instead.
- **Floor:** no paid plan sells a minute below $0.15 when paid month by month. Annual is about 15% off.
- **Annual customers get their minutes in 12 monthly grants**, not all at once.
- **Bigger plans differ by minutes, runs at once, storage, API rate and clip caps, not by price per minute.**
- A test (`tests/accounts.test.js`) fails if a paid plan breaks the floor, annual stops being a slight discount, or a bigger plan costs more per minute.

## Not decided yet

- Free-tier watermark and the cap on free caption rewrites are proposals and not built. Pack prices are in `src/plans.js`.
- Real clips per source minute and real cost per minute are unmeasured: run a handful of videos on the real providers before putting a clip count in marketing.
