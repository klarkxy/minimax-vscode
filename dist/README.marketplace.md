# MiniMax Copilot


<img src="https://vsmarketplacebadges.dev/installs-short/klarkxy.minimax-vscode.svg?style=for-the-badge" alt="Installs" />

> 🇬🇧 English | [🇨🇳 简体中文](./README.zh.md)

Language model chat provider for GitHub Copilot in VS Code using MiniMax
M-series models with a Token Plan API key. Talks to the **Anthropic-
compatible** endpoint of MiniMax — the protocol officially recommended by
MiniMax for new integrations.

> Architecture ported from
> [`deepseek-v4-for-copilot`](https://github.com/Vizards/deepseek-v4-for-copilot)
> (MIT) and adapted to the MiniMax Anthropic-compatible API.

## Features

- **Token Plan API key** from
  [platform.minimax.io](https://platform.minimax.io), stored in VS Code
  SecretStorage.
- **Anthropic-compatible protocol** to
  `https://api.minimaxi.com/anthropic` (China) or
  `https://api.minimax.io/anthropic` (international). Powered by the
  official [`@anthropic-ai/sdk`](https://www.npmjs.com/package/@anthropic-ai/sdk).
  On first activation the endpoint is auto-picked from the VS Code
  display language (`zh*` → China, anything else → international); a
  user-configured `minimax.apiBaseUrl` is never overridden.
- **Officially recommended MiniMax coding models**:
  - **MiniMax M3** — 1M context (effective 512K while the >512K tier is
    in limited rollout), native multimodal, 512K output cap, thinking
    with `budget_tokens`.
  - **MiniMax M2.7 / M2.7-highspeed** — 200K context, text-only, native
    Anthropic thinking.
- **Tool calling** with the experimental `stabilizeToolList` setting
  that synthesises preflight calls to keep the upstream prompt cache
  warm.
- **Adaptive token counting** calibrated from each API usage report.
- **Rich diagnostics**: request classifier (main-agent, terminal,
  todo-tracker, settings-resolver, background), cache-hit stats, full
  request dumps when `debugMode: verbose`, localised error messages
  with clickable actions.
- **Pricing in the model picker**: each model's per-million-token cost
  (input / output / cache read / cache write) is shown in the picker
  tooltip. Run **MiniMax: Show Pricing** for the full table.
- **Git commit message generation** in the SCM input box. Defaults to
  `MiniMax-M2.7`; switch to `MiniMax-M3` for harder refactors.
- **Replay markers** for cross-conversation reasoning context.
- **Bilingual UI** (English + Simplified Chinese, follows VS Code
  display language).

## Requirements

- VS Code 1.111.0+
- MiniMax Token Plan subscription and API key
- VS Code Insiders is required to render MiniMax thinking blocks via
  the proposed `languageModelThinkingPart` API
- VS Code's built-in Git extension must be enabled for the commit
  message generator to read the staged diff

## Setup

1. Get your Token Plan API key from
   [Account / Token Plan](https://platform.minimax.io/user-center/payment/token-plan).
2. Run **MiniMax: Set API Key** from the command palette (or use the
   API key navigation action in the model picker).
3. Choose a model in the Copilot model picker. Run
   **MiniMax: Show Pricing** to compare costs.

## Configuration

| Setting | Default | Purpose |
| --- | --- | --- |
| `minimax.apiBaseUrl` | `https://api.minimaxi.com/anthropic` | Anthropic-compatible base URL. Use `https://api.minimax.io/anthropic` for international users. The SDK appends `/v1/messages`. Auto-picked on first activation when unset. |
| `minimax.visibleModels` | _all M-series_ | Restrict which models appear in the picker. |
| `minimax.maxTokens` | `0` | Output cap. `0` lets the model decide. Hard cap: 131072 for M2.7, 512000 for M3. |
| `minimax.commitModel` | `MiniMax-M2.7` | Model used by **MiniMax: Generate Commit Message**. Switch to `MiniMax-M3` for complex refactors. |
| `minimax.debugMode` | `minimal` | `minimal` / `metadata` / `verbose` (verbose dumps every request to disk). |
| `minimax.modelIdOverrides` | _identity_ | Map picker IDs to API IDs (useful for proxies). |
| `minimax.visionModel` | _auto_ | Vision proxy for non-M3 models. Has no effect on M3. |
| `minimax.visionPrompt` | _see package.json_ | Custom vision proxy prompt. |
| `minimax.experimental.stabilizeToolList` | `false` | Synthesise preflight tool calls. **Experimental.** |

## Commands

| Command | Purpose |
| --- | --- |
| `MiniMax: Set API Key` | Store the Token Plan key in SecretStorage |
| `MiniMax: Clear API Key` | Remove the stored key |
| `MiniMax: Switch to Global API (minimax.io/anthropic)` | Switch to the international Anthropic endpoint |
| `MiniMax: Switch to Chinese API (minimaxi.com/anthropic)` | Switch to the China Anthropic endpoint |
| `MiniMax: Set Vision Proxy Model` | Pick a non-MiniMax model for image captions |
| `MiniMax: Show Pricing` | Open the pricing table in a Markdown preview |
| `MiniMax: Generate Commit Message` | Fill the SCM input box with a Conventional-Commits-style draft of the staged diff |
| `MiniMax: Show Logs` | Focus the MiniMax output channel |
| `MiniMax: Open Request Dumps Folder` | Reveal verbose request dumps |

## Git commit message generation

Run **MiniMax: Generate Commit Message** (also available from the **⋯**
menu on the right of the SCM commit-message input box) to fill the
input box with a draft. The generator:

- Reads the **staged** changes via VS Code's built-in Git extension;
  falls back to working-tree changes when nothing is staged.
- Caps the diff at 32 KB and the file list at 80 entries, so a large
  refactor still fits inside a 200K-context M2.7 budget.
- If the input box is non-empty, treats the existing text as a draft
  and asks the model to polish it instead of starting from scratch.
- Emits a Conventional-Commits-style message: `<type>(<scope>)<!>: <subject>`
  with a blank-line-separated bullet body. Allowed types: `feat`,
  `fix`, `refactor`, `perf`, `docs`, `test`, `build`, `ci`, `chore`,
  `style`, `revert`.
- Runs the request with `temperature: 0.2` for a reproducible first
  draft, and `max_tokens: 256` so a 512K-cap model doesn't burn its
  output budget by mistake.

The model is selected by `minimax.commitModel` (default
`MiniMax-M2.7`). Pick `MiniMax-M3` when the diff is hairy enough to
benefit from deeper reasoning.

## Models

| Model | Context | Effective input | Output cap | Notes |
| --- | ---: | ---: | ---: | --- |
| MiniMax M3 | 1,000,000 | 512,000 | 512,000 | Native multimodal frontier coding model |
| MiniMax M2.7 | 204,800 | 196,608 | 131,072 | Self-iterating model |
| MiniMax M2.7-highspeed | 204,800 | 196,608 | 131,072 | Faster M2.7 |

> **M3 1M context note:** the official spec is 1M, but the >512K input tier
> is currently 限时限量供应 (limited availability) and the API rejects
> requests with `max_tokens > 512_000`. We cap the effective input at
> 512K until the rollout completes.
>
> **Historical models:** M2.5 / M2.1 / M2 are no longer recommended by
> MiniMax and are not shipped by this extension. Power users can re-add
> them by populating `minimax.modelIdOverrides` and
> `minimax.visibleModels` themselves.

## Pricing (per million tokens, ¥)

| Model | Input | Output | Cache read | Cache write |
| --- | ---: | ---: | ---: | ---: |
| MiniMax M3 (≤512K input) | 4.20 | 16.80 | 0.84 | — |
| MiniMax M3 (>512K input, limited) | 8.40 | 33.60 | 1.68 | — |
| MiniMax M2.7 | 2.10 | 8.40 | 0.42 | 2.625 |
| MiniMax M2.7-highspeed | 4.20 | 16.80 | 0.42 | 2.625 |

> M3 is currently at 7-day half price: input ¥2.10 / output ¥8.40 / cache
> read ¥0.42. Pricing scraped from
> [platform.minimaxi.com/docs/guides/pricing-paygo](https://platform.minimaxi.com/docs/guides/pricing-paygo).
> Token Plan subscription is billed separately.

## Thinking mode

All shipped M-series models support reasoning. The model picker exposes
a **Thinking mode** dropdown with four levels. On the Anthropic-
compatible endpoint this maps to:

| Level | M3 | M2.7 / M2.7-highspeed |
| --- | --- | --- |
| Off | `thinking.type=disabled` | (no `thinking` field, default behaviour) |
| Light | `thinking.type=enabled, budget_tokens=1024` | (default) |
| Standard (default) | `thinking.type=enabled, budget_tokens=8192` | (default) |
| Deep | `thinking.type=enabled, budget_tokens=32768` | (default) |

## Endpoint auto-selection

On first activation, if `minimax.apiBaseUrl` is still at its factory
default, the extension picks an endpoint from the VS Code display
language:

- `zh*` (`zh-cn`, `zh-tw`, `zh-hk`, `zh-sg`, …) → China
  `https://api.minimaxi.com/anthropic`.
- anything else → international `https://api.minimax.io/anthropic`.

Once you set `minimax.apiBaseUrl` manually or invoke `switchToGlobal` /
`switchToChina`, the auto-selection is **never** re-applied.

## License

SATA 2.0 (Star And Thank Author License). Chinese translation in
[`LICENSE_zh`](./LICENSE_zh).
