// Unit tests for `src/provider/tools/flow.ts`.
//
// `processToolFlow` is the entry point that decides whether the
// host's `activate_*` placeholder tools need a synthetic preflight
// round-trip. It is pure modulo the `vscode.Progress<...>` reporter
// (we capture reports in an in-memory array) and the
// `LanguageModelToolCallPart` constructor (mocked in
// `test/helpers/vscodeMock.ts`).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	LanguageModelChatMessageRole,
	LanguageModelTextPart,
	LanguageModelToolCallPart,
	LanguageModelToolResultPart,
} from '../src/../test/helpers/vscodeMock.js';
import * as vscode from 'vscode';

import { processToolFlow } from '../src/provider/tools/flow.js';
import { ACTIVATE_TOOL_PREFIX, MAX_PREFLIGHT_ROUNDS_PER_USER_REQUEST } from '../src/provider/tools/consts.js';
import { createPreflightToolCallId } from '../src/provider/tools/preflight.js';

function fakeProgress(): {
	progress: vscode.Progress<vscode.LanguageModelResponsePart>;
	reports: vscode.LanguageModelResponsePart[];
} {
	const reports: vscode.LanguageModelResponsePart[] = [];
	const progress = {
		report(part: vscode.LanguageModelResponsePart) {
			reports.push(part);
		},
	} as unknown as vscode.Progress<vscode.LanguageModelResponsePart>;
	return { progress, reports };
}

function userText(text: string): vscode.LanguageModelChatRequestMessage {
	return {
		role: LanguageModelChatMessageRole.User,
		content: [new LanguageModelTextPart(text) as unknown as vscode.LanguageModelTextPart],
	};
}

function assistantToolCall(callId: string, name: string): vscode.LanguageModelChatRequestMessage {
	return {
		role: LanguageModelChatMessageRole.Assistant,
		content: [
			new LanguageModelToolCallPart(callId, name, {}) as unknown as vscode.LanguageModelToolCallPart,
		],
	};
}

function userToolResult(callId: string): vscode.LanguageModelChatRequestMessage {
	return {
		role: LanguageModelChatMessageRole.User,
		content: [
			new LanguageModelToolResultPart(callId, [
				new LanguageModelTextPart('ok') as unknown as vscode.LanguageModelTextPart,
			]) as unknown as vscode.LanguageModelToolResultPart,
		],
	};
}

test('processToolFlow: stabilizeToolList=false → preflight skipped, no synthetic round', () => {
	const { progress, reports } = fakeProgress();
	const out = processToolFlow({
		stabilizeToolList: false,
		messages: [userText('hi')],
		tools: [{ name: `${ACTIVATE_TOOL_PREFIX}read_file` }],
		progress,
		requestKind: 'main-agent',
	});
	assert.equal(out.preflightHandled, false);
	assert.equal(reports.length, 0);
});

test('processToolFlow: stabilizeToolList=true, no activate_* placeholders → preflight ready, no synthetic round', () => {
	const { progress, reports } = fakeProgress();
	const out = processToolFlow({
		stabilizeToolList: true,
		messages: [userText('hi')],
		tools: [{ name: 'read_file' }],
		progress,
		requestKind: 'main-agent',
	});
	assert.equal(out.preflightHandled, false);
	assert.equal(reports.length, 0);
});

test('processToolFlow: stabilizeToolList=true with unexpanded activate_* → emits a synthetic preflight call per remaining activator', () => {
	const { progress, reports } = fakeProgress();
	const out = processToolFlow({
		stabilizeToolList: true,
		messages: [userText('hi')],
		tools: [
			{ name: `${ACTIVATE_TOOL_PREFIX}read_file` },
			{ name: `${ACTIVATE_TOOL_PREFIX}write_file` },
		],
		progress,
		requestKind: 'main-agent',
	});
	assert.equal(out.preflightHandled, true);
	assert.equal(reports.length, 2);
	// The synthetic IDs follow the `preflight:<round>:<toolName>` shape.
	// First round (no history), both tools.
	const firstId = createPreflightToolCallId(1, `${ACTIVATE_TOOL_PREFIX}read_file`);
	assert.equal((reports[0] as unknown as { callId: string }).callId, firstId);
});

test('processToolFlow: subsequent preflight round (one already done) increments the round number', () => {
	const { progress, reports } = fakeProgress();
	const previousRound = createPreflightToolCallId(1, `${ACTIVATE_TOOL_PREFIX}read_file`);
	const out = processToolFlow({
		stabilizeToolList: true,
		messages: [
			userText('hi'),
			assistantToolCall(previousRound, `${ACTIVATE_TOOL_PREFIX}read_file`),
			userToolResult(previousRound),
		],
		tools: [{ name: `${ACTIVATE_TOOL_PREFIX}write_file` }],
		progress,
		requestKind: 'main-agent',
	});
	assert.equal(out.preflightHandled, true);
	// This is the second preflight round, so the ID prefix should be 2.
	const secondId = createPreflightToolCallId(2, `${ACTIVATE_TOOL_PREFIX}write_file`);
	assert.equal((reports[0] as unknown as { callId: string }).callId, secondId);
});

test('processToolFlow: exceeding MAX_PREFLIGHT_ROUNDS_PER_USER_REQUEST throws a localised error', () => {
	const { progress } = fakeProgress();
	// Synthesise `MAX_PREFLIGHT_ROUNDS_PER_USER_REQUEST` completed
	// preflight rounds by using a fresh tool on each round. Build
	// the history directly: one activator call + result per round.
	const messages: vscode.LanguageModelChatRequestMessage[] = [userText('hi')];
	for (let round = 1; round <= MAX_PREFLIGHT_ROUNDS_PER_USER_REQUEST; round += 1) {
		const id = createPreflightToolCallId(round, `${ACTIVATE_TOOL_PREFIX}t${round}`);
		messages.push(assistantToolCall(id, `${ACTIVATE_TOOL_PREFIX}t${round}`));
		messages.push(userToolResult(id));
	}
	assert.throws(
		() =>
			processToolFlow({
				stabilizeToolList: true,
				messages,
				// One more unexpanded activator → triggers the limit.
				tools: [{ name: `${ACTIVATE_TOOL_PREFIX}final` }],
				progress,
				requestKind: 'main-agent',
			}),
		/3-round limit|轮|稳定|preflightRoundLimitExceeded/,
	);
});

test('processToolFlow: already-expanded tool list + prior preflight → ready state, not handled', () => {
	const { progress, reports } = fakeProgress();
	// History shows a successful preflight expansion; current tool
	// list contains the *real* tool name (no activate_ prefix).
	const id = createPreflightToolCallId(1, `${ACTIVATE_TOOL_PREFIX}read_file`);
	const out = processToolFlow({
		stabilizeToolList: true,
		messages: [
			userText('hi'),
			assistantToolCall(id, `${ACTIVATE_TOOL_PREFIX}read_file`),
			userToolResult(id),
		],
		tools: [{ name: 'read_file' }],
		progress,
		requestKind: 'main-agent',
	});
	assert.equal(out.preflightHandled, false);
	assert.equal(reports.length, 0);
	// No drift notice either (no activate_* leftover).
	assert.equal(out.initialResponseNotice, undefined);
});
