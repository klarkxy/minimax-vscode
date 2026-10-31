// Tests for MiniMax-M3.1-Flash (GA): registry entry, flat pricing,
// the thinking-depth dropdown (`output_config.effort`), the always-on
// thinking payload, and the migration of the retired preview id.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findModelById, getModels } from '../src/models/registry.js';
import {
	REASONING_EFFORT_KEY,
	THINKING_ENABLED_KEY,
	formatPricingTooltip,
	getConfiguredReasoningEffort,
	getConfiguredThinkingEffort,
	toChatInfo,
	type ModelConfigurationOptions,
} from '../src/provider/models.js';
import { buildThinkingPayload, withReasoningEffort } from '../src/provider/request.js';
import { applyAliasOverride } from '../src/claudeCode/proxy.js';
import { DEFAULT_CLAUDE_CODE_ALLOWED_MODELS } from '../src/config.js';
import { migrateLegacyModelIds, migrateModelIdValue } from '../src/runtime/legacyModelIds.js';
import { env, mockConfig, resetMockConfig } from './helpers/vscodeMock.js';

const FLASH = 'MiniMax-M3.1-Flash';
const PREVIEW = 'MiniMax-M3.1-Flash-Preview';
const CNY_BASE_URL = 'https://api.minimaxi.com/anthropic';
const USD_BASE_URL = 'https://api.minimax.io/anthropic';

function opts(config: Record<string, unknown>): ModelConfigurationOptions {
	return { modelConfiguration: config } as unknown as ModelConfigurationOptions;
}

test.beforeEach(() => {
	resetMockConfig();
});

test('registry: the GA id replaces the preview id', () => {
	assert.ok(findModelById(FLASH));
	assert.equal(findModelById(PREVIEW), undefined);
	const flash = findModelById(FLASH)!;
	assert.equal(flash.capabilities.imageInput, true);
	assert.equal(flash.capabilities.videoInput, true);
	assert.equal(flash.thinking.supportsEffort, true);
	assert.equal(flash.thinking.supportsAdaptive, false);
});

test('registry: flat pricing in CNY and USD', () => {
	const saved = env.language;
	try {
		env.language = 'en';
		const usd = findModelById(FLASH, USD_BASE_URL)!.pricing;
		assert.deepEqual([usd.input, usd.output, usd.cacheRead, usd.currency], [0.15, 0.6, 0.015, 'USD']);
		const cny = findModelById(FLASH, CNY_BASE_URL)!.pricing;
		assert.deepEqual([cny.input, cny.output, cny.cacheRead, cny.currency], [1, 4, 0.1, 'CNY']);
	} finally {
		env.language = saved;
	}
});

test('registry: advertises 1M regardless of the M3 1M toggle', () => {
	for (const enabled of [false, true]) {
		mockConfig['minimax.enableM31MContext'] = enabled;
		const flash = getModels().find((m) => m.id === FLASH)!;
		assert.equal(flash.maxInputTokens, 1_000_000);
		assert.equal(flash.maxOutputTokens, 0);
	}
	mockConfig['minimax.enableM31MContext'] = false;
	assert.equal(findModelById('MiniMax-M3')!.maxInputTokens, 512_000);
});

test('tooltip: no >512K surcharge hint for the flat-priced Flash', () => {
	const tooltip = formatPricingTooltip(findModelById(FLASH, CNY_BASE_URL)!);
	assert.doesNotMatch(tooltip, /512K/);
});

test('picker: Flash gets the depth dropdown, M3 keeps the on/off switch', () => {
	type Schema = { configurationSchema?: { properties: Record<string, { enum: string[]; default: string }> } };
	const flash = toChatInfo(findModelById(FLASH)!, true) as unknown as Schema;
	const flashProps = flash.configurationSchema!.properties;
	assert.deepEqual(Object.keys(flashProps), [REASONING_EFFORT_KEY]);
	assert.deepEqual(flashProps[REASONING_EFFORT_KEY].enum, ['low', 'medium', 'high', 'xhigh', 'max']);
	assert.equal(flashProps[REASONING_EFFORT_KEY].default, 'max');

	const m3 = toChatInfo(findModelById('MiniMax-M3')!, true) as unknown as Schema;
	assert.deepEqual(Object.keys(m3.configurationSchema!.properties), [THINKING_ENABLED_KEY]);
});

test('getConfiguredReasoningEffort: reads the dropdown, defaults to max', () => {
	assert.equal(getConfiguredReasoningEffort(FLASH, opts({ [REASONING_EFFORT_KEY]: 'low' })), 'low');
	assert.equal(getConfiguredReasoningEffort(FLASH, opts({ [REASONING_EFFORT_KEY]: 'xhigh' })), 'xhigh');
	assert.equal(getConfiguredReasoningEffort(FLASH, opts({})), 'max');
	assert.equal(getConfiguredReasoningEffort(FLASH, opts({ [REASONING_EFFORT_KEY]: 'bogus' })), 'max');
	assert.equal(getConfiguredReasoningEffort(FLASH), 'max');
	// Other models never send output_config.
	assert.equal(getConfiguredReasoningEffort('MiniMax-M3', opts({ [REASONING_EFFORT_KEY]: 'low' })), undefined);
	assert.equal(getConfiguredReasoningEffort('MiniMax-M2.7'), undefined);
});

test('thinking payload: Flash always sends adaptive, even with a stale off switch', () => {
	const flash = findModelById(FLASH)!;
	const effort = getConfiguredThinkingEffort(FLASH, opts({ [THINKING_ENABLED_KEY]: 'false' }));
	assert.equal(effort, 'adaptive');
	assert.deepEqual(buildThinkingPayload(flash, 'disabled'), { type: 'adaptive' });
	// M3 still honours the switch; M2.x sends no thinking field.
	assert.deepEqual(buildThinkingPayload(findModelById('MiniMax-M3')!, 'disabled'), { type: 'disabled' });
	assert.equal(buildThinkingPayload(findModelById('MiniMax-M2.7')!, 'adaptive'), undefined);
});

test('withReasoningEffort: sets output_config.effort and keeps other fields', () => {
	assert.deepEqual(withReasoningEffort(undefined, 'high'), { output_config: { effort: 'high' } });
	assert.deepEqual(
		withReasoningEffort({ stop_sequences: ['x'], output_config: { effort: 'low', other: 1 } }, 'max'),
		{ stop_sequences: ['x'], output_config: { effort: 'max', other: 1 } },
	);
});

test('migrateModelIdValue: rewrites each setting shape', () => {
	assert.deepEqual(migrateModelIdValue('idArray', [PREVIEW, 'MiniMax-M3']), [FLASH, 'MiniMax-M3']);
	assert.deepEqual(migrateModelIdValue('idArray', [PREVIEW, FLASH]), [FLASH]);
	assert.equal(migrateModelIdValue('idArray', ['MiniMax-M3']), undefined);
	assert.deepEqual(migrateModelIdValue('idKeyedObject', { [PREVIEW]: { topK: 5 }, 'MiniMax-M3': {} }), {
		'MiniMax-M3': {},
		[FLASH]: { topK: 5 },
	});
	// An entry already written for the new id wins.
	assert.deepEqual(migrateModelIdValue('idKeyedObject', { [PREVIEW]: { topK: 5 }, [FLASH]: { topK: 9 } }), {
		[FLASH]: { topK: 9 },
	});
	assert.equal(migrateModelIdValue('idString', PREVIEW), FLASH);
	assert.equal(migrateModelIdValue('idString', 'MiniMax-M3'), undefined);
	assert.deepEqual(migrateModelIdValue('allowlist', [PREVIEW, 'MiniMax-M3']), [PREVIEW, 'MiniMax-M3', FLASH]);
	assert.equal(migrateModelIdValue('allowlist', [PREVIEW, FLASH]), undefined);
});

test('migrateLegacyModelIds: rewrites user settings and is idempotent', async () => {
	mockConfig['minimax.visibleModels'] = [PREVIEW, 'MiniMax-M3'];
	mockConfig['minimax.sampling'] = { [PREVIEW]: { topK: 40 } };
	mockConfig['minimax.claudeCode.routing.haikuModel'] = PREVIEW;
	await migrateLegacyModelIds();
	assert.deepEqual(mockConfig['minimax.visibleModels'], [FLASH, 'MiniMax-M3']);
	assert.deepEqual(mockConfig['minimax.sampling'], { [FLASH]: { topK: 40 } });
	assert.equal(mockConfig['minimax.claudeCode.routing.haikuModel'], FLASH);
	const snapshot = JSON.stringify(mockConfig);
	await migrateLegacyModelIds();
	assert.equal(JSON.stringify(mockConfig), snapshot);
});

test('Claude Code: proxy maps the preview id, allowlist counts both ids', () => {
	const body: Record<string, unknown> = { model: PREVIEW, messages: [] };
	applyAliasOverride(body, PREVIEW);
	assert.deepEqual(body, { model: FLASH, messages: [] });
	assert.ok(DEFAULT_CLAUDE_CODE_ALLOWED_MODELS.includes(FLASH));
	assert.ok(DEFAULT_CLAUDE_CODE_ALLOWED_MODELS.includes(PREVIEW));
});
