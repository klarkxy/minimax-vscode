// Unit tests for the usage-related pure helpers exported from
// `src/provider/stream.ts`.
//
// We can now import these directly because they're plain pure
// functions (no vscode dependency). Previously this file mirrored
// the production code; that copy-paste was a regression risk —
// the production body could change and the test would silently
// keep passing.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildUsageDataPart, updateCharsPerToken } from '../src/provider/stream.js';
import { COPILOT_USAGE_DATA_PART_MIME } from '../src/consts.js';
import type { MiniMaxUsage } from '../src/types.js';

test('buildUsageDataPart: aggregates cache_creation + cache_read into prompt_tokens', () => {
	const usage: MiniMaxUsage = {
		input_tokens: 5_000,
		cache_creation_input_tokens: 45_000, // big cache write on first turn
		cache_read_input_tokens: 0,
		output_tokens: 1_000,
	};
	const part = buildUsageDataPart(usage);
	assert.ok(part);
	assert.equal(part.mime, COPILOT_USAGE_DATA_PART_MIME);
	assert.equal(part.data.prompt_tokens, 50_000);
	assert.equal(part.data.completion_tokens, 1_000);
	assert.equal(part.data.total_tokens, 51_000);
	// cache_read was 0; we only surface the *read* count under cached_tokens
	assert.equal(part.data.prompt_tokens_details.cached_tokens, 0);
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
	assert.equal(part.data.prompt_tokens_details.cached_tokens, 49_900);
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
	assert.equal(part.data.prompt_tokens_details.cached_tokens, 0);
});

test('updateCharsPerToken: EMA blend — 0.7 old + 0.3 observed', () => {
	// 4000 chars / 1000 prompt tokens = 4.0 observed ratio
	// previous = 5.0 → expected = 5.0 * 0.7 + 4.0 * 0.3 = 3.5 + 1.2 = 4.7
	const out = updateCharsPerToken(
		4_000,
		{ input_tokens: 1_000 },
		5.0,
	);
	assert.equal(out, 4.7);
});

test('updateCharsPerToken: zero prompt tokens returns the previous ratio unchanged', () => {
	// Degenerate input: we can't observe a ratio when the API
	// reported zero tokens. Keep the previous value rather than
	// regress to 0 or NaN.
	const out = updateCharsPerToken(4_000, { input_tokens: 0 }, 5.0);
	assert.equal(out, 5.0);
});

test('updateCharsPerToken: zero request chars returns the previous ratio unchanged', () => {
	const out = updateCharsPerToken(0, { input_tokens: 1_000 }, 5.0);
	assert.equal(out, 5.0);
});

test('updateCharsPerToken: missing input_tokens field is treated as zero', () => {
	const out = updateCharsPerToken(4_000, {}, 5.0);
	assert.equal(out, 5.0);
});

test('updateCharsPerToken: converges to the observed ratio over many calls', () => {
	// 1000 chars / 100 tokens = 10.0 observed. Starting from 5.0, after
	// enough identical observations the EMA must converge to 10.0
	// (within float precision). 50 iterations is plenty — at 30%
	// weight the residual is 0.7^50 ≈ 1e-8.
	let ratio = 5.0;
	for (let i = 0; i < 50; i += 1) {
		ratio = updateCharsPerToken(1_000, { input_tokens: 100 }, ratio);
	}
	assert.ok(Math.abs(ratio - 10.0) < 1e-6, `expected ≈10.0, got ${ratio}`);
});