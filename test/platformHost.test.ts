// Unit tests for `resolvePlatformHost` in `src/consts.ts`.
//
// The helper maps a MiniMax Anthropic-compatible base URL to the
// short platform hostname (`api.minimaxi.com` vs `api.minimax.io`).
// It drives the i18n `{1}` placeholder in the 401/402 toast text.
// The rules:
//
//   - URL contains `api.minimax.io`  →  `api.minimax.io`  (international)
//   - URL contains `api.minimaxi.com` →  `api.minimaxi.com` (China)
//   - Anything else (empty, self-hosted proxy, test fixture) →
//     `null`. The caller decides what to do — typically
//     `fetchPlanUsage` short-circuits to `'unsupported'` so the
//     proxy user's key never leaves the configured proxy.
//
// The previous implementation collapsed unknowns to the China
// default. That was the credential-leak path surfaced by Codex's
// adversarial review; see LRN-20260611-005.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePlatformHost } from '../src/consts.js';

test('resolvePlatformHost: international endpoint → api.minimax.io', () => {
	assert.equal(resolvePlatformHost('https://api.minimax.io/anthropic'), 'api.minimax.io');
});

test('resolvePlatformHost: china endpoint → api.minimaxi.com', () => {
	assert.equal(resolvePlatformHost('https://api.minimaxi.com/anthropic'), 'api.minimaxi.com');
});

test('resolvePlatformHost: case-insensitive match', () => {
	// Some users paste the URL in a mix of cases; the resolver must
	// not miss the platform because the host is capitalised.
	assert.equal(resolvePlatformHost('https://API.MINIMAX.IO/anthropic'), 'api.minimax.io');
	assert.equal(resolvePlatformHost('HTTPS://API.MINIMAXI.COM/anthropic'), 'api.minimaxi.com');
});

test('resolvePlatformHost: empty / undefined input → null (NOT China default)', () => {
	// Previously these returned `api.minimaxi.com` (the China default).
	// That default-to-China behaviour was the credential-leak vector:
	// `fetchPlanUsage` would forward the proxy user's Bearer token to
	// `https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains`
	// for any unrecognised base URL. Returning `null` here lets the
	// downstream code suppress the call entirely.
	assert.equal(resolvePlatformHost(undefined), null);
	assert.equal(resolvePlatformHost(''), null);
});

test('resolvePlatformHost: self-hosted proxy → null', () => {
	// A user pointing the extension at a local Anthropic-compatible
	// proxy (`http://localhost:8080/anthropic`) is NOT a MiniMax
	// endpoint. We must not assume China; the proxy is its own thing.
	assert.equal(resolvePlatformHost('http://localhost:8080/anthropic'), null);
});

test('resolvePlatformHost: bare host substring (no api. prefix) is not a match', () => {
	// The check is deliberately strict: only `api.minimax.io` /
	// `api.minimaxi.com` count. A URL like
	// `https://proxy.example.com/minimax.io/api` is a self-hosted
	// proxy that happens to contain the string `minimax.io` as a
	// path component — we treat it as "not a MiniMax URL" and
	// return `null`, not the China default.
	assert.equal(
		resolvePlatformHost('https://proxy.example.com/minimax.io/api'),
		null,
	);
});

test('resolvePlatformHost: userinfo-spoofed host is NOT classified as MiniMax', () => {
	// A URL of the form `https://user:pass@host/...` puts the part
	// before `@` in the userinfo position. A naive `String.includes`
	// on the raw URL would match the userinfo `api.minimax.io` and
	// incorrectly classify the request as going to the international
	// MiniMax host — the request actually goes to the real host
	// (`my-proxy.example.com`) with the user's Bearer token attached.
	// The `new URL().hostname` strict-equality check rejects this
	// attack because the parsed hostname is `my-proxy.example.com`,
	// not `api.minimax.io`.
	assert.equal(
		resolvePlatformHost('https://api.minimax.io@my-proxy.example.com/v1'),
		null,
	);
	assert.equal(
		resolvePlatformHost('https://api.minimaxi.com@my-proxy.example.com/v1'),
		null,
	);
});

test('resolvePlatformHost: suffix-spoofed host (api.minimax.io.evil.example) is NOT classified as MiniMax', () => {
	// A URL like `https://api.minimax.io.evil.example/v1` has a
	// hostname that *starts with* `api.minimax.io` but is a different
	// host. Naive prefix/substring matching would classify it as
	// international MiniMax. The `new URL().hostname` strict-
	// equality check rejects it because the full hostname doesn't
	// equal `api.minimax.io` exactly.
	assert.equal(
		resolvePlatformHost('https://api.minimax.io.evil.example/v1'),
		null,
	);
	assert.equal(
		resolvePlatformHost('https://api.minimaxi.com.evil.example/v1'),
		null,
	);
});

test('resolvePlatformHost: path-embedded host (proxy.example/api.minimax.io/v1) is NOT classified as MiniMax', () => {
	// Symmetric to the previous case: a self-hosted proxy URL that
	// has `api.minimax.io` as a path component. The real host is
	// `proxy.example`, not MiniMax. Naive substring matching on the
	// raw URL would misclassify.
	assert.equal(
		resolvePlatformHost('https://proxy.example.com/api.minimax.io/v1'),
		null,
	);
	assert.equal(
		resolvePlatformHost('https://proxy.example.com/api.minimaxi.com/v1'),
		null,
	);
});

test('resolvePlatformHost: malformed URLs return null', () => {
	// Defensive: `new URL` throws on garbage input. The function
	// must not propagate the throw.
	assert.equal(resolvePlatformHost('not-a-url'), null);
	assert.equal(resolvePlatformHost('://broken'), null);
	assert.equal(resolvePlatformHost('https://'), null);
});
