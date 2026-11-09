# Accounts and plans

## Accounts

People sign up with an email and a password (at least 10 characters). Passwords are stored as salted scrypt hashes; a
session is a random token in an HttpOnly cookie, and only its hash is stored. Wrong guesses are slowed (8 tries per
email and address per 15 minutes). There is no email verification or password-reset email yet (they need an email provider):
an admin resets a password from the command line.

Everything a person makes belongs to their account: runs, clips, videos, custom audiences, 👍/👎 ratings, API keys and usage.
One account can never see or change another's. This is enforced in the database queries and covered by tests.

Settings: `SIGNUPS=closed` stops new sign-ups. `ADMIN_EMAILS=a@x.com,b@y.com` marks those accounts as admins when they sign up or in.

## Plans

The limits live in one file, `src/plans.js`, and every limit in the app follows it. The numbers there are starting points, not decisions.

| Limit | What it controls |
|---|---|
| `watermark` | every clip rendered on this plan has a burned-in, unremovable mark |
| `retentionPack` | the free pack offered to a monthly subscriber who starts to cancel and stays one more month |
| `monthlyMinutes` | minutes of source video processed per calendar month (UTC). Counts the length of each video submitted, rounded up. Unused minutes do not roll over |
| `priceMonthly`, `priceAnnual` | dollars per month, paid monthly or yearly (the yearly price is the slight discount). Not charged by the app yet |
| `maxVideoMinutes` | longest single video |
| `maxUploadMb` | largest single upload |
| `storageGb` | all of an account's stored videos and clips together |
| `retentionDays` | runs (their video and clips) are deleted this many days after they were made |
| `concurrentRuns` | runs queued or running at once |
| `apiAccess` | may create API keys and use `/v1` |
| `ratePerMin` | API requests per minute |
| `tasteExamples` | how many of the account's own 👍/👎 captions teach its caption style (each side) |
| `models` | `standard` uses the cheaper models only; `premium` uses the best available |
| `clipsPerRun` | most clips one run may make |

Where each limit is enforced: starting a run (minutes, runs at once, upload size, storage, clips per run, video length for uploads),
the runner (video length for links, the model tier, the taste history), the API (access, rate), and a sweep every 6 hours (retention).
The page shows each account its usage against the limits.

A new account is on `free`. Paying customers are moved by Stripe (see [billing.md](billing.md)). An admin can also change a plan by hand:

```bash
npm run admin -- users
npm run admin -- set-plan someone@example.com pro
npm run admin -- set-password someone@example.com "a new long password"
npm run admin -- make-admin someone@example.com
```

Billing (Stripe or similar) is the next piece: a checkout page and a webhook that calls the same `setPlan`. A downgrade takes effect
immediately for what is checked at use time (API access, limits on new runs); stored data over the new limit is not deleted early,
but new runs are refused until the account is back under it.

## Usage and cost

Every AI call is written to `model_usage` against the account and run that caused it (tokens in, out and cached, time, success).
Add prices (per million tokens) in `MODEL_PRICES_JSON` or a file named by `MODEL_PRICES_FILE` and each call also gets a dollar cost:
`{"google:gemini-3.1-pro": {"input": 0, "output": 0, "cached_input": 0}}`. Without prices the cost is left empty rather than guessed.
`GET /v1/usage` shows an account its minutes, storage and tokens per model.
