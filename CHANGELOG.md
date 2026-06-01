# Changelog

## 2.0.0 — Renamed to MiniMax Copilot + thinking-effort picker removed

This release bundles the marketplace rename with a round of
behavioural fixes. Some of these are user-visible (a UI element is
gone, the Copilot status-bar context widget now reports the right
numbers); most are behind-the-scenes hardening.

### New features

- **Usage dashboard** — new **`MiniMax: Open Usage Dashboard`**
  command plus a clickable status-bar item that shows today's /
  7-day / 30-day token usage (input, cache read, cache write,
  output, requests) sourced from the local cumulative counter.
  The dashboard also pulls the platform `coding_plan/remains`
  endpoint (5h reset, weekly limit, subscription expiry) when an
  API key is configured, and degrades gracefully when it's not.
  The usage counter now totals `requests` correctly (it didn't
  before) and persists a per-day bucket so the dashboard's
  30-day bar chart stays accurate across midnight rollovers.

### Breaking changes

- **Marketplace listing renamed to "MiniMax Copilot"** so the
  GitHub Copilot integration intent is obvious at a glance. The
  extension ID (`klarkxy.minimax-vscode`), publisher, command
  names, configuration keys, walkthrough, and `SecretStorage` key
  are all unchanged — existing installations upgrade in place and
  keep all their settings.
- **Four-level Thinking mode dropdown removed from the model
  picker.** MiniMax's Anthropic-compatible endpoint only accepts a
  binary `thinking: { type: "disabled" | "adaptive" }` toggle (see
  the [OpenAPI spec](https://platform.minimaxi.com/docs/api-reference/text/api/openapi-chat-anthropic.json));
  the `budget_tokens` field, the `reasoning_effort` URL parameter,
  and the `reasoning_split` field on the Anthropic surface simply
  do not exist, and the official `Mini-Agent` reference client
  confirms this by shipping `extra_body={"reasoning_split": true}`
  hardcoded with no UI for depth. Sending any of those triggered
  HTTP 404 on the gateway.
  - We **always** send `thinking: { type: "adaptive" }` for
    thinking-capable models, force `temperature: 1`, and drop
    `top_p` per the Anthropic constraint.
  - Restoring the picker, once MiniMax ships a typed effort
    parameter, is a single-file change in `src/provider/models.ts`.

### New features

- **Per-model sampling overrides.** New top-level
  `minimax.sampling` configuration object lets you set
  `temperature` / `topP` / `topK` / `frequencyPenalty` per model ID
  without code changes. `temperature` and `topP` are ignored when
  the model is in `thinking: adaptive` mode (Anthropic's
  constraint); `topK` and `frequencyPenalty` are always honoured.
  Example: `{ "MiniMax-M2.7": { "temperature": 0.2, "topK": 40 } }`.
- **Per-model `extra` escape hatch.** New experimental
  `minimax.experimental.modelDefPresets` object lets you merge
  arbitrary keys into the Anthropic request body — useful for
  `stop_sequences`, `service_tier`, `metadata`, or whatever
  MiniMax adds next. 11 reserved keys (the Anthropic-required
  fields and the constrained `temperature` / `top_p` / `top_k` /
  `frequency_penalty`) are rejected; `tools` is concatenated
  rather than replaced.
- **Anthropic `cache_control` breakpoints on system + last tool.**
  The system prompt and the last tool definition now carry
  `cache_control: { type: "ephemeral" }` so they count toward the
  cached prefix on subsequent turns. A new
  `enforceCacheControlBudget()` helper caps the total at the
  Anthropic-imposed 4-breakpoint ceiling and trims in-message
  breakpoints first when the host already emits its own
  breakpoints (preventing HTTP 400 from too many breakpoints).

### Fixes

- **Copilot status-bar context widget now reports cache writes.**
  `reportCopilotContextUsage` previously sent only
  `usage.input_tokens` as `prompt_tokens`, which understated the
  full computational cost on cache-creation turns (Anthropic
  charges for the full input prefix when *writing* the cache
  entry). The data part now aggregates
  `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`,
  matches the oai-compatible-copilot upstream, and skips the part
  entirely on zero-usage turns.
- **Git commit-message generator now actually fetches the diff.**
  `buildScmContext` used to read the diff from the VS Code Git
  extension's typed `state.diff` shape, which is empty in modern
  VS Code — so the prompt contained only the file list and the
  model had to "invent" the diff. A new `extractDiffViaGitCli`
  helper spawns `git --no-pager diff --staged --diff-filter=d`
  (falling back to `git --no-pager diff HEAD --diff-filter=d`) as
  a 16 MiB / 10 s bounded fallback. Spawn errors degrade
  gracefully to the file-list-only prompt.

### Notes

- The 1.6.0 → 2.0.0 version bump is **partly cosmetic** (the
  rename) and **partly substantive** (everything above). If you've
  pinned to `klarkxy.minimax-vscode` in a settings sync or DevOps
  manifest, the ID is unchanged.
- The `configurationSchema` field on `MiniMax*` chat info entries
  is now always undefined. Custom automation that introspected the
  picker schema for a `reasoningEffort` field must adapt.

## 1.6.0 — Anthropic-only, 512K M3, in-picker pricing, endpoint auto-select, commit-message generator

Breaking-change release. The extension now talks exclusively to the
**Anthropic-compatible** endpoint of MiniMax. The OpenAI-compatible
transport has been removed.

### Why Anthropic-only?

MiniMax officially recommends the Anthropic-compatible endpoint for new
integrations (it supports thinking blocks, image content blocks, tool
calling, and Anthropic's `signature_delta` verification natively). The
OpenAI-compatible transport is retained only for historical models that
do not yet have Anthropic coverage — none of the M-series programming
models fall in that bucket.

### New model capabilities

- **MiniMax M3 is now first-class**:
  - Native Anthropic `thinking` parameter with `budget_tokens` (1024 /
    8192 / 32768 for light / standard / deep).
  - Native `image` content blocks; the previous `imageInput: false` cap
    is removed for M3.
  - **Effective context capped at 512K.** The official spec is 1M, but
    the >512K input tier is 限时限量供应 and the API rejects requests
    with `max_tokens > 512_000`. We advertise 1M as the headline figure
    (so VS Code shows the model's true ambition) but clamp effective
    input + output to 512K until the rollout completes.

### Pricing in the UI

- Each model now carries a `pricing` field
  (`{ input, output, cacheRead, cacheWrite, currency, note }`).
- The model picker shows `¥X.XX in / ¥Y.YY out /M tokens` in the
  `detail` line; the full breakdown (including cache read/write and any
  note) appears in the tooltip.
- New command **MiniMax: Show Pricing** opens the full pricing table
  in a Markdown preview, including the 7-day half-price note for M3
  and the limited-availability warning for the >512K tier.

Pricing was scraped from
[platform.minimaxi.com/docs/guides/pricing-paygo](https://platform.minimaxi.com/docs/guides/pricing-paygo)
and the
[Token Plan page](https://platform.minimaxi.com/subscribe/token-plan?tab=api-enterprise).
Historical models (M2.5, M2.1, M2) are no longer recommended by MiniMax
and are not shipped by this release; they can be re-added by power
users via `minimax.modelIdOverrides` and `minimax.visibleModels`.

### New / changed configuration

| Setting | Change | Default |
| --- | --- | --- |
| `minimax.apiBaseUrl` | Anthropic URL | `https://api.minimaxi.com/anthropic` |
| `minimax.maxTokens` | hard cap respected | `0` |
| `minimax.commitModel` | new setting | `MiniMax-M2.7` |
| New command `MiniMax: Show Pricing` | — | — |
| New command `MiniMax: Generate Commit Message` | — | — |

The `switchToGlobal` and `switchToChina` commands now point to the
AnthGit commit message generator

- New command **MiniMax: Generate Commit Message** is also wired into
  the `scm/inputBox/title` menu so it sits next to the Copilot sparkle
  button.
- Reads staged changes through VS Code's built-in Git extension
  (falling back to working-tree changes when nothing is staged), caps
  the diff at 32 KB and the file list at 80 entries, and trims a
  pre-existing draft in the input box as a polish request.
- Emits a Conventional-Commits-style message
  (`<type>(<scope>)<!>: <subject>` with a bullet body) at
  `temperature: 0.2` and `max_tokens: 256` for a reproducible first
  draft.
- Model is `minimax.commitModel`, defaulting to `MiniMax-M2.7`. Switch
  to `MiniMax-M3` when the diff needs deeper reasoning.

### Architecture changes

- Dependency: `openai` → `@anthropic-ai/sdk` (Apache 2.0).
- New non-streaming helper `MiniMaxClient.completeChat()` powers the
  commit-message generator (and any future one-shot utilities that
  don't need the stream-callback ceremony

- Dependency: `openai` → `@anthropic-ai/sdk` (Apache 2.0).
- `src/types.ts` mirrors the Anthropic Messages API shape
  (`messages[].content` is an array of content blocks;
  `system` is a top-level field; `thinking.type ∈ {enabled, disabled}`;
  `tool_use.id`, `tool_result.tool_use_id`, etc.).
- `src/provider/replay` markers now carry `thinkingBlocks` (with
  `signature`) instead of `reasoningDetails` so the model can verify
  spliced-in thinking across conversation turns.
- `src/provider/convert.ts` extracts system messages into the
  top-level `system` field, emits `tool_use` / `tool_result` content
  blocks, and forwards image parts as Anthropic `image` blocks (base64
  or data-URI source).
- `src/provider/stream.ts` consumes Anthropic stream events
  (`message_start`, `content_block_start`, `content_block_delta` with
  `text_delta` / `thinking_delta` / `input_json_delta` / `signature_delta`,
  `content_block_stop`, `message_delta`, `message_stop`).
- The provider re-uses Anthropic's `usage` shape:
  `input_tokens`, `output_tokens`, `cache_read_input_tokens`,
  `cache_creation_input_tokens`.
- Error mapping extended with 403, 408, 413, 529 (Anthropic overload).

### Build

- `npm run compile` (tsc) and `npm run build` (esbuild) both pass.
- Bundle: `out/extension.js` is 226 KB (up from 161 KB due to the
  Anthropic SDK; could be reduced with a tree-shaking pass in a
  follow-up).

### Migration notes

- The public package name, vendor ID, command IDs, walkthrough IDs,
  SecretStorage key, and most configuration keys are unchanged.
- `minimax.apiBaseUrl` default changed: the previous
  `https://api.minimax.io/v1` / `https://api.minimaxi.com/v1` values
  will keep working (we still read the setting verbatim), but the new
  defaults are Anthropic URLs.
- Models removed from the default picker: M2.5, M2.5-highspeed, M2.1,
  M2.1-highspeed, M2. MiniMax no longer recommends them; power users can
  re-add via `minimax.modelIdOverrides` and `minimax.visibleModels`.
- **Endpoint auto-selection:** on first activation, if
  `minimax.apiBaseUrl` is still at its factory default, the extension
  picks an endpoint from `vscode.env.language` (`zh*` → China, anything
  else → international). The choice is persisted, and any later manual
  change wins permanently.

## 1.5.0 — Refactor with deepseek-v4-for-copilot architecture

(unchanged summary; see the README and prior git history for details)
