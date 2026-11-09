# Email: confirming addresses and resetting passwords

The app sends two emails: the link that confirms an address, and the link that lets someone choose a new password.
It needs an email provider. Resend and Postmark are supported; set one.

## Setting it up

1. Create an account with [Resend](https://resend.com) or [Postmark](https://postmarkapp.com).
2. Add and **verify your sending domain** there. They give you DNS records (SPF and DKIM) to add at your domain's DNS host. Without this, mail goes to spam or is refused.
3. Create an API key (Resend) or a server token (Postmark).
4. Type these into the host's settings (never into git or chat):

   ```
   RESEND_API_KEY=...                         # or POSTMARK_SERVER_TOKEN=...
   EMAIL_FROM="Meme Builder <hello@your-domain.com>"   # an address on the verified domain
   APP_URL=https://your-app.example.com       # the links in emails point here
   APP_NAME=Meme Builder                      # optional: the name used in emails
   ```

5. Redeploy, create an account with a real address you own, and check that the confirmation email arrives. Then try "Forgot your password?".

## What it does

- **Sign-up** sends a confirmation link (works for 3 days). The account can be used straight away to look around, but **no run can start and no checkout can begin until the address is confirmed**. This stops throwaway addresses from farming the free tier.
- **"Send the email again"** is on the page for unconfirmed accounts, limited to 3 an hour.
- **Forgot password** sends a one-hour, single-use link. The answer is the same whether or not the address has an account, so it can't be used to find out who is registered. A newer link cancels the older one. Following a reset link also confirms the address, and signs the account out everywhere.
- Limits: 10 reset requests an hour per address of the visitor, and 3 an hour per email address.
- Tokens are random, only their hash is stored, and the link is removed from the browser's address bar as soon as the page opens.

## If email is not set up

Nothing is sent, confirmation is **not required** (nobody could confirm), and "Forgot password" says it isn't available. In production the server prints a `[setup]` warning at start-up. In development the message is printed to the console so you can follow the link.

For accounts that exist before email was set up: they will be asked to confirm on their next run. An admin can confirm one by hand:

```bash
npm run admin -- verify someone@example.com
```

## Not covered

Changing an account's email address, and sending billing receipts (Stripe sends those; turn them on in Stripe's settings).
