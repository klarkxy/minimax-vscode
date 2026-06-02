# Changelog

## 2.1.2 — Status-bar trim, dashboard layout, CI fixes

Three threads in this release: trim the status bar to the two
platform quota items, give the dashboard's Token Plan section a
proper layout, and unblock CI.

### Changes

- **Daily-token status bar item removed.** The
  `$(graph) MiniMax 1.2k` slot is gone; today's token totals live
  in the dashboard (**MiniMax: Open Usage Dashboard**) and the
  **MiniMax: Show Usage** command.
- **Status bar now shows the *used* percent.** The 5h and Week
  items read `5h 54%` / `Week 88%` to mean "I've used 54% / 88% of
  the quota". The colour thresholds (≥85% red, 60-85% yellow,
  <60% green) match the dashboard's progress bar, and the tooltip
  still carries the full "used X / Y, remaining Z%" breakdown.
- **Status bar uses foreground-only colors.** The `$(bolt) 5h …`
  and `$(calendar) Week …` items use the `*Foreground` theme
  tokens. They blend with the rest of the status bar instead of
  looking like five independent buttons.
- **Dashboard Token Plan section reorganised.** The two quota
  windows (5h and Week) each render as a single card: the
  percentage on the bar, the reset time as a small pill on the
  right end of the title row. The orphan weekly-progress bar,
  the duplicate "Used: X / Y" data cards, and the per-model
  breakdown table are gone. Card titles are now consistent
  (`GENERAL · 5h` and `周额度`) so the pair reads naturally.
- **Removed unused i18n keys** that only existed for the deleted
  daily-token status bar (`status.tooltip`, `status.tooltipEmpty`,
  `status.tooltipActive`, and a duplicate `status.tooltipActive_zh`).
- **Release-please workflow fixed.** `.github/workflows/release.yml`
  was failing validation because it referenced `secrets.*`
  inside step `if:` conditions, which the GitHub Actions
  expression grammar disallows. The publish-gate conditions now
  use `vars.*` and the secret-presence check moved into a bash
  guard inside the step.
- **Marketplace publish steps removed from `release.yml`.** The
  "Publish to VS Code Marketplace" and "Publish to Open VSX"
  steps were guarded behind `vars.PUBLISH_*` toggles that were
  never set, so they were dead code. When you do want to publish
  to a marketplace, `rescue.yml` still exists for one-off manual
  runs. Its three publish toggles now default to `false`, so it
  can never silently fail with an empty token.
- **All three workflows opted into Node.js 24.** GitHub is
  deprecating the Node 20 runtime for third-party Actions on
  2026-06-16; `release-please-action@v4` was already warning
  about this on every run. All three workflows (CI / Release /
  Rescue) now set `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: 'true'`
  at the job level. Drop the env var once the `googleapis/*`
  and `actions/*` releases we depend on publish Node-24 builds.

The donut centre in the dashboard still shows the all-in token
total (input + cacheWrite + cacheRead + output), the same number
you multiply against the per-model price table. The legend breaks
out the four buckets individually, so the share that hit cache is
immediately visible.

## 2.1.1 — Dual-currency pricing + donut token chart

A small, mostly-visible release. The model-pricing table now picks
USD or CNY automatically based on the user's `minimax.apiBaseUrl`
and `vscode.env.language`, and the usage dashboard's local card
redraws the token breakdown as a donut chart with percentages.

### Features

- **Dual-currency pricing (USD / CNY).** The single-CNY price table
  splits into `PRICING_CNY` and `PRICING_USD`. A new
  `pickPricingTable()` helper picks the right one at runtime:
  - `apiBaseUrl` contains `minimaxi.com` → CNY (¥), regardless of
    locale.
  - Otherwise, Chinese locales (`zh`, `zh-*`, `zh_*`) → CNY (¥).
  - Everything else → USD ($).
  - `MODELS` is renamed `MODEL_TEMPLATES`. A new `getModels(baseUrl)`
    expands the pricing field from the chosen table. Every UI
    surface that renders prices (model-picker tooltip,
    **MiniMax: Show Pricing** command, commit-model picker, replay
    markers) goes through `getModels()` so the symbol matches the
    user's billing currency.
  - `README.md` uses USD as the primary table; `README.zh.md` uses
    CNY. Both files have a callout pointing at the other price
    site and noting that the picker / **Show Pricing** command
    render the table that matches the active `minimax.apiBaseUrl`.
  - New helpers `isChineseLocale()` and `isChinaBaseUrl()` are
    exported from `src/models/registry.ts` for any future code that
    needs the same routing logic.
  - `ModelPricing.currency` widens to the union `'CNY' | 'USD'`
    (was hard-coded to `'CNY'`).
- **Status-bar quota items (`5h 73%` / `Week 11%`).** Two new
  `StatusBarItem`s sit to the right of the existing
  `$(graph) MiniMax 1.2k` daily counter and show the platform's
  5-hour and weekly quotas at a glance:
  - `$(bolt) 5h 73%` — **remaining** percent of the 5h reset window.
  - `$(calendar) Week 11%` — **remaining** percent of the weekly
    limit (or `∞` when the plan reports an unlimited weekly budget).
  - Coloured via the built-in
    `statusBarItem.remoteBackground` / `warningBackground` /
    `errorBackground` theme tokens (green when plenty left, red when
    low) so the bar stays legible in both light and dark themes.
  - Hovering shows a `X / Y · resets in Hh Mm` summary that mirrors
    the dashboard's quota card (the `X / Y` pair is omitted when the
    platform did not report a total, same as the dashboard's fix
    below). Clicking either item opens the dashboard.
  - Without an API key both items render a muted em-dash placeholder
    and the tooltip nudges the user to run **MiniMax: Set API Key**.
- **Shared `PlanCache` between Dashboard and status bar.** A new
  `createPlanCache()` in `src/dashboard/aggregator.ts` keeps the
  last successful `coding_plan/remains` response in a single
  in-process store and broadcasts updates to any subscribers
  (dashboard panel, status-bar items, future surfaces). Concurrent
  `refresh()` calls deduplicate to one HTTP request, while the
  underlying `fetchPlanUsage` 8s TTL still throttles the actual
  transport. The extension invalidates the cache whenever
  `AuthManager.onDidChangeApiKey` fires, so switching API keys
  immediately re-renders the right quota.
- **Event-driven plan refresh — no background timer.** The plan
  cache pulses on five events, all already in the extension's
  critical path:
  1. Extension activation / first command registration (so the
     status bar shows a real value within a few seconds of VS Code
     opening, not only after the user opens the dashboard).
  2. `AuthManager.onDidChangeApiKey` (set / clear / rotate key).
  3. `vscode.workspace.onDidChangeConfiguration` for
     `minimax.apiBaseUrl` (covers **MiniMax: Switch to Global /
     Chinese API**, which updates config but not auth state).
  4. `ChatTurnNotifier.onTurnEnd` (a new event emitter fired once
     per Copilot user-facing turn by
     `MiniMaxChatProvider.provideLanguageModelChatResponse`, **not**
     once per internal API request). The notifier throttles to one
     broadcast per 30 s window so a user banging out 10 turns in a
     row still triggers at most one platform fetch.
  5. Dashboard open / Refresh / view-state-visible (the existing
     path, now also routed through the shared cache so the status
     bar sees the same response).
  No `setInterval` is installed. The extension does no background
  network work when idle. The dashboard's `DashboardPanel.refresh()`
  now calls `planCache.refresh()` instead of `fetchPlanUsage`
  directly, so the two consumers always render the same snapshot.

### Fixes

- **Usage dashboard local card now renders as a donut chart.**
  The flat key-value list (input / cache read / cache write / output)
  is replaced with a `conic-gradient` donut and a colour-coded
  legend that shows each token type, its count, and its share of
  the total. The donut is built from the same four `var(--accent)` /
  `var(--good)` / `var(--warn)` / `var(--bad)` CSS tokens the rest
  of the dashboard already uses, so the colours stay in sync with
  the theme. The `requests` count is preserved in a footer row
  below the chart, and on viewports ≤480 px the donut and legend
  stack vertically for readability.
- **Token Plan panel no longer shows meaningless "0 / 0" pairs.**
  Some platform quota models (notably `general`) return a
  `current_interval_remaining_percent` *without* a matching
  `current_interval_total_count`, so the dashboard used to render
  `0 / 0` for the used/total numbers even when the progress bar
  clearly showed a real percentage. Following the
  [minimax-status](https://github.com/JochenYang/minimax-status)
  reference, the renderer now:
  - Drops the `X / Y` suffix from the progress bar entirely when
    `total === 0`, leaving just the bar + percentage.
  - Hides the `Used: X / Y` row in the 5h / weekly cards when no
    total was reported, so the card collapses to the reset-time
    row (mirroring the "title · reset-time" layout used by
    minimax-status).
  - Renders an em-dash (`—`) in the per-model table's
    used/total cells when the model has no reported total, so
    the table stays tabular-aligned.
  The platform gives no way to derive a real used count when the
  total is missing (`current_interval_usage_count` is unreliable
  on quota models, see the long comment in
  [minimax-status/.../api.js](https://github.com/JochenYang/minimax-status)).
  Hiding the missing numbers is the right call.
- **Token counters no longer double-count Anthropic cache fields.**
  The Anthropic Messages API reports `input_tokens` as the
  *incremental, non-cached* input and reports
  `cache_creation_input_tokens` / `cache_read_input_tokens` on top
  of that. The old `totalTokens()` summed all four, so every
  cache-creation turn added the entire prompt prefix a second
  time: a typical day with a 1M-token system prompt cached across
  many turns could read as 10-50M "tokens" even though the
  underlying bill was much smaller. `totalTokens()` now returns
  `input + output` only. A new `totalBilledTokens()` helper
  returns the all-in number (`input + cacheWrite + cacheRead +
  output`) for callers that need to multiply by the per-model
  price table. The dashboard donut centre shows the net total;
  the legend still breaks out the cache slices, so you can see
  *how much* of the day's traffic hit cache.
- **Daily-token status bar item removed.** The previous
  `$(graph) MiniMax 43.66M` slot was deleted for two reasons:
  (a) the number was a side effect of the cache double-count bug
  above and was actively misleading, and (b) it crowded the
  status bar next to the 5h / Week quota items. Today's token
  totals now live in the dashboard (**MiniMax: Open Usage
  Dashboard**) and the **MiniMax: Show Usage** command; the
  status bar only carries the two platform quota items.
- **Quota status bar uses foreground-only colors.** The
  `$(bolt) 5h …` and `$(calendar) Week …` items now use the
  foreground theme tokens (green / yellow / red) and no longer
  paint their background, so they blend with the rest of the
  status bar instead of looking like five independent buttons.

## 2.0.0 — Renamed to MiniMax Copilot + thinking-effort picker removed

This release bundles the marketplace rename with a round of
behavioural fixes. Some are user-visible (a UI element is gone, the
Copilot status-bar context widget now reports the right numbers);
most are behind-the-scenes hardening.

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
  are all unchanged, so existing installations upgrade in place
  and keep all their settings.
- **Four-level Thinking mode dropdown removed from the model
  picker.** MiniMax's Anthropic-compatible endpoint only accepts a
  binary `thinking: { type: "disabled" | "adaptive" }` toggle (see
  the [OpenAPI spec](https://platform.minimaxi.com/docs/api-reference/text/api/openapi-chat-anthropic.json));
  the `budget_tokens` field, the `reasoning_effort` URL parameter,
  and the `reasoning_split` field on the Anthropic surface simply
  do not exist. The official `Mini-Agent` reference client
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
  arbitrary keys into the Anthropic request body, useful for
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
  breakpoints, which prevents HTTP 400 from too many breakpoints.

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
  VS Code, so the prompt contained only the file list and the
  model had to "invent" the diff. A new `extractDiffViaGitCli`
  helper spawns `git --no-pager diff --staged --diff-filter=d`
  (falling back to `git --no-pager diff HEAD --diff-filter=d`),
  capped at 16 MiB / 10 s. Spawn errors degrade gracefully to the
  file-list-only prompt.

### Notes

- The 1.6.0 → 2.0.0 version bump is partly cosmetic (the rename)
  and partly substantive (everything above). If you've pinned to
  `klarkxy.minimax-vscode` in a settings sync or DevOps manifest,
  the ID is unchanged.
- The `configurationSchema` field on `MiniMax*` chat info entries
  is now always `undefined`. Custom automation that introspected the
  picker schema for a `reasoningEffort` field must adapt.

## 1.6.0 — Anthropic-only, 512K M3, in-picker pricing, endpoint auto-select, commit-message generator

Breaking-change release. The extension now talks exclusively to the
**Anthropic-compatible** endpoint of MiniMax. The OpenAI-compatible
transport is gone.

### Why Anthropic-only?

MiniMax officially recommends the Anthropic-compatible endpoint for new
integrations. It supports thinking blocks, image content blocks, tool
calling, and Anthropic's `signature_delta` verification natively. The
OpenAI-compatible transport is kept only for historical models that
don't yet have Anthropic coverage; none of the M-series programming
models fall in that bucket.

### New model capabilities

- **MiniMax M3 is now first-class**:
  - Native Anthropic `thinking` parameter with `budget_tokens` (1024 /
    8192 / 32768 for light / standard / deep).
  - Native `image` content blocks; the previous `imageInput: false` cap
    is removed for M3.
  - **Effective context capped at 512K.** The official spec is 1M, but
    the >512K input tier is in limited release and the API rejects
    requests with `max_tokens > 512_000`. We advertise 1M as the
    headline figure (so VS Code shows the model's true ambition) but
    clamp effective input + output to 512K until the rollout
    completes.

### Pricing in the UI

- Each model now carries a `pricing` field
  (`{ input, output, cacheRead, cacheWrite, currency, note }`).
- The model picker shows `¥X.XX in / ¥Y.YY out /M tokens` in the
  `detail` line; the full breakdown (including cache read/write and any
  note) goes into the tooltip.
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
  Anthropic endpoint.

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
  keep working (we still read the setting verbatim), but the new
  defaults are Anthropic URLs.
- Models removed from the default picker: M2.5, M2.5-highspeed, M2.1,
  M2.1-highspeed, M2. MiniMax no longer recommends them; power users can
  re-add via `minimax.modelIdOverrides` and `minimax.visibleModels`.
- **Endpoint auto-selection:** on first activation, if
  `minimax.apiBaseUrl` is still at its factory default, the extension
  picks an endpoint from `vscode.env.language` (`zh*` → China, anything
  else → international). The choice is persisted; any later manual
  change wins permanently.

## 1.5.0 — Refactor with deepseek-v4-for-copilot architecture

(unchanged summary; see the README and prior git history for details)
