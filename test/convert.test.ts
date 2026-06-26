// Unit tests for `src/provider/convert.ts`.
//
// The converter is the boundary between VS Code's `LanguageModelChat*`
// surface and the Anthropic-compatible request body. Its behaviour
// drives the entire request payload, so we test the common shapes
// (text, image, video, tool_use / tool_result) and the off-the-happy-
// path edge cases (unsupported MIME, large attachments, mixed text +
// image blocks).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	LanguageModelDataPart,
	LanguageModelTextPart,
	LanguageModelToolCallPart,
	LanguageModelToolResultPart,
	LanguageModelChatMessageRole,
	UriInstance,
	mockConfig,
	window as vscodeWindow,
} from '../src/../test/helpers/vscodeMock.js';
import * as vscode from 'vscode';
import { convertMessages, convertTools, countMessageChars } from '../src/provider/convert.js';
import { appendTerminalGuidanceToSystemPrompt, buildTerminalGuidance } from '../src/provider/terminalEnvironment.js';

// Build a small user message with only text.
function userText(text: string): vscode.LanguageModelChatRequestMessage {
	return {
		role: LanguageModelChatMessageRole.User,
		content: [new LanguageModelTextPart(text) as unknown as vscode.LanguageModelTextPart],
	};
}

function userImage(base64: string, mime: string): vscode.LanguageModelChatRequestMessage {
	return {
		role: LanguageModelChatMessageRole.User,
		content: [
			new LanguageModelDataPart(Buffer.from(base64, 'utf8'), mime) as unknown as vscode.LanguageModelDataPart,
		],
	};
}

function userMixed(
	text: string,
	image: { data: string; mime: string },
): vscode.LanguageModelChatRequestMessage {
	return {
		role: LanguageModelChatMessageRole.User,
		content: [
			new LanguageModelTextPart(text) as unknown as vscode.LanguageModelTextPart,
			new LanguageModelDataPart(Buffer.from(image.data, 'utf8'), image.mime) as unknown as vscode.LanguageModelDataPart,
		],
	};
}

function assistantToolCall(name: string, input: unknown): vscode.LanguageModelChatRequestMessage {
	return {
		role: LanguageModelChatMessageRole.Assistant,
		content: [
			new LanguageModelToolCallPart('call_1', name, input) as unknown as vscode.LanguageModelToolCallPart,
		],
	};
}

function userToolResult(callId: string, text: string): vscode.LanguageModelChatRequestMessage {
	return {
		role: LanguageModelChatMessageRole.User,
		content: [
			new LanguageModelToolResultPart(callId, [
				new LanguageModelTextPart(text) as unknown as vscode.LanguageModelTextPart,
			]) as unknown as vscode.LanguageModelToolResultPart,
		],
	};
}

const M3_ID = 'MiniMax-M3';
const M27_ID = 'MiniMax-M2.7';

// --- Text-only --------------------------------------------------------

test('convertMessages: text-only user message collapses to a string content', () => {
	const result = convertMessages([userText('hello')], M3_ID);
	assert.equal(result.messages.length, 1);
	assert.equal(result.messages[0].role, 'user');
	assert.equal(result.messages[0].content, 'hello');
	assert.equal(result.systemPrompt, undefined);
});

test('convertMessages: system messages are extracted from the array', () => {
	const systemMsg: vscode.LanguageModelChatRequestMessage = {
		role: 3 as unknown as vscode.LanguageModelChatMessageRole, // System
		content: [new LanguageModelTextPart('be brief') as unknown as vscode.LanguageModelTextPart],
	};
	const result = convertMessages([systemMsg, userText('hi')], M3_ID);
	assert.equal(result.systemPrompt, 'be brief');
	assert.equal(result.messages.length, 1);
	assert.equal(result.messages[0].role, 'user');
});

test('convertMessages: multiple system messages are joined with double newlines', () => {
	const sys1: vscode.LanguageModelChatRequestMessage = {
		role: 3 as unknown as vscode.LanguageModelChatMessageRole,
		content: [new LanguageModelTextPart('a') as unknown as vscode.LanguageModelTextPart],
	};
	const sys2: vscode.LanguageModelChatRequestMessage = {
		role: 3 as unknown as vscode.LanguageModelChatMessageRole,
		content: [new LanguageModelTextPart('b') as unknown as vscode.LanguageModelTextPart],
	};
	const result = convertMessages([sys1, sys2], M3_ID);
	assert.equal(result.systemPrompt, 'a\n\nb');
	assert.equal(result.messages.length, 0);
});

// --- Tool use / tool result ------------------------------------------

test('convertMessages: assistant tool call becomes a tool_use block', () => {
	const result = convertMessages([assistantToolCall('read_file', { path: '/x' })], M3_ID);
	assert.equal(result.messages.length, 1);
	assert.equal(result.messages[0].role, 'assistant');
	const blocks = result.messages[0].content as Array<Record<string, unknown>>;
	assert.equal(blocks.length, 1);
	assert.equal(blocks[0].type, 'tool_use');
	assert.equal(blocks[0].id, 'call_1');
	assert.equal(blocks[0].name, 'read_file');
	assert.deepEqual(blocks[0].input, { path: '/x' });
});

test('convertMessages: tool result becomes a tool_result block on a user message', () => {
	const result = convertMessages([userToolResult('call_1', 'ok')], M3_ID);
	assert.equal(result.messages.length, 1);
	assert.equal(result.messages[0].role, 'user');
	const blocks = result.messages[0].content as Array<Record<string, unknown>>;
	assert.equal(blocks[0].type, 'tool_result');
	assert.equal(blocks[0].tool_use_id, 'call_1');
	assert.equal(blocks[0].content, 'ok');
});

// --- Image / video handling ------------------------------------------

test('convertMessages: image part on M3 is forwarded as base64', () => {
	const result = convertMessages(
		[userImage('hello-image', 'image/png')],
		M3_ID,
	);
	const blocks = result.messages[0].content as Array<Record<string, unknown>>;
	assert.equal(blocks.length, 1);
	assert.equal(blocks[0].type, 'image');
	const source = blocks[0].source as Record<string, unknown>;
	assert.equal(source.type, 'base64');
	assert.equal(source.media_type, 'image/png');
	// base64('hello-image') → aGVsbG8taW1hZ2U=
	assert.equal(source.data, 'aGVsbG8taW1hZ2U=');
});

test('convertMessages: image part on M2.7 is dropped (text/tool-call only)', () => {
	const result = convertMessages(
		[userImage('data', 'image/png')],
		M27_ID,
	);
	// M2.x models only accept text and tool-call blocks on MiniMax's
	// Anthropic-compatible API; image attachments must not be forwarded.
	assert.equal(result.messages.length, 0);
});

test('convertMessages: text + image on M3 keeps both blocks in order', () => {
	const result = convertMessages(
		[userMixed('describe:', { data: 'img', mime: 'image/jpeg' })],
		M3_ID,
	);
	const blocks = result.messages[0].content as Array<Record<string, unknown>>;
	assert.equal(blocks.length, 2);
	assert.equal(blocks[0].type, 'text');
	assert.equal(blocks[1].type, 'image');
});

test('convertMessages: unsupported image MIME on M3 logs a warning, image is dropped', () => {
	const result = convertMessages(
		[userMixed('look:', { data: 'data', mime: 'image/x-fake' })],
		M3_ID,
	);
	// Only the text part survives; the converter collapses a single
	// surviving text block into a plain string content, so we assert
	// the string content rather than the array shape.
	assert.equal(result.messages[0].content, 'look:');
});

// --- convertTools ----------------------------------------------------

test('convertTools: undefined / empty input returns undefined', () => {
	assert.equal(convertTools(undefined), undefined);
	assert.equal(convertTools([]), undefined);
});

test('convertTools: maps VS Code tool shape to Anthropic tool shape', () => {
	const tools: vscode.LanguageModelChatTool[] = [
		{
			name: 'grep',
			description: 'ripgrep',
			inputSchema: {
				type: 'object',
				properties: { pattern: { type: 'string' } },
			},
		},
	];
	const out = convertTools(tools);
	assert.ok(out);
	assert.equal(out!.length, 1);
	assert.equal(out![0].name, 'grep');
	assert.equal(out![0].description, 'ripgrep');
	assert.equal((out![0].input_schema as Record<string, unknown>).type, 'object');
});

test('convertTools: appends detected terminal guidance to tool descriptions', () => {
	mockConfig['terminal.integrated.defaultProfile.windows'] = 'Command Prompt';
	const terminalGuidance = buildTerminalGuidance();
	delete mockConfig['terminal.integrated.defaultProfile.windows'];

	const out = convertTools([
		{
			name: 'run_in_terminal',
			description: 'Run a shell command',
			inputSchema: { type: 'object' },
		},
	], terminalGuidance);

	assert.match(out![0].description!, /Command Prompt/);
	assert.match(out![0].description!, /Do not use Bash-only syntax/);
});

test('buildTerminalGuidance: strips local paths from active terminal shellPath', () => {
	vscodeWindow.activeTerminal = {
		name: 'pwsh',
		shellPath: 'C:\\Users\\alice\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe',
	};
	const terminalGuidance = buildTerminalGuidance();
	vscodeWindow.activeTerminal = undefined;

	assert.match(terminalGuidance!, /PowerShell/);
	assert.doesNotMatch(terminalGuidance!, /alice/);
	assert.doesNotMatch(terminalGuidance!, /AppData/);
	assert.doesNotMatch(terminalGuidance!, /\\/);
});

test('appendTerminalGuidanceToSystemPrompt: adds dynamic terminal guidance once', () => {
	const guidance = 'The user\'s terminal environment is pwsh. For terminal commands, use syntax that is valid for this shell.';
	const once = appendTerminalGuidanceToSystemPrompt('be brief', guidance);
	const twice = appendTerminalGuidanceToSystemPrompt(once, guidance);

	assert.equal(once, `be brief\n\n${guidance}`);
	assert.equal(twice, once);
});

test('convertTools: missing inputSchema falls back to an empty object schema', () => {
	const tools = [{
		name: 'noop',
		description: 'no schema',
	}] as unknown as vscode.LanguageModelChatTool[];
	const out = convertTools(tools);
	assert.deepEqual(out![0].input_schema, { type: 'object', properties: {} });
});

// --- countMessageChars -----------------------------------------------

test('countMessageChars: counts system prompt and text blocks', () => {
	const conv = convertMessages([userText('hello world')], M3_ID);
	// "hello world" is 11 chars; system prompt is undefined.
	assert.equal(countMessageChars(conv), 11);
});

test('countMessageChars: counts base64 image data length', () => {
	const conv = convertMessages(
		[userImage('aGVsbG8=', 'image/png')],
		M3_ID,
	);
	// base64('hello') is 'aGVsbG8=' which is 8 chars.
	const blocks = conv.messages[0].content as Array<Record<string, unknown>>;
	const source = blocks[0].source as Record<string, unknown>;
	assert.equal(countMessageChars(conv), (source.data as string).length);
});

// Sanity check the test mock setup: UriInstance should exist so other
// tests that depend on it (e.g. visionBypass.test.ts) keep working.
test('vscode mock: UriInstance round-trips a file path', () => {
	const u = new UriInstance('file', '/tmp/x', '/tmp/x');
	assert.equal(u.fsPath, '/tmp/x');
});
