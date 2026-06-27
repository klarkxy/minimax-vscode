# Changelog

## 2.5.0 — 2026-06-27

### Added — Named API key pool

- **Multiple named API keys.** Run **MiniMax: Add API Key** to give a key a name; the extension auto-probes the official China / Global `coding_plan/remains` endpoint, picks the right region, stores the secret in VS Code SecretStorage, and sets the key active. The key's `apiBaseUrl` is the source of truth for which Anthropic-compatible endpoint the chat request hits — the legacy `minimax.apiBaseUrl` setting is **not** mirrored (see "Key owns the host" below). Add as many keys as you like.
- **Five new commands** alongside the historical "Set / Clear":
  - **MiniMax: Add API Key** — name + secret + region probe + activate.
  - **MiniMax: Switch API Key** — pick from the pool; the active key's endpoint wins.
  - **MiniMax: Rename API Key** — change a name; secrets are not touched.
  - **MiniMax: Delete API Key** — pick a key, confirm, drop secret + metadata; active rotates to the next entry automatically.
  - **MiniMax: Manage API Keys** — sub-menu that runs any of the four above.
- **Status bar mirrors the active key.** The right-side quota items render as `copilot-1 5h 73%` / `Week 11%` instead of an anonymous `5h 73%`. The tooltip lists every named key with its region and fingerprint, so a glance tells you which key is feeding today's quota.
- **Dashboard "API Keys" section.** Top of the "总" tab; every named key is listed with the active one badge-marked. Five inline buttons (Add / Switch / Rename / Delete / Manage) drive the same `minimax.*` commands.
- **Per-key usage scoping.** `UsageStore` now buckets Copilot usage by `keyId`. The default view follows the active key; a future "all keys" aggregate is rendered only when the user explicitly asks for it. Claude Code JSONL stays a separate source (no key attribution by design).
- **Cross-window sync.** `KeyManager.onDidChange` fans out to the chat model picker, the dashboard, the status bar, and the PlanCache. `secrets.onDidChange` listens on the whole `minimax-vscode.apiKeys.*` prefix, so adding / switching / deleting in window A refreshes window B without a reload.
- **Active key switch invalidates the plan cache + re-registers the MCP provider.** `runtime/commands.ts` now hooks the pool's `onDidChange` to drop every cached `coding_plan/remains` snapshot (the previous `(apiKey, host)` identity no longer matches the new active key) and to fire `mcp.refreshDefinitions()` so the next MCP spawn picks up the new key + endpoint. The legacy single-key slot is also re-detected on every refresh, so an out-of-band SecretStorage reset surfaces a `secret missing` badge in the dashboard's API Keys section instead of failing silently.
- **Add key auto-probe is advisory.** `KeyManager.addApiKey` runs `coding_plan/remains` against both official hosts and picks the narrowest result (`china` / `global`). When both succeed it falls back to the China default (matching `autoSelectEndpointIfUnset`). When neither succeeds, the key is saved with `region: 'custom'` and the user's existing `minimax.apiBaseUrl`; the dashboard renders it as "unrecognised". The user can override at any time via `minimax.switchApiKey` / `minimax.switchToGlobal` / `minimax.switchToChina`.

### Added — Terminal environment injection

- **System prompt and tool descriptions now describe the host terminal.** [`injectTerminalEnvironment`](src/provider/terminalEnvironment.ts) builds a short environment block (OS, shell, default working directory, `git status` short SHA when available) and prepends it to the system prompt on every chat turn. The same block is appended to each tool's `description` so an MCP server / `Activate_*` placeholder tool can decide whether to spawn a subprocess without asking the model. The block is bounded to a few hundred bytes; local-only; never sent anywhere except MiniMax's Anthropic-compatible endpoint on the active key.
- **Toggleable.** New setting `minimax.experimental.injectTerminalEnvironment` (default `true`) lets advanced users disable the injection when they want the system prompt to mirror the upstream baseline. Off is unconditional — the field is never silently re-enabled.

### Added — BYOK signal on chat models

- All chat models are now advertised as `isBYOK: true` in [`LanguageModelChatInformation`](src/provider/models.ts). MiniMax's Token-Plan billing is wholly separate from Copilot's premium-request budget, and the host uses this flag to avoid charging the round-trip to its own quota. The flag is part of the same proposed-API bucket as `configurationSchema`; keep the literal-`true` type and inline comment so any host that knows about the field picks it up.

### Changed — Provider request body

- **Adjacent same-role messages are merged before the API call.** The Anthropic-compatible protocol rejects runs of consecutive `user` or `assistant` turns; when Copilot emits fragmented turns (e.g. a tool result chunked across two `LanguageModelChatRequestMessage` entries) the converter used to forward the run as-is and let the upstream error out. [`request.ts`](src/provider/request.ts) now collapses every contiguous run into a single message and concatenates the content blocks in order. No content is dropped, no role is re-labelled, and tool-call / tool-result pairing is preserved across the merge.

### Changed

- **The legacy `minimax.setApiKey` command is now titled "Add API Key"** and routes through the named key pool instead of writing to `minimax-vscode.apiKey` directly. The old single-key slot is preserved as a read-only fallback (for users upgrading without re-running the setup flow) and is labelled "Default" in the dashboard.
- **`minimax.clearApiKey` is now titled "Remove API Key"**: when at least one named key exists it opens the same delete confirmation as the new command; when the pool is empty it falls back to clearing the legacy slot.

### Fixed

- **M2.7 models no longer advertise native image input.** MiniMax's Anthropic-compatible API only accepts text and tool-call content blocks for the M2.x family; image and video blocks are M3-only. The picker capabilities, converter tests, and README model table now reflect that boundary so image attachments are not forwarded to `MiniMax-M2.7` / `MiniMax-M2.7-highspeed` as unsupported `image` blocks.

### Added — Key owns the host

The MiniMax API key is now the source of truth for which Anthropic-compatible endpoint to talk to. The `minimax.apiBaseUrl` setting is **deprecated** and is only consulted as a fallback when the named-key pool has no active entry. Switching the active key no longer rewrites the setting, and custom-proxy users keep their proxy URL.

- **Legacy single-key slot is auto-migrated on activation.** On `activate()`, the manager detects the legacy `secrets['minimax-vscode.apiKey']` slot and copies it into a `__legacy__` entry in the named pool with `region: 'custom'` and an empty `apiBaseUrl`. Migration is idempotent across windows and is skipped when a non-legacy key is already active. A fire-and-forget region probe (`coding_plan/remains` against both official hosts) then fills in `region` + `apiBaseUrl` without blocking activation; the request path falls back to the configured setting while the probe is in flight.
- **`reprobeActiveKey()` on `KeyManager`** re-runs the official China / Global probe against the currently active key and updates the entry's `region` / `apiBaseUrl` in place. Already-probed named keys short-circuit to a no-op. When the probe returns `unsupported`, the entry keeps `region: 'custom'` and falls back to the user's configured `minimax.apiBaseUrl` (custom-proxy preserved). On success, the legacy `secrets['minimax-vscode.apiKey']` slot is deleted once the migrated legacy entry has a confirmed host.
- **One new command:**
  - **`MiniMax: Re-probe Active API Key`** — re-detect China / Global region for the active key on demand. No-op when the active key is already on a known region + URL. Invalidates the plan cache on a real change so the dashboard quota card re-fetches against the new host.
  - Available in the **MiniMax: Manage API Keys** sub-menu as **Re-probe active API key**.
- **Request path reads the host from the active key.** [`PreparedChatRequest`](src/provider/request.ts) carries a new `baseUrl` field that [`prepareChatRequest`](src/provider/request.ts) resolves via `keyManager.getActiveApiBaseUrl()`. [`streamChatCompletion`](src/provider/stream.ts) passes that into `MiniMaxClient.streamChat` instead of `getBaseUrl()` from `src/config.ts`. The setting is still read by `getActiveApiBaseUrl()` as a fallback when the pool is empty.
- **Plan cache + dashboard quota card follow the active key.** [`detectHost`](src/runtime/commands.ts) reads the active key's `apiBaseUrl` first, then falls back to `minimax.apiBaseUrl`. Same pattern in `refreshMcp` so the MCP server definition matches the chat request host.

### Changed

- **`minimax.apiBaseUrl` setting is deprecated.** Carries a `deprecationMessage` pointing users at **MiniMax: Add API Key**. Will be removed in 3.0. Existing `settings.json` entries still load.
- **Walkthrough completion events updated.** The "Pick your API endpoint" step now completes on `onCommand:minimax.reprobeApiKey` (was `onCommand:minimax.switchToGlobal` / `onCommand:minimax.switchToChina`). The "Add your first API key" step now completes on `onCommand:minimax.addApiKey` (was `onCommand:minimax.setApiKey`) so it tracks the modern entry point.

### Removed

- **`minimax.switchToGlobal` command.** Replaced by **`MiniMax: Re-probe Active API Key`**. Users with keybindings pointing at the old command id will get a "command not found" — update the binding to the new id.
- **`minimax.switchToChina` command.** Same replacement story.

### Migration notes for this release

- **Single-key users**: nothing to do. On next activation the legacy secret is migrated into the pool; the region probe runs asynchronously. The first chat turn before the probe completes may use the previously-configured `minimax.apiBaseUrl` setting — that is expected.
- **Custom-proxy users**: keep using `minimax.apiBaseUrl` to point at your proxy. After you add a named key (via **MiniMax: Add API Key**), the key's probed `apiBaseUrl` wins. To re-bind the proxy URL, run **MiniMax: Re-probe Active API Key** — when the probe returns `unsupported` the entry falls back to your configured `minimax.apiBaseUrl`.
- **Multi-key users**: switching keys no longer touches the setting. The active key's `apiBaseUrl` is read on every request.

## 2.4.1 — 2026-06-17

### Fixed

- **402/429 no longer trigger Copilot's "reached the limit / upgrade" modal.** When the MiniMax upstream returns `402 Insufficient Balance` or `429 Rate Limit`, Copilot Chat was treating it as a Copilot-side quota error and popping a misleading upgrade modal on top of the request. [`streamChatCompletion`](src/provider/stream.ts) now detects those two statuses on a `MiniMaxRequestError` and emits the localised `userSummary` (e.g. `[402] 当前端点余额不足…`) as plain in-chat text via `progress.report(new LanguageModelTextPart(...))` instead of throwing — the message lands in the conversation where the user can actually read it. Every other status (401 / 500 / 503 / 529 / …) still goes through the existing throw path, so the structured action buttons keep firing. The change is a no-op for any non-MiniMax error (the `instanceof MiniMaxRequestError` guard short-circuits).

- **`.vscodeignore` now denies `**/*.log` everywhere.** `.gitignore` already ignored `*.log` for git, but `vsce package` only consults `.vscodeignore` — a stray `> test-all.log` from an ad-hoc `npm test` run would have silently shipped as `extension/test-all.log` in the VSIX (the v2.4.0 cut almost published with the full unit-test transcript inside). The deny is mirrored in `.vscodeignore` so any future log artifact — including from sub-directories `.gitignore` doesn't cover — stays out of the package. Catches the same class of leak that 2.3.1 closed for Windows reserved device names and `.claude/memory`.

## 2.4.0 — 2026-06-17

### MiniMax Web Search MCP — Agent Mode tools without skill prompts

- The extension now registers a VS Code MCP server definition provider
  (`contributes.mcpServerDefinitionProviders` id `minimax-web-search`,
  registered via `vscode.lm.registerMcpServerDefinitionProvider`).
  VS Code's MCP runtime spawns `uvx minimax-coding-plan-mcp -y` on
  demand and discovers the `web_search` tool from the official
  MiniMax Web Search MCP package — no `mmx-cli` install or skill
  prompt required.
- The API key stays in SecretStorage; the extension only injects it
  as `MINIMAX_API_KEY` env into the child process at spawn time.
  `MINIMAX_API_HOST` follows the user's `minimax.apiBaseUrl` —
  China → `https://api.minimaxi.com`, international →
  `https://api.minimax.io`. Third-party proxy base URLs are
  rejected on purpose to avoid credential leak (the same policy
  the dashboard's Token Plan card already enforces).
- Dashboard gains a compact **MiniMax Web Search MCP** card next
  to the mmx-cli status: provider / key / host / launch command.
  New command `MiniMax: Refresh MiniMax Web Search MCP` re-fires
  the provider so VS Code picks up fresh credentials on the next
  MCP call.
- `onDidChangeMcpServerDefinitions` fires automatically when the
  API key changes (set / clear / replace) or when `minimax.apiBaseUrl`
  changes — no manual restart required.
- We deliberately do NOT enumerate the tools the MCP server
  exposes (the docs only list `web_search` on the international site
  and may change). The authoritative list lives in Copilot Chat's
  Configure Tools picker, not in our UI. We also do NOT install
  `uvx` for the user — when it's missing VS Code surfaces the spawn
  failure in the MCP output channel, and the README links to the
  official install command.

### Tests

- Added `test/mcp.test.ts` covering host mapping (China / global /
  spoofed userinfo / malformed), env injection, the provider's
  `provideMcpServerDefinitions` / `resolveMcpServerDefinition`
  contract, missing-key behaviour, and the
  `onDidChangeMcpServerDefinitions` config listeners.
- `test/helpers/vscodeMock.ts` gains a minimal `vscode.lm` mock
  (`registerMcpServerDefinitionProvider`, `McpStdioServerDefinition`)
  plus a `mockConfig` store and a `workspace.onDidChangeConfiguration`
  stub so the existing tests can keep driving the dashboard through
  its public surface.

## 2.3.1 — Drop stray `nul` file, harden `.vscodeignore`

### Fixed

- **Marketplace validation rejected v2.3.0 with `The extension contains an entry extension/nul which is unsafe for extraction.`** A 0-byte file literally named `nul` had landed in the project root (a Windows `>nul` shell-redirection artifact). The Marketplace validator scans VSIX entries for Windows reserved device names (`nul`, `con`, `prn`, `aux`, `com1`-`com9`, `lpt1`-`lpt9`) and rejects them regardless of the build host's OS — a file named `nul` on Linux/macOS still fails validation because end users may extract on Windows. The file has been deleted and [.vscodeignore](.vscodeignore) now denies the full reserved-name set at the root, so future stray `>nul` / `>con` / etc. artifacts cannot slip through.
- **`.claude/memory/release-workflow.md` was silently bundled into the VSIX** (1.9 KB internal memory note shipped as `extension/.claude/memory/release-workflow.md`). The path is now in [.vscodeignore](.vscodeignore) deny list. Working-tree files are not extension assets.

### Release workflow

- `release.yml` now also triggers on `push: tags: ['v*']` and the `publish` job fires on tag pushes (in addition to `release_created == 'true'`). This means a manual release cut (`git tag vX.Y.Z && git push origin vX.Y.Z`) flows through the same pipeline as a release-please cut: the workflow builds, attaches to the GitHub Release, and (new) publishes to the VS Code Marketplace and Open VSX automatically. Previously, the marketplace publish step was missing from `release.yml` entirely — every cut had to be hand-published via `rescue.yml` (or `vsce publish` locally), which is exactly how v2.3.0's `nul` leak reached the marketplace uncaught.
- `rescue.yml` is unchanged and remains the escape hatch for re-publishing an existing tag without cutting a new one.

## 2.3.0 — Drop custom commit pipeline, route Copilot's utility models

> **Heads-up:** this release removes a previously public command and setting.
> Users who had `MiniMax: Generate Commit Message` bound to a keyboard
> shortcut, or who set `minimax.commitModel` in their `settings.json`,
> will need to migrate to the new path.

### Removed

- **The `MiniMax: Generate Commit Message` command and the `minimax.commitModel` setting are gone.** To use MiniMax for commit messages, set `chat.utilitySmallModel: minimax/<id>` in your user settings, or run the new **MiniMax: Set Copilot's Utility Models** command — a two-stage QuickPick first asks which model, then which `chat.*` settings to overwrite (defaults to `chat.utilitySmallModel` for the Source Control ✨ button, also offers `chat.utilityModel` for titles / summaries). The new path uses VS Code's built-in ✨ button in the Source Control title bar and respects Copilot's `commitMessageGeneration.instructions` and `localeOverride` settings automatically.
- The bespoke `src/git/commitMessage.ts` and `src/git/scm.ts` modules (and their `test/git.test.ts`) have been deleted. The `enabledApiProposals: contribSourceControlInputBoxMenu` declaration is gone too — the input-box menu slot is no longer claimed.
- The `commit.*` i18n keys (12 entries) are reduced to one: `commit.setupComplete`.

### Why

VS Code's `ILanguageModelsService` already routes `chat.utilitySmallModel` to extension-registered providers (us included) — see the [utilityModelContribution source](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/chat/browser/utilityModelContribution.ts). Maintaining a parallel commit-message pipeline duplicated effort and diverged from Copilot's UX. The new path is also strictly more capable: it picks up `github.copilot.chat.commitMessageGeneration.instructions` (per-project format), `github.copilot.chat.localeOverride` (response language), and `.github/commit-message-instructions.md` (team rule file), none of which our bespoke pipeline ever honored.

### Fixed

- **Removed four commands (`Show Provider Status`, `Show Usage`, `Reset Usage`, `Show Pricing`)** that were redundant with the **Usage Dashboard** (`MiniMax: Open Usage Dashboard`). The pricing table is now inlined in the README (CNY and USD tables side-by-side) instead of rendered on demand via the `Show Pricing` command. The `status.*`, `usage.*`, and `pricing.*` i18n keys (except `status.thinking`, `usage.resetDone`, and `pricing.unlisted` which remain in use) are removed from `src/i18n.ts`. Renamed `package.nls.zh-cn.json` → `package.nls.zh.json`. VS Code's NLS lookup strips the rightmost locale segment until it finds a match, so `zh-Hans-CN` (the BCP 47 tag Windows 10/11 reports for Simplified Chinese) previously fell through `zh-hans-cn` → `zh-hans` → `zh` and ended up at the English fallback, leaving Chinese users staring at English titles in the command palette. The new name matches the `zh` segment on the second hop for every Chinese locale variant (`zh-cn`, `zh-hans-cn`, `zh-hans`, `zh`, …). Behaviour for non-Chinese locales is unchanged.
- **Host classification is now spoof-proof end-to-end.** `isChinaBaseUrl()` (used by `pickPricingTable()` to pick the CNY vs USD price table and the Show Pricing flag) and the inline `baseUrl.includes('minimaxi.com')` check in `showPricing()` were both substring-matching the raw URL, the same spoofable pattern LRN-20260611-005 documented for the 401/402 action buttons. A user with `minimax.apiBaseUrl = 'https://api.minimax.io@my-proxy.example.com/v1'` would have been silently classified as international even though their real request goes to the proxy host. Both call sites now go through the hardened `resolvePlatformHost()` helper (which uses `new URL().hostname` strict equality). The 401/402 action buttons were also simplified to share the new `resolvePlatformUrl()` / `displayPlatformUrl()` helpers. No behaviour change for valid `api.minimaxi.com` / `api.minimax.io` URLs.
- **`auth.prompt` and `pricing.note` no longer ship the wrong platform to the wrong user.** Both strings were locale-keyed (`zh-cn` → `platform.minimaxi.com`, `en` → `platform.minimax.io`), so a Chinese-locale user on the international endpoint got a `platform.minimaxi.com` link they couldn't log in to, and vice versa. Both now take the platform URL as a `{0}` placeholder; the caller resolves it from the configured `minimax.apiBaseUrl` via `displayPlatformUrl()`. Third-party-proxy users get the configured URL verbatim instead of a hard-coded platform link.
- **Renamed `minimax.maxTokens` → `minimax.maxOutputTokens`** to disambiguate from `minimax.enableM31MContext` (which controls the *input* context window, not the output cap). The new key is read first; the old `minimax.maxTokens` is kept as a deprecated fallback so existing `settings.json` entries continue to work, and is marked `deprecationMessage` in the JSON schema. The old key will be removed in 3.0.

## 2.2.0 — README restyling, config unification, Claude Code JSONL ingest

### UI

- **Usage dashboard switched to a tab bar.** The previously-stacked
  "MiniMax 用量面板" and "Claude Code 用量" sections are now
  siblings under a single `<nav class="tabs" role="tablist">` with
  `总 / copilot / claude / codex / opencode` labels. Tabs without a
  backing data source are hidden entirely so users cannot click into
  an empty pane. The active tab is persisted in the webview state
  and survives a panel re-render or a dashboard close-and-reopen.
  When only `总` has data the tab bar is omitted entirely, preserving
  the previous single-section layout.
- **"总" tab is now the element-wise sum of every source.** The
  local (Copilot Chat) data was renamed to the "copilot" tab; the
  "总" tab reads from a fresh `view.total` aggregate that sums
  `copilot` + `claudeCode` (+ future `codex` / `opencode`)
  element-wise, with `perModel` and `dailySeries` merged by key.
  When only one source is present `total === that source`
  numerically, so the visual is unchanged for the common
  single-source case.
- **K / M / B suffix on the donut legend, the per-model table, and
  the requests count.** Values that previously rendered as
  `18,234,290 3.3%` and overflowed the row now render as
  `18.23M 3.3%`. `fmtFull` is kept around for the day-axis hover
  tooltip on the bar chart, where full numbers are still useful.

### Documentation

- Restyled README for scannable presentation: command reference table,
  per-model settings section, pricing visual, thinking-mode description.
- Clarified M3 context handling caveats, reworked "advanced settings"
  walkthrough copy, and unified all command names across en/zh.

### Features

- **Claude Code JSONL ingest in the usage dashboard.** The dashboard
  now shows token usage from **Claude Code CLI** and the **Claude Code
  VSCode extension** alongside the extension's own accounting.
  Previously, those clients sent API calls that bypassed our request
  layer, so the dashboard silently missed them.
  - **Background poller reads `~/.claude/projects/**/*.jsonl`** on a
    30 s tick, parses each `type: "assistant"` line, and feeds
    per-model / per-day / per-month totals into a sibling
    Memento-backed store (`src/dashboard/claudeCodeIngest.ts`).
    Cursor state is persisted in memento so restarts resume from the
    last byte — no re-reading of historical data. UUID-based
    1000-entry LRU prevents the same record from being counted
    twice when Claude Code is mid-writing a line. The cursor
    resets to 0 on file truncation or rotation.
  - **New "Claude Code usage" section in the dashboard.** Sits
    below the existing "Local token usage" card with a left accent
    strip for visual separation. Shows today / 7d / 30d cards, a
    per-model breakdown table, a 30-day bar chart, the last-sync
    timestamp, the resolved log path, file count, and any
    unparseable-line count. Subscribes to the ingester's store so
    the panel re-renders on every poll that lands new data.
  - **Three new settings** (all in the existing `minimax.*`
    namespace):
    - `minimax.dashboard.includeClaudeCode` (boolean, default
      `true`) — master toggle for the section. When `false`, the
      dashboard keeps the section visible and shows a
      "Disabled in Settings" banner with an "Open Settings" button.
    - `minimax.claudeCode.logPath` (string, default
      `~/.claude/projects`) — root directory Claude Code writes
      JSONL session logs to. Supports `~` expansion on both POSIX
      and Windows.
    - `minimax.claudeCode.pollIntervalMs` (integer, default
      `30000`, clamped to `[5000, 600000]`) — how often the
      ingester scans for new lines.
  - **Two new commands:** `MiniMax: Rescan Claude Code Logs` and
    `MiniMax: Open Claude Code Log Folder`. The dashboard section
    also has a "Re-scan now" button that calls the same code path.
  - **`MiniMax: Show Usage` extended.** The markdown report now
    ends with a clearly-labelled "## Claude Code (separate
    source)" section that includes today's totals, the per-model
    breakdown, and the resolved log path. Independent of the
    local-store data so the two sources stay visually separated.
  - **Independent lifecycle.** The ingester is constructed and
    started in `runtime/lifecycle.ts` after the provider registers.
    Flipping any of the three Claude Code settings in real time
    tears the ingester down and rebuilds it on the next tick so
    changes take effect within seconds.

### Migration

- The new Memento keys (`minimax-vscode.claudeCodeUsageStats`,
  `minimax-vscode.claudeCodeIngestCursor`) are purely additive.
  Existing `USAGE_STATS_KEY` data is untouched.
- No backfill is needed — the cursor is empty on first run; the
  first poll reads all files from byte 0.
- On uninstall the two new keys are inert and are eventually
  garbage-collected by VS Code.
- **The `minimax.thinking.enabled` setting and the `MiniMax: Toggle
  M3 Thinking Mode` command are gone.** The thinking on/off switch
  is now per-model in the Copilot Chat picker dropdown (sent
  verbatim as `thinking: { type: "disabled" | "adaptive" }` to the
  Anthropic-compatible surface). Users upgrading from 2.1.9 with
  `minimax.thinking.enabled: false` in their `settings.json` can
  delete the line — it has no effect in 2.2.0+.

### Fixes

- `minimax.experimental.modelDefPresets` `tools` key now actually merges
  with the main tool list (was silently ignored by the reserved-key guard).

## 2.1.9 — M3 native video input + thinking on/off switch

Aligns the Anthropic-compatible surface with the latest
[platform.minimaxi.com docs](https://platform.minimaxi.com/docs/api-reference/text-anthropic-api).

### Features

- **M3 native video input.** M3 now accepts `type: "video"`
  content blocks inline (MP4 / AVI / MOV / MKV) and through the
  Files API (`mm_file://{file_id}`). Previously a video attachment
  was silently dropped, the same failure mode that bit the early
  image input. The converter now warns and drops unsupported
  containers; the request layer adds a 64 MB body-size pre-flight
  check that throws a localised error before the API would 413.
- **`minimax.thinking.enabled` (M3 only) with a dedicated
  `MiniMax: Toggle M3 Thinking Mode` command.** MiniMax's
  Anthropic-compatible endpoint exposes a binary
  `thinking: { type: "disabled" | "adaptive" }` switch — there is
  no intensity / budget / split knob to forward. The on/off switch
  is now exposed two ways: a `minimax.thinking.enabled` boolean
  setting (default `true`) and a command-palette entry that
  flips it and shows a localised toast.
  - M2.x always stays `adaptive` because the API ignores
    `disabled` for the M2 family, so the toggle is a no-op there.
  - Flipping M3 off also unlocks `temperature` / `topP` from
    `minimax.sampling` (the Anthropic `temperature=1, no top_p`
    constraint only applies while thinking is on).
  - **Removed the Copilot Chat per-model dropdown.** An earlier
    draft shipped a `configurationSchema` dropdown matching the
    DeepSeek-for-Copilot pattern, but the host re-applies the
    schema `default` on every re-render: the user's first click
    was silently overridden, the second click flipped back to
    "On". The setting + command pair is reliable.
- **Test coverage for the new paths.** New unit tests in
  `test/convertVideo.test.ts` exercise the video conversion
  (base64 block, MOV container, unsupported drop, M2.x drop) and
  the thinking switch (M2.x always adaptive, M3 default + override).
  The `vscode` mock in `test/helpers/vscodeMock.ts` now also
  exports `LanguageModelChatMessageRole` so the converter can be
  exercised end-to-end.

## 2.1.8 — fix: extension activates without the built-in Git extension

- **Removes the hard `vscode.git` extension dependency.** The
  extension no longer refuses to activate when the built-in Git
  extension fails to load — e.g. in remote UI tunnels where `git`
  isn't installed, `git.enabled` is off, or the Git extension
  itself can't activate. Fixes
  [#1](https://github.com/klarkxy/minimax-vscode/issues/1).
- **Main functionality is unaffected.** The language-model
  provider, Copilot chat, dashboard, vision, tools, and mmx-cli
  panels never depended on Git in the first place.
- **`Generate Commit Message` now degrades gracefully** when Git
  is unavailable. `getGitApi()` already returns `undefined` in
  that case, and the command shows the existing
  `commit.gitUnavailable` i18n message and bails out — no crash.
  The SCM input-box menu item is also gated on
  `when: scmProvider == git`, so it auto-disables when there's
  no Git provider.

## 2.1.7 — mmx-cli: persistent cache, faster dashboard, correct auth detection

- **mmx-cli status is now persisted across VS Code restarts.** A
  new `MmxCliCache` (Memento-backed, mirroring the existing
  `PlanCache` shape) stores the last-known detection result. The
  dashboard paints the cached state on the very first frame after
  restart and re-probes in the background, so users no longer see
  the "unknown → green" flicker every time they open the panel.
- **Dashboard no longer blocks on the platform fetch.** `refresh()`
  now paints the local counters + cached plan snapshot synchronously,
  kicks the platform refresh in the background, and re-paints when
  the new data arrives. A new `plan: 'loading'` source state covers
  the in-flight window with a "Loading Token Plan data..." banner.
- **mmx auth detection no longer shells out by default.** The fast
  path reads `~/.mmx/config.json` directly (0 subprocesses, 0
  network), which is both faster and more accurate: mmx ≥ 1.0
  masks the user's key as `sk-c…4fB4` (with a literal `…`), and
  `mmx auth status` additionally runs a full quota fetch on every
  call. The CLI fallback still runs if the config file is missing.
- **Recheck now persists.** Clicking the "Re-check" button routes
  through `MmxCliCache.refresh()`, which writes the new snapshot
  to memento so the next dashboard open is also instant.
- **mmx steps are pending-only.** The three "完成 X" green rows
  below the status cards are now only shown for steps the user
  hasn't completed yet — when everything is green the section
  collapses to just the three status cards, the "Agent ready"
  note, and the two buttons.
- **Cross-day usage accounting regression test.** A new test in
  `test/usage.test.ts` seeds yesterday's bucket directly into
  the memento and confirms a `record()` issued today doesn't
  overwrite it (and that `readRange(7)` correctly sums both).

### Verification

- TypeScript clean (`tsc -p ./ --noEmit`)
- Unit tests: **99/99 pass** (was 78; +13 for the mmx config auth
  fast path, +6 for the new `MmxCliCache`, +1 cross-day regression,
  +1 new `platform: 'loading'` plumbing check)

## 2.1.6 — mmx-cli: detection-only, locale-aware install prompt

Reverts the dashboard to the minimal possible surface: the
extension only **detects** the three mmx-cli states (binary on
PATH, `mmx auth` logged in, agent SKILL installed). It does **not**
install the CLI, log in, or install the SKILL — the user (or their
AI agent) drives all three steps from outside the extension.

The one and only user-facing action in the mmx-cli section is now
"Copy the official three-step install prompt to the clipboard" in
the language matching the configured endpoint (China → 简体中文,
otherwise → English). The prompt contains the API key only as the
literal `sk-xxxxx` placeholder; the user fills in their real key
themselves before pasting it into a chat (or, if they prefer, just
runs the three commands in a terminal).

This also drops the in-extension `npm install -g` / `mmx auth login`
/ `npx skills add` code paths, which had a recurring class of
"command not found" failures on Windows (npm `PATHEXT`, missing
PATH, UAC prompts that extensions can't show) and were redundant
once we already had the user (or their agent) as the install
driver.

### Verification

- TypeScript clean (`tsc -p ./ --noEmit`)
- Unit tests: **78/78 pass** (rewritten to assert the locale-aware
  prompt returns the Chinese / English text and contains no
  real-looking key tokens)
- Smoke test: `mmxInstallPrompt('china')` and `mmxInstallPrompt('global')`
  return the verbatim prompts from the official docs

## 2.1.5 — mmx-cli install: delegate `npm install -g` to Copilot Chat

Replaces the in-extension `npm install -g mmx-cli` step with a
"copy install prompt + open Copilot chat" flow. Agents have richer
package-manager access than an extension does (e.g. they can
respond to interactive UAC prompts, install build tools, retry on
transient npm registry errors), so asking the user to send the
official three-step prompt to a chat is more reliable than us
silently running it ourselves.

### Changes

- **Dashboard "Install mmx-cli" button** and the
  **`MiniMax: Install mmx-cli`** command both now copy the official
  prompt to the clipboard and open a new Copilot chat so the user
  can paste-and-send. No shell-out from the extension.
- **API key safety preserved**: the prompt references the key only
  as the literal `sk-xxxxx` placeholder. Step 2 (`mmx auth login`)
  is **still** run by the extension — it pulls the real key from
  SecretStorage and passes it via argv, so the key never enters
  the chat transcript, never lands in disk-stored chat history,
  and never reaches the agent.
- Steps 2 and 3 (login + SKILL install) are still reachable as
  separate buttons in the dashboard, so once the agent finishes
  step 1 the user just clicks through the rest.
- New dashboard messages and a new `mmxInstallPrompt()` /
  `copyMmxInstallPromptToChat()` export for testability.

### Verification

- TypeScript clean (`tsc -p ./ --noEmit`)
- Unit tests: **84/84 pass** (2 new tests: prompt includes the
  three steps, prompt contains no real-looking key tokens)

## 2.1.4 — mmx-cli install: fix `npm not found on PATH` on Windows

Hotfix for the **MiniMax: Install mmx-cli** command failing with
`npm not found on PATH` on Windows even though `npm --version`
worked fine in a fresh terminal.

### Bug

`installMmxCli` was calling `execFile('npm', …)` with the bare
binary name. On Windows, `execFile` does **not** do `PATHEXT`
resolution — it tries the literal filename `npm` and fails with
`ENOENT` because the real binary ships as `npm.cmd` (and Node 18+
also blocks direct spawn of `.cmd` / `.bat` with `EINVAL` as a
security hardening measure). The bug surfaced on every Windows
machine that didn't have a literal `npm.exe` on PATH.

### Fix

- `mmxCli.resolveNpmBin()` now resolves the absolute path of
  `npm` (or `npx`) by running `where npm` and **preferring the
  `.cmd` form** over a no-extension sibling. The Windows fallback
  list (`%ProgramFiles%\nodejs`, `%APPDATA%\npm`, `nvm-windows`,
  `fnm`, `Volta`) is consulted when `where` finds nothing.
- `run()` now transparently wraps any `.cmd` / `.bat` target in
  `cmd.exe /c …` so the spawn passes the Node 18+ security gate.
  The API key passed to `mmx auth login --api-key <key>` still goes
  through Node's argv escape path, not a shell, so the original
  "no shell, no key in process listings" guarantee is preserved.
- The `MiniMax: Install mmx-cli` wizard now offers a **Reload
  Window** button when the install fails with the npm-missing
  error, so users who installed Node **after** launching VS Code
  can pick up the new PATH without a manual restart.

### Verification

- TypeScript clean (`tsc -p ./ --noEmit`)
- Unit tests: **82/82 pass** (2 new tests for `resolveNpmBin` /
  `resolveNpmEnv`)
- Real spawn smoke test on Windows: `cmd.exe /c
  C:\Program Files\nodejs\npm.cmd --version` → `11.6.2` ✅

## 2.1.3 — mmx-cli integration

Adds the official multimodal `mmx` CLI as an optional companion to
the Token Plan flow. The CLI gives the agent (Copilot Chat, Claude
Code, Cursor, etc.) full access to image, video, music, speech,
vision, and web search using the same Token Plan API key.

### New

- **mmx-cli section at the bottom of the dashboard.** Shows three
  status badges (CLI installed, `mmx auth` logged in, agent skill
  installed) plus a three-step checklist and a "Re-check" button.
  The checklist mirrors the official onboarding at
  `platform.minimaxi.com/docs/token-plan/minimax-cli`:
  1. `npm install -g mmx-cli`
  2. `mmx auth login --api-key <key>` (reuses the SecretStorage
     key — the user is prompted to set it if missing)
  3. `npx skills add MiniMax-AI/cli -y -g`
  A green "agent ready" hint appears once all three are done,
  telling the user the agent can now call mmx from a prompt.
- **`MiniMax: Install mmx-cli` command.** Walks the same three
  steps in order with a progress notification, then opens the
  dashboard. The SKILL step falls back to copying the bundled
  `SKILL.md` (in `skills/minimax-cli/`) to
  `~/.{claude,copilot,mmx}/skills/minimax-cli/SKILL.md` when
  `npx` is unavailable or the registry fetch fails.
- **Bundled `SKILL.md`** under `skills/minimax-cli/`. Documented
  as a fallback for environments where `npx skills` cannot
  reach the registry. Same content the official
  `MiniMax-AI/cli` slug ships, but bundled with the extension so
  the install step is offline-tolerant.

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
