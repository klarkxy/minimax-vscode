<p align="center">
  <img src="icon/icon.png" alt="MiniMax Copilot" width="120">
</p>

<h1 align="center">MiniMax Copilot</h1>

<p align="center">
  <!-- marketplace-readme:remove-start -->
  <a href="https://marketplace.visualstudio.com/items?itemName=klarkxy.minimax-vscode-copilot"><img src="https://img.shields.io/badge/VS%20Code%20Marketplace-Install-007ACC?logo=visualstudiocode&logoColor=white&style=for-the-badge" alt="Install from VS Code Marketplace"></a>
  <br/>
  <!-- marketplace-readme:remove-end -->
</p>

<p align="center">
  <a href="./README.md"><b>English</b></a>
  ·
  <a href="./README.zh.md">简体中文</a>
</p>

<p align="center">
  Pick <b>MiniMax M3 / M2.7</b> from the Copilot Chat model picker — and keep everything else Copilot already gives you.
</p>

## Why this extension?

Love MiniMax's price-performance but don't want to give up GitHub Copilot's agent mode, tool calling, and polished UI? This extension drops **MiniMax M3 / M2.7** straight into the Copilot Chat model selector — with **vision**, **thinking mode**, **usage dashboard**, and your Token Plan API key.

- **Don't replace Copilot — power it up.** No new sidebar, no new chat UI to learn. Just new entries in the model picker you already use.
- **Agent mode, tool calling, MCP — all of it still works.** Copilot's entire stack, now running on MiniMax.
- **BYOK, pay MiniMax directly.** Your Token Plan API key, your bill, your rate limits. Stored in the OS keychain, never on disk.
- **Bilingual UI** that follows the VS Code display language.

## Features

### M3 / M2.7 / M2.7-highspeed in the model picker

All three models show up alongside GPT, Claude, and friends in Copilot Chat's model selector. Each row carries the context window, output cap, and per-million-token pricing in its tooltip. M3 has native image + video input; M2.x falls back to a transparent vision proxy so image attachments work on every model.

### Native video input on M3

M3 accepts `type: "video"` content blocks inline (MP4 / AVI / MOV / MKV) and through the Files API (`mm_file://{file_id}`). The request layer throws a localised error if the request body exceeds the official 64 MB cap, so you never see a cryptic HTTP 413.

### Thinking mode with on/off toggle

MiniMax's Anthropic-compatible surface exposes a binary `thinking: { type: "disabled" | "adaptive" }` switch — no intensity knob to forward. The **MiniMax: Toggle M3 Thinking Mode** command flips it on M3 (M2.x always stays adaptive because the API ignores `disabled` for the M2 family). Flipping M3 off also unlocks your custom `temperature` / `topP` from `minimax.sampling`.

### Git commit message generation

Fill the SCM input box with a Conventional-Commits-style draft of the staged diff. Conventional Commits + gitmoji by default; existing text in the input box is treated as a draft to polish rather than overwriting.

### Cumulative usage tracker

Per-model cumulative input / output / cache-read tokens across the extension lifetime, with a **MiniMax: Show Usage** status command.

### Usage dashboard

A one-click webview with today / 7-day / 30-day token usage, a 30-day bar chart, a per-model breakdown, and the platform `coding_plan/remains` data (5h reset, weekly limit, subscription expiry) when an API key is configured. A bottom-of-page **mmx-cli** section detects / installs the official [`mmx`](https://github.com/MiniMax-AI/cli) multimodal CLI and the matching agent SKILL.

### Per-model sampling controls

Set `temperature`, `topK`, and friends per model without editing code. See [Settings](#settings).

### Diagnostics

Per-request classifier, cache-hit stats, and a verbose mode that dumps every request to disk for debugging.

## Getting Started

### Prerequisites

- **VS Code 1.111.0+**
- **GitHub Copilot Chat** installed and signed in (the extension registers as a model provider)
- A MiniMax [Token Plan](https://platform.minimax.io/user-center/payment/token-plan) subscription and API key
- **VS Code Insiders** is required to render MiniMax thinking blocks via the proposed `languageModelThinkingPart` API
- The built-in **Git** extension must be enabled for the commit-message generator

### Installation

1. Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=klarkxy.minimax-vscode-copilot) (or build a `.vsix` from source with `npm run package`).
2. Run **MiniMax: Set API Key** from the command palette and paste your Token Plan key.
3. Open Copilot Chat, click the model picker, pick **MiniMax M3** (or M2.7 / M2.7-highspeed). **MiniMax: Show Pricing** will compare costs.
4. Chat with the model. Run **MiniMax: Generate Commit Message** in the SCM input box to draft a commit message.

### Endpoint auto-selection

On first activation, if `minimax.apiBaseUrl` is still at its default value, the extension picks an endpoint from the VS Code display language:

- `zh*` (`zh-cn`, `zh-tw`, `zh-hk`, `zh-sg`, …) → China, `https://api.minimaxi.com/anthropic`.
- Anything else → international, `https://api.minimax.io/anthropic`.

Once you set `minimax.apiBaseUrl` manually or run **MiniMax: Switch to Global/Chinese API**, auto-selection stays off for good.

## Models

| Model | Context (spec / effective) | Image input | Notes |
| --- | ---: | --- | --- |
| **MiniMax M3** | 1,000,000 / 512,000 | ✅ native | Current top-tier coding model; native video input (MP4 / AVI / MOV / MKV). Effective cap is 512K because the >512K input tier is still in limited rollout. |
| **MiniMax M2.7** | 204,800 | ✅ vision proxy | Self-iterating, ~60 TPS |
| **MiniMax M2.7-highspeed** | 204,800 | ✅ vision proxy | Same quality, ~100 TPS |

The first number in the **Context** column is the official spec from the [Supported models](https://platform.minimaxi.com/docs/guides/text-generation) page; the second (when shown) is what the Copilot model picker reports as the effective cap. We display the smaller number so VS Code's "上下文窗口: N / M" indicator stays honest about what a normal user can actually push to.

Users who have been granted access to the >512K tier can flip `minimax.enableM31MContext: true` via the **MiniMax: Toggle M3 1M Context** command — the command pops a modal warning about the 2× billing rate and the need for sales-granted >512K access before changing the setting. The chat info emitter rebuilds the picker entry on setting change so the indicator updates live without an editor reload.

**Historical models:** M2.5 / M2.1 / M2 are no longer recommended by MiniMax and are not shipped. Power users can re-add them via `minimax.modelIdOverrides` + `minimax.visibleModels`.

## Pricing

Prices differ between the China endpoint (`api.minimaxi.com`, billed in CNY) and the international endpoint (`api.minimax.io`, billed in USD). The picker tooltip and **MiniMax: Show Pricing** both render the table that matches the active `minimax.apiBaseUrl`.

### Pay-as-you-go (LLM, per million tokens)

> The China table is in **CNY**, the international table in **USD**. The full pricing page covers all modalities; this section is the LLM subset the extension actually uses.

| Model | Input | Output | Cache read | Cache write |
| --- | ---: | ---: | ---: | ---: |
| **MiniMax M3 (≤512K input)** | $0.30 / ¥2.10 | $1.20 / ¥8.40 | $0.06 / ¥0.42 | — |
| **MiniMax M3 (>512K input, limited)** | $0.60 / ¥4.20 | $2.40 / ¥16.80 | $0.12 / ¥0.84 | — |
| **MiniMax M2.7** | $0.30 / ¥2.10 | $1.20 / ¥8.40 | $0.06 / ¥0.42 | $0.375 / ¥2.625 |
| **MiniMax M2.7-highspeed** | $0.60 / ¥4.20 | $2.40 / ¥16.80 | $0.06 / ¥0.42 | $0.375 / ¥2.625 |

M3 is permanently 50% off on both input tiers. The >512K input tier is in limited rollout; see the [pricing page footnote](https://platform.minimaxi.com/docs/guides/pricing-paygo) for the latest rollout status. Token Plan subscription is billed separately — see below.

### Token Plan subscription

Subscription pricing for the Token Plan API key (separate from the pay-as-you-go rates above). One Subscription Key covers language models plus speech / video / music / image endpoints through a shared usage bar.

| Tier | Price (USD / CNY) | Best for | Quota windows | Agent usage |
| --- | --- | --- | --- | ---: |
| Starter / 轻量版 | $20 / ¥49 per month | Personal projects and prototyping | 5-hour rolling + weekly | 3-4 agents |
| Pro / 高频版 | $50 / ¥119 per month | Daily coding with agents and multimodal work | 5-hour rolling + weekly | 4-5 agents |
| Max / 重度版 | $120 / ¥469 per month | Heavy Agent workflows and extended sessions | 5-hour rolling + weekly | 6-7 agents |

Token Plan usage deducts from the included quota according to each endpoint's pay-as-you-go price. When the quota is exhausted you can let purchased Credits cover the overrun, swap the Subscription Key for a pay-as-you-go API Key, or wait for the next window reset (unused quota does not carry over).

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `minimax.apiBaseUrl` | `https://api.minimaxi.com/anthropic` | Anthropic-compatible base URL. Use `https://api.minimax.io/anthropic` for international users. The SDK appends `/v1/messages`. Auto-picked on first activation when unset. |
| `minimax.visibleModels` | _all M-series_ | Restrict which models appear in the picker. |
| `minimax.maxTokens` | `0` | Output cap. `0` lets the model decide. Set a positive integer to cap the output yourself; the request layer does not clamp it client-side, and any 4xx from the upstream is surfaced as-is. |
| `minimax.enableM31MContext` | `false` | Lift the **MiniMax-M3** picker entry from the safe 512K default to the official 1M cap. **Off by default.** Enabling this only works if your MiniMax account has been granted access to the >512K tier, and the >512K tier is billed at **2× the per-token rate** (see the [pricing page](https://platform.minimaxi.com/docs/guides/pricing-paygo)). Use the **MiniMax: Toggle M3 1M Context** command — it pops a modal warning before flipping the switch. |
| `minimax.commitModel` | `MiniMax-M3` | Model used by **MiniMax: Generate Commit Message**. M3 and M2.7 now share the same per-token price, so M3's frontier-coding quality is the obvious default; switch to `MiniMax-M2.7-highspeed` for a faster draft. |
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
| **MiniMax: Toggle M3 Thinking Mode** | Flip the `minimax.thinking.enabled` setting (M3 only). M2.x always stays on. |
| **MiniMax: Toggle M3 1M Context** | Lift M3's picker entry from the safe 512K default to the official 1M cap. Pops a modal warning about the 2× billing rate and the need for sales-granted >512K access before flipping on; off is unconditional. |
| **MiniMax: Switch to Global API (`minimax.io/anthropic`)** | Switch to the international Anthropic endpoint |
| **MiniMax: Switch to Chinese API (`minimaxi.com/anthropic`)** | Switch to the China Anthropic endpoint |
| **MiniMax: Show Logs** | Focus the MiniMax output channel |
| **MiniMax: Open Request Dumps Folder** | Reveal verbose request dumps |
| **MiniMax: Open Usage Dashboard** | Open the usage dashboard (today / 7-day / 30-day tokens, per-model breakdown, 30-day bar chart, platform `coding_plan/remains` data) |
| **MiniMax: Copy mmx-cli install prompt** | Copy the verbatim three-step install prompt from the [official docs](https://platform.minimaxi.com/docs/token-plan/minimax-cli) to the clipboard. Language matches the configured endpoint (China → 简体中文, otherwise → English). The extension does not run any install / login / SKILL commands on your behalf. |

## Per-model sampling

Two configuration knobs let you tweak the sampling parameters and request body per model ID without editing code:

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

- `temperature` and `topP` are ignored when the model is in `thinking: adaptive` mode. That's Anthropic's rule, not ours.
- `topK` and `frequencyPenalty` always take effect.
- `modelDefPresets` is an escape hatch. Any key you put there is merged into the request body after the standard fields. Eleven reserved keys are rejected; `tools` is concatenated rather than replaced.

## Git commit message generation

Run **MiniMax: Generate Commit Message** (also in the **⋯** menu on the right of the SCM commit-message input box) to fill the input box with a draft. The generator:

- Reads the **staged** changes via VS Code's built-in Git extension, falling back to working-tree changes when nothing is staged.
- Caps the diff at 32 KB and the file list at 80 entries.
- Treats existing text in the input box as a draft to polish rather than overwriting it.
- Emits Conventional-Commits-style messages (`<type>(<scope>)<!>: <subject>` + optional bullet body) at `temperature: 0.2` and `max_tokens: 256` for a reproducible first draft.

The model is selected by `minimax.commitModel` (default `MiniMax-M3`). M3 and M2.7 now share the same per-token price on both billing sites, so the frontier-coding quality is the obvious default. Switch to `MiniMax-M2.7-highspeed` if you prefer a faster draft over deeper reasoning.

## Thinking mode

MiniMax's Anthropic-compatible endpoint exposes a binary `thinking: { type: "disabled" | "adaptive" }` toggle. There is no user-facing effort knob — no `budget_tokens`, no `reasoning_effort`, no `reasoning_split`. The on/off switch is exposed two ways for **MiniMax-M3**:

- **`minimax.thinking.enabled`** boolean setting (default `true`).
- **MiniMax: Toggle M3 Thinking Mode** command — flips the setting and shows a localised toast so the new state is unambiguous.

M2.x always stays `adaptive` — the docs say the gateway ignores `disabled` for the M2 family, so the toggle is a no-op for M2.7 / M2.7-highspeed.

Forcing `temperature: 1` and dropping `top_p` whenever thinking is on is the Anthropic constraint, not our choice. The M3-only escape hatch: flip the toggle off, and your custom `temperature` / `topP` from `minimax.sampling` finally apply. M2.x reasoning still surfaces as `<think>…</think>` inside the text content rather than a typed `thinking` block.

## Video input (M3)

M3 accepts video parts natively on the Anthropic-compatible surface. The supported containers are **MP4**, **AVI**, **MOV (QuickTime)** and **MKV**. Inline base64 uploads are capped at **50 MB**; videos larger than that should be uploaded via the official Files API and referenced as `mm_file://{file_id}` (Files API cap: 512 MB). The whole request body is capped at **64 MB**; the extension throws a localised error before the API would return 413.

M2.x silently drops video attachments (with a log warning) — they have no `videoInput` capability.

## Usage dashboard

Click the `$(graph) MiniMax …` item in the VS Code status bar, or run **MiniMax: Open Usage Dashboard**, to open a side-panel webview that combines two data sources:

- **Local token accounting**: every request the extension makes is written to a persistent counter. The dashboard aggregates it into three windows (**Today**, **Last 7 days**, **Last 30 days**), each with columns for `Input`, `Cache read`, `Cache write`, `Output` and `Requests`. A 30-day bar chart and a per-model breakdown table sit below the windows.
- **Platform Token Plan**: when an API key is configured, the dashboard also calls `GET /v1/api/openplatform/coding_plan/remains` and renders the 5-hour reset window, the weekly limit, the per-model quota table and the subscription expiry.

Two extra status-bar items sit to the right of the daily-token counter: `$(bolt) 5h 73%` (5-hour remaining percent) and `$(calendar) Week 11%` (weekly remaining percent). The colour follows the `statusBarItem.remoteBackground` / `warningBackground` / `errorBackground` theme tokens. Without an API key both items render a muted em-dash placeholder and the tooltip nudges you to run **MiniMax: Set API Key**.

## mmx-cli (multimodal companion)

The dashboard's bottom section reports the status of the official [`mmx`](https://github.com/MiniMax-AI/cli) CLI as an optional companion to the Token Plan flow. Once installed, your agent (Copilot Chat, Claude Code, Cursor, …) can drive image / video / music / speech / vision / web search using the **same** API key.

The extension only **detects** three things; it never installs, logs in, or runs anything on your behalf:

- **CLI binary** on `PATH` (`mmx --version`)
- **`mmx auth`** logged in (`mmx auth status`)
- **Agent SKILL** installed (a `SKILL.md` under `~/.claude/skills/minimax-cli/`, `~/.copilot/skills/minimax-cli/`, or `~/.mmx/skills/minimax-cli/`)

The "Copy official install prompt" button (and the **MiniMax: Copy mmx-cli install prompt** command) puts the verbatim three-step prompt from the [official docs](https://platform.minimaxi.com/docs/token-plan/minimax-cli) on the clipboard, in the language that matches the configured endpoint. The prompt only contains the literal `sk-xxxxx` placeholder for the API key; you fill in your real Token Plan key yourself before pasting it into a chat. Once you've finished the install, click **Re-check** and the dashboard's status badges will turn green.

## Troubleshooting

- **No models in the picker** — run **MiniMax: Show Provider Status** to see whether an API key is set and which models are visible.
- **HTTP 404 from the gateway** — make sure `minimax.apiBaseUrl` points at a MiniMax Anthropic-compatible host (`api.minimaxi.com/anthropic` or `api.minimax.io/anthropic`), not a third-party proxy that expects the OpenAI protocol.
- **"API key not configured"** — run **MiniMax: Set API Key**; the key is stored in VS Code SecretStorage, not in `settings.json`.
- **Empty commit-message draft** — the diff may be larger than 32 KB. Run **MiniMax: Show Logs** to see what the generator saw.
- **M3 picker still shows 512K after toggling 1M on** — the chat-info emitter rebuilds the picker entry on setting change, but some Copilot Chat versions cache the entry until the next message. Switch models in the picker once and the new cap takes effect.

## License

SATA 2.0 (Star And Thank Author License). Chinese translation in [`LICENSE_zh`](./LICENSE_zh).