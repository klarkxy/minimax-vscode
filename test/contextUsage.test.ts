// Unit tests for the Copilot status-bar context-usage data-part emitter
// in src/provider/stream.ts. We can't import `stream.ts` directly because
// it pulls in `vscode`, so we re-implement the same logic against the
// `MiniMaxUsage` shape and assert on the data part the helper would emit.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { COPILOT_USAGE_DATA_PART_MIME } from '../src/consts.js';
import type { MiniMaxUsage } from '../src/types.js';

/**
 * Mirrors the production body of `reportCopilotContextUsage` in
 * `src/provider/stream.ts` so we can assert on the emitted payload
 * without depending on the `vscode` import (which is mocked but the
 * helper itself isn't exported). When the helper is refactored, this
 * copy must follow.
 */
function buildUsageDataPart(usage: MiniMaxUsage): { mime: string; data: unknown } | null {
	const inputTokens = usage.input_tokens ?? 0;
	const cacheCreateTokens = usage.cache_creation_input_tokens ?? 0;
	const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
	const outputTokens = usage.output_tokens ?? 0;
	const promptTokens = inputTokens + cacheCreateTokens + cacheReadTokens;
	if (promptTokens === 0 && outputTokens === 0) {
		return null;
	}
	return {
		mime: COPILOT_USAGE_DATA_PART_MIME,
		data: {
			prompt_tokens: promptTokens,
			completion_tokens: outputTokens,
			total_tokens: promptTokens + outputTokens,
			prompt_tokens_details: {
				cached_tokens: cacheReadTokens,
			},
		},
	};
}

test('buildUsageDataPart: aggregates cache_creation + cache_read into prompt_tokens', () => {
	const usage: MiniMaxUsage = {
		input_tokens: 5_000,
		cache_creation_input_tokens: 45_000, // big cache write on first turn
		cache_read_input_tokens: 0,
		output_tokens: 1_000,
	};
	const part = buildUsageDataPart(usage);
	assert.ok(part);
	assert.equal(part.mime, 'usage');
	assert.equal(part.data.prompt_tokens, 50_000);
	assert.equal(part.data.completion_tokens, 1_000);
	assert.equal(part.data.total_tokens, 51_000);
	// cache_read was 0; we only surface the *read* count under cached_tokens
	assert.equal((part.data.prompt_tokens_details as { cached_tokens: number }).cached_tokens, 0);
});

test('buildUsageDataPart: pure cache hit (read) shows full prefix as prompt_tokens', () => {
	const usage: MiniMaxUsage = {
		input_tokens: 100,
		cache_creation_input_tokens: 0,
		cache_read_input_tokens: 49_900, // 50K cache hit
		output_tokens: 500,
	};
	const part = buildUsageDataPart(usage);
	assert.ok(part);
	assert.equal(part.data.prompt_tokens, 50_000);
	assert.equal(
		(part.data.prompt_tokens_details as { cached_tokens: number }).cached_tokens,
		49_900,
	);
});

test('buildUsageDataPart: pure uncached request', () => {
	const usage: MiniMaxUsage = {
		input_tokens: 1_234,
		cache_creation_input_tokens: 0,
		cache_read_input_tokens: 0,
		output_tokens: 56,
	};
	const part = buildUsageDataPart(usage);
	assert.ok(part);
	assert.equal(part.data.prompt_tokens, 1_234);
	assert.equal(part.data.completion_tokens, 56);
	assert.equal(part.data.total_tokens, 1_290);
});

test('buildUsageDataPart: short-circuits on a zero-usage turn', () => {
	const usage: MiniMaxUsage = {
		input_tokens: 0,
		cache_creation_input_tokens: 0,
		cache_read_input_tokens: 0,
		output_tokens: 0,
	};
	assert.equal(buildUsageDataPart(usage), null);
});

test('buildUsageDataPart: tolerates missing cache fields', () => {
	const usage: MiniMaxUsage = {
		input_tokens: 100,
		output_tokens: 50,
		// no cache_creation_input_tokens / cache_read_input_tokens
	};
	const part = buildUsageDataPart(usage);
	assert.ok(part);
	assert.equal(part.data.prompt_tokens, 100);
	assert.equal(
		(part.data.prompt_tokens_details as { cached_tokens: number }).cached_tokens,
		0,
	);
});
