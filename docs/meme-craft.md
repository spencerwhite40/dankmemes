# What makes a reaction clip land

This is the craft the pipeline is built to follow. Each rule says what it is, why it matters, and where the code
makes it happen, so a change to a prompt can be checked against the rule it serves.

A dankmemes clip is a **reaction meme**: a caption on top describes a moment from the viewer's own life, and the
clip underneath is the reaction to it. The clip is about something else entirely. It works when the viewer reads
the caption, the clip plays, and within two seconds they think "that's literally me" and send it to someone.

## The rules

| # | Rule | Why | Where it lives |
|---|---|---|---|
| 1 | **Caption is the setup, clip is the punchline.** Never put the punchline in the caption, and never describe what the clip shows. | A caption that is already a whole joke leaves the clip nothing to do, and the viewer has no reason to watch. | `STYLE_RULES` in `src/lib/captions.js` |
| 2 | **Match the feeling, not the topic.** A smug voice fits the person who talks down to us; an exasperated sigh is us. | The topic of the clip never matches the viewer's life. The feeling and the social dynamic (condescension, a dodge, getting caught, quiet defeat) do. | Moment finding (`analyze.js`: emotion, dynamic, intensity); `STYLE_RULES`; the verify check scores the fit by watching the clip (`refine.js`) |
| 3 | **Relatable.** It happens to most of the audience, often. | Shares come from "this is us", and a shared recurring pain beats a clever one-off story. | `STYLE_RULES`; the score needs it for a 7 (`SCORE_RULE`); the situation bank is made of recurring moments only |
| 4 | **Specific.** One concrete insider detail: a number, a term, a time, a place. One, not three. | The detail is what makes an insider feel seen. Stacking details makes it a paragraph. | `STYLE_RULES`; the persona's vocabulary and bank; `SCORE_RULE` |
| 5 | **Instant.** The caption reads in two seconds, and the link to the clip clicks without explaining. | People scroll. If it takes a sentence to explain why the two fit, it doesn't fit. | `STYLE_RULES` (unusable if it needs explaining); `SCORE_RULE`; verify fit 1 to 3 drops the clip |
| 6 | **Short.** Ideally under 12 words, never over 100 characters. | Two seconds of reading at phone size. | `STYLE_RULES`; the caption card keeps text big (76 px) and at most 4 lines |
| 7 | **Don't explain the joke.** No "because", no moral, no "lol". Deadpan beats exclamation marks. | Explaining kills it, and deadpan reads as more confident. | `STYLE_RULES` |
| 8 | **Vary the format.** "When...", "POV:", "Me when...", a role and their exact line, numbers first, "The way...". | A feed of 30 clips that all start with "When" reads as a template. | `STYLE_RULES`; the persona's `caption_formats` |
| 9 | **Timing: room to read, then tight on the payoff.** About a second of lead-in while the caption is read, end just after the reaction lands, no dead air. | The caption needs time to be read, and a clip that runs past the beat loses the laugh. | Moment finding asks for setup and payoff bounds; verify re-cuts on a short excerpt with "cut tight, usually 4 to 12 seconds"; cuts snap to pauses in speech so no word is clipped (`cuts.js`) |
| 10 | **The words must not fight the caption.** | If the speaker is clearly talking about cars, a caption about rent clashes. | Moment finding marks words as neutral or topic; `STYLE_RULES` |
| 11 | **Audience-specific, never outsider.** Their vocabulary, their people, their running jokes, and none of their "never say" list. | An outsider word ruins it instantly for insiders. | The persona (`personas.js`): vocabulary, recurring characters, never say, good vs bad, the situation bank |
| 12 | **Fresh, not the obvious five jokes.** | Every audience has a handful of topics that are already memed to death. | Per audience `overused_topics`; the situation bank rotates areas of life; captions already used in the video are passed on |
| 13 | **Spice is sprinkled, never the whole batch.** Suggestive, never explicit, never punching at identity. | Crude lands when the scene calls for it; a crude batch reads as try-hard. | `SPICE_RULE` plus the audience's own `spice_notes` |
| 14 | **A longer bit gets a hook, not a spoiler.** | For a 30 to 60 second take, the caption's job is to make you watch to the end. | `STYLE_RULES` |
| 15 | **The look people recognise.** A white card with black bold text directly on top of the video, the pair a little above the middle, clear of the app's buttons. | It reads as a meme at a glance, and the text is never lost on a busy background. | `captionLayout` in `src/lib/render.js` |

## How a clip is graded

The caption writer scores its own pick from 1 to 10, harshly. A 7 or more needs all four of: relatable, specific,
instant, and the clip itself is the punchline. Then the video model watches each picked clip with the candidate
captions and gives a fit from 1 to 10. Fit replaces the writer's score, because it comes from something that saw and
heard the clip. A fit of 3 or less drops the clip, and a spare takes its place.

## Worked examples

These are written by hand to show the rules. They are not output from a model run.

The clip: someone leans back and says "woah woah buddy, you have no idea what you're talking about".

| Caption | Verdict |
|---|---|
| When someone disagrees with you | Fails 3 and 4: true of everyone, so it lands with no one. |
| When the broker offers 20% under spot and calls it "the market" because rates are down this week | Fails 6 and 7: too long, and "because..." explains it. |
| Broker offers 20% under spot. Me: "I'll pass." Broker: "OK, $400 more" | Fails 1: the whole joke is in the caption, and the clip adds nothing. |
| **When the broker offers 20% under spot rate** | Passes: a recurring pain, one real number, reads in two seconds, and the clip is the answer. |

The same clip for a different audience:

| Audience | Caption |
|---|---|
| Night-shift nurses | When the new grad says nights are the easy shift |
| Landlords' tenants | When the landlord says the rent is only going up a little |
