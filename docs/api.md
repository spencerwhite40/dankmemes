# Meme Builder API (v1)

Base URL: your deployment, e.g. `https://memes.example.com`. All calls except playback links need an API key:

```
Authorization: Bearer mk_live_...
```

Create keys on the web page ("API keys") or `POST /admin/keys`. A key belongs to one **owner**; everything a key creates is
visible only to that owner. A key is shown once when created, along with its **webhook secret**.

Errors are JSON: `{ "error": "message", "code": "machine_code" }`. Common codes: `no_key`/`bad_key` (401), `quota_exceeded` (402),
`not_found` (404, also for other customers' ids), `rate_limited` (429, with `Retry-After`).

## Make clips

```bash
# from a file
curl -X POST $BASE/v1/runs -H "Authorization: Bearer $KEY" -H "Idempotency-Key: my-upload-123" \
  -F audience=truckers -F file=@podcast.mp4 -F webhook_url=https://example.com/hooks/memes

# from a direct video link (not YouTube/TikTok pages: those can't be downloaded by the server)
curl -X POST $BASE/v1/runs -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"audience":"truckers","source_url":"https://example.com/video.mp4","options":{"max_clips":12}}'
```

Returns `202 { "run": { "id", "status": "queued", ... } }`. Sending the same `Idempotency-Key` again returns the same run (`200`), so a
retried request never starts a second run (and never costs twice).

`audience` is an id from `GET /v1/audiences` (default `truckers`). `options`: `max_clips` (1-60), `min_score` (1-10, default keeps all).

## Follow a run

`GET /v1/runs/:id` returns `{ run, clips }`. `run.status` is `queued`, `running`, `done` or `error`; `run.stage` and `run.progress` say
where it is. Clips appear as they finish rendering, so you can show them while the run is still going. Poll every few seconds, or use the webhook.

Each clip has `caption`, `score`, `start_sec`, `end_sec`, and `video_url`: a signed link valid for an hour (`video_url_expires_at`) that
plays in a `<video>` tag with no key. Fetch the run again for a fresh link. Append `&download=1` to force a download.

## Webhook

If you gave `webhook_url`, a `POST` is sent when the run ends:

```json
{ "event": "run.finished", "run": { "id": "...", "status": "done", "clip_count": 11, "error": null, "finished_at": "..." } }
```

(`run.failed` with `status: "error"` on failure.) The `X-Meme-Signature: sha256=<hex>` header is an HMAC-SHA256 of the raw body using your
key's webhook secret. Verify it before trusting the call:

```js
const ok = crypto.timingSafeEqual(Buffer.from(req.headers["x-meme-signature"]),
  Buffer.from("sha256=" + crypto.createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex")));
```

Delivery is retried a few times, but not stored: always be able to fall back to polling. The URL must be a public address.

## Other endpoints

| | |
|---|---|
| `GET /v1/audiences` | built-in audiences plus your own |
| `POST /v1/audiences` `{ name, notes }` | describe an audience in plain words (20+ characters of notes); an AI builds its full profile |
| `GET /v1/runs` | your recent runs |
| `POST /v1/runs/:id/rerun` `{ audience?, options?, webhook_url? }` | new clips from an already stored video, no re-upload (skips re-watching) |
| `GET /v1/videos` | videos you have uploaded, to re-run |
| `GET /v1/clips/:id` | one clip with a fresh link |
| `POST /v1/clips/:id/rating` `{ rating: -1 \| 0 \| 1 }` | 👍/👎. Your ratings teach your audience's caption style (only yours) |
| `POST /v1/clips/:id/regenerate-caption` | write a new caption and re-render |
| `DELETE /v1/clips/:id` | delete a clip |
| `GET /v1/usage` | minutes processed this month and what remains of your quota |

## Limits

Each key has a request rate limit (default 120 per minute) and an optional monthly quota of source-video minutes. Hitting the quota
returns `402 quota_exceeded` on new runs; runs already started finish.
