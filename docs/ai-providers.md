# AI providers

All model calls go through `src/lib/ai/`. Nothing else in the app knows which provider answered.

| Provider | Used for | Key |
|---|---|---|
| Google Gemini | watching video (uploaded through Google's Files API), and writing captions | `GOOGLE_API_KEY` |
| Anthropic Claude | writing captions (the humor), with the long audience profile cached between calls | `ANTHROPIC_API_KEY` |
| OpenAI GPT | writing captions (a fallback from a different vendor) | `OPENAI_API_KEY` |
| kie.ai | optional reseller for all of the above, kept while its credits last | `KIE_API_KEY` |

Only Google (or kie.ai's Gemini) can watch video; Claude and GPT only ever get text.

## Models

A model is written `provider:model`, e.g. `google:gemini-3.1-pro` or `anthropic:claude-fable-5-1` (no prefix means kie.ai).
Defaults, best first:

- **Video** (watching and checking each clip): Google fast model, then Google Pro model.
- **Captions**: Claude writer, Gemini Pro, GPT, Claude balanced, Gemini fast. Accounts on the `standard` tier skip the most expensive ones.

Change names with `GOOGLE_FLASH_MODEL`, `GOOGLE_PRO_MODEL`, `ANTHROPIC_WRITER_MODEL`, `ANTHROPIC_BALANCED_MODEL`, `OPENAI_MODEL`,
or set a whole chain with `MEME_BUILDER_VIDEO_MODELS` / `MEME_BUILDER_TEXT_MODELS` (comma lists).
**Provider docs disagree about exact model names, so run `npm run models:check` after setting keys.** It asks each provider's own
model list whether the configured names exist, and prints what is available.

## How a call behaves

A temporary failure (server error, rate limit, network) is retried with backoff and then the next model in the chain takes over;
a permanent one (bad key, out of credit, unknown model) moves straight to the next model. A model that just failed is skipped for
three minutes. A model that can't read the uploaded video (wrong provider) is left out of that call. If the account is out of credit
or the key is wrong, the user is told in plain words and the server log has the detail.

## Moving off kie.ai

1. Set `GOOGLE_API_KEY` (and `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`), run `npm run models:check`, fix any names it flags.
2. With keys set, the defaults already prefer the direct providers and keep kie.ai as the last fallback, so credits get used only
   when the direct ones fail. To spend kie.ai credits first instead, list them first in the chains.
3. When the credits are gone, remove `KIE_API_KEY`. Nothing else changes.
