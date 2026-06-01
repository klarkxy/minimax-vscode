// Unit tests for the vision-bypass path in `src/provider/vision/resolve.ts`
// and the conditional short-circuit in `src/provider/request.ts`.
//
// The bug we are guarding against (regression: "images cannot be
// transmitted at all now") happens when the request pipeline calls the
// vision proxy on a multimodal model (MiniMax-M3). The proxy either
// (a) wastes a round-trip describing an image we are about to send
// base64 anyway, or (b) is unavailable and silently replaces the
// image with `[Image Description unavailable]`, which the user then
// sees as "I attached an image and the model pretended it didn't
// exist".
//
// `bypassVisionResolution` is the helper that lets the request layer
// skip the proxy entirely for models with `imageInput: true`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bypassVisionResolution } from '../src/provider/vision/resolve.js';
import { LanguageModelDataPart, LanguageModelTextPart } from './helpers/vscodeMock.js';

function makeTextMessage(role: 'user' | 'assistant', text: string) {
	return {
		role,
		content: [new LanguageModelTextPart(text)],
	};
}

function makeImageMessage(role: 'user' | 'assistant', mime: string) {
	// The data buffer content is irrelevant for these tests — the
	// bypass path never inspects the bytes.
	return {
		role,
		content: [new LanguageModelDataPart(Buffer.from('fake'), mime)],
	};
}

test('bypassVisionResolution: returns the same message list unchanged', () => {
	const messages = [
		makeTextMessage('user', 'hi'),
		makeImageMessage('user', 'image/png'),
	];

	const result = bypassVisionResolution(messages);
	assert.strictEqual(result.messages, messages as unknown as typeof result.messages);
});

test('bypassVisionResolution: never marks a part as resolved by the proxy', () => {
	const messages = [
		makeImageMessage('user', 'image/jpeg'),
		makeImageMessage('user', 'image/webp'),
	];

	const result = bypassVisionResolution(messages);
	const stats = result.stats;

	// Every "did work happen in the proxy" counter must be zero —
	// the bypass path is, by definition, a no-op.
	assert.strictEqual(stats.inputImageParts, 0);
	assert.strictEqual(stats.inputImageMessages, 0);
	assert.strictEqual(stats.currentImageMessages, 0);
	assert.strictEqual(stats.generatedImageMessages, 0);
	assert.strictEqual(stats.replayedImageMessages, 0);
	assert.strictEqual(stats.omittedImageMessages, 0);
	assert.strictEqual(stats.unavailableImageMessages, 0);
	assert.strictEqual(stats.failedImageMessages, 0);
	assert.strictEqual(stats.droppedImageParts, 0);
	assert.strictEqual(stats.markerVisionTextChars, 0);
	assert.strictEqual(stats.invalidMarkerVisionMetadata, 0);
});

test('bypassVisionResolution: emits an empty replay marker', () => {
	const result = bypassVisionResolution([makeTextMessage('user', 'hi')]);
	// The shape `{ thinkingBlocks: undefined }` is the same one
	// `resolveImageMessages` uses when it has nothing to carry over;
	// keeping it identical means downstream code (e.g. the dump
	// pipeline) does not need to special-case the bypass path.
	assert.deepStrictEqual(result.replayMarkerMetadata, { thinkingBlocks: undefined });
});

test('bypassVisionResolution: leaves visionModelId undefined', () => {
	const result = bypassVisionResolution([makeTextMessage('user', 'hi')]);
	assert.strictEqual(result.visionModelId, undefined);
});
