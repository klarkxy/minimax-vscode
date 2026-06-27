// Unit tests for `src/provider/replay/markers.ts`.
//
// The replay-marker module owns a small but critical protocol: the
// extension embeds a `LanguageModelDataPart` carrying a base64url-
// encoded JSON blob (or a legacy raw UUID) into assistant turns so
// the next chat turn can replay the model's prior thinking. A
// regression in the parser would silently break thinking replay
// for every M3 conversation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';

import {
	createReplayMarkerPart,
	findFirstReplayMarker,
	hasReplayMarkerMetadata,
	parseFirstReplayMarker,
	parseReplayMarkerData,
} from '../src/provider/replay/markers.js';
import { REPLAY_MARKER_MIME } from '../src/provider/replay/index.js';

function utf8(s: string): Uint8Array {
	return new TextEncoder().encode(s);
}

// ---- hasReplayMarkerMetadata ---------------------------------------

test('hasReplayMarkerMetadata: false when thinkingBlocks missing or empty', () => {
	assert.equal(hasReplayMarkerMetadata({}), false);
	assert.equal(hasReplayMarkerMetadata({ thinkingBlocks: [] }), false);
});

test('hasReplayMarkerMetadata: true when thinkingBlocks has at least one entry', () => {
	assert.equal(
		hasReplayMarkerMetadata({ thinkingBlocks: [{ type: 'thinking', thinking: 'hi' }] }),
		true,
	);
});

// ---- parseReplayMarkerData ----------------------------------------

test('parseReplayMarkerData: rejects empty / missing prefix', () => {
	assert.deepEqual(parseReplayMarkerData(utf8('')), { valid: false, error: 'marker-prefix-missing' });
	assert.deepEqual(
		parseReplayMarkerData(utf8('unknown-prefix\\payload')),
		{ valid: false, error: 'marker-prefix-mismatch' },
	);
});

test('parseReplayMarkerData: accepts a legacy raw-UUID payload', () => {
	const id = '12345678-90AB-CDEF-1234-567890ABCDEF';
	const result = parseReplayMarkerData(utf8(`minimax-vscode\\${id}`));
	assert.equal(result.valid, true);
	if (result.valid) {
		assert.equal(result.legacySegmentOnly, true);
		assert.equal(result.segmentId, id.toLowerCase());
		assert.equal(result.payloadFormat, 'raw-uuid');
	}
});

test('parseReplayMarkerData: accepts a json-base64url payload', () => {
	const json = JSON.stringify({ segmentId: 'deadbeef-1111-2222-3333-444455556666', thinking: { blocks: [{ thinking: 'let me think…' }] } });
	const encoded = Buffer.from(json, 'utf8').toString('base64url');
	const result = parseReplayMarkerData(utf8(`minimax-vscode\\json:${encoded}`));
	assert.equal(result.valid, true);
	if (result.valid) {
		assert.equal(result.payloadFormat, 'json-base64url');
		assert.equal(result.thinkingBlocks?.[0]?.thinking, 'let me think…');
	}
});

test('parseReplayMarkerData: accepts a raw JSON payload (no "json:" prefix)', () => {
	const json = JSON.stringify({ segmentId: 'cafef00d-0000-0000-0000-000000000000', thinking: { blocks: [{ thinking: 'A', signature: 'sig-1' }] } });
	const result = parseReplayMarkerData(utf8(`minimax-vscode\\${json}`));
	assert.equal(result.valid, true);
	if (result.valid) {
		assert.equal(result.payloadFormat, 'raw-json');
		assert.equal(result.thinkingBlocks?.[0]?.thinking, 'A');
		assert.equal(result.thinkingBlocks?.[0]?.signature, 'sig-1');
	}
});

test('parseReplayMarkerData: rejects an invalid base64url string after json:', () => {
	const result = parseReplayMarkerData(utf8('minimax-vscode\\json:!!!not-base64!!!'));
	assert.equal(result.valid, false);
	if (!result.valid) {
		assert.equal(result.error, 'marker-payload-not-base64url');
	}
});

test('parseReplayMarkerData: rejects a payload that is neither json nor a uuid', () => {
	const result = parseReplayMarkerData(utf8('minimax-vscode\\hello-world'));
	assert.equal(result.valid, false);
	if (!result.valid) {
		assert.equal(result.error, 'marker-payload-not-json');
	}
});

test('parseReplayMarkerData: rejects malformed JSON', () => {
	const result = parseReplayMarkerData(utf8('minimax-vscode\\{not-json'));
	assert.equal(result.valid, false);
	if (!result.valid) {
		assert.equal(result.error, 'marker-json-invalid');
	}
});

test('parseReplayMarkerData: rejects a non-object payload', () => {
	// Use a JSON array — parses fine but the schema rejects arrays.
	const result = parseReplayMarkerData(utf8('minimax-vscode\\[1,2,3]'));
	assert.equal(result.valid, false);
	if (!result.valid) {
		assert.equal(result.error, 'marker-payload-not-object');
	}
});

test('parseReplayMarkerData: rejects a non-string segmentId', () => {
	const json = JSON.stringify({ segmentId: 42 });
	const result = parseReplayMarkerData(utf8(`minimax-vscode\\${json}`));
	assert.equal(result.valid, false);
	if (!result.valid) {
		assert.equal(result.error, 'segment-id-not-string');
	}
});

test('parseReplayMarkerData: rejects a malformed segmentId', () => {
	const json = JSON.stringify({ segmentId: 'not-a-uuid' });
	const result = parseReplayMarkerData(utf8(`minimax-vscode\\${json}`));
	assert.equal(result.valid, false);
	if (!result.valid) {
		assert.equal(result.error, 'segment-id-not-uuid');
	}
});

test('parseReplayMarkerData: drops non-string entries inside thinking.blocks', () => {
	const json = JSON.stringify({
		thinking: {
			blocks: [
				{ thinking: 'real' },
				{ thinking: '' }, // empty text — dropped
				null, // not an object — dropped
				{ thinking: 42 }, // non-string — dropped
			],
		},
	});
	const result = parseReplayMarkerData(utf8(`minimax-vscode\\${json}`));
	assert.equal(result.valid, true);
	if (result.valid) {
		assert.equal(result.thinkingBlocks?.length, 1);
		assert.equal(result.thinkingBlocks?.[0]?.thinking, 'real');
	}
});

test('parseReplayMarkerData: omits thinkingBlocks when none survive validation', () => {
	const json = JSON.stringify({ thinking: { blocks: [{ thinking: '' }] } });
	const result = parseReplayMarkerData(utf8(`minimax-vscode\\${json}`));
	assert.equal(result.valid, true);
	if (result.valid) {
		assert.equal(result.thinkingBlocks, undefined);
	}
});

// ---- createReplayMarkerPart (round-trip) ---------------------------

test('createReplayMarkerPart: round-trips through parseReplayMarkerData', () => {
	const part = createReplayMarkerPart({
		thinkingBlocks: [{ type: 'thinking', thinking: 'reasoning', signature: 'sig-abc' }],
	});
	assert.ok(part instanceof vscode.LanguageModelDataPart);
	assert.equal(part.mimeType, REPLAY_MARKER_MIME);
	const decoded = parseReplayMarkerData(part.data);
	assert.equal(decoded.valid, true);
	if (decoded.valid) {
		assert.equal(decoded.thinkingBlocks?.[0]?.thinking, 'reasoning');
		assert.equal(decoded.thinkingBlocks?.[0]?.signature, 'sig-abc');
	}
});

test('createReplayMarkerPart: emits an empty marker when no thinking blocks present', () => {
	const part = createReplayMarkerPart({});
	assert.ok(part instanceof vscode.LanguageModelDataPart);
	const decoded = parseReplayMarkerData(part.data);
	assert.equal(decoded.valid, true);
	if (decoded.valid) {
		assert.equal(decoded.thinkingBlocks, undefined);
		assert.equal(decoded.legacySegmentOnly, false);
	}
});

// ---- findFirstReplayMarker / parseFirstReplayMarker --------------

test('findFirstReplayMarker: returns undefined when the message has no marker', () => {
	const message: vscode.LanguageModelChatRequestMessage = {
		role: vscode.LanguageModelChatMessageRole.User,
		content: [{ value: 'hi' } as unknown as vscode.LanguageModelTextPart],
	};
	assert.equal(findFirstReplayMarker(message), undefined);
	assert.equal(parseFirstReplayMarker(message), undefined);
});

test('findFirstReplayMarker: locates the marker in the message content array', () => {
	const part = createReplayMarkerPart({ segmentId: 'abc12345-0000-0000-0000-000000000000' });
	const message: vscode.LanguageModelChatRequestMessage = {
		role: vscode.LanguageModelChatMessageRole.Assistant,
		content: [
			{ value: 'before' } as unknown as vscode.LanguageModelTextPart,
			part as unknown as vscode.LanguageModelContentPart,
		],
	};
	const located = findFirstReplayMarker(message);
	assert.ok(located);
	assert.equal(located!.partIndex, 1);
	assert.equal(located!.marker.valid, true);
});

test('findFirstReplayMarker: ignores non-marker DataParts with the same MIME', () => {
	const otherData = new vscode.LanguageModelDataPart(utf8('not-a-marker'), REPLAY_MARKER_MIME);
	const part = createReplayMarkerPart({});
	const message: vscode.LanguageModelChatRequestMessage = {
		role: vscode.LanguageModelChatMessageRole.Assistant,
		content: [
			otherData as unknown as vscode.LanguageModelContentPart,
			part as unknown as vscode.LanguageModelContentPart,
		],
	};
	const located = findFirstReplayMarker(message);
	assert.ok(located, 'expected a marker to be found at index 1');
	assert.equal(located!.partIndex, 1);
});

test('findFirstReplayMarker: ignores DataParts with a different MIME', () => {
	const wrongMime = new vscode.LanguageModelDataPart(utf8('not-a-marker'), 'image/png');
	const message: vscode.LanguageModelChatRequestMessage = {
		role: vscode.LanguageModelChatMessageRole.Assistant,
		content: [wrongMime as unknown as vscode.LanguageModelContentPart],
	};
	assert.equal(findFirstReplayMarker(message), undefined);
});