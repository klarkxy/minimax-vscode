// Unit tests for the pure size-enforcement helpers in
// `src/provider/request.ts`.
//
// The full `prepareChatRequest` flow needs `vscode.workspace` and
// `KeyManager`, but the byte-counting + cap-enforcement helpers
// are pure and we exercise them here. The constants for the
// per-attachment caps and the request body cap are pinned by the
// MiniMax Anthropic-API docs (see the comments in `request.ts`).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	enforceRequestBodySizeLimit,
	estimateRequestBodyBytes,
	mergeExtraPreservingReserved,
} from '../src/provider/request.js';
import type { ConvertedConversation, MiniMaxContentBlock, MiniMaxMessage } from '../src/types.js';

function textMsg(role: 'user' | 'assistant', text: string): MiniMaxMessage {
	return { role, content: [{ type: 'text', text }] };
}

function imageMsg(base64Len: number, mime = 'image/png'): MiniMaxMessage {
	return {
		role: 'user',
		content: [
			{
				type: 'image',
				source: { type: 'base64', media_type: mime, data: 'A'.repeat(base64Len) },
			},
		],
	};
}

function videoMsg(base64Len: number): MiniMaxMessage {
	return {
		role: 'user',
		content: [
			{
				type: 'video',
				source: { type: 'base64', media_type: 'video/mp4', data: 'B'.repeat(base64Len) },
			},
		],
	};
}

function mmFileMsg(): MiniMaxMessage {
	return {
		role: 'user',
		content: [
			{
				type: 'video',
				source: { type: 'mm_file', url: 'mm_file://abc' },
			},
		],
	};
}

const M3_ID = 'MiniMax-M3';

// ---- estimateRequestBodyBytes --------------------------------------

test('estimateRequestBodyBytes: empty conversation is 0 bytes', () => {
	const conv: ConvertedConversation = { messages: [] };
	assert.equal(estimateRequestBodyBytes(conv), 0);
});

test('estimateRequestBodyBytes: counts system prompt + text blocks', () => {
	const conv: ConvertedConversation = {
		systemPrompt: 'hi', // 2 bytes
		messages: [
			textMsg('user', 'hello'), // 5 bytes
			textMsg('assistant', 'hi!'), // 3 bytes
		],
	};
	assert.equal(estimateRequestBodyBytes(conv), 2 + 5 + 3);
});

test('estimateRequestBodyBytes: base64 image bytes decoded ~ length * 3/4', () => {
	const conv: ConvertedConversation = {
		messages: [imageMsg(400)],
	};
	// 400 base64 chars → ~300 bytes after decode
	const bytes = estimateRequestBodyBytes(conv);
	assert.equal(bytes, Math.floor((400 * 3) / 4));
});

test('estimateRequestBodyBytes: mm_file video reference is exempt (0 bytes)', () => {
	const conv: ConvertedConversation = {
		messages: [mmFileMsg()],
	};
	assert.equal(estimateRequestBodyBytes(conv), 0);
});

test('estimateRequestBodyBytes: base64 video counts as length * 3/4', () => {
	const conv: ConvertedConversation = {
		messages: [videoMsg(800)],
	};
	assert.equal(estimateRequestBodyBytes(conv), Math.floor((800 * 3) / 4));
});

test('estimateRequestBodyBytes: tool_use block counts the serialised JSON', () => {
	const conv: ConvertedConversation = {
		messages: [
			{
				role: 'assistant',
				content: [
					{
						type: 'tool_use',
						id: 'call_1',
						name: 'read_file',
						input: { path: '/x' },
					},
				],
			},
		],
	};
	// We don't pin the exact number — only that the block contributes
	// a non-zero byte count and the function doesn't throw.
	assert.ok(estimateRequestBodyBytes(conv) > 0);
});

test('estimateRequestBodyBytes: tool_result with text content counts text bytes', () => {
	const conv: ConvertedConversation = {
		messages: [
			{
				role: 'user',
				content: [
					{
						type: 'tool_result',
						tool_use_id: 'call_1', // 6 bytes
						content: 'ok', // 2 bytes
					},
				],
			},
		],
	};
	assert.equal(estimateRequestBodyBytes(conv), 6 + 2);
});

test('estimateRequestBodyBytes: thinking block counts the thinking text', () => {
	const conv: ConvertedConversation = {
		messages: [
			{
				role: 'assistant',
				content: [{ type: 'thinking', thinking: 'let me think...' }],
			},
		],
	};
	assert.equal(estimateRequestBodyBytes(conv), 'let me think...'.length);
});

// ---- enforceRequestBodySizeLimit -----------------------------------

test('enforceRequestBodySizeLimit: small conversation is a no-op', () => {
	const conv: ConvertedConversation = {
		messages: [textMsg('user', 'hi')],
	};
	enforceRequestBodySizeLimit(conv, M3_ID); // no throw
});

test('enforceRequestBodySizeLimit: oversized image throws (10 MB image cap)', () => {
	// 14 MB base64 → ~10.5 MB decoded, over the 10 MB inline cap.
	const base64Len = Math.ceil((10 * 1024 * 1024 * 4) / 3) + 100_000;
	const conv: ConvertedConversation = {
		messages: [imageMsg(base64Len)],
	};
	assert.throws(
		() => enforceRequestBodySizeLimit(conv, M3_ID),
		/10 MB|inline image|图片/,
	);
});

test('enforceRequestBodySizeLimit: oversized video throws (50 MB video cap)', () => {
	const base64Len = Math.ceil((50 * 1024 * 1024 * 4) / 3) + 100_000;
	const conv: ConvertedConversation = {
		messages: [videoMsg(base64Len)],
	};
	assert.throws(
		() => enforceRequestBodySizeLimit(conv, M3_ID),
		/50 MB|inline video|视频/,
	);
});

test('enforceRequestBodySizeLimit: mm_file video is exempt from the per-attachment cap', () => {
	// A `mm_file://` reference is never inline content; the
	// attachment cap must not flag it. We also stay well under the
	// 64 MB request-body cap so the body check is also happy.
	const conv: ConvertedConversation = {
		messages: [mmFileMsg(), textMsg('user', 'look at the file')],
	};
	enforceRequestBodySizeLimit(conv, M3_ID); // no throw
});

const M3_PRIORITY_API_ID = 'MiniMax-M3';

test('enforceRequestBodySizeLimit: MiniMax-M3-Priority uses the 64 MB cap (multimodal shared with M3)', () => {
	// The M3-Priority variant shares the upstream M3 model and its
	// multimodal caps. Ten ~6 MB images (under the per-attachment
	// 10 MB cap) total ~60 MB, just under the 64 MB body cap, so the
	// body-cap check must NOT throw on the priority picker's resolved
	// API id — the 64 MB branch in MAX_REQUEST_BODY_BYTES_FOR_MODEL
	// is what covers M3 (and, by extension, M3-Priority). Before the
	// request.ts rework the size check was keyed off the picker id,
	// which meant the priority id hit the 32 MB fallback.
	const perImage = Math.floor((6 * 1024 * 1024 * 4) / 3);
	const conv: ConvertedConversation = {
		messages: Array.from({ length: 10 }, () => imageMsg(perImage)),
	};
	enforceRequestBodySizeLimit(conv, M3_PRIORITY_API_ID); // no throw
});

test('enforceRequestBodySizeLimit: MiniMax-M3-Priority still throws when over the 64 MB cap', () => {
	// Twelve ~6 MB images decode to ~72 MB, well over the 64 MB body
	// cap, while every individual image stays under the 10 MB
	// per-attachment cap. The body-cap check must trigger.
	const perImage = Math.floor((6 * 1024 * 1024 * 4) / 3);
	const conv: ConvertedConversation = {
		messages: Array.from({ length: 12 }, () => imageMsg(perImage)),
	};
	assert.throws(
		() => enforceRequestBodySizeLimit(conv, M3_PRIORITY_API_ID),
		/64 MB|request body|请求体/,
	);
});

// ---- mergeExtraPreservingReserved --------------------------------
//
// The priority variant relies on this helper to pin `service_tier`
// while still letting the user override other escape-hatch fields
// (`stop_sequences`, `metadata`, …). The previous `??` short-circuit
// in `prepareChatRequest` silently dropped `service_tier` as soon as
// any preset entry was set, so we pin the contract with a direct test.

test('mergeExtraPreservingReserved: returns registry extra when user extra is empty', () => {
	const registry = { service_tier: 'priority', metadata: { team: 'core' } };
	const merged = mergeExtraPreservingReserved(registry, undefined, ['service_tier']);
	assert.deepEqual(merged, registry);
});

test('mergeExtraPreservingReserved: user wins for non-reserved keys', () => {
	const registry = { service_tier: 'priority', stop_sequences: ['OLD'] };
	const user = { stop_sequences: ['NEW'] };
	const merged = mergeExtraPreservingReserved(registry, user, ['service_tier']);
	assert.deepEqual(merged, { service_tier: 'priority', stop_sequences: ['NEW'] });
});

test('mergeExtraPreservingReserved: registry wins for reserved keys even when user sets them', () => {
	// The whole point of the helper — a user setting service_tier
	// in modelDefPresets must NOT downgrade the priority variant.
	const registry = { service_tier: 'priority' };
	const user = { service_tier: 'standard', stop_sequences: ['END'] };
	const merged = mergeExtraPreservingReserved(registry, user, ['service_tier']);
	assert.equal(merged.service_tier, 'priority');
	assert.deepEqual(merged.stop_sequences, ['END']);
});

test('mergeExtraPreservingReserved: missing reserved key in registry is stripped from user extra', () => {
	// Defensive case: a future variant adds a reserved list without
	// populating the registry value. The user must not be allowed to
	// inject a half-configured value.
	const merged = mergeExtraPreservingReserved(
		undefined,
		{ service_tier: 'priority' },
		['service_tier'],
	);
	assert.equal(Object.prototype.hasOwnProperty.call(merged, 'service_tier'), false);
});

test('mergeExtraPreservingReserved: empty reserved list is a plain shallow merge', () => {
	const merged = mergeExtraPreservingReserved(
		{ a: 1, b: 2 },
		{ b: 3, c: 4 },
		[],
	);
	assert.deepEqual(merged, { a: 1, b: 3, c: 4 });
});
