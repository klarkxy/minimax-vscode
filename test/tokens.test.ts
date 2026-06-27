// Unit tests for `src/provider/tokens.ts`.
//
// `estimateTokenCount` divides a string or message's parts by
// `charsPerToken` (calibrated by `updateCharsPerToken` in
// `provider/stream.ts`). The minimum return value is 1 to avoid
// returning zero for empty inputs (which the upstream prompt
// cache treats as a "skip").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';

import { DEFAULT_CHARS_PER_TOKEN, estimateTokenCount } from '../src/provider/tokens.js';

test('estimateTokenCount: a string returns ceil(len / charsPerToken), min 1', () => {
	assert.equal(estimateTokenCount('', 4), 1);
	assert.equal(estimateTokenCount('a', 4), 1);
	assert.equal(estimateTokenCount('abcd', 4), 1);
	assert.equal(estimateTokenCount('abcde', 4), 2);
	assert.equal(estimateTokenCount('hello world', 4), 3);
});

test('estimateTokenCount: honours a non-default charsPerToken', () => {
	// 5 chars at 2 cpt = 3 tokens
	assert.equal(estimateTokenCount('hello', 2), 3);
});

test('estimateTokenCount: text part on a message', () => {
	const message: vscode.LanguageModelChatRequestMessage = {
		role: vscode.LanguageModelChatMessageRole.User,
		content: [new vscode.LanguageModelTextPart('abcde') as unknown as vscode.LanguageModelTextPart],
	};
	assert.equal(estimateTokenCount(message, 4), 2);
});

test('estimateTokenCount: tool call part counts callId + name + JSON input', () => {
	const message: vscode.LanguageModelChatRequestMessage = {
		role: vscode.LanguageModelChatMessageRole.Assistant,
		content: [
			new vscode.LanguageModelToolCallPart('id_12345', 'read_file', { path: '/x' }) as unknown as vscode.LanguageModelToolCallPart,
		],
	};
	// callId=7, name=9, JSON('{"path":"/x"}')=13 → 29 chars → ceil(29/4)=8
	assert.equal(estimateTokenCount(message, 4), 8);
});

test('estimateTokenCount: image data part uses the flat 1020-char estimate', () => {
	const message: vscode.LanguageModelChatRequestMessage = {
		role: vscode.LanguageModelChatMessageRole.User,
		content: [new vscode.LanguageModelDataPart(new Uint8Array(50_000), 'image/png') as unknown as vscode.LanguageModelDataPart],
	};
	// 1020 / 4 = 255
	assert.equal(estimateTokenCount(message, 4), 255);
});

test('estimateTokenCount: replay marker data part contributes 0 chars', () => {
	const message: vscode.LanguageModelChatRequestMessage = {
		role: vscode.LanguageModelChatMessageRole.Assistant,
		content: [new vscode.LanguageModelDataPart(new Uint8Array(1000), 'minimax_marker') as unknown as vscode.LanguageModelDataPart],
	};
	// Marker metadata is not sent as assistant content.
	assert.equal(estimateTokenCount(message, 4), 1);
});

test('estimateTokenCount: tool result part with nested text counts the inner text', () => {
	const message: vscode.LanguageModelChatRequestMessage = {
		role: vscode.LanguageModelChatMessageRole.User,
		content: [
			new vscode.LanguageModelToolResultPart('id_1', [
				new vscode.LanguageModelTextPart('hello world') as unknown as vscode.LanguageModelTextPart,
			]) as unknown as vscode.LanguageModelToolResultPart,
		],
	};
	// callId=4 + 'hello world'=11 = 15 → ceil(15/4)=4
	assert.equal(estimateTokenCount(message, 4), 4);
});

test('estimateTokenCount: empty / malformed message falls back to 1', () => {
	// No content array
	const empty: vscode.LanguageModelChatRequestMessage = {} as never;
	assert.equal(estimateTokenCount(empty, 4), 1);
	// Non-array content
	const weird: vscode.LanguageModelChatRequestMessage = { content: 'not-an-array' } as never;
	assert.equal(estimateTokenCount(weird, 4), 1);
});

test('DEFAULT_CHARS_PER_TOKEN: matches the deepseek-v4-for-copilot calibration (4.0)', () => {
	assert.equal(DEFAULT_CHARS_PER_TOKEN, 4.0);
});
