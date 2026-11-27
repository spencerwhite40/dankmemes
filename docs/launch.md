# Launch checklist

The code is ready to go. The only steps left are the ones that need your accounts, your card or your name. Do them in this order, because each one hands a value to the next.
Keys and secrets always go into each host's own settings page, never into git or chat. `docs/deploy.md` has the click-by-click detail for each step.

## What only you can do

| # | Step | You end up with | Cost |
|---|---|---|---|
| 1 | Buy a domain (any registrar, or Cloudflare) | `your-domain.com` | roughly $10 to $20 a year |
| 2 | Neon: make a project and copy the **direct** connection string | `DATABASE_URL` | $0 to start |
| 3 | Cloudflare R2: make a private bucket and an API token with read and write on it | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | about $0.015 per GB a month |
| 4 | Google AI Studio: make an API key. Anthropic and OpenAI keys are optional and give better captions | `GOOGLE_API_KEY` (plus `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) | pay per use, with a free tier for testing |
| 5 | Fly.io: sign up, run the `fly` commands in `docs/deploy.md` step 4, put the deploy token on Render as `FLY_API_TOKEN` | the processing machines (one per run, stopped when idle) | $0.18 an hour per busy machine, about $396 a month at worst with the cap of 3 |
| 6 | Render: New, then Blueprint, point it at this repo and paste the values above when it asks | the website | about $7 to $25 a month |
| 7 | Point the domain at Render, then set `APP_URL=https://your-domain.com` | the live address | none |
| 8 | Resend: add and verify your domain, then make an API key | `RESEND_API_KEY`, `EMAIL_FROM` | free tier to start |
| 9 | Stripe: make the products and prices (test mode first), the webhook and the customer portal (`docs/billing.md`) | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, 13 `STRIPE_PRICE_*` ids | a fee per charge, no monthly fee |
| 10 | Legal pages: fill in the company details, have a lawyer read them, then set `LEGAL_REVIEWED=yes` | `COMPANY_NAME`, `COMPANY_ADDRESS`, `SUPPORT_EMAIL`, `COPYRIGHT_EMAIL`, `LEGAL_JURISDICTION` | a lawyer's time |

Until step 8 is done, sign-up works without email confirmation. Until step 9, everyone is on the free plan. Until step 10, the legal pages show a draft banner.

## Then check it works

1. `https://your-domain.com/health` shows `{"ok":true}`.
2. `fly ssh console -C "npm run models:check"` lists the AI models the keys can reach.
3. Sign up with your own email, confirm it, and run one short video you own.
4. Buy a plan with Stripe's test card `4242 4242 4242 4242`, then switch Stripe to live keys.

## Every variable, and where it goes

Web app on Render, unless it says otherwise. `render.yaml` asks for every one marked as a secret, and `.env.example` explains each one.

| Variable | Needed? | Also on Fly? |
|---|---|---|
| `DATABASE_URL` | yes | yes |
| `GOOGLE_API_KEY` | yes | yes |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | optional | yes, if set |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | yes | yes |
| `APP_URL` | yes | no |
| `ADMIN_EMAILS` | yes (your email) | no |
| `SESSION_SECRET` | yes, Render makes it | no |
| `RESEND_API_KEY`, `EMAIL_FROM` | for email | no |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_*` | for payments | no |
| `COMPANY_NAME`, `COMPANY_ADDRESS`, `SUPPORT_EMAIL`, `COPYRIGHT_EMAIL`, `LEGAL_JURISDICTION`, `LEGAL_REVIEWED` | for legal pages | no |
| `ALERT_WEBHOOK_URL` | optional | yes, if set |
| `MEME_BUILDER_RUNNER=off`, `NODE_ENV=production` | already set in `render.yaml` | no |
| `FLY_API_TOKEN` (a Fly deploy token for the worker app) | yes, so each run gets its own machine | no |
| `FLY_WORKER_APP`, `WORKER_MAX_MACHINES` (the cost cap, default 3) | already set in `render.yaml` | no |
| `WORKER_IDLE_POLL_SECONDS`, `WORKER_IDLE_EXIT_SECONDS`, `RENDER_CONCURRENCY` | already set in `fly.toml` | only there |
