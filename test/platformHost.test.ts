// Unit tests for `resolvePlatformHost` in `src/consts.ts`.
//
// The helper maps a MiniMax Anthropic-compatible base URL to the
// short platform hostname (`api.minimaxi.com` vs `api.minimax.io`).
// It drives the 401/402 action-button hosts in `client/error.ts` and
// the dashboard's "Token Plan" widget host. The rules:
//
//   - URL contains `api.minimax.io`  →  `api.minimax.io`  (international)
//   - URL contains `api.minimaxi.com` →  `api.minimaxi.com` (China)
//   - Anything else (empty, self-hosted proxy, test fixture) →
//     the China default, which matches
//     `package.json#contributes.configuration.minimax.apiBaseUrl.default`.

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

test('resolvePlatformHost: empty / undefined input → China default', () => {
	// Matches the `minimax.apiBaseUrl` default in `package.json` —
	// a fresh install with the setting cleared lands on the China
	// platform rather than a third-party host.
	assert.equal(resolvePlatformHost(undefined), 'api.minimaxi.com');
	assert.equal(resolvePlatformHost(''), 'api.minimaxi.com');
});

test('resolvePlatformHost: self-hosted proxy falls back to China default', () => {
	// A user pointing the extension at a local proxy
	// (`http://localhost:8080/anthropic`) still gets a concrete
	// platform host for the action-button to point at, even though
	// the proxy is neither China nor international. Defaulting to
	// China matches the package.json default and keeps the link
	// stable for the common case.
	assert.equal(resolvePlatformHost('http://localhost:8080/anthropic'), 'api.minimaxi.com');
});

test('resolvePlatformHost: bare host substring (no api. prefix) is not a match', () => {
	// The check is deliberately strict: only `api.minimax.io` /
	// `api.minimaxi.com` count. A URL like
	// `https://proxy.example.com/minimax.io/api` is a self-hosted
	// proxy that happens to contain the string `minimax.io` as a
	// path component — we treat it as "not a MiniMax URL" and fall
	// back to the default, rather than guessing.
	assert.equal(
		resolvePlatformHost('https://proxy.example.com/minimax.io/api'),
		'api.minimaxi.com',
	);
});
