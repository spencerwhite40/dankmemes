# Meme Builder

Pick an audience, give it a video, get captioned vertical reaction-meme clips.

A reaction meme is a caption describing a situation from the audience's life, plus a clip that is the perfect
reaction to it, even though the clip is about something else entirely. What has to match is the **feeling and the
social dynamic**, not the topic. This tool finds those moments, writes the captions in the audience's voice, checks
each pairing against the actual clip, and renders 9:16 clips with the caption burned in.

## The flow

1. **Watch.** A video model watches the whole video and picks moments that show one clear, reusable feeling.
2. **Write.** The audience's profile (voice, vocabulary, in-jokes, and a bank of ~500 situations) is used to write
   three candidate captions per moment.
3. **Check.** The video model watches each chosen moment and picks which caption it delivers best.
4. **Render.** ffmpeg cuts to the speech (snapped to pauses), lays the clip over a blurred background, burns in the
   caption, and lightly levels the audio. Clips appear on the page as they finish.

## Run it

```bash
cp .env.example .env     # fill in DATABASE_URL, KIE_API_KEY, APP_PASSWORD, SESSION_SECRET (and R2 for real use)
npm install
npm run migrate          # tables are also created on boot
npm start                # http://localhost:3000
npm test               # the API integration tests also run when DATABASE_URL_TEST points at a scratch Postgres
```

Local runs and tests use `DATABASE_URL_TEST` when it is set, so they can't touch a production database.

## Running the processing on a faster machine

Everything heavy (shrinking video, rendering) happens in the runner. By default it runs inside the web process. To move it:

- On the web app set `MEME_BUILDER_RUNNER=off`.
- Run `npm run worker` on the faster machine (see `fly.toml` / `Dockerfile`), with the same `DATABASE_URL`, R2 and
  model keys. Jobs are claimed from Postgres with `FOR UPDATE SKIP LOCKED`, so any number of workers can run at once.

## API

A versioned public API (API keys, per-customer isolation, usage, expiring playback links, webhooks) is documented in
[docs/api.md](docs/api.md). The web page and the API run the same code.

## Layout

```
public/            the whole interface (plain HTML + JS, no build step)
src/server.js      web app (API + page) and, unless disabled, the runner
src/routes.js      the API
src/worker.js      the job runner (claims queued jobs, retries, watchdog)
src/run-worker.js  runner only, for a separate machine
src/auth.js        one shared password (APP_PASSWORD) and a signed cookie
src/v1.js          the public API (API-key auth)
src/intake.js      starting a run (shared by the page and the API)
src/webhooks.js    signed run-finished callbacks
src/lib/           the pipeline: analyze, captions, refine, cuts, render, media, storage, store, personas, kie (model client)
src/lib/presets/   built-in audiences (truckers: profile + situation bank)
schema.sql         database tables
assets/fonts/      the caption font (Liberation Sans Bold, SIL OFL)
docs/              how it works in detail
```

## Status

Extracted from the Haulers app. Next: direct provider keys behind the model client (replacing kie.ai), a usage/cost
ledger, parallel rendering, and the Fly worker.
