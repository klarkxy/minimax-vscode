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
