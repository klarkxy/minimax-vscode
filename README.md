<p align="center">
  <img src="icon/icon.png" alt="MiniMax Claude Code" width="120">
</p>

<h1 align="center">MiniMax Claude Code</h1>

<p align="center">
  <a href="https://github.com/rzfzr/minimax-vscode/blob/main/README.md"><b>English</b></a>
  ·
  <a href="https://github.com/rzfzr/minimax-vscode/blob/main/README.zh.md">简体中文</a>
</p>

<p align="center">
  Run Claude Code's <b>Haiku</b> tier on <b>MiniMax M3</b> — keep your own Claude login for everything else.
</p>

## About this fork

This is a fork of **[klarkxy/minimax-vscode](https://github.com/klarkxy/minimax-vscode)** ("MiniMax Copilot"), which registers MiniMax models in GitHub Copilot Chat. All of the original Copilot Chat features are kept and still work (see [Features](#features)).

**Why it exists:** Claude Code sends a large share of its traffic to its cheapest tier, **Haiku**: background tasks, session titles, Explore and other subagents, and anything you run with `/model haiku`. This fork moves that tier onto a **MiniMax Token Plan** without touching anything else. Sonnet and Opus keep running on your own Claude subscription or API login, so subagent-heavy workflows spend MiniMax quota instead of Anthropic quota. The upstream extension only targets Copilot Chat and has no way to do this.

**What this fork adds on top of upstream:**

- A local routing proxy plus Claude Code environment injection ([Claude Code routing](#claude-code-routing)).
- MiniMax tokens used through Claude Code show up in the usage dashboard.
- A [benchmark](#benchmark-m3-as-claude-codes-haiku-tier) checking that M3 can fully replace Haiku as a Claude Code subagent model.

## Quick start (Claude Code)

1. **Install.** This fork is not the extension on the upstream Marketplace listing. Build and install it from source:

   ```bash
   git clone https://github.com/rzfzr/minimax-vscode && cd minimax-vscode
   npm ci
   npm run package:dev            # → dist/minimax-claude-code-<version>.vsix
   code --install-extension dist/minimax-claude-code-<version>.vsix
   ```

   Uninstall the original `klarkxy.minimax-vscode-copilot` first, because both register the same `minimax.*` commands.

2. **Add your key.** Run **MiniMax: Add API Key** from the command palette and paste a MiniMax Token Plan key. The China or Global endpoint is detected automatically.
3. **Turn routing on.** Run **MiniMax: Enable Claude Code Routing**. Routing is opt-in; nothing in your Claude Code settings changes until you do this.
4. **Start a new Claude Code session**, either in the Claude Code extension or with `claude` in a VS Code terminal. Sessions that were already open keep their old environment.
5. **Check that routing works.** The `MiniMax CC` status bar item should show the proxy as running. After a Haiku-tier request (for example an Explore subagent, or `/model haiku`), **MiniMax: Show Logs** prints `[ClaudeCode] POST /v1/messages model=MiniMax-M3 → MiniMax`, and the tokens show up in the **Usage Dashboard** `claude` tab.

GitHub Copilot Chat is **not** required for Claude Code routing. You only need it for the Copilot Chat models described in [Getting Started](#getting-started).

## Claude Code routing

Add your MiniMax Token Plan key (**MiniMax: Add API Key**) and turn routing on (**MiniMax: Enable Claude Code Routing**). The extension then:

1. Starts a local proxy on `http://127.0.0.1:4000`.
2. Injects into every **new** Claude Code session started from VS Code (the Claude Code extension via `claudeCode.environmentVariables`, and `claude` run in VS Code terminals):

   ```json
   {
   	"ANTHROPIC_BASE_URL": "http://127.0.0.1:4000",
   	"ANTHROPIC_DEFAULT_HAIKU_MODEL": "MiniMax-M3"
   }
   ```

3. Routes each request by its `model`: `MiniMax-*` models go to MiniMax with your key; everything else (Opus, Sonnet, OAuth/usage endpoints) is passed through byte-for-byte with **your own** Claude credentials, to the `ANTHROPIC_BASE_URL` you had before (if any) or to `api.anthropic.com`.

No `ANTHROPIC_AUTH_TOKEN` is set — it would replace your Claude subscription login on every request. The proxy adds the MiniMax key itself.

| Setting                                                | Default      |                                                                                                                   |
| ------------------------------------------------------ | ------------ | ----------------------------------------------------------------------------------------------------------------- |
| `minimax.claudeCode.routing.enabled`                   | `false`      | Master switch (also: **MiniMax: Enable / Disable Claude Code Routing**, or the `MiniMax CC` status bar item).     |
| `minimax.claudeCode.routing.haikuModel`                | `MiniMax-M3` | Model for the Haiku tier (background tasks, Explore subagents, `/model haiku`). Empty = Anthropic Haiku.          |
| `minimax.claudeCode.routing.sonnetModel` / `opusModel` | empty        | Optional overrides for the other tiers.                                                                           |
| `minimax.claudeCode.routing.port`                      | `4000`       | Proxy port. Multiple VS Code windows share one proxy; another window takes over within 5 s when the owner closes. |
| `minimax.claudeCode.routing.passthroughUrl`            | empty        | Upstream for non-MiniMax traffic. Empty = your previous `ANTHROPIC_BASE_URL`, else `https://api.anthropic.com`.   |

Notes:

- Changes apply to **new** Claude Code sessions; restart open ones.
- A standalone `claude` outside VS Code is never redirected, so it never depends on the proxy being up.
- Claude Code prints a one-time note that `MiniMax-M3` is not in its model catalog and assumes a 200K context window; that is expected.
- Provisioning without the input box: put the key in the user setting `minimax.apiKey`; on activation it is moved into SecretStorage and the setting is cleared.
- MiniMax tokens used through Claude Code show up in the **Usage Dashboard**'s `claude` tab.

How your Claude Code settings are handled:

- Only the variables routing needs are written: `ANTHROPIC_BASE_URL` and the tiers you set a model for. A tier left empty is not touched, so your own `ANTHROPIC_DEFAULT_OPUS_MODEL` (for example) stays as it is. Other entries in `claudeCode.environmentVariables` are never modified.
- Before a variable is replaced, its previous value is saved. Turning routing off puts it back, or removes the variable if you had none. If you edit a routed variable while routing is on, your edit becomes the value that is put back later.
- With routing off, or with no API key, the extension does not write to your Claude Code settings at all (except to restore values it changed earlier).
- Claude Code is only pointed at the proxy while a proxy is running. When the window running the proxy closes, or the extension is disabled or uninstalled, the previous values are restored first. Another open window takes over the proxy and re-applies routing; otherwise the next VS Code start does. If VS Code is killed before the restore finishes, the next start fixes it.

Multiple windows:

- VS Code windows of the same installation and profile share one proxy. They also share the same API keys and settings, and the proxy reads the active key, region and passthrough upstream for every request, so it does not matter which window started it.
- A MiniMax proxy from a different installation (e.g. VS Code Insiders next to Stable), a different profile, or an older build of this extension is identified through its health check and never used, because it would answer with that instance's keys and settings. Routing stays off in that window until the other proxy goes away; set a different `minimax.claudeCode.routing.port` there to run both.

## Benchmark: M3 as Claude Code's Haiku tier

This benchmark asks whether `MiniMax-M3`, routed through this extension, can **fully replace** Haiku as a Claude Code subagent model. That means two things: it has to produce correct results, and it has to behave the same way inside the harness (tool calling, Read-before-Edit, following constraints and report formats). It also checks whether Claude Code's reasoning-effort setting changes anything for M3.

### Setup

- **Date and versions:** run on 2026-10-06 with Claude Code 2.1.289 (VS Code extension, Windows 11).
- **Configurations compared:**
  - Sonnet 5.5 at `--effort low`, which is the baseline and goes to Anthropic.
  - `haiku` → M3 at `--effort low`.
  - `haiku` → M3 at `--effort high`.
  - Three in-session subagents (`Agent` tool, `model: haiku`) that inherit the parent session's effort (high).
- **How the runs were made:** the three configurations ran as headless `claude -p` sessions. The Agent tool has no per-subagent effort setting, and agent definitions are not reloaded mid-session.
- **Same harness for every run:** the same allowed tools (`Read, Grep, Glob, Edit, Bash`) and the Agent tool disabled, to match a subagent's toolset. Each session also had its own logging relay in front of the proxy to record what was sent upstream.
- **Grading:** every answer was checked against the source by hand, and every bug fix was re-run.

| Task                         | What it tests                                                                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **T1** Code questions        | Four read-only questions about this repo, answered as JSON only, with file:line citations. One trap: the docs said "11 reserved keys", but the code skips 10.            |
| **T2** Bug fix               | Fix 4 planted bugs in `lib.js` without changing the spec file `lib.test.js`, then run the tests. Trap: sorting the input in place breaks a "does not mutate input" test. |
| **T3** Run tests, trace code | Run the proxy unit tests, then answer 5 routing and port-conflict questions in a fixed markdown format with citations.                                                   |

### Results

| Configuration           | T1 (4 questions)      | T2 (bug fix)     | T3 (5 questions) | Followed the output format?           | Time T1 / T2 / T3 |
| ----------------------- | --------------------- | ---------------- | ---------------- | ------------------------------------- | ----------------- |
| Sonnet 5.5, low         | 4/4                   | 12/12 tests pass | 5/5              | ✗ T1: prose before "JSON only" answer | 22 / 13 / 13 s    |
| M3, low                 | **4/4**, best notes   | 12/12 tests pass | 5/5              | ✗ T3: went over the 2-sentence limit  | 62 / 80 / 24 s    |
| M3, high                | 3/4 (missed the trap) | 12/12 tests pass | 5/5              | ~ T1: JSON wrapped in a code fence    | 48 / 106 / 41 s   |
| M3, in-session subagent | 3/4 (missed the trap) | 12/12 tests pass | 5/5              | ✓                                     | 53 / 73 / 35 s    |

**Tool calling:** M3 works as a drop-in replacement.

- **No failures:** across all M3 runs there were zero malformed tool calls, zero permission denials and zero writes outside allowed paths. The spec file was never modified, and the repo was left clean.
- **Dedicated tools:** M3 always read a file before editing it, used `Edit` for changes and `Grep`/`Glob` for search, and often ran several tools in parallel (7 of 10 tool-using turns in one run).
- **Sonnet deviated more:** at low effort it rewrote `lib.js` with a Python script run through `Bash`, without using Read or Edit.
- **M3 quirks:**
  - **Inflated bug count:** one M3 run broke a test with its first edit, caught it on the test run and fixed it, then reported its own regression as a fifth "bug".
  - **Trusting the docs:** two M3 runs accepted the docs' "11 reserved keys" after finding a secondary mechanism, instead of searching further.

**Speed:** M3 was about 2–8× slower in wall-clock time than Sonnet at low effort on these tasks. This is the main practical cost.

**Background calls:** Claude Code also sends some background requests to the Haiku tier, such as session-title generation with a `json_schema` output format. With routing on, those go to M3 even in Sonnet sessions, and all of them returned HTTP 200.

### Reasoning effort has no effect on M3

- **What reaches MiniMax:** Claude Code sends effort as `output_config.effort: "low" | "high"` together with `thinking: { type: "adaptive" }`, and the proxy forwards the body unchanged.
- **Controlled test:** the same multi-step probability problem was sent directly to M3 three times each with effort `low`, `high` and unset:

  | Effort | Output tokens | Correct answers |
  | ------ | ------------: | :-------------: |
  | low    |       806–976 |       3/3       |
  | high   |      752–1201 |       3/3       |
  | unset  |       826–873 |       3/3       |

  Latency was also the same within noise.

- **In the agent runs:** high effort did not produce more thinking (T2: 15.2k thinking characters at low vs 9.3k at high) or better answers.

In practice, Claude Code's `/effort` setting does nothing for the Haiku tier when it runs on M3. M3's only real reasoning switch is turning thinking off (`thinking: { type: "disabled" }`).

### Caveats

- There is one run per cell, so the score differences between the M3 configurations are within noise. The tool-calling behaviour and the speed gap were consistent across every run.
- The dollar costs Claude Code reports for the M3 sessions use Claude's own price table. They do not reflect what MiniMax actually bills.
- Headless `claude -p` sessions use the main-session system prompt rather than the subagent one. The three in-session `Agent` subagents ran the real subagent path and agree with the headless results.

## Features

- **M3.1-Flash-Preview / M3 / M2.7 / M2.7-highspeed in the Copilot Chat model picker** with pricing in the tooltip. M3 accepts native image and video input; M2.7 models are text / tool-call only on the Anthropic-compatible API.
- **Native video input on M3** — `type: "video"` parts inline, with a hard 64 MB request body cap.
- **Thinking mode toggle** — binary `disabled` / `adaptive` switch in the M3 picker dropdown.
- **Use MiniMax for Copilot utility flows** — configure Agent helpers, titles, summaries, and the Source Control ✨ commit button through MiniMax.
- **Per-model sampling** — `temperature` / `topK` / `topP` / `frequencyPenalty` overrides per model.
- **Cumulative usage tracker** — per-model input / output / cache tokens across the extension lifetime.
- **Usage dashboard** — today / 7-day / 30-day views, 30-day bar chart, per-model breakdown, platform `coding_plan/remains`, and Claude Code JSONL ingest.
- **mmx-cli status detection** — dashboard shows whether the official MiniMax CLI / auth / SKILL is set up; copy the install prompt to the clipboard.
- **MiniMax Web Search MCP (Agent Mode)** — VS Code's MCP runtime launches `uvx minimax-coding-plan-mcp` automatically once you've set an API key and a recognised host; the extension injects the key + host as env and re-fires the definition when either changes.
- **Diagnostics** — per-request classifier, cache-hit stats, verbose mode dumps every request to disk.

## Screenshots

![MiniMax usage dashboard](https://raw.githubusercontent.com/klarkxy/minimax-vscode/main/image/dashboard.png)

![MiniMax quota status bar](https://raw.githubusercontent.com/klarkxy/minimax-vscode/main/image/%E7%8A%B6%E6%80%81%E6%A0%8F.png)

## Getting Started

This section covers the **Copilot Chat** models inherited from upstream. For Claude Code routing, see [Quick start (Claude Code)](#quick-start-claude-code).

### Prerequisites

- **VS Code 1.111.0+**
- **GitHub Copilot Chat** installed and signed in
- A MiniMax [Token Plan](https://platform.minimax.io/user-center/payment/token-plan) subscription and API key
- **VS Code Insiders** to render M3 thinking blocks via the proposed `languageModelThinkingPart` API

### Installation

1. Install this fork from a `.vsix` as described in [Quick start (Claude Code)](#quick-start-claude-code). The [Marketplace listing](https://marketplace.visualstudio.com/items?itemName=klarkxy.minimax-vscode-copilot) is the original upstream extension, which has no Claude Code routing.
2. Run **MiniMax: Add API Key** from the command palette, give it a name, and paste your Token Plan key. The extension auto-detects China vs Global and stores the key in SecretStorage. Use **MiniMax: Manage API Keys** to add more, switch, rename, or delete.
3. Open Copilot Chat, pick **MiniMax M3** (or M2.7 / M2.7-highspeed).
4. On VS Code 1.128+, run **MiniMax: Set Copilot's Utility Models** before using Agent mode with MiniMax. Choose a MiniMax model, keep both utility slots selected, then reload Copilot Chat.

### Endpoint

On first activation, if `minimax.apiBaseUrl` is still at its default, the extension picks `https://api.minimax.io/anthropic` automatically. Once you set the URL manually or run the switch command, the auto-picked value is preserved.

## Models

| Model                            | Context (spec / effective) | Native media input | Notes                                                                                                                        |
| -------------------------------- | -------------------------: | ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| **MiniMax M3.1 Flash (Preview)** |        1,000,000 / 512,000 | ✅ image + video   | Post-trained M3 variant; shares M3's capabilities, pricing and the 512K safe default / 1M toggle.                            |
| **MiniMax M3**                   |        1,000,000 / 512,000 | ✅ image + video   | Top-tier coding; native video input (MP4 / AVI / MOV / MKV). Effective cap is 512K until the >512K tier is fully rolled out. |
| **MiniMax M2.7**                 |                    204,800 | —                  | Self-iterating, ~60 TPS; text and tool-call content blocks only.                                                             |
| **MiniMax M2.7-highspeed**       |                    204,800 | —                  | Same quality, ~100 TPS; text and tool-call content blocks only.                                                              |

Users with >512K access can run **MiniMax: Toggle M3 1M Context** to lift the cap (the command pops a modal warning about 1.5× billing before flipping the switch). The full spec is on the [Supported models page](https://platform.minimax.io/docs/guides/text-generation).

**Historical models:** M2.5 / M2.1 / M2 are not in the picker by default.

## Pricing

Prices are in **USD** (billed in USD for international users). The picker tooltip renders the table that matches your active `minimax.apiBaseUrl`. See the [pricing page](https://platform.minimax.io/docs/guides/pricing-paygo) for the latest.

### Pay-as-you-go (per million tokens)

| Model                                 | Input | Output | Cache read | Cache write |
| ------------------------------------- | ----: | -----: | ---------: | ----------: |
| **MiniMax M3.1 Flash (Preview)**      | $0.30 |  $1.20 |      $0.06 |           — |
| **MiniMax M3 (≤512K input)**          | $0.30 |  $1.20 |      $0.06 |           — |
| **MiniMax M3 (>512K input, limited)** | $0.60 |  $2.40 |      $0.12 |           — |
| **MiniMax M2.7**                      | $0.30 |  $1.20 |      $0.06 |      $0.375 |
| **MiniMax M2.7-highspeed**            | $0.60 |  $2.40 |      $0.06 |      $0.375 |

The >512K input tier is in limited rollout; see the [pricing page](https://platform.minimax.io/docs/guides/pricing-paygo) for the latest. Token Plan subscription is billed separately — see below.

### Token Plan subscription

A Subscription Key covers language models plus speech / video / music / image endpoints through a shared usage bar. Deducts from the included quota at each endpoint's pay-as-you-go price; purchased Credits cover any overrun.

| Tier    |    Price (USD) | Quota windows           | Agent usage |
| ------- | -------------: | ----------------------- | ----------: |
| Starter |  $20 per month | 5-hour rolling + weekly |  3-4 agents |
| Pro     |  $50 per month | 5-hour rolling + weekly |  4-5 agents |
| Max     | $120 per month | 5-hour rolling + weekly |  6-7 agents |

## Settings

| Setting                                  | Default                                                                      | Purpose                                                                                                                                                                                      |
| ---------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `minimax.apiBaseUrl`                     | _auto-picked_                                                                | Anthropic-compatible base URL. Auto-picked on first activation; defaults to `https://api.minimax.io/anthropic`.                                                                              |
| `minimax.visibleModels`                  | _all M-series_                                                               | Restrict which models appear in the picker. Defaults to `MiniMax-M3.1-Flash-Preview / MiniMax-M3 / MiniMax-M3-Priority / MiniMax-M2.7 / MiniMax-M2.7-highspeed`.                             |
| `minimax.maxOutputTokens`                | `0`                                                                          | Output cap. `0` lets the model decide. See `minimax.enableM31MContext` for the input/context window.                                                                                         |
| `minimax.enableM31MContext`              | `false`                                                                      | Lift M3 / M3-Priority from 512K to 1M context. Off by default; the toggle command pops a billing warning first.                                                                              |
| `minimax.sampling`                       | `{}`                                                                         | Per-model `temperature` / `topP` / `topK` / `frequencyPenalty` overrides. Keys: `MiniMax-M3.1-Flash-Preview`, `MiniMax-M3`, `MiniMax-M3-Priority`, `MiniMax-M2.7`, `MiniMax-M2.7-highspeed`. |
| `minimax.experimental.modelDefPresets`   | `{}`                                                                         | Per-model escape hatch for request body fields.                                                                                                                                              |
| `minimax.debugMode`                      | `minimal`                                                                    | `minimal` / `metadata` / `verbose`.                                                                                                                                                          |
| `minimax.modelIdOverrides`               | `{}`                                                                         | Map picker IDs to API IDs (useful for proxies).                                                                                                                                              |
| `minimax.dashboard.includeClaudeCode`    | `true`                                                                       | Master toggle for the Claude Code JSONL ingest section.                                                                                                                                      |
| `minimax.claudeCode.logPath`             | `~/.claude/projects`                                                         | Root directory the ingester walks.                                                                                                                                                           |
| `minimax.claudeCode.pollIntervalMs`      | `30000`                                                                      | Scan interval in milliseconds. Clamped to `[5000, 600000]`.                                                                                                                                  |
| `minimax.experimental.stabilizeToolList` | `false`                                                                      | Synthesise preflight tool calls to keep the upstream prompt cache warm. **Experimental.**                                                                                                    |
| `minimax.claudeCode.allowedModels`       | `MiniMax-M3.1-Flash-Preview / M3 / M2.7 / M2.7-highspeed / M2.5 / M2.1 / M2` | Allowlist of model IDs counted in the Claude Code section of the dashboard. Claude Code may be talking to other Anthropic-compatible providers; only MiniMax-related rows are counted.       |

## Commands

| Command                                                       | Purpose                                                                                                   |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **MiniMax: Add API Key**                                      | Name a new key, auto-detect its region (China / Global / unknown), store in SecretStorage, make it active |
| **MiniMax: Remove API Key**                                   | Remove the active named key (or the legacy single-key slot if the pool is empty)                          |
| **MiniMax: Manage API Keys**                                  | Open a sub-menu: Add / Switch / Rename / Delete                                                           |
| **MiniMax: Switch API Key**                                   | Pick an existing named key to make active (mirrors its endpoint)                                          |
| **MiniMax: Rename API Key**                                   | Change a named key's display name                                                                         |
| **MiniMax: Delete API Key**                                   | Pick a named key to delete (with confirmation)                                                            |
| **MiniMax: Set Copilot's Utility Models**                     | Pick a chat model and write it to both `chat.utilitySmallModel` and `chat.utilityModel` by default        |
| **MiniMax: Toggle M3 1M Context**                             | Lift M3's picker entry to 1M (with billing warning)                                                       |
| **MiniMax: Switch to Global API (`minimax.io/anthropic`)**    | Switch to the international Anthropic endpoint                                                            |
| **MiniMax: Switch to Chinese API (`minimaxi.com/anthropic`)** | Switch to the China-region Anthropic endpoint                                                             |
| **MiniMax: Show Logs**                                        | Focus the MiniMax output channel                                                                          |
| **MiniMax: Open Request Dumps Folder**                        | Reveal verbose request dumps                                                                              |
| **MiniMax: Open Usage Dashboard**                             | Open the usage dashboard                                                                                  |
| **MiniMax: Rescan Claude Code Logs**                          | Force a fresh read of the Claude Code JSONL log directory                                                 |
| **MiniMax: Open Claude Code Log Folder**                      | Reveal the resolved Claude Code log directory in the OS file manager                                      |
| **MiniMax: Copy mmx-cli install prompt**                      | Copy the verbatim three-step install prompt to the clipboard                                              |
| **MiniMax: Refresh MiniMax Web Search MCP**                   | Re-resolve the MCP provider so VS Code picks up the latest API key / host on the next spawn               |

## Troubleshooting

- **No models in the picker** — open **MiniMax: Open Usage Dashboard** to see whether an API key is set and which models are visible.
- **HTTP 404 from the gateway** — make sure `minimax.apiBaseUrl` is `https://api.minimax.io/anthropic`, not a third-party proxy that expects the OpenAI protocol.
- **"API key is missing its secret" warning in the dashboard** — VS Code SecretStorage lost the entry (e.g. after a settings reset or a workspace migration). Run **MiniMax: Add API Key** to re-add the key, or **MiniMax: Delete API Key** to drop the orphan metadata. The dashboard shows a `secret missing` badge next to affected entries.
- **"API key not configured"** — run **MiniMax: Add API Key**; the key is stored in VS Code SecretStorage, not in `settings.json`.
- **`No utility model is configured for 'copilot-utility-small'` in Agent mode** — run **MiniMax: Set Copilot's Utility Models**, keep both utility slots selected, then reload Copilot Chat. Alternatively set `chat.byokUtilityModelDefault` to `mainAgent` in user settings.
- **Source Control ✨ button does not invoke MiniMax** — run **MiniMax: Set Copilot's Utility Models** to set `chat.utilitySmallModel` to a MiniMax model, then restart Copilot Chat.
- **M3 picker still shows 512K after toggling 1M on** — switch models in the picker once; some Copilot Chat versions cache the entry until the next message.
