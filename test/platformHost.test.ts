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
import {
	PLATFORM_URL_CHINA,
	PLATFORM_URL_GLOBAL,
	displayPlatformUrl,
	resolvePlatformHost,
	resolvePlatformUrl,
	resolvePricingDocsUrl,
} from '../src/consts.js';
import { isChinaBaseUrl } from '../src/models/registry.js';

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

// --------------------------------------------------------------------------
// resolvePlatformUrl — maps a base URL to the user-facing *platform* URL.
// Distinct from resolvePlatformHost (which returns the API hostname
// `api.minimax.io`); the user-visible link is `https://platform.minimax.io`.
// Note the `platform.` prefix — pasting the API hostname into the platform
// template produced the invalid `platform.api.minimax.io` URL in an earlier
// version, see LRN-20260611-005.
// --------------------------------------------------------------------------

test('resolvePlatformUrl: china endpoint → platform.minimaxi.com', () => {
	assert.equal(
		resolvePlatformUrl('https://api.minimaxi.com/anthropic'),
		PLATFORM_URL_CHINA,
	);
});

test('resolvePlatformUrl: global endpoint → platform.minimax.io', () => {
	assert.equal(
		resolvePlatformUrl('https://api.minimax.io/anthropic'),
		PLATFORM_URL_GLOBAL,
	);
});

test('resolvePlatformUrl: unrecognised / malformed / empty → null', () => {
	// Symmetric to resolvePlatformHost: third-party proxies get
	// `null` so the caller can decide (e.g. suppress the action
	// button, fall back to the raw baseUrl, etc.). The default-to-
	// China behaviour of an earlier draft was a credential-leak
	// vector for proxy users; the 401/402 action button must not
	// point at a MiniMax platform for an unrecognised URL.
	assert.equal(resolvePlatformUrl('http://localhost:8080/anthropic'), null);
	assert.equal(resolvePlatformUrl('https://proxy.example.com/v1'), null);
	assert.equal(resolvePlatformUrl(undefined), null);
	assert.equal(resolvePlatformUrl(''), null);
	assert.equal(resolvePlatformUrl('not-a-url'), null);
});

test('resolvePlatformUrl: spoofed URL (userinfo / suffix / path) → null', () => {
	// Mirrors the resolvePlatformHost spoofing tests — the URL
	// parser strips userinfo (`@`), treats the rest as the real
	// host, and rejects suffix/path spoofs via strict hostname
	// equality. So a maliciously-crafted URL claiming
	// `api.minimax.io` in the userinfo or path positions does NOT
	// get the China/GLOBAL platform link — `null` falls through
	// and the caller renders no platform link at all.
	assert.equal(
		resolvePlatformUrl('https://api.minimax.io@my-proxy.example.com/v1'),
		null,
	);
	assert.equal(
		resolvePlatformUrl('https://api.minimax.io.evil.example/v1'),
		null,
	);
	assert.equal(
		resolvePlatformUrl('https://proxy.example.com/api.minimax.io/v1'),
		null,
	);
});

// --------------------------------------------------------------------------
// displayPlatformUrl — UX helper used by the i18n `auth.prompt` and
// `pricing.note` strings. Returns the platform URL for known hosts and
// the raw baseUrl for unrecognised / malformed input so the user can
// still see what they configured.
// --------------------------------------------------------------------------

test('displayPlatformUrl: known china host → PLATFORM_URL_CHINA', () => {
	assert.equal(
		displayPlatformUrl('https://api.minimaxi.com/anthropic'),
		PLATFORM_URL_CHINA,
	);
});

test('displayPlatformUrl: known global host → PLATFORM_URL_GLOBAL', () => {
	assert.equal(
		displayPlatformUrl('https://api.minimax.io/anthropic'),
		PLATFORM_URL_GLOBAL,
	);
});

test('displayPlatformUrl: third-party proxy → raw baseUrl (NOT China default)', () => {
	// The whole point of the helper: a self-hosted Anthropic-
	// compatible proxy user gets to see *their* URL in the prompt,
	// not a hard-coded `platform.minimaxi.com` they can't actually
	// log in to. The previous `auth.prompt` for the Chinese locale
	// always said `platform.minimaxi.com` regardless of which
	// endpoint the user had configured — that's the locale/endpoint
	// mismatch the LRN-20260612-003 fix addresses.
	const proxy = 'https://my-anthropic-proxy.example.com/v1';
	assert.equal(displayPlatformUrl(proxy), proxy);
});

test('displayPlatformUrl: undefined / null / empty → empty string', () => {
	// The i18n `t()` call is `t('auth.prompt', displayPlatformUrl(baseUrl))`;
	// an empty `baseUrl` produces `''`, which the template renders as
	// empty parens — better than throwing, and better than falling back
	// to one of the two platform URLs.
	assert.equal(displayPlatformUrl(undefined), '');
	assert.equal(displayPlatformUrl(null), '');
	assert.equal(displayPlatformUrl(''), '');
});

// --------------------------------------------------------------------------
// resolvePricingDocsUrl — same shape as resolvePlatformUrl but the result
// is the `/docs/guides/pricing-paygo` page, which the `pricing.note` Show
// Pricing footer links to.
// --------------------------------------------------------------------------

test('resolvePricingDocsUrl: china host → platform.minimaxi.com/docs/guides/pricing-paygo', () => {
	assert.equal(
		resolvePricingDocsUrl('https://api.minimaxi.com/anthropic'),
		'https://platform.minimaxi.com/docs/guides/pricing-paygo',
	);
});

test('resolvePricingDocsUrl: global host → platform.minimax.io/docs/guides/pricing-paygo', () => {
	assert.equal(
		resolvePricingDocsUrl('https://api.minimax.io/anthropic'),
		'https://platform.minimax.io/docs/guides/pricing-paygo',
	);
});

test('resolvePricingDocsUrl: third-party proxy → null (caller falls back to displayPlatformUrl)', () => {
	assert.equal(
		resolvePricingDocsUrl('https://my-anthropic-proxy.example.com/v1'),
		null,
	);
});

// --------------------------------------------------------------------------
// isChinaBaseUrl — was `baseUrl.includes('minimaxi.com')` (spoofable).
// Now built on resolvePlatformHost, so all the spoofing vectors
// (userinfo / suffix / path) classify as `false`.
// --------------------------------------------------------------------------

test('isChinaBaseUrl: china endpoint → true', () => {
	assert.equal(isChinaBaseUrl('https://api.minimaxi.com/anthropic'), true);
});

test('isChinaBaseUrl: global endpoint → false', () => {
	assert.equal(isChinaBaseUrl('https://api.minimax.io/anthropic'), false);
});

test('isChinaBaseUrl: spoofed URL is NOT classified as china (regression for LRN-20260611-005)', () => {
	// The previous implementation was literally
	// `return baseUrl.includes('minimaxi.com')`, which is
	// spoofable. The hardened version uses `resolvePlatformHost`
	// (which uses `new URL().hostname` strict equality) and returns
	// `false` for every spoofing vector. The `pickPricingTable()`
	// consumer reads `true` to mean "render CNY prices", so getting
	// this wrong silently mis-prices the user in the wrong currency.
	assert.equal(
		isChinaBaseUrl('https://api.minimax.io@my-proxy.example.com/v1'),
		false,
	);
	assert.equal(
		isChinaBaseUrl('https://api.minimaxi.com@my-proxy.example.com/v1'),
		false,
	);
	assert.equal(
		isChinaBaseUrl('https://api.minimaxi.com.evil.example/v1'),
		false,
	);
	assert.equal(
		isChinaBaseUrl('https://proxy.example.com/api.minimaxi.com/v1'),
		false,
	);
});

test('isChinaBaseUrl: case-insensitive match', () => {
	assert.equal(isChinaBaseUrl('HTTPS://API.MINIMAXI.COM/anthropic'), true);
	assert.equal(isChinaBaseUrl('https://API.MINIMAX.IO/anthropic'), false);
});

test('isChinaBaseUrl: malformed / empty / self-hosted → false', () => {
	// Self-hosted proxies are not china; the helper must not
	// default-to-true (which would render CNY prices for a
	// USD-only proxy user).
	assert.equal(isChinaBaseUrl(''), false);
	assert.equal(isChinaBaseUrl('not-a-url'), false);
	assert.equal(isChinaBaseUrl('http://localhost:8080/anthropic'), false);
});
