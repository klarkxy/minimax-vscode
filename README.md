# MiniMax Copilot

<!-- marketplace-readme:remove-start -->
> 🇬🇧 English | [🇨🇳 简体中文](./README.zh.md)
<!-- marketplace-readme:remove-end -->

A [GitHub Copilot Chat](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot-chat)
language model provider. It registers **MiniMax M3**, **M2.7** and
**M2.7-highspeed** with the Copilot model picker, backed by a
[Token Plan](https://platform.minimax.io/user-center/payment/token-plan)
API key.

> Architecture ported from
> [`deepseek-v4-for-copilot`](https://github.com/Vizards/deepseek-v4-for-copilot)
> (MIT) and adapted to the MiniMax Anthropic-compatible API.

## Features

- **M3, M2.7 and M2.7-highspeed** show up in the Copilot model picker.
  Each entry has the context window, output cap and pricing in its
  tooltip.
- **Image input on M3** is native. M2.x falls back to a vision proxy,
  so image attachments work on every model.
- **Tool calling** with an experimental cache-stabilisation switch
  for keeping the upstream prompt cache warm.
- **Git commit message generation** wired into the SCM input box.
  Conventional Commits + gitmoji by default, and it polishes whatever
  you already typed.
- **Per-model sampling controls**: set `temperature`, `topK` and
  friends per model without editing code.
- **Cumulative usage tracker** for input, output and cache-read
  tokens across the whole extension lifetime, with a status command.
- **Usage dashboard**: a one-click webview (status-bar entry plus
  a command) showing today / 7-day / 30-day token usage, a 30-day
  bar chart, a per-model breakdown, and the platform
  `coding_plan/remains` data (5h reset, weekly limit, subscription
  expiry) when an API key is configured. The counter updates live
  as new requests land. A bottom-of-page **mmx-cli** section
  detects / installs the official [`mmx`](https://github.com/MiniMax-AI/cli)
  multimodal CLI and the matching agent SKILL, so the agent can
  call image / video / music / speech / vision / search with the
  same Token Plan key.
- **Diagnostics**: per-request classifier, cache-hit stats, and a
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
3. Pick a model in the Copilot model picker. **MiniMax: Show Pricing**
   will compare costs.
4. Chat with the model in Copilot Chat, or hit
   **MiniMax: Generate Commit Message** in the SCM input box.

## Models

| Model | Context | Effective input | Output | Image input | Notes |
| --- | ---: | ---: | ---: | --- | --- |
| MiniMax M3 | 1,000,000 | 512,000 | 512,000 | ✅ (native) | Current top-tier coding model |
| MiniMax M2.7 | 204,800 | 196,608 | 131,072 | ✅ (via vision proxy) | Self-iterating, ~60 TPS |
| MiniMax M2.7-highspeed | 204,800 | 196,608 | 131,072 | ✅ (via vision proxy) | Same quality, ~100 TPS |

> **M3 1M context note:** the >512K input tier is in limited rollout
> and the API rejects requests with `max_tokens > 512_000`. The
> effective input is capped at 512K until the rollout completes.
>
> **Historical models:** M2.5 / M2.1 / M2 are no longer recommended
> by MiniMax and are not shipped. Power users can re-add them via
> `minimax.modelIdOverrides` + `minimax.visibleModels`.

## Pricing (per million tokens, USD)

> The prices below match the international billing site
> [platform.minimax.io](https://platform.minimax.io/docs/guides/pricing-paygo)
> (`https://api.minimax.io/anthropic`). The Chinese mirror
> ([platform.minimaxi.com](https://platform.minimaxi.com/docs/guides/pricing-paygo),
> `https://api.minimaxi.com/anthropic`) charges in CNY at different
> rates — see [`README.zh.md`](./README.zh.md) for that table.
> The picker tooltip and **MiniMax: Show Pricing** both render the
> table that matches the active `minimax.apiBaseUrl`.

| Model | Input | Output | Cache read | Cache write |
| --- | ---: | ---: | ---: | ---: |
| MiniMax M3 (≤512K input) | $0.60 | $2.40 | $0.12 | — |
| MiniMax M3 (>512K input, limited) | $1.20 | $4.80 | $0.24 | — |
| MiniMax M2.7 | $0.30 | $1.20 | $0.06 | $0.375 |
| MiniMax M2.7-highspeed | $0.60 | $2.40 | $0.06 | $0.375 |

> The M3 >512K input tier is in limited rollout and the API rejects
> requests with `max_tokens > 512_000`. The effective input is capped
> at 512K until the rollout completes. Token Plan subscription is
> billed separately.

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
| **MiniMax: Open Usage Dashboard** | Open the usage dashboard (today / 7-day / 30-day tokens, per-model breakdown, 30-day bar chart, platform `coding_plan/remains` data) |
| **MiniMax: Copy mmx-cli install prompt** | Copy the verbatim three-step install prompt from the [official docs](https://platform.minimaxi.com/docs/token-plan/minimax-cli) to the clipboard. Language matches the configured endpoint (China → 简体中文, otherwise → English). The extension does not run any install / login / SKILL commands on your behalf. |

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
  `thinking: adaptive` mode. That's Anthropic's rule, not ours.
- `topK` and `frequencyPenalty` always take effect.
- `modelDefPresets` is an escape hatch. Any key you put there is
  merged into the request body after the standard fields. Eleven
  reserved keys are rejected; `tools` is concatenated rather than
  replaced.

## Git commit message generation

Run **MiniMax: Generate Commit Message** (also in the **⋯** menu on
the right of the SCM commit-message input box) to fill the input
box with a draft. The generator:

- Reads the **staged** changes via VS Code's built-in Git extension,
  falling back to working-tree changes when nothing is staged.
- Caps the diff at 32 KB and the file list at 80 entries.
- Treats existing text in the input box as a draft to polish rather
  than overwriting it.
- Emits Conventional-Commits-style messages
  (`<type>(<scope>)<!>: <subject>` + optional bullet body) at
  `temperature: 0.2` and `max_tokens: 256` for a reproducible first
  draft.

The model is selected by `minimax.commitModel` (default
`MiniMax-M2.7`). Switch to `MiniMax-M3` when the diff needs deeper
reasoning.

## Thinking mode

MiniMax's Anthropic-compatible endpoint exposes a binary
`thinking: { type: "disabled" | "adaptive" }` toggle. There is no
user-facing effort knob, so the extension always sends `adaptive`
for thinking-capable models (M3) and skips the field for M2.x
(their reasoning surfaces as `<think>…</think>` inside the text
content). Forcing `temperature: 1` and dropping `top_p` whenever
thinking is on is the Anthropic constraint, not our choice.

## Usage dashboard

Click the `$(graph) MiniMax …` item in the VS Code status bar, or run
**MiniMax: Open Usage Dashboard**, to open a side-panel webview that
combines two data sources:

- **Local token accounting**: every request the extension makes is
  written to a persistent counter. The dashboard aggregates it into
  three windows (**Today**, **Last 7 days**, **Last 30 days**), each
  with columns for `Input`, `Cache read`, `Cache write`, `Output` and
  `Requests`. A 30-day bar chart and a per-model breakdown table sit
  below the windows. The counter updates live: every new chat request
  bumps the day bucket and the dashboard re-renders on its own.
- **Platform Token Plan**: when an API key is configured, the
  dashboard also calls `GET /v1/api/openplatform/coding_plan/remains`
  and renders the 5-hour reset window, the weekly limit, the
  per-model quota table and the subscription expiry. Failures (401,
  network, malformed payload) show a yellow banner; the local
  counters above stay accurate. The host (`minimaxi.com` vs
  `minimax.io`) is auto-picked from `minimax.apiBaseUrl`.

The dashboard has a **Reset counters** button that clears the local
Memento after a confirmation prompt. The platform data can't be
reset from the extension.

### Status-bar quota items

Two extra status-bar items sit to the right of the daily-token
counter, so you can see your plan usage at a glance without opening
the dashboard:

- `$(bolt) 5h 73%`: 5-hour reset window, **remaining** percent
- `$(calendar) Week 11%`: weekly limit, **remaining** percent

The colour follows the `statusBarItem.remoteBackground` /
`warningBackground` / `errorBackground` theme tokens (green when
plenty left, red when low), so the bar stays legible in both light
and dark themes. Hovering shows a `X / Y · resets in Hh Mm` summary
that mirrors the dashboard's quota card. Clicking the item opens
the dashboard. Without an API key both items render a muted em-dash
placeholder and the tooltip nudges you to run
**MiniMax: Set API Key**.

Both items read the same in-process plan cache as the dashboard
(the `fetchPlanUsage` 8s TTL still applies), so opening the dashboard
or letting the status bar refresh does not add a second HTTP call.

### mmx-cli (multimodal companion)

The dashboard's bottom section reports the status of the official
[`mmx`](https://github.com/MiniMax-AI/cli) CLI as an optional
companion to the Token Plan flow. Once installed, your agent
(Copilot Chat, Claude Code, Cursor, …) can drive image / video /
music / speech / vision / web search using the **same** API key.

The extension only **detects** three things; it never installs,
logs in, or runs anything on your behalf:

- **CLI binary** on `PATH` (`mmx --version`)
- **`mmx auth`** logged in (`mmx auth status`)
- **Agent SKILL** installed (a `SKILL.md` under
  `~/.claude/skills/minimax-cli/`,
  `~/.copilot/skills/minimax-cli/`, or `~/.mmx/skills/minimax-cli/`)

The "Copy official install prompt" button (and the
**MiniMax: Copy mmx-cli install prompt** command) put the
verbatim three-step prompt from the
[official docs](https://platform.minimaxi.com/docs/token-plan/minimax-cli)
on the clipboard, in the language that matches the configured
endpoint. The prompt only contains the literal `sk-xxxxx`
placeholder for the API key; you fill in your real Token Plan
key yourself before pasting it into a chat (or, if you prefer,
just run the three commands in a terminal directly). Once you've
finished the install, click **Re-check** and the dashboard's
status badges will turn green.

## Endpoint auto-selection

On first activation, if `minimax.apiBaseUrl` is still at its default
value, the extension picks an endpoint from the VS Code display
language:

- `zh*` (`zh-cn`, `zh-tw`, `zh-hk`, `zh-sg`, …) → China,
  `https://api.minimaxi.com/anthropic`.
- Anything else → international, `https://api.minimax.io/anthropic`.

Once you set `minimax.apiBaseUrl` manually or run
**MiniMax: Switch to Global/Chinese API**, auto-selection stays
off for good.

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
