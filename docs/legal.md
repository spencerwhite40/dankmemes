# Legal pages

Four public pages, served by the app: `/terms`, `/privacy`, `/refunds`, `/copyright`. Their text is in `legal/*.html`. Links are in the page footer,
the sign-up form requires ticking "I agree to the Terms and the Privacy Policy" (the time is stored), and the copyright page is the takedown route.

**These are drafts written to match what the product actually does. They are not legal advice and should be reviewed by a lawyer
before real customers use the service.** Until `LEGAL_REVIEWED=yes` is set, every page shows a yellow "Draft" banner.

## Fill in

Set these in the host's settings. Anything unset shows as an obvious `[placeholder]` on the page, and the server warns at start-up in production:

```
COMPANY_NAME=          COMPANY_ADDRESS=       SUPPORT_EMAIL=
COPYRIGHT_EMAIL=       LEGAL_JURISDICTION=    LEGAL_REVIEWED=yes   (only after review)
```

## Decisions the drafts make for you (change them in the HTML if you disagree)

- **18 and over only.**
- **Refunds:** 7 days from the first payment if less than 10% of the period's minutes are used; unused top-up packs refundable for 7 days; nothing for a period already started; failed runs are never counted.
- **Cancelled accounts:** locked, content kept; deleted only if the owner asks, or with at least 30 days' email notice. (Storage for locked accounts therefore grows until you decide on a limit.)
- **Account deletion** is by email request for now; there is no self-service button yet.
- **Liability** is limited to what the customer paid in the previous 12 months.
- **Watermark** on Free and Starter clips may not be removed. A test fails if the plans with a watermark change without these pages being revisited.
- **Privacy:** says the video, its audio and transcript, and captions go to Google, Anthropic and OpenAI, and files to Cloudflare. If you change providers, update the list. It makes no claim about how those providers use API data: check their terms and add what you can truthfully say.

## For the lawyer

- Jurisdiction, governing law, the liability cap, and whether the arbitration or class-action terms you want are missing.
- Privacy law that applies to your customers (GDPR/UK, California, others), including a data-processing basis and any transfer wording.
- **US copyright safe harbour** (DMCA) usually requires registering a designated agent with the US Copyright Office; the page names `COPYRIGHT_EMAIL` as the contact but registration is a separate step.
- Whether customers uploading other people's podcasts needs stronger terms (for example a warranty that they hold the rights).
- Sales tax or VAT on subscriptions (Stripe Tax is a setting in Stripe).

## Handling a takedown notice

When a valid notice arrives at `COPYRIGHT_EMAIL`:

```bash
npm run admin -- takedown <run-id or clip-id>
```

This removes the whole run (its stored video and all its clips) and prints who owned it and the captions. Tell the account holder, keep a note of the notice,
and for repeat offenders end the account. (A clip id takes down the run it came from, because clips are made and kept per run.)
