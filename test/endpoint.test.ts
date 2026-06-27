// Unit tests for `src/runtime/endpoint.ts`.
//
// The endpoint auto-selector has two pieces: a pure function that
// picks the default base URL from a locale string, and an
// `autoSelectEndpointIfUnset` that wraps a `vscode.WorkspaceConfiguration`.
// We exercise the pure function directly and stub the
// WorkspaceConfiguration surface for the auto-select path.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	pickDefaultBaseUrlForDisplayLanguage,
	autoSelectEndpointIfUnset,
} from '../src/runtime/endpoint.js';
import { DEFAULT_BASE_URL_CHINA, DEFAULT_BASE_URL_GLOBAL } from '../src/consts.js';

test('pickDefaultBaseUrlForDisplayLanguage: zh* variants map to China', () => {
	const cases = ['zh', 'zh-cn', 'zh-hans', 'zh-hans-cn', 'zh-hant', 'zh-hk', 'zh-tw'];
	for (const lang of cases) {
		const out = pickDefaultBaseUrlForDisplayLanguage(lang);
		assert.equal(out.url, DEFAULT_BASE_URL_CHINA, `locale "${lang}" should map to China`);
		assert.equal(out.isChina, true, `locale "${lang}" should report isChina=true`);
	}
});

test('pickDefaultBaseUrlForDisplayLanguage: non-zh locales map to Global', () => {
	const cases = ['en', 'en-us', 'en-gb', 'ja', 'ko', 'fr', ''];
	for (const lang of cases) {
		const out = pickDefaultBaseUrlForDisplayLanguage(lang);
		assert.equal(out.url, DEFAULT_BASE_URL_GLOBAL, `locale "${lang}" should map to Global`);
		assert.equal(out.isChina, false, `locale "${lang}" should report isChina=false`);
	}
});

// Build a minimal WorkspaceConfiguration stand-in. The auto-selector
// reads `inspect('apiBaseUrl')` and the current `get('apiBaseUrl')`,
// then optionally calls `update('apiBaseUrl', value, target)`.
function fakeConfig(opts: {
	workspaceFolderValue?: unknown;
	workspaceValue?: unknown;
	globalValue?: unknown;
	currentValue?: string;
}): { fake: any; updates: Array<{ key: string; value: string }> } {
	const updates: Array<{ key: string; value: string }> = [];
	const fake = {
		inspect<T>(key: string) {
			return {
				key,
				workspaceFolderValue: opts.workspaceFolderValue,
				workspaceValue: opts.workspaceValue,
				globalValue: opts.globalValue,
			};
		},
		get<T>(key: string): T | undefined {
			return opts.currentValue as unknown as T | undefined;
		},
		async update(key: string, value: string): Promise<void> {
			updates.push({ key, value });
			opts.currentValue = value;
		},
	};
	return { fake, updates };
}

test('autoSelectEndpointIfUnset: user-configured value is preserved (source=user)', async () => {
	const { fake } = fakeConfig({
		globalValue: 'https://my-proxy.example.com/anthropic',
		currentValue: 'https://my-proxy.example.com/anthropic',
	});
	const out = await autoSelectEndpointIfUnset(() => fake);
	assert.equal(out.url, 'https://my-proxy.example.com/anthropic');
	assert.equal(out.source, 'user');
});

test('autoSelectEndpointIfUnset: no user value, current already matches default → source=default, no update', async () => {
	const { fake, updates } = fakeConfig({
		currentValue: DEFAULT_BASE_URL_GLOBAL,
	});
	const out = await autoSelectEndpointIfUnset(() => fake);
	assert.equal(out.url, DEFAULT_BASE_URL_GLOBAL);
	assert.equal(out.source, 'default');
	assert.equal(updates.length, 0);
});

test('autoSelectEndpointIfUnset: no user value, current differs from default → writes and source=auto', async () => {
	const { fake, updates } = fakeConfig({
		currentValue: '',
	});
	const out = await autoSelectEndpointIfUnset(() => fake);
	// pickDefaultBaseUrlForDisplayLanguage runs on the host's
	// vscode.env.language, which the test host may set to any value;
	// we accept either endpoint and assert the right side effects.
	assert.match(out.url, /^https:\/\/api\.minimax(io\.com|.io)\/anthropic$/);
	assert.equal(out.source, 'auto');
	assert.equal(updates.length, 1);
	assert.equal(updates[0].key, 'apiBaseUrl');
	assert.equal(updates[0].value, out.url);
});

test('autoSelectEndpointIfUnset: workspaceFolderValue wins over globalValue', async () => {
	const { fake } = fakeConfig({
		workspaceFolderValue: 'https://folder.example.com/anthropic',
		workspaceValue: 'https://workspace.example.com/anthropic',
		globalValue: 'https://global.example.com/anthropic',
		currentValue: 'https://folder.example.com/anthropic',
	});
	const out = await autoSelectEndpointIfUnset(() => fake);
	assert.equal(out.url, 'https://folder.example.com/anthropic');
	assert.equal(out.source, 'user');
});

test('autoSelectEndpointIfUnset: empty-string user values are treated as unset', async () => {
	const { fake, updates } = fakeConfig({
		workspaceValue: '   ',
		globalValue: '',
		currentValue: DEFAULT_BASE_URL_GLOBAL,
	});
	const out = await autoSelectEndpointIfUnset(() => fake);
	// All user-set strings are blank → treat as unset. Current
	// value already matches the default, so no write happens.
	assert.equal(out.source, 'default');
	assert.equal(updates.length, 0);
});
