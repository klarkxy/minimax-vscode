# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A VS Code extension that registers **MiniMax M3 / M2.7 / M2.7-highspeed** as chat models inside **GitHub Copilot Chat** by implementing `vscode.LanguageModelChatProvider`. The extension talks to MiniMax's **Anthropic-compatible** surface (`@anthropic-ai/sdk` is the only runtime dep), so the SDK appends `/v1/messages` to `minimax.apiBaseUrl`. The default endpoint is China (`api.minimaxi.com/anthropic`); the international one is `api.minimax.io/anthropic`. The endpoint is auto-picked from `vscode.env.language` on first activation and re-selected on demand via the `minimax.switchToGlobal` / `minimax.switchToChina` commands.

Requires VS Code **1.111.0+**, GitHub Copilot Chat installed & signed in, and a MiniMax Token Plan API key. VS Code **Insiders** is required to render M3 thinking blocks via the proposed `languageModelThinkingPart` API.

## Commands

```bash
npm ci                  # install
npm run compile         # typecheck (tsc --noEmit) + bundle via esbuild — CI runs this
npm run build           # production bundle (minified) → out/extension.js
npm run watch:esbuild   # esbuild --watch
npm run watch:tsc       # tsc --noEmit --watch

# Unit tests (Node's built-in test runner, no test framework dep)
npm run test:unit       # esbuild.tests.mjs → out-test/*.test.js, then `node --test`
npm test                # alias for test:unit
# Run a single test file:
node esbuild.tests.mjs && node --test out-test/cacheControl.test.js

# Package a .vsix for the marketplace
npm run package:dev     # build + vsce package → dist/
npm run prepare:readme  # strip marketplace-only blocks from README.md
```

CI (`.github/workflows/ci.yml`) runs `npm ci` → `npm run compile` → `prepare:readme` → `npm run package` on `main` PRs/pushes and uploads the `.vsix` artifact.

## Architecture

### Entry point & activation
- [`src/extension.ts`](src/extension.ts) is a one-liner that re-exports from [`src/runtime/lifecycle.ts`](src/runtime/lifecycle.ts).
- `activate(context)` in [lifecycle.ts](src/runtime/lifecycle.ts) wires up: command context → diagnostics → commands → Claude Code JSONL ingester → action URLs → endpoint auto-selection → `registerProvider()` → chat-turn notifier binding → welcome walkthrough.
- `deactivate()` calls `provider.prepareForDeactivate()` then disposes the logger.

### Provider layer — `src/provider/`
The `MiniMaxChatProvider` in [index.ts](src/provider/index.ts) is the only `vscode.LanguageModelChatProvider` implementation. Two public methods:
- `provideLanguageModelChatInformation` — returns one `LanguageModelChatInformation` per model in [models/registry.ts](src/models/registry.ts), filtered by `minimax.visibleModels`. Watches `onDidChangeConfiguration` for ~10 settings (apiKey, visibleModels, apiBaseUrl, debugMode, modelIdOverrides, enableM31MContext, maxTokens, sampling, experimental.*) and fires the change emitter so the picker refreshes live. Also subscribes to `context.secrets.onDidChange` for multi-window API-key sync.
- `provideLanguageModelChatResponse` — runs in this order: `dumpProviderInput` (debug) → `processToolFlow` (handles placeholder `activate_*` tools, may short-circuit) → `prepareChatRequest` → `streamChatCompletion`. Bracketed by `chatTurnNotifier.notifyTurnStart/End` so the dashboard's plan cache pulses at most once per Copilot user turn (not per internal API request).

Key sub-modules:
- [request.ts](src/provider/request.ts) — Builds the `MiniMaxRequest` body. Reads `minimax.sampling` (per-model `temperature`/`topP`/`topK`/`frequencyPenalty`) and `minimax.experimental.modelDefPresets` (request-body escape hatch; 11 reserved keys are stripped, `tools` is concatenated). Enforces the 64 MB request body cap and per-attachment caps (10 MB image, 50 MB video) with localised errors. The thinking field is the binary `disabled`/`adaptive` switch from [models.ts](src/provider/models.ts) — no `budget_tokens`, no `reasoning_effort`. When thinking is on, `temperature=1` is forced and `top_p` is dropped (Anthropic rule). M2.x always stays `adaptive` (the gateway ignores `disabled` for the M2 family). M3 reads the user's choice from `options.modelConfiguration[THINKING_ENABLED_KEY]` (the dropdown in the Copilot Chat model picker).
- [convert.ts](src/provider/convert.ts) — Copilot `LanguageModelChatRequestMessage` → Anthropic-format messages/tools.
- [stream.ts](src/provider/stream.ts) — SSE consumption, emits typed `thinking` blocks (proposed API) for M3 and `<think>…</think>` text for M2.x, handles replay markers, calibrates `charsPerToken` via EMA on real `usage` data.
- [vision/](src/provider/vision/) — Resolves image attachments. M3 bypasses the proxy; M2.x uses a configured non-MiniMax vision model to caption images into text.
- [tools/](src/provider/tools/) — Tool-flow preflight (`processToolFlow`). The experimental `minimax.experimental.stabilizeToolList` synthesises preflight tool calls to keep the upstream prompt cache warm.
- [debug/](src/provider/debug/) — Request classifier, cache-hit diagnostics recorder, and request-dump writer (under `globalStorageUri/request-dumps/<segmentId>/` when `minimax.debugMode === 'verbose'`).

### Client layer — `src/client/`
Thin wrapper around `@anthropic-ai/sdk`. [core.ts](src/client/core.ts) holds `MiniMaxClient` and the `ChatOptions` / request builder; [error.ts](src/client/error.ts) normalises transport / SDK errors into `MiniMaxRequestError` + `createUserFacingError` so the provider can surface them with action URLs. **The error normaliser preserves the upstream Anthropic-compatible envelope's `error.type` and `request_id`** (see `MiniMaxRequestError.serverErrorType` / `serverRequestId`) and includes them in the 401/402 toast text plus the diagnostic channel. The 401/402 action buttons resolve their platform host from the configured `minimax.apiBaseUrl` via `resolvePlatformHost()` (defined in `src/consts.ts`) — the previous hard-coded `api.minimaxi.com` was wrong for international users (see issue #2).

### Dashboard — `src/dashboard/`
Webview panel + the data plumbing that feeds it.
- [panel.ts](src/dashboard/panel.ts) — Owns the `WebviewPanel` lifetime. Renders HTML in a template literal with inline JS; messages are a `{type, payload}` discriminated union handled in `handleMessage`. Locale is picked from `vscode.env.language` and persisted in webview state. **The dashboard is a tab bar**: `总` (always shown) + `copilot` / `claude` / `codex` / `opencode` (each shown only when its source has data). Tabs with no backing source are hidden entirely.
- [aggregator.ts](src/dashboard/aggregator.ts) — `buildDashboardView` stitches together three sources into a `DashboardView`: (1) the local `UsageStore` from [src/usage.ts](src/usage.ts) (every API call the extension makes), (2) the platform `coding_plan/remains` snapshot, (3) the Claude Code JSONL ingester. Exposes a shared `PlanCache` (singleton, **5 minute** TTL, in-flight dedup) consumed by both the panel and `planStatusBar`. The TTL matches the cadence the platform's own UI uses for auto-syncing the Token Plan card, so a burst of `refresh()` calls (one per chat turn, dashboard open, apiBaseUrl switch) collapses into a single HTTP round-trip per window.
- [api.ts](src/dashboard/api.ts) — `fetchPlanUsage(apiKey, host)` for the platform quota data.
- [claudeCodeIngest.ts](src/dashboard/claudeCodeIngest.ts) — Background poller (default 30 s, clamped to `[5000, 600000]`) that walks `~/.claude/projects/**/*.jsonl`, parses `type === "assistant"` lines for `message.usage`, tracks a per-file byte-offset cursor in Memento with truncation detection (size shrink + mtimeMs sanity check), holds a partial-line buffer for in-flight writes, and dedups by `message.id` via a small LRU. The cursor is persisted in memento so disabling and re-enabling `minimax.dashboard.includeClaudeCode` does not re-read historical data. **Records are filtered through a MiniMax model allowlist** (`minimax.claudeCode.allowedModels`, default `MiniMax-M3` / `M2.7` / `M2.7-highspeed` + the legacy M2 family) — Claude Code may be talking to other Anthropic-compatible providers via the user's own routing, and we only want MiniMax tokens in the dashboard. The cumulative skip count is exposed on `status.skippedModels` for visibility and survives the cursor round-trip.
- [mmxCli.ts](src/dashboard/mmxCli.ts) + [mmxCliCache.ts](src/dashboard/mmxCliCache.ts) — **Detection only**, never installs, never logs in, never installs the SKILL. Probes `mmx --version`, `mmx auth status`, and the SKILL.md path. `copyMmxInstallPrompt(host)` puts the verbatim three-step install prompt from the official docs on the clipboard, in the language matching the configured endpoint.
- [planStatusBar.ts](src/dashboard/planStatusBar.ts) — Status bar quota items (`$(bolt) 5h 73%`, `$(calendar) Week 11%`) coloured by `statusBarItem.{remote,warning,error}Background` tokens.

### Runtime — `src/runtime/`
- [commands.ts](src/runtime/commands.ts) — Registers every `minimax.*` command (one per `package.json#contributes.commands` entry). Caches `AuthManager`, `UsageStore`, `PlanCache`, `MmxCliCache`, `PlanStatusBar`, `ClaudeCodeIngestHandle` at module scope so the dashboard panel and status bar share the same instances. `setClaudeCodeIngest` rebuilds the ingester when `includeClaudeCode` / `logPath` / `pollIntervalMs` change.
- [endpoint.ts](src/runtime/endpoint.ts) — `autoSelectEndpointIfUnset` — picks China vs global from `vscode.env.language`; no-op once the user has manually set the URL.
- [provider.ts](src/runtime/provider.ts) — `registerProvider` instantiates the chat provider, registers the `setApiKey` / `clearApiKey` / `setVisionModel` commands, and calls `vscode.lm.registerLanguageModelChatProvider('minimax', provider)`. Eagerly activates `github.copilot-chat` so the first model-picker refresh reaches a live listener.
- [actions.ts](src/runtime/actions.ts) — Action-URL registration for the error renderer (e.g. "Open Settings" buttons in error toasts).
- [welcome.ts](src/runtime/welcome.ts) — First-run walkthrough guard.
- [diagnostics.ts](src/runtime/diagnostics.ts) — Logger / output-channel initialisation.
- [lifecycle.ts](src/runtime/lifecycle.ts) — `activate` / `deactivate` orchestration.

### Git integration — `src/git/`
- [commitMessage.ts](src/git/commitMessage.ts) — Generates a Conventional Commits + gitmoji draft of the staged diff via the built-in `vscode.git` extension, falls back to working-tree changes when nothing is staged. Caps the diff at 32 KB and the file list at 80 entries. Existing text in the input box is treated as a draft to polish (temperature 0.2, max_tokens 256). The model is `minimax.commitModel` (default M3).
- [scm.ts](src/git/scm.ts) — Thin `vscode.git` extension wrapper (the proposed `contribSourceControlInputBoxMenu` API puts the generate button in the SCM input box `⋯` menu).

### Other
- [auth.ts](src/auth.ts) — SecretStorage-backed API key (`minimax-vscode.apiKey`). Falls back to the `minimax.apiKey` setting in CI/automation contexts only.
- [config.ts](src/config.ts) — Typed getters around `vscode.workspace.getConfiguration('minimax')`. No defaults sneak in here; they're declared in `package.json#contributes.configuration` and surface in the Settings UI.
- [usage.ts](src/usage.ts) — Memento-backed `UsageStore` (`USAGE_STATS_KEY`) with `read / record / reset / readDailySeries` and the shared `todayKey` helper that the Claude Code ingester also uses.
- [consts.ts](src/consts.ts) — Compile-time constants (config section, default base URLs, platform host mapping, secret/memento keys, default `~/.claude/projects` path, tool-call limit, replay-marker MIME, etc.). `resolvePlatformHost(apiBaseUrl)` is the pure helper that turns the configured `minimax.apiBaseUrl` into a short platform hostname (`api.minimaxi.com` or `api.minimax.io`); it drives the 401/402 action buttons in `client/error.ts` and the dashboard's Token Plan host. Anything depending on the VS Code runtime lives elsewhere.
- [i18n.ts](src/i18n.ts) — Zero-dep `t(key, ...args)` against a hand-written `en` / `zh-cn` dictionary. `package.nls.json` and `package.nls.zh.json` mirror the command / config titles — the file is intentionally named `zh.json` (not `zh-cn.json`) so VS Code's NLS fallback chain matches it for every Chinese locale variant (`zh-cn`, `zh-hans-cn`, `zh-hans`, `zh`, etc.).
- [models/registry.ts](src/models/registry.ts) — Single source of truth for model definitions, capabilities (`imageInput`, `videoInput`, `toolCalling`, `thinking`), and pricing. `localizeModelPricing()` picks the CNY vs USD table from `minimax.apiBaseUrl`. The internal `readConfiguredBaseUrl()` helper routes through `getBaseUrl()` from `src/config.ts` so the picker pricing and the chat request use the same configured URL (previously the registry had a private `'https://api.minimax.io/v1'` fallback that disagreed with the China default in `package.json`).
- [client/types.ts](src/client/types.ts) — `MiniMaxRequest` / `MiniMaxStreamEvent` / `MiniMaxUsage` / `MiniMaxThinkingBlock` / `MiniMaxTool` — the Anthropic-shaped request/response types the SDK adapter produces and the provider consumes.
- [json.ts](src/json.ts) — Safe stringifier that handles circular refs (used by the debug request-dump writer).
- [logger.ts](src/logger.ts) — Single shared `vscode.OutputChannel` wrapper.
- `src/vscode.proposed.*.d.ts` — Ambient declarations for `languageModelThinkingPart` and `languageModelConfigurationSchema` (proposed APIs, gated by `enabledApiProposals` in `package.json`).

## Test architecture

Tests live in [test/](test/) and use **Node's built-in `node --test` runner** — no Jest, no Mocha. Each `test/*.test.ts` is bundled by [esbuild.tests.mjs](esbuild.tests.mjs) into a standalone CJS file under `out-test/`, with `vscode` aliased to [test/helpers/vscodeMock.ts](test/helpers/vscodeMock.ts) (a hand-written namespace with `UriInstance`, `LanguageModelTextPart`, `LanguageModelToolCallPart`, etc., and a `mockState` singleton that records `vscode.window.showInformationMessage` / `showErrorMessage` / `showWarningMessage` / `showQuickPick` calls). To run a single test file: `node esbuild.tests.mjs && node --test out-test/<name>.test.js`.

Each test file should `import { describe, it } from 'node:test'` and `import * as assert from 'node:assert/strict'`.

## Conventions

- Bilingual UI: every user-visible string lives in [src/i18n.ts](src/i18n.ts) and the `package.nls.*.json` files. Use `t(key, ...args)`; do not hardcode English.
- Localised errors: prefer `throw new Error(t('request.bodyTooLarge', modelId, mb, cap))` over `throw new Error('Request body too large')`.
- Configuration lives in `package.json#contributes.configuration` with a `minimax.*` key. The typed accessor goes in [src/config.ts](src/config.ts).
- Memento / SecretStorage keys are declared as constants in [src/consts.ts](src/consts.ts); add the new key there, do not inline strings.
- The `vscode` import is bundled externally; the production build keeps it as a peer, the test build aliases it. Do not add `vscode` as a runtime npm dependency.
- The Anthropic-compatible surface does **not** publish per-model `max_tokens` ceilings — `request.ts` deliberately does not clamp to `modelDef.maxOutputTokens`. If the upstream rejects a value, the error surfaces verbatim. Same for `topP` / `topK` / `frequencyPenalty` — pass them through, let the API validate.
- The M3 >512K input tier is billed at 2× the standard rate and requires sales-granted access; the `minimax.toggleM31MContext` command pops a modal warning before flipping on. Off is unconditional. Do not silently raise the picker entry.
- The dashboard's `总` tab is always present; per-source tabs (`copilot` / `claude` / `codex` / `opencode`) are shown only when their source has data. New data sources must implement the same `SourceView` shape used by [aggregator.ts](src/dashboard/aggregator.ts) and add their own tab entry to `KNOWN_TAB_IDS` in the webview script.
- The Claude Code JSONL ingester **only counts MiniMax-related models** (`minimax.claudeCode.allowedModels`). Records whose `message.model` is not in the allowlist are silently dropped; the cumulative skip count is exposed on `status.skippedModels` so the dashboard can surface "X non-MiniMax lines skipped" for visibility. Tests pass `allowedModels: []` to disable the filter so their assertions stay independent of the user's settings.json.
- The shared `PlanCache` enforces a 5-minute TTL: a refresh inside the window reuses the cached snapshot (no HTTP call), a refresh past the window re-fetches. The TTL is overridable per-instance for tests.
- The Claude Code JSONL ingester cursor is persisted across restarts; disabling and re-enabling `minimax.dashboard.includeClaudeCode` must not re-read historical data. Use the `Re-scan now` button or the `minimax.refreshClaudeCodeIngest` command for forced refreshes.
- The extension **detects** the `mmx` CLI / auth / SKILL but never installs anything on the user's behalf. The only user-facing action is "Copy the official three-step install prompt" to the clipboard.
- The 401 / 402 error toasts and the "Create API Key" / "Set API Key" action buttons derive their platform host from the configured `minimax.apiBaseUrl` via `resolvePlatformHost()` in [src/consts.ts](src/consts.ts) — never hard-code `api.minimaxi.com` for an international user. The diagnostic `MiniMaxRequestError.serverErrorType` and `serverRequestId` fields preserve the upstream Anthropic-compatible envelope so the "MiniMax: Show Logs" output has the structured fields the user can quote to MiniMax support.
</content>
</invoke>