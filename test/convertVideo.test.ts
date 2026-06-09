// Unit tests for the M3-native video path in src/provider/convert.ts
// and the M3 thinking switch in src/provider/models.ts.
//
// Run via `npm run test:unit`. The vscode namespace is swapped for the
// in-process mock via esbuild's `alias` option.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LanguageModelDataPart, LanguageModelTextPart, LanguageModelChatMessageRole, workspace } from './helpers/vscodeMock.js';

import { convertMessages } from '../src/provider/convert.js';
import {
	THINKING_ENABLED_KEY,
	getConfiguredThinkingEffort,
	toChatInfo,
	type ModelConfigurationOptions,
} from '../src/provider/models.js';
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

// ---- Thinking switch ----

test('getConfiguredThinkingEffort: M2.x is always adaptive (dropdown ignored)', () => {
	const opts: ModelConfigurationOptions = {
		modelConfiguration: { [THINKING_ENABLED_KEY]: 'false' },
	} as unknown as ModelConfigurationOptions;
	assert.equal(getConfiguredThinkingEffort('MiniMax-M2.7', opts), 'adaptive');
	assert.equal(getConfiguredThinkingEffort('MiniMax-M2.7-highspeed', opts), 'adaptive');
});

test('toChatInfo: M3 exposes a thinking on/off configurationSchema dropdown', () => {
	// The on/off switch now lives in the per-model configurationSchema,
	// matching the deepseek-v4-for-copilot pattern. The schema's only
	// property is the thinkingEnabled string enum (true / false), and
	// the default is "true" (thinking on).
	const m = findModelById('MiniMax-M3')!;
	const info = toChatInfo(m, true);
	const schema = (info as unknown as {
		configurationSchema?: {
			properties?: Record<string, { enum?: string[]; default?: string }>;
		};
	}).configurationSchema;
	assert.ok(schema, 'M3 should advertise a configurationSchema');
	const prop = schema?.properties?.[THINKING_ENABLED_KEY];
	assert.ok(prop, 'configurationSchema should declare the thinkingEnabled property');
	assert.deepEqual(prop?.enum, ['true', 'false']);
	assert.equal(prop?.default, 'true');
});

test('toChatInfo: M2.x does not advertise a configurationSchema', () => {
	// M2.x always stays adaptive; no dropdown is rendered.
	const flash = findModelById('MiniMax-M2.7')!;
	const hs = findModelById('MiniMax-M2.7-highspeed')!;
	assert.equal(
		(flash && (toChatInfo(flash, true) as unknown as { configurationSchema?: unknown }).configurationSchema),
		undefined,
	);
	assert.equal(
		(hs && (toChatInfo(hs, true) as unknown as { configurationSchema?: unknown }).configurationSchema),
		undefined,
	);
});

test('getConfiguredThinkingEffort: M3 follows modelConfiguration "false" → disabled', () => {
	const opts = {
		modelConfiguration: { [THINKING_ENABLED_KEY]: 'false' },
	} as unknown as ModelConfigurationOptions;
	assert.equal(getConfiguredThinkingEffort('MiniMax-M3', opts), 'disabled');
});

test('getConfiguredThinkingEffort: M3 follows modelConfiguration "true" → adaptive', () => {
	const opts = {
		modelConfiguration: { [THINKING_ENABLED_KEY]: 'true' },
	} as unknown as ModelConfigurationOptions;
	assert.equal(getConfiguredThinkingEffort('MiniMax-M3', opts), 'adaptive');
});

test('getConfiguredThinkingEffort: M3 also reads from the legacy `configuration` key', () => {
	// Copilot Chat used to pass user selection under the generic
	// `configuration` key on older hosts. We accept both.
	const opts = {
		configuration: { [THINKING_ENABLED_KEY]: 'false' },
	} as unknown as ModelConfigurationOptions;
	assert.equal(getConfiguredThinkingEffort('MiniMax-M3', opts), 'disabled');
});

test('getConfiguredThinkingEffort: M3 default is adaptive (no dropdown)', () => {
	// The dropdown is the single source of truth — no
	// `modelConfiguration[THINKING_ENABLED_KEY]` is delivered on the
	// request (host forgot to wire it up, or the user opened the
	// picker for the first time before changing anything). We
	// default to `adaptive` so M3 keeps emitting the typed
	// `thinking` block the user expects. This mirrors the
	// `deepseek-v4-for-copilot` `reasoningEffort` default, which is
	// also a per-render schema default and not a separate setting.
	assert.equal(getConfiguredThinkingEffort('MiniMax-M3'), 'adaptive');
});
