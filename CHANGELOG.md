# Changelog

## 2.0.0 — Renamed to MiniMax Copilot

**Breaking change** (display name only). The extension's marketplace
listing is now shown as **MiniMax Copilot** to make the GitHub
Copilot integration intent obvious at a glance. The extension ID,
publisher, command names, configuration keys, walkthrough, and
`SecretStorage` key are all unchanged — existing installations will
upgrade in place, see the new display name in their extension list,
and keep all their settings.

### Why the rename?

- The previous display name (`MiniMax (coding)`) read like a model
  name rather than a Copilot provider; renaming reduces confusion
  with other MiniMax models / tools.
- The new name aligns with the user's mental model: install
  **MiniMax Copilot** to add MiniMax as a model provider in GitHub
  Copilot Chat.

### Notes

- No code change between 1.6.0 and 2.0.0. The version bump is solely
  a UX / marketplace signal.
- If you've pinned to `klarkxy.minimax-vscode` in a settings sync or
  DevOps manifest, the ID is unchanged.

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
