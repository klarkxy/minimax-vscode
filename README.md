# MiniMax Copilot

<!-- marketplace-readme:remove-start -->
<a href="https://marketplace.visualstudio.com/items?itemName=klarkxy.minimax-vscode"><img src="https://img.shields.io/badge/VS%20Code%20Marketplace-Install-007ACC?logo=visualstudiocode&logoColor=white&style=for-the-badge" alt="Install from VS Code Marketplace"></a>
<a href="https://open-vsx.org/extension/klarkxy/minimax-vscode"><img src="https://img.shields.io/badge/Open%20VSX-Install-2F81F7?logo=openvsx&logoColor=white&style=for-the-badge" alt="Install from Open VSX"></a>
<!-- marketplace-readme:remove-end -->

<img src="https://vsmarketplacebadges.dev/installs-short/klarkxy.minimax-vscode.vsix.svg?style=for-the-badge" alt="Installs" />

> 🇬🇧 English | [🇨🇳 简体中文](./README.zh.md)

A [GitHub Copilot Chat](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot-chat)
language model provider that adds **MiniMax M3** and **M2.7** to the
Copilot model picker. Backed by a [Token Plan](https://platform.minimax.io/user-center/payment/token-plan)
API key.

> Architecture ported from
> [`deepseek-v4-for-copilot`](https://github.com/Vizards/deepseek-v4-for-copilot)
> (MIT) and adapted to the MiniMax Anthropic-compatible API.

## What you get

- **M3, M2.7, M2.7-highspeed** in the Copilot model picker, with
  per-model context, output cap, and pricing shown in the tooltip.
- **Image input on M3** (native multimodal) and a vision proxy fallback
  for M2.x so image attachments work on every model.
- **Tool calling** with an optional experimental cache-stabilisation
  switch that keeps the upstream prompt cache warm.
- **Git commit message generation** wired into the SCM input box.
  Conventional-Commits + gitmoji by default; drafts in place of
  whatever you had typed.
- **Per-model sampling controls** — set `temperature`, `topK`, etc.
  per model without editing code.
- **Cumulative usage tracker** — input / output / cache-read tokens
  across the whole extension lifetime, with a status command.
- **Diagnostics** — per-request classifier, cache-hit stats, and a
  verbose mode that dumps every request to disk.
- **Bilingual UI** that follows the VS Code display language.

## Requirements

- VS Code 1.111.0+
- MiniMax [Token Plan](https://platform.minimax.io/user-center/payment/token-plan)
  subscription and API key
- VS Code Insiders is required to render MiniMax thinking blocks via
  the proposed `languageModelThinkingPart` API
- The built-in Git extension must be enabled for the commit-message
  generator

## Quick start

1. Grab a Token Plan API key from
   [Account / Token Plan](https://platform.minimax.io/user-center/payment/token-plan).
2. Run **MiniMax: Set API Key** from the command palette.
3. Pick a model in the Copilot model picker. Run
   **MiniMax: Show Pricing** to compare costs.
4. Done — chat with the model directly in Copilot Chat, or use
   **MiniMax: Generate Commit Message** in the SCM input box.

## Models

| Model | Context | Effective input | Output | Image input | Notes |
| --- | ---: | ---: | ---: | --- | --- |
| MiniMax M3 | 1,000,000 | 512,000 | 512,000 | ✅ (native) | Frontier coding model |
| MiniMax M2.7 | 204,800 | 196,608 | 131,072 | ✅ (via vision proxy) | Self-iterating, ~60 TPS |
| MiniMax M2.7-highspeed | 204,800 | 196,608 | 131,072 | ✅ (via vision proxy) | Same quality, ~100 TPS |

> **M3 1M context note:** the >512K input tier is in limited rollout
> and the API rejects requests with `max_tokens > 512_000`. The
> effective input is capped at 512K until the rollout completes.
>
> **Historical models:** M2.5 / M2.1 / M2 are no longer recommended
> by MiniMax and are not shipped. Power users can re-add them via
> `minimax.modelIdOverrides` + `minimax.visibleModels`.

## Pricing (per million tokens, ¥)

| Model | Input | Output | Cache read | Cache write |
| --- | ---: | ---: | ---: | ---: |
| MiniMax M3 (≤512K input) | 4.20 | 16.80 | 0.84 | — |
| MiniMax M3 (>512K input, limited) | 8.40 | 33.60 | 1.68 | — |
| MiniMax M2.7 | 2.10 | 8.40 | 0.42 | 2.625 |
| MiniMax M2.7-highspeed | 4.20 | 16.80 | 0.42 | 2.625 |

> M3 is currently at 7-day half price: input ¥2.10 / output ¥8.40 /
> cache read ¥0.42. Source:
> [platform.minimaxi.com/docs/guides/pricing-paygo](https://platform.minimaxi.com/docs/guides/pricing-paygo).
> Token Plan subscription is billed separately.

## Configuration

| Setting | Default | Purpose |
| --- | --- | --- |
| `minimax.apiBaseUrl` | `https://api.minimaxi.com/anthropic` | Anthropic-compatible base URL. Use `https://api.minimax.io/anthropic` for international users. The SDK appends `/v1/messages`. Auto-picked on first activation when unset. |
| `minimax.visibleModels` | _all M-series_ | Restrict which models appear in the picker. |
| `minimax.maxTokens` | `0` | Output cap. `0` lets the model decide. Hard cap: 131072 for M2.7, 512000 for M3. |
| `minimax.commitModel` | `MiniMax-M2.7` | Model used by **MiniMax: Generate Commit Message**. |
| `minimax.sampling` | `{}` | Per-model `temperature` / `topP` / `topK` / `frequencyPenalty` overrides. See [Per-model sampling](#per-model-sampling). |
| `minimax.experimental.modelDefPresets` | `{}` | Per-model escape hatch for request body fields. See [Per-model sampling](#per-model-sampling). |
| `minimax.debugMode` | `minimal` | `minimal` / `metadata` / `verbose` (verbose dumps every request to disk). |
| `minimax.modelIdOverrides` | _identity_ | Map picker IDs to API IDs (useful for proxies). |
| `minimax.visionModel` | _auto_ | Vision proxy for non-M3 models. Has no effect on M3. |
| `minimax.visionPrompt` | _see package.json_ | Custom vision proxy prompt. |
| `minimax.experimental.stabilizeToolList` | `false` | Synthesise preflight tool calls to keep the upstream prompt cache warm. **Experimental.** |

## Commands

| Command | Purpose |
| --- | --- |
| **MiniMax: Set API Key** | Store the Token Plan key in SecretStorage |
| **MiniMax: Clear API Key** | Remove the stored key |
| **MiniMax: Show Provider Status** | One-screen summary of the current configuration + last request usage |
| **MiniMax: Show Usage** | Per-model cumulative token usage since the extension was first activated |
| **MiniMax: Reset Usage** | Zero out the cumulative usage counters |
| **MiniMax: Show Pricing** | Open the pricing table in a Markdown preview |
| **MiniMax: Set Vision Proxy Model** | Pick a non-MiniMax model for image captions |
| **MiniMax: Generate Commit Message** | Fill the SCM input box with a Conventional-Commits-style draft of the staged diff |
| **MiniMax: Set Commit Model** | Switch the model used by **Generate Commit Message** |
| **MiniMax: Switch to Global API (`minimax.io/anthropic`)** | Switch to the international Anthropic endpoint |
| **MiniMax: Switch to Chinese API (`minimaxi.com/anthropic`)** | Switch to the China Anthropic endpoint |
| **MiniMax: Show Logs** | Focus the MiniMax output channel |
| **MiniMax: Open Request Dumps Folder** | Reveal verbose request dumps |

## Per-model sampling

Two configuration knobs let you tweak the sampling parameters and
request body per model ID without editing code:

```jsonc
// settings.json
"minimax.sampling": {
  "MiniMax-M2.7": { "temperature": 0.2, "topK": 40 },
  "MiniMax-M3":   { "topK": 80 }
},
"minimax.experimental.modelDefPresets": {
  "MiniMax-M3": { "service_tier": "auto" }
}
```

- `temperature` and `topP` are ignored when the model is in
  `thinking: adaptive` mode (Anthropic's constraint).
- `topK` and `frequencyPenalty` are always honoured.
- `modelDefPresets` is an escape hatch — any key you put there is
  merged into the request body verbatim (after the standard fields).
  Eleven reserved keys are rejected; `tools` is concatenated rather
  than replaced.

## Git commit message generation

Run **MiniMax: Generate Commit Message** (also available from the **⋯**
menu on the right of the SCM commit-message input box) to fill the
input box with a draft. The generator:

- Reads the **staged** changes via VS Code's built-in Git extension;
  falls back to working-tree changes when nothing is staged.
- Caps the diff at 32 KB and the file list at 80 entries.
- Treats existing text in the input box as a draft to polish instead
  of starting from scratch.
- Emits Conventional-Commits-style messages
  (`<type>(<scope>)<!>: <subject>` + optional bullet body) with
  `temperature: 0.2` and `max_tokens: 256` for a reproducible first
  draft.

The model is selected by `minimax.commitModel` (default
`MiniMax-M2.7`). Switch to `MiniMax-M3` when the diff is hairy enough
to benefit from deeper reasoning.

## Thinking mode

MiniMax's Anthropic-compatible endpoint exposes a binary
`thinking: { type: "disabled" | "adaptive" }` toggle — there is **no**
user-facing effort knob. The extension always sends
`adaptive` for thinking-capable models (M3) and skips the field
entirely for M2.x (whose reasoning surfaces as `<think>…</think>`
inside the text content). Forcing `temperature: 1` and dropping
`top_p` whenever thinking is on is the Anthropic constraint, not a
choice.

## Endpoint auto-selection

On first activation, if `minimax.apiBaseUrl` is still at its factory
default, the extension picks an endpoint from the VS Code display
language:

- `zh*` (`zh-cn`, `zh-tw`, `zh-hk`, `zh-sg`, …) → China
  `https://api.minimaxi.com/anthropic`.
- Anything else → international `https://api.minimax.io/anthropic`.

Once you set `minimax.apiBaseUrl` manually or invoke
**MiniMax: Switch to Global/Chinese API**, the auto-selection is
**never** re-applied.

## Troubleshooting

- **No models in the picker** — run **MiniMax: Show Provider Status**
  to see whether an API key is set and which models are visible.
- **HTTP 404 from the gateway** — make sure `minimax.apiBaseUrl`
  points at a MiniMax Anthropic-compatible host (`api.minimaxi.com/anthropic`
  or `api.minimax.io/anthropic`), not a third-party proxy that
  expects the OpenAI protocol.
- **"API key not configured"** — run **MiniMax: Set API Key**;
  the key is stored in VS Code SecretStorage, not in `settings.json`.
- **Empty commit-message draft** — the diff may be larger than
  32 KB. Run **MiniMax: Show Logs** to see what the generator saw.

## License

SATA 2.0 (Star And Thank Author License). Chinese translation in
[`LICENSE_zh`](./LICENSE_zh).
