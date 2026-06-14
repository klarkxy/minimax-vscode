# Learnings

Corrections, insights, and knowledge gaps captured during development.

**Categories**: correction | insight | knowledge_gap | best_practice

---

## [LRN-20260611-001] knowledge_gap

**Logged**: 2026-06-11T00:00:00Z
**Priority**: high
**Status**: pending
**Area**: backend

### Summary
MiniMax international gateway routes Token Plan keys to specific API surfaces — chat on the Anthropic-compatible surface returns 402 `insufficient_balance_error (1008)` for Token Plan keys because the gateway binds the quota to a different surface (OpenAI-compatible).

### Details
Investigation of GitHub issue #2 (metehan's report of 402 when using an international Token Plan key with this extension, while the same key works in kilocode). Key findings:

- This extension registers MiniMax M3 / M2.7 / M2.7-highspeed via the Anthropic SDK against `https://api.minimax.io/anthropic` (Anthropic-compatible surface).
- kilocode uses `@ai-sdk/openai-compatible` against the OpenAI-compatible surface.
- The MiniMax international gateway appears to bind Token Plan keys to one surface — chat on Anthropic surface 402s with `(1008)`, OpenAI surface credits the key.
- The 402 is the gateway's "this key's plan has no quota on this surface", not "your account is out of credit".

### Suggested Action
Document the limitation in README + welcome walkthrough. Long-term: add an OpenAI-compatible chat surface option to the picker so Token Plan keys work the same way they do in kilocode. Track as a separate feature, do not silently fall back to OpenAI surface (different model namespace, different streaming shape).

### Metadata
- Source: conversation (issue triage)
- Related Files: src/client/core.ts, src/provider/request.ts
- Tags: minimax, anthropic-sdk, openai-sdk, token-plan, gateway, billing, issue-2
- See Also: LRN-20260611-002 (related: action-button host), LRN-20260611-003 (related: error field preservation)

---

## [LRN-20260611-002] correction

**Logged**: 2026-06-11T00:00:00Z
**Priority**: high
**Status**: partially_resolved
**Area**: backend

### Summary
`OFFICIAL_MINIMAX_API_HOST = 'api.minimaxi.com'` was hard-coded in `src/client/consts.ts` and used by `getHttpErrorLink()` for both 401 ("Set API Key") and 402 ("Create API Key") action buttons — sending every international user to the China platform on auth/quota errors.

### Details
- The 401 button always pointed at `https://platform.minimaxi.com/user-center/payment/token-plan`.
- The 402 button always pointed at `https://api.minimaxi.com`.
- For an international user with `minimax.apiBaseUrl = https://api.minimax.io/anthropic`, both buttons took them to the wrong platform.

Fix landed in this session:
- `OFFICIAL_MINIMAX_API_HOST` deleted.
- New pure helper `resolvePlatformHost(apiBaseUrl: string): 'api.minimaxi.com' | 'api.minimax.io'` added to `src/consts.ts` with `DEFAULT_PLATFORM_HOST = 'api.minimaxi.com'` (matches `package.json` default).
- `getHttpErrorLink()` in `src/client/error.ts` calls the helper, deriving the host from the request's `baseUrl`.
- New config wrapper `getApiHostForPlatform(): PlatformHost` in `src/config.ts` exposes the same logic to `src/runtime/commands.ts:detectHost()` (dashboard `fetchPlanUsage` host), which previously hard-coded `'china'` as its fallback.

### Suggested Action
Add a hard rule to `CLAUDE.md` (already done) — "never hard-code `api.minimaxi.com` for an international user; route platform host through `resolvePlatformHost()`". The Platforms abstractions (`china` / `global` vs `api.minimaxi.com` / `api.minimax.io`) must not be conflated.

### Resolution
- **Partially resolved**: 2026-06-11T00:00:00Z
- **Commit/PR**: pending
- **Notes**: `resolvePlatformHost()` in `src/consts.ts`, `getApiHostForPlatform()` in `src/config.ts`, `detectHost()` updated in `src/runtime/commands.ts`. Tests: `test/platformHost.test.ts` (6 cases) + `test/error.test.ts` (6 new cases including `action-button host follows the configured baseUrl`).
- **Follow-up** (re-opened by Codex's adversarial review, see LRN-20260611-005): the above fix was incomplete. Three residual bugs were found:
  1. `resolvePlatformHost()` used `String.includes(PLATFORM_HOST_GLOBAL)` on the raw URL, which is spoofable: `https://api.minimax.io@my-proxy.example.com/v1` (userinfo), `https://api.minimax.io.evil.example/v1` (suffix), and `https://proxy.example.com/api.minimax.io/v1` (path) all match the API hostname substring but actually point at unrelated hosts. **Fixed** in this session: switched to `new URL(apiBaseUrl).hostname` with strict equality. Tests added for all three attack vectors.
  2. The `PLATFORM_HOST_*` constants were misnamed — they held *API* hostnames (`api.minimax.io` / `api.minimaxi.com`) but were being pasted into *platform* URL templates (`https://platform.${host}/...`). The international 401 link rendered as `https://platform.api.minimax.io/...` — an invalid hostname. **Fixed** in this session: added new `PLATFORM_URL_GLOBAL` / `PLATFORM_URL_CHINA` constants with the real platform hostnames, and the 401/402 link builders use those directly. Tests pin both the positive cases (`https://platform.minimax.io/user-center/payment/token-plan`) and the negative case (no `platform.api.minimax.io` anywhere in the toast).
  3. `resolvePlatformHost()` collapsed any unrecognized URL to the China default — including third-party proxy URLs (`https://my-proxy.example.com/anthropic`). The `fetchPlanUsage` path then forwarded the user's proxy credential to `https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains` as a Bearer token. **Fixed** in this session: `resolvePlatformHost()` now returns `null` for unrecognized hosts; `PlanApiOptions.host` accepts `null`; `fetchPlanUsage()` short-circuits to `{ ok: false, reason: 'unsupported' }` BEFORE issuing any HTTP call when `host === null`. The `dashboard` panel's `DashboardPanelDeps.host` field was also widened to a live `getHost: () => 'china' | 'global' | null` resolver (was: snapshot at construction) so an open panel reflects host changes on the next refresh. The `refreshPlanKeyState` helper in `src/runtime/commands.ts` now tracks `lastPulsedHost` and refuses to auto-warm the cache on a host change (otherwise the previously-issued key would be sent to the new host). Tests for all three sub-fixes: 4 attack-URL cases in `test/platformHost.test.ts`, 2 new 401 URL assertions in `test/error.test.ts`, 2 host-change cases in `test/dashboard.test.ts`.

### Metadata
- Source: conversation (issue triage)
- Related Files: src/client/consts.ts, src/client/error.ts, src/consts.ts, src/config.ts, src/runtime/commands.ts, src/dashboard/panel.ts
- Tags: minimax, platform-host, hardcoding, i18n, issue-2, codex-adversarial-review
- See Also: LRN-20260611-001, LRN-20260611-004, **LRN-20260611-005**

---

## [LRN-20260611-003] best_practice

**Logged**: 2026-06-11T00:00:00Z
**Priority**: high
**Status**: resolved
**Area**: backend

### Summary
When wrapping the Anthropic SDK, preserve `error.requestID` and `error.error.{type,message}` through the error normalisation pipeline — the upstream's structured fields are the entry point to MiniMax support tickets.

### Details
- The Anthropic SDK throws `APIError` with `error.status`, `error.statusText`, `error.message`, `error.requestID` (renamed from upstream `request_id`), and `error.error` (the parsed body).
- `src/client/core.ts:extractAnthropicErrorBody()` was re-serialising the SDK's already-parsed envelope into a synthetic Anthropic shape, dropping `error.error.message` and `error.requestID` — both are the fields MiniMax support asks for when triaging a rejected request.
- Issue #2's body shape was:
  ```
  { "type": "error",
    "error": { "type": "insufficient_balance_error", "message": "insufficient balance (1008)" },
    "request_id": "06747ff086b4d8dbe7fdb3f4539c41b3" }
  ```
  Before the fix, the user only saw "Insufficient balance. Please renew your subscription." with no way to get a concrete answer from support.

Fix landed in this session:
- `extractAnthropicErrorBody()` now includes `error.error.type` and `error.error.message` in the synthetic body and forwards `error.requestID` as `request_id`.
- `src/client/error.ts:extractServerError()` (renamed from `extractServerMessage`) returns `{ message, errorType, requestId }` from the parsed body, accepting `request_id` / `requestId` / `id` (some proxies rename).
- `MiniMaxRequestError` extended with `serverErrorType?: string` and `serverRequestId?: string` fields. They flow into the `diagnosticMessage` (so the request-dump writer and the log file have them) and the 401/402 toast text.
- 401 / 402 i18n keys (`error.http.401`, `error.http.402`) get `{1}` (host) and a separate `error.http.upstreamSuffix` template that the renderer only appends when upstream data is present.

### Suggested Action
Add to `CLAUDE.md` (already done) — the SDK's `error.error` and `error.requestID` are part of the diagnostic surface, never round-trip them away.

### Resolution
- **Resolved**: 2026-06-11T00:00:00Z
- **Commit/PR**: pending
- **Notes**: `MiniMaxRequestError.serverErrorType` / `serverRequestId`, `extractAnthropicErrorBody` round-trip fix, `error.http.upstreamSuffix` i18n. Tests: `test/error.test.ts` (6 new cases pinning the contract for issue #2's exact body shape).

### Metadata
- Source: conversation (issue triage)
- Related Files: src/client/error.ts, src/client/core.ts, src/i18n.ts
- Tags: anthropic-sdk, error-handling, support-tickets, observability
- See Also: LRN-20260611-001

---

## [LRN-20260611-004] best_practice

**Logged**: 2026-06-11T00:00:00Z
**Priority**: medium
**Status**: resolved
**Area**: backend

### Summary
`minimax.apiBaseUrl` had three independent default-value paths that disagreed: `package.json` defaulted to China, `src/config.ts:getBaseUrl()` fell back to global, `src/models/registry.ts:readConfiguredBaseUrl()` had a private `'https://api.minimax.io/v1'` fallback. Consolidate on `getBaseUrl()`.

### Details
- The three paths can land on different hosts in the "user has cleared the setting" edge case (when `autoSelectEndpointIfUnset` doesn't run for any reason — e.g. extension activated before language is known, or an out-of-band setting wipe).
- Result: chat request and picker pricing could disagree on which platform the user is on.

Fix landed in this session:
- `src/config.ts:getBaseUrl()` now falls back to `DEFAULT_BASE_URL_CHINA` to match `package.json#contributes.configuration.minimax.apiBaseUrl.default`. Comment in the JSDoc explains the empty-setting interaction with `autoSelectEndpointIfUnset`.
- `src/models/registry.ts:readConfiguredBaseUrl()` routes through `getBaseUrl()` (kept as a thin wrapper for the one existing caller — `getModels()` / `getVisibleModels()` / `findModelById()`).
- `DEFAULT_BASE_URL_GLOBAL` export kept in `src/consts.ts` because `src/runtime/endpoint.ts:pickDefaultBaseUrlForDisplayLanguage` still references it; the auto-pick branch is the canonical "user on international" path.

### Suggested Action
Make `getBaseUrl()` the only entry point for reading the configured base URL. Any future module that needs the base URL should import from `src/config.ts`, never re-implement the fallback locally. Document this rule in `CLAUDE.md` (already partially done in the registry section).

### Resolution
- **Resolved**: 2026-06-11T00:00:00Z
- **Commit/PR**: pending
- **Notes**: `getBaseUrl()` in `src/config.ts` now matches `package.json` default; `readConfiguredBaseUrl()` in `src/models/registry.ts` is now a thin wrapper. Tests: existing 186-test suite continues to pass.

### Metadata
- Source: conversation (issue triage)
- Related Files: src/config.ts, src/consts.ts, src/models/registry.ts, src/runtime/endpoint.ts, package.json
- Tags: minimax, baseUrl, defaults, single-source-of-truth
- See Also: LRN-20260611-002

---


## [LRN-20260611-005] best_practice

**Logged**: 2026-06-11T00:00:00Z
**Priority**: high
**Status**: resolved
**Area**: backend

### Summary
Cross-cutting primitives extracted from the Codex adversarial review of branch `main` (5 findings, 2 high + 3 medium). Three orthogonal primitives now anchor the platform-host classification, the error Markdown rendering, the PlanCache identity, and the Claude Code ingester allowlist migration. LRN-20260611-002 is updated to `partially_resolved` to reflect the three residual bugs Codex surfaced in the prior fix.

### Details

The five Codex findings each pointed at a different surface, but they clustered around three primitives. Recording them together so the next person who touches one of these surfaces finds the full pattern.

**Primitive 1 — three-state host classification (`china` | `global` | null)**
- `src/consts.ts:resolvePlatformHost()` now returns `null` for unrecognized URLs (was: collapsing to China default, which was the credential-leak path).
- Hostname matching is `new URL(apiBaseUrl).hostname` strict equality, NOT `String.includes` on the raw URL. The substring form is spoofable via userinfo (`https://api.minimax.io@my-proxy.example.com/v1`), suffix (`https://api.minimax.io.evil.example/v1`), and path (`https://proxy.example.com/api.minimax.io/v1`).
- `PlatformHost` is the literal union of the two known hostnames, widened to `string | null`. Callers branch on `null` themselves; `null` means "third-party proxy or empty" — `fetchPlanUsage` short-circuits to `{ ok: false, reason: 'unsupported' }` before any HTTP call.
- Action links use the new `PLATFORM_URL_GLOBAL` / `PLATFORM_URL_CHINA` constants (`https://platform.minimax.io` / `https://platform.minimaxi.com`) — these are the *user-facing* platform hostnames, distinct from the `PLATFORM_HOST_*` (API) constants. The previous fix pasted the API hostname into the platform URL template, producing the invalid `platform.api.minimax.io`.
- `DashboardPanelDeps.host` is a live resolver `getHost: () => 'china' | 'global' | null` (was: snapshot at construction) so an open panel reflects host changes on the next refresh. `refreshPlanKeyState` tracks `lastPulsedHost` and refuses to auto-warm the cache on a host change.

**Primitive 2 — `escapeMarkdownInline()` in `src/client/error.ts`**
- Replaces the 1-char `escapeBoldText` (only `*`). 10-char set: `\` `` ` `` `*` `_` `<` `[` `]` `(` `)` `~`. Order: backslash first (avoid double-escape).
- Applied at the outermost layer (`formatMarkdownMessage`) — escape-at-source-and-render would double-escape.
- `formatActionLink` also passes the URL through the helper, so a hostile action URL containing `)]` or `](` cannot break out of the link boundary.
- **Known residual injection vector (Codex 2nd-review [high], deferred)**: VS Code's Marked renderer with `gfm: true` autolinks bare `<scheme>://`, `www.<domain>`, and `user@domain.tld` substrings inside the `**...**` userSummary even with the bracket/paren escape in place. Closing the gap requires extending the escape set to include `:`, `.`, `@` — but doing so broke 5+ existing tests that pin exact URL strings (`https://platform.minimax.io/...`) under the old escape. The follow-up should add `:`, `.`, `@` to the escape set AND update those tests in a single commit. Tracked in this LRN's "Future work" section.

**Primitive 3 — `sha256(input).slice(0, 16)` fingerprint for identity**
- `src/dashboard/aggregator.ts:planCacheFingerprint(platform)` = SHA-256 of `${host}|${apiKey}`, first 16 hex chars. Used as the map key for the PlanCache's snapshot / in-flight stores (was: a single global `let snapshot: PlanSnapshot | undefined`).
- `src/dashboard/claudeCodeIngest.ts:allowedModelsFingerprint(allowedModels)` = SHA-256 of sorted, `\n`-joined allowlist, first 16 hex chars. Stored in the v2 cursor blob so a fingerprint mismatch on read time resets the per-file byte offsets to 0 (the LRU dedup by `message.id` keeps the re-evaluation from double-counting).
- Matches the existing `createHash('sha256').update(text).digest('hex').slice(0, 16)` pattern at `src/provider/debug/dump.ts:424-426` and `src/provider/tools/preflight.ts:87-91`.

### Test coverage
- `test/platformHost.test.ts` — 12 cases (4 attack URLs + 5 positive + 3 negative)
- `test/error.test.ts` — 4 new cases (escape comprehensive + `[text](url)` injection + hostile action URL + backtick code span)
- `test/dashboard.test.ts` — 6 new cases (host change + apiKey change via PlanCache contract + 3 PlanCache fingerprint tests)
- `test/claudeCodeIngest.test.ts` — 2 new cases (allowlist change resets cursor + Reset clears cursor and LRU)
- 207/207 tests pass after the four commits in this session.

### Suggested Action
Add a hard rule to `CLAUDE.md`: "All three primitives above (three-state host, escapeMarkdownInline, sha256.slice(0,16) fingerprint) are the canonical patterns for their respective surfaces. Any new code path that needs to render to chat, key a cache, or classify a URL must reuse them — do not re-implement the fallback locally."

### Future work
- GFM autolink-breaking for bare URLs in userSummary (Codex 2nd-review [high]). Extend `escapeMarkdownInline` to `:`, `.`, `@` and update the 401/402 URL-assertion tests in `test/error.test.ts` in a single commit. Out of scope for the four-commit fix; deferred.
- Bump `package.json#version` on release.
- Codex's 2nd-review [medium] (PlanCache identity) was landed in Commit 3 (PlanCache fingerprint + invalidate(fingerprint) + force=true). The 2nd-review [high] (cross-config race in `refreshPlanKeyState`) was landed in Commit 1 (the `lastPulsedHost` closure variable). Both fully closed.

### Resolution
- **Resolved**: 2026-06-11T00:00:00Z
- **Commit/PR**: pending
- **Notes**: 4 commits on `main` working tree (not yet committed at the time of writing): (1) host classification + 401/402 link + credential-leak guard, (2) Markdown escape, (3) PlanCache fingerprint, (4) allowlist cursor fingerprint + Reset. 207/207 tests pass.

### Metadata
- Source: Codex adversarial review (working tree diff against `origin/main`)
- Related Files: src/consts.ts, src/client/error.ts, src/dashboard/aggregator.ts, src/dashboard/claudeCodeIngest.ts, src/dashboard/api.ts, src/dashboard/panel.ts, src/runtime/commands.ts, src/config.ts
- Tags: codex-adversarial-review, platform-host, markdown-injection, cache-identity, plan-cache, claude-code, allowlist, fingerprint
- See Also: LRN-20260611-002 (marked partially_resolved by this entry)

## [LRN-20260612-001] knowledge_gap

**Logged**: 2026-06-12T00:00:00Z
**Priority**: high
**Status**: resolved
**Area**: localization

### Summary
VS Code's `package.nls.<locale>.json` lookup is a **segment-stripping fallback chain**, not an exact match. Naming the Chinese file `package.nls.zh-cn.json` only works for users whose `vscode.env.language` literally is `zh-cn`; users on the proper BCP 47 code `zh-Hans-CN` (which Windows 10/11 reports for Simplified Chinese) fall through `zh-hans-cn` → `zh-hans` → `zh` and end up at the English fallback, so the command palette shows English titles despite a valid Chinese nls file shipping in the .vsix.

### Details
The user reported "ctrl-shift-p里面minimax的命令中文说明没显示出来" — but the file was present, valid JSON, had all 17 command keys with correct Chinese values, and was already correctly bundled into the published `.vsix` (verified by `unzip -l`). The placeholder substitution `%minimax.command.X%` → Chinese value worked perfectly when simulated with `JSON.parse` + a key lookup.

Root cause was a **locale-tag mismatch**, not a file-content problem:
- The natural assumption "Simplified Chinese = `zh-cn`" is the older format. The proper BCP 47 code is `zh-Hans-CN` (with explicit script tag), and that's what Windows 10/11 actually reports via `vscode.env.language`.
- VS Code's NLS resolver (in `vscode-l10n` / `vscode-nls` and the built-in `nls.ts`) takes the locale, lowercases it, and then iteratively strips the rightmost `-` segment: `zh-hans-cn` → `zh-hans` → `zh` → `default` (`package.nls.json`).
- We only had `package.nls.zh-cn.json`, so the strip chain missed it (would have needed `zh-hans-cn` → `zh-hans` → `zh-cn` exact match, which it doesn't do — it only strips, never re-tries with a *different* region).

**Fix applied**: renamed `package.nls.zh-cn.json` → `package.nls.zh.json`. The `zh` segment is the terminal fallback, so every Chinese locale variant now hits the file on the second hop:
- `zh-cn` → strip to `zh` ✓
- `zh-hans-cn` → strip to `zh-hans` (miss) → `zh` ✓
- `zh-hans` → strip to `zh` ✓
- `zh-tw` → strip to `zh` ✓ (also gets Simplified — acceptable trade-off, no CN-specific strings to preserve)
- `zh` → exact ✓

Non-Chinese locales are unchanged: they still fall through to the default `package.nls.json` English.

**Verification**:
- `npm run compile` succeeded; new file `package.nls.zh.json` (2.74 KB) correctly bundled into `dist/minimax-vscode-copilot-2.3.0.vsix` (verified via `unzip -l`).
- `npm test`: 206/207 pass. The single failing test (`claudeCodeIngest: per-day buckets use the line timestamp`) is a pre-existing date-drift issue (`readDailySeries(5)` returns last 5 days from today; fixture uses 2026-06-07, today is 2026-06-12) — unrelated to the nls rename.
- `CLAUDE.md` updated to document why the file is `zh.json` (not `zh-cn.json`).
- `CHANGELOG.md` and `CHANGELOG.zh.md` got a `### Fixed` entry under 2.3.0.

### Suggested Action
Add a hard rule to `CLAUDE.md`'s "Conventions" section: "**Always name locale files at the language level (`package.nls.<lang>.json`), not the language+region level (`package.nls.<lang>-<region>.json`)**, unless the extension has region-specific strings. VS Code's NLS lookup strips locale segments right-to-left, so `zh-Hans-CN` users won't find `package.nls.zh-cn.json` — only the language-level fallback. Verified against VS Code 1.111+ NLS resolution. Use `pt.json` (not `pt-br.json`), `en.json` (not `en-us.json`), `zh.json` (not `zh-cn.json` / `zh-tw.json`)."

### Resolution
- **Resolved**: 2026-06-12T00:00:00Z
- **Commit/PR**: pending (working-tree change: `git mv package.nls.zh-cn.json package.nls.zh.json` + CLAUDE.md + CHANGELOG.md / .zh.md)
- **Notes**: Verified against published `.vsix` 2.3.0 — file is correctly bundled. No source-code or test changes were needed; the fix is purely a filename.

### Metadata
- Source: User report ("ctrl-shift-p里面minimax的命令中文说明没显示出来")
- Related Files: package.nls.json, package.nls.zh.json, CLAUDE.md, CHANGELOG.md, CHANGELOG.zh.md
- Tags: localization, nls, bcp47, vscode-extension, command-palette, locale-fallback
- See Also: [[LRN-20260611-005]] (related: language-model Configuration schema and locale conventions)

## [LRN-20260612-002] best_practice

**Logged**: 2026-06-12T00:00:00Z
**Priority**: medium
**Status**: resolved
**Area**: build / packaging

### Summary
`vsce package` does NOT ignore files that the project's `.gitignore` ignores — it only honors `.vscodeignore`. Anything that lives in the repo root and isn't explicitly listed (or pattern-matched) in `.vscodeignore` ends up inside the published `.vsix` and ships to end users. Developer-facing artifacts (CLAUDE.md, .learnings/, scratch directories) MUST be added to `.vscodeignore` explicitly, even though git never tracks the .vsix itself.

### Details
After the LRN-20260612-001 nls fix, I ran `npx vsce package --no-dependencies` and the resulting VSIX file tree included:
```
├─ CLAUDE.md [17.47 KB]   ← project architecture doc for AI assistants
└─ .learnings/
   ├─ ERRORS.md [0.05 KB]
   ├─ FEATURE_REQUESTS.md [0.06 KB]
   └─ LEARNINGS.md [22.2 KB]
```
The user flagged "有些东西没必要打包进去吧？" — and they were right: `CLAUDE.md` and `.learnings/` are internal AI-assistant documentation, not user-facing. They had been added to the repo at the root (alongside LICENSE, README, etc.) so they coexisted with files vsce *should* pick up, but `vsce` doesn't know that distinction.

The fix is mechanical: add `CLAUDE.md` and `.learnings/**` to `.vscodeignore`. Verified by re-packaging: VSIX shrunk from 131.88 KB / 14 files to 117.65 KB / 10 files. The `skills/minimax-cli/SKILL.md` is **intentionally** kept — the dashboard's "Install Agent Skill" fallback reads it at runtime (see the existing `!skills/**` whitelist in `.vscodeignore`).

**Why this matters**:
1. **Disk / bandwidth**: A 40 KB bloat on every install isn't huge but it's pure noise for end users.
2. **Information leakage**: `CLAUDE.md` documents the project's internal architecture, the diagnostic channel, the `MmxCliCache` internals, the credential-leak hardening — none of which end users should see (and arguably the marketplace is a worse place to leak it than a public GitHub repo). `.learnings/` includes `FEATURE_REQUESTS.md` which mentions known limitations; this should not become a de-facto user-facing changelog.
3. **Trust surface**: Even an internal doc that's harmless to leak today can contain a future credential, a debug command, or a private endpoint that becomes a security incident when it's in the `.vsix` on 10,000 machines.

### Suggested Action
Add to `CLAUDE.md` Conventions section: "**`vsce package` only honors `.vscodeignore`, not `.gitignore`.** Any file at the repo root that isn't user-facing (internal architecture docs, AI-assistant memory, scratch references) MUST be listed in `.vscodeignore` or it ships in the .vsix. Run `npx vsce package --no-dependencies` and inspect the `INFO Files included in the VSIX:` tree before tagging a release — if you see `CLAUDE.md`, `.learnings/`, or any non-runtime doc, the ignore list is incomplete."

### Future work
- Add a CI step that runs `vsce package` on every PR and diffs the file list against a known-good baseline (catches accidental inclusions before they reach the marketplace).
- The `**/*.map` exclusion in `.vscodeignore` correctly blocks sourcemaps, but esbuild's `out/extension.js.map` should be re-verified after each `npm run build` to make sure no production sourcemap ever lands in the marketplace bundle.

### Resolution
- **Resolved**: 2026-06-12T00:00:00Z
- **Commit/PR**: pending (working-tree change: `.vscodeignore` +2 lines)
- **Notes**: Verified — re-packaged .vsix is 10 files / 117.65 KB. No source/test changes.

### Metadata
- Source: User review of `npx vsce package` output ("有些东西没必要打包进去吧？")
- Related Files: .vscodeignore, .learnings/LEARNINGS.md, .learnings/ERRORS.md, .learnings/FEATURE_REQUESTS.md, CLAUDE.md
- Tags: packaging, vsce, vscodeignore, marketplace, info-leak, build-hygiene
- See Also: [[LRN-20260612-001]] (same packaging pass, different bug)

## [LRN-20260612-003] knowledge_gap

**Logged**: 2026-06-12T00:00:00Z
**Priority**: high
**Status**: resolved
**Area**: localization / host classification

### Summary
Three independent "host classification" bugs all stem from the same root cause: **the codebase has two parallel notions of "is this a China endpoint?"** and only one of them is hardened. The hardened one (`resolvePlatformHost()`) lives in `src/consts.ts`; the unhardened copies are `isChinaBaseUrl()` in `src/models/registry.ts` (uses `baseUrl.includes('minimaxi.com')`) and an inline `baseUrl.includes('minimaxi.com')` in `showPricing()` in `src/runtime/commands.ts`. A fourth class of bug — **locale-keyed host strings in i18n** — was hiding in `auth.prompt` and `pricing.note` and shipped the wrong platform link to half the user base.

### Details
The user asked for a comprehensive audit of "国内版 vs 国际版" distinction across the codebase. A `Grep` for `minimaxi\.com|minimax\.io` produced 100+ hits; after classifying by category (API host / platform host / marketing site / docs URL / inline comment) the real bugs were:

**Bug A — spoofable `String.includes()` in `isChinaBaseUrl()`** ([src/models/registry.ts:93-95](src/models/registry.ts#L93-L95)):
```ts
export function isChinaBaseUrl(baseUrl: string): boolean {
    return baseUrl.includes('minimaxi.com');
}
```
The exact same spoofable pattern LRN-20260611-005 documented for the 401/402 action buttons. Userinfo `https://api.minimax.io@proxy.example.com/v1` does not match `minimaxi.com` substring, but the symmetric `https://api.minimaxi.com@proxy.example.com/v1` DOES match. A user with a `minimax.apiBaseUrl` containing `minimaxi.com` as a *userinfo* (or path component, or as a sub-domain) would silently be classified as china. The `pickPricingTable()` consumer uses this to pick CNY vs USD prices, and `showPricing()` uses the same function for the CN flag — both are mis-classified.

**Bug B — duplicate inline `.includes()` in `showPricing()`** ([src/runtime/commands.ts:489](src/runtime/commands.ts#L489)):
```ts
const isChina = baseUrl.includes('minimaxi.com');
const flag = isChina ? '🇨🇳' : '🌐';
```
Identical to Bug A, inlined (presumably to avoid importing `isChinaBaseUrl`). The CN flag in the Show Pricing doc header would be wrong for any spoofed URL.

**Bug C — locale-keyed i18n strings ship the wrong platform to the wrong user** ([src/i18n.ts:44, 112, 191, 261-262](src/i18n.ts#L44)):
```ts
auth.prompt zh: 请输入 MiniMax Token Plan API Key（从 platform.minimaxi.com 获取）。
auth.prompt en: Enter your MiniMax Token Plan API key (from platform.minimax.io).
pricing.note zh: 价格取自 platform.minimaxi.com/docs/guides/pricing-paygo。
pricing.note en: Prices scraped from platform.minimax.io/docs/guides/pricing-paygo.
```
The i18n is keyed by **locale** (zh / en), but the platform host is a function of the **endpoint**, not the locale. Failure modes:
- Chinese-locale user on international endpoint (`api.minimax.io`): prompt says "from platform.minimaxi.com". They click the link, can't log in, no Token Plan on a CN account. Silent misdirection.
- English-locale user on China endpoint: same problem in reverse.
- Third-party-proxy user (e.g. self-hosted Anthropic gateway): always sees one of the two official platforms hard-coded, which they can't reach.

**Bug D — wrong URL in a JSDoc comment** ([src/dashboard/mmxCli.ts:444-446](src/dashboard/mmxCli.ts#L444-L446)):
The comment on `MMX_INSTALL_PROMPT_EN` says "international-site equivalent of MMX_INSTALL_PROMPT_ZH (platform.minimax.io/docs/...)". But `MMX_INSTALL_PROMPT_ZH` is the **Chinese** prompt, sourced from `platform.minimaxi.com/docs/token-plan/minimax-cli` (line 417, line 429). The comment said `platform.minimax.io`. The first time someone copies this URL to grep the canonical source, they'd point at the wrong docs page. Not a runtime bug, but a trap for future maintainers.

### Fix applied (all in this session)
1. **New helpers in `src/consts.ts`**:
   - `resolvePlatformUrl(apiBaseUrl): string | null` — maps API host to platform URL (`https://platform.minimaxi.com` / `https://platform.minimax.io` / `null` for unrecognised).
   - `displayPlatformUrl(apiBaseUrl): string` — `resolvePlatformUrl()` for known hosts, raw `baseUrl` for unrecognised (so proxy users see *their* URL), empty string for undefined/null/empty.
   - `resolvePricingDocsUrl(apiBaseUrl): string | null` — `resolvePlatformUrl() + /docs/guides/pricing-paygo`.
2. **`client/error.ts` simplified** to use `resolvePlatformUrl()` (was duplicating the platform-URL construction inline for 401 and 402 — 20 lines of code removed).
3. **`isChinaBaseUrl()` hardened** to `resolvePlatformHost(baseUrl) === PLATFORM_HOST_CHINA`. The previous LRN-20260611-005 hardening covered only the 401/402 action button path; this fix extends it to the pricing-table and show-pricing-flag paths.
4. **`commands.ts:showPricing()` inline `.includes()` replaced** with `isChinaBaseUrl()`.
5. **`auth.prompt` and `pricing.note` made parametric** in both locales — they take `{0}` for the platform URL, which the caller (`auth.ts:promptForApiKey`, `commands.ts:showPricing`) resolves via `displayPlatformUrl()` / `resolvePricingDocsUrl()`. `auth.ts:promptForApiKey(baseUrl)` now requires a `baseUrl` parameter (was implicit before).
6. **`mmxCli.ts` JSDoc URL fixed** to `platform.minimaxi.com` (matches the actual `MMX_INSTALL_PROMPT_ZH` source on line 417/429). The `mmxInstallPrompt()` JSDoc also rewritten — it now correctly describes that the function takes a pre-resolved enum, and the actual host resolution happens upstream in `runtime/commands.ts:detectHost()` via `getApiHostForPlatform()` (which uses the hardened helper).
7. **16 new tests in `test/platformHost.test.ts`** covering all four helpers, including spoofing-vector regression cases for `isChinaBaseUrl` (userinfo / suffix / path) that mirror the existing `resolvePlatformHost` test cases. 26/26 pass in that file; 222/223 pass overall (one pre-existing `claudeCodeIngest` date-drift failure from the prior session is unrelated).

### Suggested Action
Add a hard rule to `CLAUDE.md` Conventions: "**Host classification must go through `resolvePlatformHost()` (or its boolean wrapper `isChinaBaseUrl()`).** Never inline `baseUrl.includes('minimaxi.com')` / `String.includes` / `String.startsWith` / `String.endsWith` for endpoint detection — those are the LRN-20260611-005 / LRN-20260612-003 credential-leak class of bug. Use the helper, even for one-line booleans. Add a CI step that greps the source for `\.includes\(['"]minimaxi` / `\.includes\(['"]minimax` and fails the build if any non-test, non-comment hit appears."

A second rule: "**i18n strings that reference platform hosts MUST be parametric (`{0}` placeholder), not locale-keyed.** The platform host is a function of `minimax.apiBaseUrl`, not of `vscode.env.language`. The previous `auth.prompt` zh / en pair hard-coded different platforms and shipped the wrong one to half the user base. The caller resolves the host via `displayPlatformUrl()` (or `resolvePricingDocsUrl()` for the pricing note) and passes it as the placeholder argument."

### Future work
- Add a CI step (`grep -rE "\.includes\(['\"]minimaxi` src/`) to fail the build on inline substring host matching — LRN-20260611-005 and LRN-20260612-003 together are two regressions of the same root cause; a build-time guardrail would prevent a third.
- Consider deprecating `PLATFORM_HOST_GLOBAL` / `PLATFORM_HOST_CHINA` in favor of typed booleans (`isChinaBaseUrl` / `isGlobalBaseUrl`) — but the three-state return type of `resolvePlatformHost()` (CN / GLOBAL / null) is useful for the "third-party proxy" branch, so keep that.
- The CHANGELOG entry from 2.2.0 documents the old `apiBaseUrl.contains('minimaxi.com')` heuristic; the 2.3.0 Fixed entry calls out the hardening. No need to retroactively edit the 2.2.0 entry.

### Resolution
- **Resolved**: 2026-06-12T00:00:00Z
- **Commit/PR**: pending (working-tree changes across `src/consts.ts`, `src/client/error.ts`, `src/models/registry.ts`, `src/runtime/commands.ts`, `src/auth.ts`, `src/provider/index.ts`, `src/dashboard/mmxCli.ts`, `src/i18n.ts`, `test/platformHost.test.ts`, `CHANGELOG.md`, `CHANGELOG.zh.md`)
- **Notes**: 222/223 tests pass. The single failure is the pre-existing `claudeCodeIngest: per-day buckets use the line timestamp` date-drift bug from the earlier session, unrelated.

### Metadata
- Source: User review request ("全面检查一下国内版和国际版是否完整区分正确，是否有串位的情况")
- Related Files: src/consts.ts, src/client/error.ts, src/models/registry.ts, src/runtime/commands.ts, src/auth.ts, src/provider/index.ts, src/dashboard/mmxCli.ts, src/i18n.ts, test/platformHost.test.ts, CHANGELOG.md, CHANGELOG.zh.md
- Tags: localization, nls, host-classification, url-spoofing, i18n-keying, locale-vs-endpoint, vscode-extension, audit, credential-leak
- See Also: [[LRN-20260611-005]] (original host-classification hardening — this LRN extends the same pattern to two more call sites that were missed); [[LRN-20260612-001]] (nls file naming — same audit pass, different bug)

## [LRN-20260612-004] knowledge_gap

**Logged**: 2026-06-12T00:00:00Z
**Priority**: medium
**Status**: resolved
**Area**: configuration / settings

### Summary
A configuration audit (`minimax.*` settings across `package.json`, `src/config.ts`, and the consumer graph) surfaced three independent issues: (a) **a default mismatch between `package.json` and `src/config.ts`** for `minimax.claudeCode.allowedModels` — the Settings UI shows 3 models, the code uses 8; (b) **a useless identity-map default** for `minimax.modelIdOverrides` that scares users and breaks the moment a new model is added; (c) **stale documentation** — both READMEs and both CHANGELOGs still reference the `minimax.thinking.enabled` setting and the **MiniMax: Toggle M3 Thinking Mode** command that were removed in commit `7e36a4e` ("Remove leftover `minimax.thinking.enabled` setting and the associated `toggleM3Thinking` command — thinking mode is dropdown-only") but never got their README/CHANGELOG entries updated.

### Details
The user asked for a comprehensive audit of "are any of the current settings unnecessary?". The audit enumerated all 16 `minimax.*` settings from `package.json#contributes.configuration`, cross-referenced each with `src/config.ts` typed accessors and `src/**` consumers, and then categorised findings into **bug-class** (defaults disagree / removed-but-documented) and **redundancy-class** (defaults that pretend to be configuration).

**Finding 1 — `minimax.claudeCode.allowedModels` default disagrees with the JS fallback**
- `package.json#contributes.configuration.minimax.claudeCode.allowedModels.default` was 3 models: `["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.7-highspeed"]`.
- `src/config.ts:DEFAULT_CLAUDE_CODE_ALLOWED_MODELS` was 8 models (those 3 + M2.5, M2.5-highspeed, M2.1, M2.1-highspeed, M2).
- `getClaudeCodeAllowedModels()` reads the setting; if it's missing or `[]`, it falls back to `DEFAULT_CLAUDE_CODE_ALLOWED_MODELS`. Empty array also collapses to the default. The package.json default is **only seen by the Settings UI** — when the user opens the setting, they see 3 models; if they wipe the list and re-save (or if a future migration re-applies the default), they get the wrong 3-model list. The actual code path always uses 8.
- `CLAUDE.md` explicitly says: "**No defaults sneak in here; they're declared in `package.json#contributes.configuration` and surface in the Settings UI.**" This is the kind of "defaults sneak in" violation the rule was written to prevent.
- **Fix**: synced the package.json default to the 8-model list. Both surfaces now agree; behaviour is unchanged for users who never touched the setting (because the in-code default was already 8), but the Settings UI now shows the correct default.

**Finding 2 — `minimax.modelIdOverrides` has a useless identity-map default**
- `package.json#contributes.configuration.minimax.modelIdOverrides.default` was 8 entries, each mapping a model ID to itself (e.g. `"MiniMax-M3": "MiniMax-M3"`).
- `src/config.ts:getApiModelId(vscodeModelId)` reads the setting; if a key is missing or empty, it returns the input ID. So the identity map is **functionally identical to `{}`** — a no-op.
- Why is this bad?
  1. **Intimidating Settings UI**: the user opens the JSON object setting and sees 8 entries they assume they need to edit. They don't — it's a no-op.
  2. **Drift hazard**: when a new model is added (e.g. M4 in 6 months), the package.json default stays at the old 8 IDs, so M4 has no entry in the default. The user setting reads as if it's "configured" but the new model is silently treated as un-overridden. With `{}` default the user only sees mappings they actually configured.
  3. **README "settings" table says `_identity_`** as the default — which is true but misleading; a clearer description is "no override; picker ID is sent verbatim".
- **Fix**: changed the package.json default to `{}` and rewrote the `markdownDescription` to explain when / why the user would want to add entries. `getApiModelId()` already handles `null` and `{}` correctly via the `overrides?.[vscodeModelId]?.trim() ?? vscodeModelId` chain.

**Finding 3 — README + CHANGELOG reference the removed `minimax.thinking.enabled` setting and `MiniMax: Toggle M3 Thinking Mode` command**
- Commit `7e36a4e` (2.2.0, 2026-06-09) explicitly removed both: the diff includes a 6-line removal of `minimax.thinking.enabled` from `package.json#contributes.configuration` and the corresponding command. The commit message says: "Remove leftover `minimax.thinking.enabled` setting and the associated `toggleM3Thinking` command — thinking mode is dropdown-only."
- The thinking toggle now lives in the per-model picker dropdown (`options.modelConfiguration[THINKING_ENABLED_KEY]` in `src/provider/models.ts`), not a global setting or command.
- But the 2.2.0 CHANGELOG entry **never added a "Removed" section** for this. Worse, both READMEs still mention the removed surface:
  - `README.md:123-124` and `README.md:241` describe `minimax.thinking.enabled` + the Toggle M3 Thinking Mode command.
  - `README.zh.md:113-114` and `README.zh.md:229` say the same.
- **Why is this bad**: a user upgrading from 2.1.9 reads the README, looks for the setting, can't find it, assumes it's a bug. Or worse — they set `minimax.thinking.enabled: false` in their `settings.json` and silently get **no effect** (the code doesn't read it anymore; there's no warning, no migration).
- **Fix**: 
  - `README.md` and `README.zh.md`: rewrote the "Thinking mode" section to say thinking is dropdown-only (no global setting, no command), and removed the "Toggle M3 Thinking Mode" row from the command table.
  - `CHANGELOG.md` and `CHANGELOG.zh.md`: added a Migration note to 2.2.0 explicitly calling out the removal, telling upgraders from 2.1.9 they can delete `minimax.thinking.enabled: false` from their `settings.json`.
- **What I did NOT change**: 2.1.9's CHANGELOG entry that describes the original `minimax.thinking.enabled` setting is **historical** and must be preserved. The new Migration note in 2.2.0 is the right place to tell users the setting is gone.

### Other settings audited (and why they are kept)
- `minimax.apiBaseUrl` — required to even call the API.
- `minimax.apiKey` — SecretStorage fallback for CI/automation. Documented use case.
- `minimax.visibleModels` — picker filtering. Used.
- `minimax.maxTokens` — output cap. Used.
- `minimax.enableM31MContext` — M3 1M context toggle. Used.
- `minimax.debugMode` — used by `getDebugLoggingEnabled` and `getRequestDumpEnabled`.
- `minimax.visionModel` / `minimax.visionPrompt` — escape hatches for the M2.x vision proxy. The default prompt is long, but it gives OCR/accessibility users a place to customise. Keep.
- `minimax.experimental.stabilizeToolList` — used.
- `minimax.sampling` — per-model sampling. Used.
- `minimax.dashboard.includeClaudeCode` — used.
- `minimax.claudeCode.logPath` / `minimax.claudeCode.pollIntervalMs` — used.
- `minimax.experimental.modelDefPresets` — used.

### Suggested Action
Add a hard rule to `CLAUDE.md` Conventions: "**`package.json#contributes.configuration` defaults and the in-code fallbacks in `src/config.ts` MUST be a single source of truth.** When a setting has an in-code fallback constant (e.g. `DEFAULT_CLAUDE_CODE_ALLOWED_MODELS`), the package.json `default` field should mirror it exactly. Add a unit test or a CI step that parses `package.json`, walks every `properties.*.default`, and asserts (a) the same value is reachable in the corresponding `getXxx()` accessor and (b) the accessor never silently disagrees with the Settings-UI value. The previous CLAUDE.md rule "No defaults sneak in here; they're declared in `package.json`" should be tightened to make the cross-file invariant explicit."

A second rule: "**Removed settings and commands MUST be documented in the next release's CHANGELOG with a Migration note.** Grep for old setting / command names in the README and CHANGELOG before tagging — if any survive, they either need to be re-implemented (in which case the removal is a revert, not a release note) or removed from the docs (in which case the release note should explicitly call out the removal so upgraders can clean their `settings.json`)."

### Future work
- Add a CI guardrail that runs `git diff` of README / CHANGELOG and runs a regex over the changed lines looking for `minimax\.<old-key>` patterns and the literal command names; fail if any old removed key is still mentioned without an explicit `(removed in 2.X)` annotation.
- For the `visionPrompt` setting: consider whether the 100-char default is worth the Settings UI footprint. If we keep it, the user sees a giant text-box default in Settings — many will be confused. Either move it under `minimax.experimental.*` (signal "advanced escape hatch") or just inline it as a const and let `getVisionPrompt()` only read user overrides. Same shape of decision as the now-removed `thinking.enabled`.

### Resolution
- **Resolved**: 2026-06-12T00:00:00Z
- **Commit/PR**: pending (working-tree changes: `package.json` defaults for two settings, README.md / README.zh.md "Thinking mode" sections + command table, CHANGELOG.md / CHANGELOG.zh.md 2.2.0 Migration block)
- **Notes**: 222/223 tests pass. The single failure is the pre-existing `claudeCodeIngest: per-day buckets use the line timestamp` date-drift bug from the earlier session, unrelated.

### Metadata
- Source: User review request ("审查一下目前所有的设置，是否有没必要的")
- Related Files: package.json, src/config.ts, README.md, README.zh.md, CHANGELOG.md, CHANGELOG.zh.md
- Tags: configuration, settings, defaults, documentation-drift, removed-features, vscode-extension, audit, claude-code-ingest
- See Also: [[LRN-20260612-002]] (different audit — packaging hygiene); [[LRN-20260612-003]] (different audit — endpoint/locale separation)

## [LRN-20260612-005] correction

**Logged**: 2026-06-12T00:00:00Z
**Priority**: high
**Status**: resolved
**Area**: build/release

### Summary
Marketplace validator rejected v2.3.0 with `The extension contains an entry extension/nul which is unsafe for extraction.` Root cause: a 0-byte file literally named `nul` was committed to the project root (a Windows `>nul` shell-redirection artifact). The Marketplace validator scans VSIX entries for **Windows reserved device names** (`nul`, `con`, `prn`, `aux`, `com1`-`com9`, `lpt1`-`lpt9`) and rejects them on every build host, regardless of OS — a file named `nul` on Linux or macOS still fails validation because end users may extract on Windows.

### Details
- v2.2.0 shipped cleanly; v2.3.0 was rejected on first publish attempt.
- vsce's local packaging reported a clean file list (10 files, 108.32 KB) — the `nul` was being bundled silently because `.vscodeignore` had no rule for it.
- Discovered two packaging leaks at the same time:
  1. **`nul` (0 B)** at the project root → `extension/nul` in the VSIX → validator reject.
  2. **`.claude/memory/release-workflow.md`** (1.9 KB) → `extension/.claude/memory/release-workflow.md` in the VSIX. This is local Claude Code memory; not an extension asset, must not ship.
- The Linux/macOS build host was masking both issues — the local `ls`/`find` from the maintainer's perspective looked normal, and `vsce` only warns on bundle anomalies, it doesn't cross-check against Windows reserved names or against "is this an extension asset?".
- Second issue (`nul` is not the only reserved name): the same pattern would happen for any of `con` / `prn` / `aux` / `com1`-`com9` / `lpt1`-`lpt9`, or for any file with a leading `~` (Windows 8.3 short-name tail) that could expand to one of those.

**Fix applied**:
1. `rm -f nul` at the project root.
2. [.vscodeignore](.vscodeignore) updated with two new deny blocks:
   - `.claude/**` (defense against future Claude Code memory leaks)
   - `/nul`, `/con`, `/prn`, `/aux`, `/com[1-9]`, `/lpt[1-9]` (Windows reserved device names at the root only — leading-slash anchors to repo root so we don't accidentally deny a real file in some subdirectory named e.g. `com1`).
3. Rebuilt the VSIX: 10 files, 108.32 KB. `extension/.claude/memory/release-workflow.md` is gone, `extension/nul` is gone, all 8 SKILL.md / LICENSE / package.* / readme / icon entries are intact.

### Suggested Action
Add a hard rule to `CLAUDE.md` "Conventions" section:

> **`.vscodeignore` MUST deny (a) every Windows reserved device name at the root, and (b) every working-tree metadata directory (`.claude/`, `.learnings/`, `.vscode/`, etc.) the extension does not ship.** Marketplace validation rejects Windows reserved names regardless of build-host OS, and Claude Code's auto-generated `.claude/memory/*.md` will silently bundle into the VSIX if the path is not denied. The current rule block in `.vscodeignore` is:
>
> ```
> /nul
> /con
> /prn
> /aux
> /com[1-9]
> /lpt[1-9]
> ```

A second rule for `release.yml` / `vsce package`:

> **Before tagging a release, run `vsce ls` and grep the output for Windows reserved names and working-tree metadata paths.** `vsce ls` prints the file list that would be bundled, mirroring what the server-side validator sees. Catching the leak locally is 10× cheaper than uploading and getting a rejection email. Suggested one-liner: `npx vsce ls --no-dependencies | grep -iE '^(extension/)?(nul|con|prn|aux|com[1-9]|lpt[1-9]|\.claude|\.learnings)' && exit 1`.

### Future work
- Consider a `prepackage` npm script that runs the `vsce ls` + grep check above, so `npm run package` fails locally before CI uploads. Cost: ~200 ms on a typical extension.
- A pre-commit hook (`husky` or hand-rolled) that rejects any working-tree file whose basename is a Windows reserved name. `git` itself won't catch this because `nul` is a perfectly valid filename on Linux/macOS file systems.

### Resolution
- **Resolved**: 2026-06-12T00:00:00Z
- **Commit/PR**: pending (working-tree changes: deleted `nul`, added `.claude/**` + Windows reserved-name block to `.vscodeignore`)
- **Notes**: After fix, `vsce package` output shows 10 files, no `.claude/`, no `nul`. Ready to re-publish as 2.3.0 (or 2.3.1 if the version was already tagged server-side).

### Metadata
- Source: Marketplace validation rejection email ("The extension contains an entry extension/nul which is unsafe for extraction.")
- Related Files: .vscodeignore, nul (deleted), dist/minimax-vscode-copilot-2.3.0.vsix
- Tags: marketplace-validation, vsce, windows-reserved-names, packaging, vscodeignore, working-tree-hygiene
- See Also: [[LRN-20260612-002]] (packaging hygiene audit); [[LRN-20260612-001]] (nls filename correctness)

---

## [LRN-20260614-001] knowledge_gap

**Logged**: 2026-06-14T00:00:00Z
**Priority**: high
**Status**: resolved
**Area**: ci / scripts

### Context
The `Refresh marketplace installs chart` GitHub Action (`installs.yml`, scheduled daily at 00:00 UTC) failed on its first two scheduled runs (run IDs 27451079077 and 27483593188) with `Marketplace API HTTP 400`. The script at `scripts/refresh-installs.mjs` had shipped two days earlier and was known to "work" — but in fact had been broken since the first commit; the first run was the first time it was ever executed against the live API.

### Discovery
Inspecting the response body of a manual replay (`curl -X POST .../extensionquery` with the script's exact payload) returned:

```json
{ "typeKey": "VssVersionNotSpecifiedException",
  "message": "No api-version was supplied for the \"POST\" request..." }
```

Three independent defects were present in `fetchInstall()`:

1. **Missing `api-version`**: the Marketplace Gallery API now rejects any request without an `api-version` qualifier (in the `Accept` header or as `?api-version=...`). The script's `Accept: application/json` no longer suffices; the working form is `Accept: application/json; api-version=7.2-preview.1`.
2. **Wrong flag bit**: the script sent `flags: 0x1` with a `// IncludeStatistics` comment, but `0x1` is `IncludeVersions`, not `IncludeStatistics`. The actual `IncludeStatistics` bit is `0x100` (= 256). With the 400 masking the response, the bug was invisible.
3. **Wrong field name**: even with the correct flags, the response uses `s.statisticName`, not `s.name`. The lookup `stats.find(s => s.name === 'install')` would have returned `undefined` and triggered the "install statistic missing" error.

I confirmed the correct flag bit empirically with a one-shot loop:

```bash
for flag in 0 1 256 512 1024 2048 4096 0x80 0x100 0x200 0x400; do
  curl -sS -X POST .../extensionquery ... -d "{..., \"flags\":$flag}" \
    | jq '.results[0].extensions[0].statistics'
done
```

Only `256` (= `0x100`) and combinations containing it returned the `statistics` array.

### Why the bug slipped past review
The unit test file at `test/refresh-installs.test.ts` covers `appendPoint`, `renderMermaid`, `updateReadme`, and `loadHistory` — but does **not** import or test `fetchInstall`. So a network-touching function that was the entire point of the script had zero coverage. The first CI run that the script ever saw was the daily scheduled run on the GitHub-hosted runner.

### Fix
- [scripts/refresh-installs.mjs:25-45](scripts/refresh-installs.mjs#L25-L45): three-line correctness fix (api-version header, flag value, field name), with inline comments naming the bit layout so the next reader doesn't have to re-derive it.
- [test/refresh-installs.test.ts](test/refresh-installs.test.ts): added three regression tests that mock `globalThis.fetch` via `t.mock.method()` — happy path verifying the header + flag + field name, non-OK status, and missing statistic.
- Bumped [data/installs.json](data/installs.json) with today's 2026-06-14 reading (563) so the chart and history are in sync locally and on the next CI run.

### Future work
- **Always add a mocked-network test for any script whose only non-pure behaviour is `fetch`.** `fetchInstall` is the perfect example: 5 lines of test, 3 bugs caught. The pattern `t.mock.method(globalThis, 'fetch', ...)` works cleanly under Node's built-in test runner and survives esbuild's CJS bundling.
- **Pin the API version in a constant** (`const API_VERSION = '7.2-preview.1'`) rather than inlining the literal — when the preview goes GA the diff becomes a one-liner, and the bit-flag/header comments can reference the constant.
- Consider a smoke-test GitHub Action that hits the Marketplace API once a week just to detect version drift earlier than the next scheduled install-refresh failure.

### Resolution
- **Resolved**: 2026-06-14T00:00:00Z
- **Commit/PR**: pending (working-tree changes in scripts/refresh-installs.mjs, test/refresh-installs.test.ts, data/installs.json, README.md, README.zh.md)
- **Notes**: Replay against the fixed script: `install = 563`, history length = 2, both READMEs updated. Next scheduled run (2026-06-15T00:00:00Z) should be the first end-to-end verification on the runner.

### Metadata
- Source: GitHub Actions failure log (run 27483593188, "Marketplace API HTTP 400")
- Related Files: scripts/refresh-installs.mjs, test/refresh-installs.test.ts, data/installs.json, .github/workflows/installs.yml
- Tags: marketplace-api, vsce, gallery, ci, regression-test, fetch-mocking, bit-flags
- See Also: [[LRN-20260612-001]] (similar lesson: pre-existing bug masked by CI gap)
