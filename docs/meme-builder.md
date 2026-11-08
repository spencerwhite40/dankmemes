# How Meme Builder works

## A run, step by step

```
upload (or reuse a stored video) ──► stored in R2
   queued job ──► runner:
     1. fetch + probe the video
     2. a small 360p copy goes to the model host           (skipped when the video was already analysed)
     3. a video model WATCHES the whole video and picks moments that show one clear, reusable feeling
        (feeling, dynamic, intensity, whether the words are neutral, quick reaction or longer bit)
     4. the audience's profile writes 3 candidate captions per moment, based on situations drawn from
        different areas of life (the bank), told what is already used in this video
     5. the video model watches each chosen moment, fixes its exact start/end, and picks which caption
        the clip delivers best (its 1-10 fit is the clip's score); clips no caption fits are dropped
     6. ffmpeg: cut (edges snapped to pauses in speech), 9:16 layout over a blurred background,
        caption burned in, light audio levelling ──► clips stored, shown on the page as they finish
```

Step 3 is audience-agnostic and cached on the job, so re-making clips for another audience reuses it.
Videos up to 25 minutes are watched in one pass; if the model service keeps failing, the run retries with shorter
overlapping pieces. Longer videos are cut into 10-minute pieces up front.

## Models

All model calls go through `src/lib/kie.js` (currently the kie.ai gateway): watching and checking use Gemini Flash
first with Gemini Pro as a fallback; captions use Gemini 3.1 Pro first, then Claude, GPT and Flash. Every model
name can be overridden with `MEME_BUILDER_VIDEO_MODELS` / `MEME_BUILDER_TEXT_MODELS` (comma lists). Replacing this
file with direct provider clients is the next planned change; nothing else calls a model.

## Reliability

- A live run updates a heartbeat every 30 seconds; a run silent for 3 minutes (server restarted) is put back in the
  queue, checked every minute. A run orphaned 3 times fails.
- A temporary AI failure re-queues the run on its own (up to 3 tries); every run has a 45 minute watchdog.
- One bad clip never fails the others. Clips are saved the moment they render.
- If the source video has no sound track, the page says so.

## Operating it

- Storage: R2 when `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` are set (bucket `R2_BUCKET`), otherwise the
  local disk, which a restart wipes. The page shows a warning when it is on disk.
- `MEME_BUILDER_RUNNER=off` disables the runner in a process (run it elsewhere with `npm run worker`).
- `MEME_BUILDER_MAX_UPLOAD_MB` (default 500) caps uploads.
- Audience profiles live in `src/lib/presets/`. `situation_bank` is the pool of situations; the long lists
  (examples, in-jokes, characters, pain points) show a fresh random subset per batch so batches don't repeat jokes.

## Known limits

- Framing is the blurred-background layout; no face/speaker tracking yet.
- Copyright: clipping other people's content for commercial posting is the user's responsibility.
- One shared password for access; no accounts yet.
