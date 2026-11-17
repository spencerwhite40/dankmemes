# First deploy: the order to do things in

Nothing here is deployed yet. This is the checklist for when the accounts exist. Secrets are always typed into each host's own settings page,
never into git or chat. Do the steps in order: each one needs the one before it.

| Piece | Runs | Config in the repo |
|---|---|---|
| Web app (pages, API, billing webhook, emails) | Render | `render.yaml` |
| Processing machine (watches video, renders clips) | Fly.io | `fly.toml`, `Dockerfile` |
| Database | Neon (Postgres) | `schema.sql`, applied automatically on start |
| Videos and clips | Cloudflare R2 | no config file |
| Payments / email | Stripe / Resend or Postmark | `docs/billing.md`, `docs/email.md` |

## Rough fixed monthly cost to have it running

From the providers' pricing pages as read earlier (check them when you sign up): Render web service about $7 to $25, Neon pay-as-you-go from $0,
Fly processing machine about $33 (performance-1x) or $66 (performance-2x, which is what `fly.toml` asks for), R2 $0.015 per GB stored and free to download.
Roughly $50 to $120 a month before any customers, plus the AI providers' usage (`docs/funding.md`).
The Fly machine runs all the time (there's no auto-stop configured), so use the smaller size while testing.

## 1. Database (Neon)

1. Create a project and a database. Copy the **direct** connection string (it ends in `?sslmode=require`).
2. That string is `DATABASE_URL` for both the web app and the Fly machine.
3. Don't create tables: the app applies `schema.sql` itself on every start.

## 2. File storage (Cloudflare R2)

1. Create a bucket (private). Note the account id.
2. Create an API token with read and write on that bucket.
3. You now have `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`. Without these, files go to the machine's disk and are lost on every restart: the logs say so.

## 3. AI keys

- Minimum: `GOOGLE_API_KEY` (Gemini watches the video and can write the captions too). A free Google AI Studio key works for testing.
- Better captions: also `ANTHROPIC_API_KEY`, and `OPENAI_API_KEY` as a fallback. `docs/funding.md` covers how to fund them.

## 4. The processing machine (Fly)

```bash
fly launch --no-deploy --copy-config --name <your-app-name>
fly secrets set DATABASE_URL=... GOOGLE_API_KEY=... R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_BUCKET=...
fly deploy
```

Add `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` to the secrets if you have them. This machine doesn't need the Stripe, email or legal settings.
Use `fly scale count 2` later if runs queue up: several machines safely share one queue.

**How fast it renders (measured, not guessed):** with real ffmpeg on a synthetic 720p test video, a 25-second clip took about 9 seconds on a
2-core machine and about 6 seconds on 4 cores, so roughly 3 minutes of rendering for 20 clips on the 2-core size. Real footage and 1080p sources will be
somewhat slower, so time one real video. Rendering two clips at once gained about 1.3x on 4 cores and almost nothing (1.05x) on 2 cores,
so the runner only does it on 4 or more cores (`RENDER_CONCURRENCY` overrides). The AI steps (watching, captions, checking cuts) add their own time on top.
If runs queue up, add machines (`fly scale count 2`) rather than parallelism on a small one.

## 5. The web app (Render)

1. New, Blueprint, point it at the repo. Render reads `render.yaml` and asks for each secret marked `sync: false`.
2. Set `DATABASE_URL`, the R2 values and the AI keys (same values as Fly), `APP_URL` (the public address, with `https://`), and `ADMIN_EMAILS` (your email, so your account is an admin).
3. `SESSION_SECRET` is generated for you. `MEME_BUILDER_RUNNER` is already `off`: the Fly machine does the processing.
4. Point your domain at the service and wait for the certificate.

## 6. Email (`docs/email.md`)

Verify a sending domain with Resend or Postmark, then set `RESEND_API_KEY` (or `POSTMARK_SERVER_TOKEN`) and `EMAIL_FROM` on the web app.
Until then nobody has to confirm their address (nobody could).

## 7. Stripe (`docs/billing.md`)

Create the products and prices, the webhook at `https://YOUR-DOMAIN/billing/webhook`, and the customer portal. Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and the ten `STRIPE_PRICE_*` variables on the web app. Do it all in Stripe's **test mode** first.

## 8. Legal (`docs/legal.md`)

Set the company details. Get the pages reviewed, then set `LEGAL_REVIEWED=yes` to remove the draft banner.

## 9. Check that it works (in this order)

1. `curl https://YOUR-DOMAIN/health` returns `{"ok":true}`. The logs show `[setup]` warnings for anything you haven't set yet.
2. Check the model names against the real providers. This is the first time they are tested for real:
   ```bash
   fly ssh console -C "npm run models:check"
   ```
   If a configured model isn't listed, set the matching variable (`GOOGLE_FLASH_MODEL`, `GOOGLE_PRO_MODEL`, `ANTHROPIC_WRITER_MODEL`, `OPENAI_MODEL`, or the whole chains `MEME_BUILDER_VIDEO_MODELS` / `MEME_BUILDER_TEXT_MODELS`).
3. Create an account on the site, confirm the email, and run one short video you own. Watch `fly logs` while it runs.
4. Run `npm run admin -- funding` (on Fly: `fly ssh console -C "npm run admin -- funding"`) to see the real tokens and cost per source minute.
5. Make a test purchase with Stripe's test card `4242 4242 4242 4242`: the plan should change, a pack should add minutes, cancelling should offer the stay-another-month pack.
6. Only then switch Stripe to live keys and set up the funding (auto-reload) on each AI provider.

## Backups

Neon keeps a history of the database. Try restoring from it once before you have customers, so you know how. Stored videos and clips live only in R2.

## Rolling back

Render keeps previous deploys: redeploy an older one from its dashboard. `fly deploy` an older commit for the processing machine. The database schema only ever adds, so older code keeps working against it.
