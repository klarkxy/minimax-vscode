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
**Status**: resolved
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
- **Resolved**: 2026-06-11T00:00:00Z
- **Commit/PR**: pending
- **Notes**: `resolvePlatformHost()` in `src/consts.ts`, `getApiHostForPlatform()` in `src/config.ts`, `detectHost()` updated in `src/runtime/commands.ts`. Tests: `test/platformHost.test.ts` (6 cases) + `test/error.test.ts` (6 new cases including `action-button host follows the configured baseUrl`).

### Metadata
- Source: conversation (issue triage)
- Related Files: src/client/consts.ts, src/client/error.ts, src/consts.ts, src/config.ts, src/runtime/commands.ts
- Tags: minimax, platform-host, hardcoding, i18n, issue-2
- See Also: LRN-20260611-001, LRN-20260611-004

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

