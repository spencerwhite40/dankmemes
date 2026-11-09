"use strict";
// Account types and what each one allows. This is the one place to change a limit.
// The numbers are starting points, not decisions: edit them here and every limit in the app follows.
// (Prices and billing are not in the app yet: an admin sets a user's plan. See docs/accounts.md.)
//
//   monthlyMinutes   minutes of source video processed per calendar month (UTC). A run counts the length of the video it
//                    was given, rounded up; unused minutes do not roll over to the next month
//   priceMonthly     dollars per month when paid month by month
//   priceAnnual      dollars per month when paid once a year (slightly less); 0 on the free plan
//   maxVideoMinutes  longest single video
//   maxUploadMb      largest single upload
//   storageGb        all stored videos and clips together
//   retentionDays    runs (their videos and clips) are deleted this many days after they were made
//   concurrentRuns   runs queued or running at once
//   apiAccess        may create API keys and use /v1
//   ratePerMin       API requests per minute
//   tasteExamples    how many of the account's own 👍/👎 captions teach its caption style (each side)
//   models           "standard" uses the cheaper models only; "premium" uses the best available
//   clipsPerRun      most clips one run may make
//   watermark        every clip rendered on this plan has a mark burned into the picture (it cannot be removed: no clean copy is kept)
//   retentionPack    the free top-up pack offered to a monthly subscriber who is about to cancel and stays one more month (a key of PACKS)
const PLANS = {
  free:    { label: "Free",    monthlyMinutes: 5,    priceMonthly: 0,   priceAnnual: 0,     maxVideoMinutes: 5,  maxUploadMb: 200,  storageGb: 1,   retentionDays: 14,  concurrentRuns: 1, apiAccess: false, ratePerMin: 30,  tasteExamples: 5,  models: "standard", clipsPerRun: 12, watermark: true,  retentionPack: null },
  starter: { label: "Starter", monthlyMinutes: 100,  priceMonthly: 15,  priceAnnual: 12.75, maxVideoMinutes: 15, maxUploadMb: 300,  storageGb: 5,   retentionDays: 30,  concurrentRuns: 1, apiAccess: false, ratePerMin: 60,  tasteExamples: 10, models: "premium",  clipsPerRun: 20, watermark: true,  retentionPack: "mini" },
  creator: { label: "Creator", monthlyMinutes: 200,  priceMonthly: 30,  priceAnnual: 25.5,  maxVideoMinutes: 30,  maxUploadMb: 500,  storageGb: 20,  retentionDays: 90,  concurrentRuns: 2, apiAccess: true,  ratePerMin: 120, tasteExamples: 15, models: "premium",  clipsPerRun: 30, watermark: false, retentionPack: "small" },
  pro:     { label: "Pro",     monthlyMinutes: 600,  priceMonthly: 90,  priceAnnual: 76.5,  maxVideoMinutes: 60,  maxUploadMb: 1000, storageGb: 100, retentionDays: 180, concurrentRuns: 4, apiAccess: true,  ratePerMin: 300, tasteExamples: 30, models: "premium",  clipsPerRun: 60, watermark: false, retentionPack: "medium" },
  agency:  { label: "Agency",  monthlyMinutes: 2000, priceMonthly: 300, priceAnnual: 255,   maxVideoMinutes: 120, maxUploadMb: 2000, storageGb: 500, retentionDays: 365, concurrentRuns: 8, apiAccess: true,  ratePerMin: 600, tasteExamples: 50, models: "premium",  clipsPerRun: 60, watermark: false, retentionPack: "bulk" },
};

// Top-up packs: extra minutes bought once, by subscribers only. They are used after the plan's monthly minutes and never expire.
// Listed smallest to largest. Each size up is a better price per minute, the smallest is the worst deal, and even the
// best deal costs a little more per minute than a subscription (tests check all three), so subscribing stays the better buy.
const PACKS = {
  mini:   { label: "20 minutes",  minutes: 20,  price: 6 },
  small:  { label: "50 minutes",  minutes: 50,  price: 13 },
  medium: { label: "100 minutes", minutes: 100, price: 23 },
  large:  { label: "250 minutes", minutes: 250, price: 50 },
  bulk:   { label: "500 minutes", minutes: 500, price: 85 },
};
const PERIODS = ["monthly", "annual"];
const paidPlanNames = () => Object.keys(PLANS).filter((n) => PLANS[n].priceMonthly > 0);

const DEFAULT_PLAN = "free";
const planNames = () => Object.keys(PLANS);
/** The limits for a plan name (an unknown name falls back to the free plan, never to unlimited). */
const getPlan = (name) => ({ name: PLANS[name] ? name : DEFAULT_PLAN, ...(PLANS[name] || PLANS[DEFAULT_PLAN]) });
const GB = 1024 ** 3;

module.exports = { PLANS, PACKS, PERIODS, DEFAULT_PLAN, planNames, paidPlanNames, getPlan, GB };
