// Unit tests for `src/provider/tools/notices.ts`.
//
// `filterProviderNotices` strips our own injected tool-drift
// notices from assistant history so we don't echo them back to
// the API on subsequent turns. A bug here either drops real
// assistant content or leaves orphan markers in the request.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';

import {
	createToolDriftNotice,
	filterProviderNotices,
} from '../src/provider/tools/notices.js';

function userText(text: string): vscode.LanguageModelChatRequestMessage {
	return {
		role: vscode.LanguageModelChatMessageRole.User,
		content: [new vscode.LanguageModelTextPart(text) as unknown as vscode.LanguageModelTextPart],
	};
}

function assistantText(text: string): vscode.LanguageModelChatRequestMessage {
	return {
		role: vscode.LanguageModelChatMessageRole.Assistant,
		content: [new vscode.LanguageModelTextPart(text) as unknown as vscode.LanguageModelTextPart],
	};
}

// ---- createToolDriftNotice --------------------------------------

test('createToolDriftNotice: wraps the i18n string in start/end markers + blockquote', () => {
	const notice = createToolDriftNotice();
	assert.match(notice, /\[minimax-copilot-tool-drift-notice-start\]: #/);
	assert.match(notice, /\[minimax-copilot-tool-drift-notice-end\]: #/);
	// The i18n body is rendered as a markdown blockquote.
	assert.match(notice, /^> /m);
});

test('createToolDriftNotice: includes the localised text', () => {
	const notice = createToolDriftNotice();
	// The English text starts with "⚠️" per src/i18n.ts.
	assert.match(notice, /cache/i);
});

// ---- filterProviderNotices: identity cases ------------------------

test('filterProviderNotices: returns the same array reference when nothing changed', () => {
	const messages = [userText('hi'), assistantText('plain reply')];
	const filtered = filterProviderNotices(messages);
	assert.equal(filtered, messages);
});

test('filterProviderNotices: passes user messages through unchanged', () => {
	const user = userText('hi');
	const filtered = filterProviderNotices([user]);
	assert.equal(filtered[0], user);
});

// ---- filterProviderNotices: stripping ---------------------------

test('filterProviderNotices: strips a single embedded notice from an assistant turn', () => {
	const notice = createToolDriftNotice();
	const original = assistantText(`Some context.\n\n${notice}\n\nMore context after.`);
	const filtered = filterProviderNotices([original]);
	assert.equal(filtered.length, 1);
	const blocks = (filtered[0]!.content[0] as vscode.LanguageModelTextPart).value;
	assert.ok(!blocks.includes('minimax-copilot-tool-drift-notice-start'));
	assert.match(blocks, /^Some context\./);
	assert.match(blocks, /More context after\.$/);
});

test('filterProviderNotices: strips multiple notices from the same turn', () => {
	const notice = createToolDriftNotice();
	const text = `${notice}\n\nfirst\n\n${notice}\n\nsecond`;
	const filtered = filterProviderNotices([assistantText(text)]);
	const blocks = (filtered[0]!.content[0] as vscode.LanguageModelTextPart).value;
	assert.ok(!blocks.includes('minimax-copilot-tool-drift-notice-start'));
	assert.match(blocks, /first/);
	assert.match(blocks, /second/);
});

test('filterProviderNotices: keeps the text before / after a stripped notice', () => {
	const notice = createToolDriftNotice();
	const text = `before\n\n${notice}\n\nafter`;
	const original = assistantText(text);
	const filtered = filterProviderNotices([userText('hi'), original]);
	assert.equal(filtered.length, 2);
	assert.equal(filtered[0]!.role, vscode.LanguageModelChatMessageRole.User);
	const blocks = (filtered[1]!.content[0] as vscode.LanguageModelTextPart).value;
	// `removeRangeWithWhitespace` trims the leading newline
	// preceding the start marker, so the surviving text is
	// `"before\n\nafter"` (with a single blank-line separator).
	assert.match(blocks, /before/);
	assert.match(blocks, /after/);
	assert.ok(!blocks.includes('minimax-copilot-tool-drift-notice-start'));
});

test('filterProviderNotices: preserves non-text parts on the assistant message', () => {
	const notice = createToolDriftNotice();
	const dataPart = new vscode.LanguageModelDataPart(new Uint8Array([1, 2, 3]), 'image/png');
	const original: vscode.LanguageModelChatRequestMessage = {
		role: vscode.LanguageModelChatMessageRole.Assistant,
		content: [
			new vscode.LanguageModelTextPart(`hi ${notice}`) as unknown as vscode.LanguageModelTextPart,
			dataPart as unknown as vscode.LanguageModelContentPart,
		],
	};
	const filtered = filterProviderNotices([original]);
	assert.equal(filtered.length, 1);
	// The data part survives unchanged.
	assert.ok(filtered[0]!.content.some((p) => p instanceof vscode.LanguageModelDataPart));
	const remainingText = (filtered[0]!.content.find((p) => p instanceof vscode.LanguageModelTextPart) as vscode.LanguageModelTextPart).value;
	assert.ok(!remainingText.includes('minimax-copilot-tool-drift-notice-start'));
});

test('filterProviderNotices: handles an unterminated start marker (end missing)', () => {
	// Without an end marker, the strip function consumes the
	// start marker and everything after it, plus the leading
	// whitespace. So the surviving text is the prefix before the
	// start marker's preceding whitespace run.
	const unterminated = `Some text\n\n[minimax-copilot-tool-drift-notice-start]: #\nstill going`;
	const filtered = filterProviderNotices([assistantText(unterminated)]);
	assert.equal(filtered.length, 1);
	const blocks = (filtered[0]!.content[0] as vscode.LanguageModelTextPart).value;
	assert.equal(blocks, 'Some text');
});
