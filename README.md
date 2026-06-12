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
  Pick <b>MiniMax M3 / M2.7</b> from the Copilot Chat model picker.
</p>

## Features

- **M3 / M2.7 / M2.7-highspeed in the Copilot Chat model picker** with pricing in the tooltip. All three accept image input; M3 also accepts video.
- **Native video input on M3** — `type: "video"` parts inline, with a hard 64 MB request body cap.
- **Thinking mode toggle** — binary `disabled` / `adaptive` switch in the M3 picker dropdown.
- **Drive the Source Control ✨ commit button** — route Copilot's built-in commit-message generation through MiniMax via `chat.utilitySmallModel`.
- **Per-model sampling** — `temperature` / `topK` / `topP` / `frequencyPenalty` overrides per model.
- **Cumulative usage tracker** — per-model input / output / cache tokens across the extension lifetime.
- **Usage dashboard** — today / 7-day / 30-day views, 30-day bar chart, per-model breakdown, platform `coding_plan/remains`, and Claude Code JSONL ingest.
- **mmx-cli status detection** — dashboard shows whether the official MiniMax CLI / auth / SKILL is set up; copy the install prompt to the clipboard.
- **Diagnostics** — per-request classifier, cache-hit stats, verbose mode dumps every request to disk.

## Getting Started

### Prerequisites

- **VS Code 1.111.0+**
- **GitHub Copilot Chat** installed and signed in
- A MiniMax [Token Plan](https://platform.minimax.io/user-center/payment/token-plan) subscription and API key
- **VS Code Insiders** to render M3 thinking blocks via the proposed `languageModelThinkingPart` API

### Installation

1. Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=klarkxy.minimax-vscode-copilot) (or build a `.vsix` from source with `npm run package`).
2. Run **MiniMax: Set API Key** from the command palette and paste your Token Plan key.
3. Open Copilot Chat, pick **MiniMax M3** (or M2.7 / M2.7-highspeed).
4. (Optional) Run **MiniMax: Set Copilot's Utility Models** to route the Source Control ✨ button through MiniMax.

### Endpoint

On first activation, if `minimax.apiBaseUrl` is still at its default, the extension picks `https://api.minimax.io/anthropic` automatically. Once you set the URL manually or run the switch command, the auto-picked value is preserved.

## Models

| Model | Context (spec / effective) | Image input | Notes |
| --- | ---: | --- | --- |
| **MiniMax M3** | 1,000,000 / 512,000 | ✅ native | Top-tier coding; native video input (MP4 / AVI / MOV / MKV). Effective cap is 512K until the >512K tier is fully rolled out. |
| **MiniMax M2.7** | 204,800 | ✅ native | Self-iterating, ~60 TPS |
| **MiniMax M2.7-highspeed** | 204,800 | ✅ native | Same quality, ~100 TPS |

Users with >512K access can run **MiniMax: Toggle M3 1M Context** to lift the cap (the command pops a modal warning about 2× billing before flipping the switch). The full spec is on the [Supported models page](https://platform.minimax.io/docs/guides/text-generation).

**Historical models:** M2.5 / M2.1 / M2 are not in the picker by default.

## Pricing

Prices are in **USD** (billed in USD for international users). The picker tooltip renders the table that matches your active `minimax.apiBaseUrl`. See the [pricing page](https://platform.minimax.io/docs/guides/pricing-paygo) for the latest.

### Pay-as-you-go (per million tokens)

| Model | Input | Output | Cache read | Cache write |
| --- | ---: | ---: | ---: | ---: |
| **MiniMax M3 (≤512K input)** | $0.60 | $2.40 | $0.12 | — |
| **MiniMax M3 (>512K input, limited)** | $1.20 | $4.80 | $0.24 | — |
| **MiniMax M2.7** | $0.30 | $1.20 | $0.06 | $0.375 |
| **MiniMax M2.7-highspeed** | $0.60 | $2.40 | $0.06 | $0.375 |

The >512K input tier is in limited rollout; see the [pricing page](https://platform.minimax.io/docs/guides/pricing-paygo) for the latest. Token Plan subscription is billed separately — see below.

### Token Plan subscription

A Subscription Key covers language models plus speech / video / music / image endpoints through a shared usage bar. Deducts from the included quota at each endpoint's pay-as-you-go price; purchased Credits cover any overrun.

| Tier | Price (USD) | Quota windows | Agent usage |
| --- | ---: | --- | ---: |
| Starter | $20 per month | 5-hour rolling + weekly | 3-4 agents |
| Pro | $50 per month | 5-hour rolling + weekly | 4-5 agents |
| Max | $120 per month | 5-hour rolling + weekly | 6-7 agents |

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `minimax.apiBaseUrl` | _auto-picked_ | Anthropic-compatible base URL. Auto-picked on first activation; defaults to `https://api.minimax.io/anthropic`. |
| `minimax.visibleModels` | _all M-series_ | Restrict which models appear in the picker. |
| `minimax.maxOutputTokens` | `0` | Output cap. `0` lets the model decide. See `minimax.enableM31MContext` for the input/context window. |
| `minimax.enableM31MContext` | `false` | Lift M3 from 512K to 1M context. Off by default; the toggle command pops a billing warning first. |
| `minimax.sampling` | `{}` | Per-model `temperature` / `topP` / `topK` / `frequencyPenalty` overrides. |
| `minimax.experimental.modelDefPresets` | `{}` | Per-model escape hatch for request body fields. |
| `minimax.debugMode` | `minimal` | `minimal` / `metadata` / `verbose`. |
| `minimax.modelIdOverrides` | `{}` | Map picker IDs to API IDs (useful for proxies). |
| `minimax.dashboard.includeClaudeCode` | `true` | Master toggle for the Claude Code JSONL ingest section. |
| `minimax.claudeCode.logPath` | `~/.claude/projects` | Root directory the ingester walks. |
| `minimax.claudeCode.pollIntervalMs` | `30000` | Scan interval in milliseconds. Clamped to `[5000, 600000]`. |
| `minimax.experimental.stabilizeToolList` | `false` | Synthesise preflight tool calls to keep the upstream prompt cache warm. **Experimental.** |

## Commands

| Command | Purpose |
| --- | --- |
| **MiniMax: Set API Key** | Store the Token Plan key in SecretStorage |
| **MiniMax: Clear API Key** | Remove the stored key |
| **MiniMax: Set Copilot's Utility Models** | Pick a chat model and write it to `chat.utilitySmallModel` (and optionally `chat.utilityModel`) |
| **MiniMax: Toggle M3 1M Context** | Lift M3's picker entry to 1M (with billing warning) |
| **MiniMax: Switch to Global API (`minimax.io/anthropic`)** | Switch to the international Anthropic endpoint |
| **MiniMax: Show Logs** | Focus the MiniMax output channel |
| **MiniMax: Open Request Dumps Folder** | Reveal verbose request dumps |
| **MiniMax: Open Usage Dashboard** | Open the usage dashboard |
| **MiniMax: Rescan Claude Code Logs** | Force a fresh read of the Claude Code JSONL log directory |
| **MiniMax: Open Claude Code Log Folder** | Reveal the resolved Claude Code log directory in the OS file manager |
| **MiniMax: Copy mmx-cli install prompt** | Copy the verbatim three-step install prompt to the clipboard |

## Troubleshooting

- **No models in the picker** — open **MiniMax: Open Usage Dashboard** to see whether an API key is set and which models are visible.
- **HTTP 404 from the gateway** — make sure `minimax.apiBaseUrl` is `https://api.minimax.io/anthropic`, not a third-party proxy that expects the OpenAI protocol.
- **"API key not configured"** — run **MiniMax: Set API Key**; the key is stored in VS Code SecretStorage, not in `settings.json`.
- **Source Control ✨ button does not invoke MiniMax** — run **MiniMax: Set Copilot's Utility Models** to set `chat.utilitySmallModel` to a MiniMax model, then restart Copilot Chat.
- **M3 picker still shows 512K after toggling 1M on** — switch models in the picker once; some Copilot Chat versions cache the entry until the next message.
