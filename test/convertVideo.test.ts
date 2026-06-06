// Unit tests for the M3-native video path in src/provider/convert.ts and
// the M3 thinking switch in src/provider/models.ts.
//
// Run via `npm run test:unit`. The vscode namespace is swapped for the
// in-process mock via esbuild's `alias` option.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LanguageModelDataPart, LanguageModelTextPart, LanguageModelChatMessageRole, workspace } from './helpers/vscodeMock.js';

import { convertMessages } from '../src/provider/convert.js';
import { getConfiguredThinkingEffort, toChatInfo, type ModelConfigurationOptions } from '../src/provider/models.js';
import { findModelById } from '../src/models/registry.js';

function userMessage(parts: unknown[]) {
	return {
		role: LanguageModelChatMessageRole.User,
		content: parts,
	};
}

test('convertMessages: M3 user video is forwarded as a base64 video block', () => {
	const data = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
	const message = userMessage([new LanguageModelDataPart(data, 'video/mp4')]);
	const result = convertMessages([message], 'MiniMax-M3');
	assert.equal(result.messages.length, 1);
	const content = result.messages[0].content as Array<Record<string, unknown>>;
	assert.equal(content.length, 1);
	const block = content[0] as {
		type: string;
		source: { type: string; media_type?: string; data?: string };
	};
	assert.equal(block.type, 'video');
	assert.equal(block.source.type, 'base64');
	assert.equal(block.source.media_type, 'video/mp4');
	assert.equal(typeof block.source.data, 'string');
	// base64 round-trip
	assert.equal(Buffer.from(block.source.data ?? '', 'base64').length, data.length);
});

test('convertMessages: M3 user video in MOV container is accepted', () => {
	const data = new Uint8Array([0xff, 0xd8, 0xff]);
	const message = userMessage([new LanguageModelDataPart(data, 'video/quicktime')]);
	const result = convertMessages([message], 'MiniMax-M3');
	const content = result.messages[0].content as Array<Record<string, unknown>>;
	assert.equal((content[0] as { type: string }).type, 'video');
});

test('convertMessages: M3 user video in unsupported container is dropped (no throw)', () => {
	const data = new Uint8Array([0x00]);
	const message = userMessage([new LanguageModelDataPart(data, 'video/3gpp')]);
	const result = convertMessages([message], 'MiniMax-M3');
	// The video part is dropped → user message has no blocks → it
	// collapses to `undefined` and `convertMessages` filters it out.
	assert.equal(result.messages.length, 0);
});

test('convertMessages: M2.x user video is dropped (text-only model)', () => {
	const data = new Uint8Array([0x00]);
	const message = userMessage([new LanguageModelDataPart(data, 'video/mp4')]);
	const result = convertMessages([message], 'MiniMax-M2.7');
	// M2.x has no video support; the part is silently dropped.
	assert.equal(result.messages.length, 0);
});

test('convertMessages: M3 user video alongside text preserves both blocks', () => {
	const data = new Uint8Array([0x00, 0x01, 0x02]);
	const message = userMessage([
		new LanguageModelTextPart('Watch this:'),
		new LanguageModelDataPart(data, 'video/mp4'),
	]);
	const result = convertMessages([message], 'MiniMax-M3');
	const content = result.messages[0].content as Array<{ type: string }>;
	assert.equal(content.length, 2);
	assert.equal(content[0].type, 'text');
	assert.equal(content[1].type, 'video');
});

test('getConfiguredThinkingEffort: M2.x is always adaptive', () => {
	assert.equal(getConfiguredThinkingEffort('MiniMax-M2.7'), 'adaptive');
	assert.equal(getConfiguredThinkingEffort('MiniMax-M2.7-highspeed'), 'adaptive');
});

test('getConfiguredThinkingEffort: M3 default is adaptive (thinking on)', () => {
	// The vscodeMock returns `true` for `enabled`; for `thinking.enabled`
	// (a different key) it returns the supplied default, which is `true`.
	// But `getConfiguredThinkingEffort` no longer falls back to that
	// setting at request time — it only trusts the dropdown or the
	// upstream default.
	assert.equal(getConfiguredThinkingEffort('MiniMax-M3'), 'adaptive');
});

test('toChatInfo: M3 has no configurationSchema (dropdown removed)', () => {
	// The per-model dropdown was removed because the host re-applies
	// the schema `default` on every re-render, silently overriding
	// the user's first click. The on/off switch now lives in the
	// `minimax.thinking.enabled` setting (toggleable via the
	// `minimax.toggleThinking` command).
	const m = findModelById('MiniMax-M3')!;
	const info = toChatInfo(m, true);
	assert.equal(
		(info as unknown as Record<string, unknown>).configurationSchema,
		undefined,
	);
});

test('getConfiguredThinkingEffort: M2.x always adaptive regardless of setting', () => {
	const original = workspace.getConfiguration;
	try {
		(workspace as unknown as { getConfiguration: typeof original }).getConfiguration =
			(_section: string) => ({
				get: <T>(key: string, defaultValue?: T): T | undefined => {
					if (key === 'thinking.enabled') return false as unknown as T;
					return defaultValue;
				},
			});
		assert.equal(getConfiguredThinkingEffort('MiniMax-M2.7'), 'adaptive');
		assert.equal(getConfiguredThinkingEffort('MiniMax-M2.7-highspeed'), 'adaptive');
	} finally {
		(workspace as unknown as { getConfiguration: typeof original }).getConfiguration = original;
	}
});

test('getConfiguredThinkingEffort: M3 follows minimax.thinking.enabled', () => {
	const original = workspace.getConfiguration;
	try {
		(workspace as unknown as { getConfiguration: typeof original }).getConfiguration =
			(_section: string) => ({
				get: <T>(key: string, defaultValue?: T): T | undefined => {
					if (key === 'thinking.enabled') return false as unknown as T;
					return defaultValue;
				},
			});
		assert.equal(getConfiguredThinkingEffort('MiniMax-M3'), 'disabled');
	} finally {
		(workspace as unknown as { getConfiguration: typeof original }).getConfiguration = original;
	}
});

test('getConfiguredThinkingEffort: M3 default is adaptive (thinking on)', () => {
	// vscodeMock returns the supplied default for unknown keys, which
	// is `true` for `thinking.enabled` (matches the package.json
	// default). The picker dropdown is no longer consulted.
	assert.equal(getConfiguredThinkingEffort('MiniMax-M3'), 'adaptive');
});
