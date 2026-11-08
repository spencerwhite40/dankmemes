"use strict";
// Account types and what each one allows. This is the one place to change a limit.
// The numbers are starting points, not decisions: edit them here and every limit in the app follows.
// (Prices and billing are not in the app yet: an admin sets a user's plan. See docs/accounts.md.)
//
//   monthlyMinutes   minutes of source video processed per calendar month (UTC)
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
const PLANS = {
  free:    { label: "Free",    monthlyMinutes: 10,   maxVideoMinutes: 10,  maxUploadMb: 200,  storageGb: 1,   retentionDays: 14,  concurrentRuns: 1, apiAccess: false, ratePerMin: 30,  tasteExamples: 5,  models: "standard", clipsPerRun: 12 },
  creator: { label: "Creator", monthlyMinutes: 200,  maxVideoMinutes: 30,  maxUploadMb: 500,  storageGb: 20,  retentionDays: 90,  concurrentRuns: 2, apiAccess: true,  ratePerMin: 120, tasteExamples: 15, models: "premium",  clipsPerRun: 30 },
  pro:     { label: "Pro",     monthlyMinutes: 700,  maxVideoMinutes: 60,  maxUploadMb: 1000, storageGb: 100, retentionDays: 180, concurrentRuns: 4, apiAccess: true,  ratePerMin: 300, tasteExamples: 30, models: "premium",  clipsPerRun: 60 },
  agency:  { label: "Agency",  monthlyMinutes: 2500, maxVideoMinutes: 120, maxUploadMb: 2000, storageGb: 500, retentionDays: 365, concurrentRuns: 8, apiAccess: true,  ratePerMin: 600, tasteExamples: 50, models: "premium",  clipsPerRun: 60 },
};

const DEFAULT_PLAN = "free";
const planNames = () => Object.keys(PLANS);
/** The limits for a plan name (an unknown name falls back to the free plan, never to unlimited). */
const getPlan = (name) => ({ name: PLANS[name] ? name : DEFAULT_PLAN, ...(PLANS[name] || PLANS[DEFAULT_PLAN]) });
const GB = 1024 ** 3;

module.exports = { PLANS, DEFAULT_PLAN, planNames, getPlan, GB };
