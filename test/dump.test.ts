// Unit tests for `src/provider/debug/dump.ts`.
//
// The dump module is fundamentally a side-effecting file writer, so
// the test strategy is:
//   1. Extract / drive the helpers that build snapshots and
//      paths through the public functions.
//   2. Stub the `getRequestDumpEnabled` setting to enable the
//      write path.
//   3. Use a real temp dir (via `node:os.tmpdir`) to verify the
//      on-disk shape.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
	ensureRequestDumpRoot,
	dumpProviderInput,
	dumpMiniMaxRequest,
	flushPendingDumpWrites,
} from '../src/provider/debug/dump.js';
import { REPLAY_MARKER_MIME } from '../src/provider/replay/index.js';
import { getOpenExternalCalls, mockConfig, resetMockConfig, UriInstance, window as vscodeWindow, LanguageModelDataPart, LanguageModelTextPart } from './helpers/vscodeMock.js';

beforeEach(() => {
	// The dump queue is module-scope state; reset between tests so
	// writes from one test don't leak into the next.
	resetMockConfig();
});

// ---- helpers ---------------------------------------------------------

function makeMessage(role: 'user' | 'assistant', text: string): import('vscode').LanguageModelChatRequestMessage {
	return {
		role: role === 'user' ? 1 : 2,
		content: [{ value: text } as never],
	} as unknown as import('vscode').LanguageModelChatRequestMessage;
}

function tmpRoot(): Promise<{ root: string; cleanup: () => Promise<void> }> {
	const dir = path.join(os.tmpdir(), `minimax-dump-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	return Promise.resolve({
		root: dir,
		cleanup: async () => { await fsp.rm(dir, { recursive: true, force: true }); },
	});
}

function makeSegment(): import('../src/provider/segment.js').ConversationSegment {
	return {
		segmentId: 'seg-' + Math.random().toString(36).slice(2),
		reason: 'first-turn',
	};
}

// ---- ensureRequestDumpRoot -------------------------------------------

test('ensureRequestDumpRoot: appends request-dumps to the global storage path', () => {
	const uri = new UriInstance('vscode-userdata', '/path/to/globalStorage', '/path/to/globalStorage');
	assert.equal(ensureRequestDumpRoot(uri), path.join('/path/to/globalStorage', 'request-dumps'));
});

// ---- dumpProviderInput ------------------------------------------------

test('dumpProviderInput: no-op when debugMode is not "verbose"', async () => {
	const { root, cleanup } = await tmpRoot();
	try {
		mockConfig['minimax.debugMode'] = 'minimal';
		// Reset external calls so the test is hermetic
		getOpenExternalCalls().length = 0;
		dumpProviderInput({
			globalStorageUri: new UriInstance('vscode-userdata', root, root),
			segment: makeSegment(),
			modelInfo: { id: 'MiniMax-M3', name: 'M3', vendor: 'minimax', family: 'minimax', version: '1', maxInputTokens: 1, maxOutputTokens: 1, isDefault: false } as never,
			messages: [makeMessage('user', 'hi')],
			requestOptions: { tools: [], modelOptions: {} } as never,
		});
		// Nothing should have been written to disk.
		const exists = await fsp.access(root).then(() => true).catch(() => false);
		assert.equal(exists, false);
	} finally {
		await cleanup();
	}
});

test('dumpProviderInput: writes a provider-input snapshot under request-dumps/<segment>/', async () => {
	const { root, cleanup } = await tmpRoot();
	try {
		mockConfig['minimax.debugMode'] = 'verbose';
		dumpProviderInput({
			globalStorageUri: new UriInstance('vscode-userdata', root, root),
			segment: { segmentId: 'seg-fresh', reason: 'first-turn' },
			modelInfo: {
				id: 'MiniMax-M3', name: 'M3', vendor: 'minimax', family: 'minimax',
				version: '1', maxInputTokens: 1, maxOutputTokens: 1, isDefault: false,
			} as never,
			messages: [makeMessage('user', 'hello there')],
			requestOptions: { tools: [], modelOptions: {} } as never,
		});

		// Wait for the enqueued write to flush.
		await flushPendingDumpWrites();

		const dumpRoot = path.join(root, 'request-dumps', 'seg-fresh');
		const entries = await fsp.readdir(dumpRoot);
		// One or more `minimax-provider-input-<ts>-NNNN.provider-input.json`
		// files should be present.
		const providerInput = entries.find((e) => e.includes('minimax-provider-input') && e.endsWith('.provider-input.json'));
		assert.ok(providerInput, `expected a provider-input file, got: ${entries.join(', ')}`);
		const body = await fsp.readFile(path.join(dumpRoot, providerInput!), 'utf8');
		const parsed = JSON.parse(body);
		assert.equal(parsed.model.vscodeModelId, 'MiniMax-M3');
		assert.equal(parsed.tools.toolCount, 0);
		// `requestOptions` should be summarised — tools count + model options.
		assert.equal(parsed.requestOptions.toolCount, 0);
	} finally {
		await cleanup();
	}
});

test('dumpProviderInput: appends a line to _request-observations.jsonl', async () => {
	const { root, cleanup } = await tmpRoot();
	try {
		mockConfig['minimax.debugMode'] = 'verbose';
		dumpProviderInput({
			globalStorageUri: new UriInstance('vscode-userdata', root, root),
			segment: { segmentId: 'seg-obs', reason: 'first-turn' },
			modelInfo: {
				id: 'MiniMax-M3', name: 'M3', vendor: 'minimax', family: 'minimax',
				version: '1', maxInputTokens: 1, maxOutputTokens: 1, isDefault: false,
			} as never,
			messages: [makeMessage('user', 'hi')],
			requestOptions: { tools: [], modelOptions: {} } as never,
		});
		await flushPendingDumpWrites();

		const obsPath = path.join(root, 'request-dumps', '_request-observations.jsonl');
		const obs = await fsp.readFile(obsPath, 'utf8');
		const lines = obs.trim().split('\n');
		// At least one line, shape = { event, requestKind, segment, ... }
		const last = JSON.parse(lines[lines.length - 1]);
		assert.equal(last.event, 'provider-input');
		assert.equal(last.segment.id, 'seg-obs');
	} finally {
		await cleanup();
	}
});

// ---- dumpMiniMaxRequest -----------------------------------------------

test('dumpMiniMaxRequest: no-op when debugMode is not "verbose"', async () => {
	const { root, cleanup } = await tmpRoot();
	try {
		mockConfig['minimax.debugMode'] = 'minimal';
		dumpMiniMaxRequest(
			{
				model: 'MiniMax-M3',
				messages: [{ role: 'user', content: 'hi' }],
				max_tokens: 1000,
				stream: true,
			},
			{
				globalStorageUri: new UriInstance('vscode-userdata', root, root),
				segment: { segmentId: 'seg-nop', reason: 'first-turn' },
				vscodeModelId: 'MiniMax-M3',
				isThinkingModel: true,
				thinkingEffort: 'adaptive',
				maxTokens: 1000,
				inputMessages: [makeMessage('user', 'hi')],
				resolvedMessages: [makeMessage('user', 'hi')],
				requestOptions: { tools: [], modelOptions: {} } as never,
			},
		);
		await new Promise((r) => setTimeout(r, 50));
		const exists = await fsp.access(path.join(root, 'request-dumps')).then(() => true).catch(() => false);
		assert.equal(exists, false);
	} finally {
		await cleanup();
	}
});

test('dumpMiniMaxRequest: writes the four snapshot files + a request.json', async () => {
	const { root, cleanup } = await tmpRoot();
	try {
		mockConfig['minimax.debugMode'] = 'verbose';
		dumpMiniMaxRequest(
			{
				model: 'MiniMax-M3',
				messages: [{ role: 'user', content: 'hi' }],
				max_tokens: 1000,
				stream: true,
			},
			{
				globalStorageUri: new UriInstance('vscode-userdata', root, root),
				segment: { segmentId: 'seg-full', reason: 'first-turn' },
				vscodeModelId: 'MiniMax-M3',
				isThinkingModel: true,
				thinkingEffort: 'adaptive',
				maxTokens: 1000,
				inputMessages: [makeMessage('user', 'hi')],
				resolvedMessages: [makeMessage('user', 'hi')],
				requestOptions: { tools: [], modelOptions: {} } as never,
			},
		);
		await flushPendingDumpWrites();

		const dumpRoot = path.join(root, 'request-dumps', 'seg-full');
		const entries = await fsp.readdir(dumpRoot);
		const hasInput = entries.some((e) => e.endsWith('.input.json'));
		const hasResolved = entries.some((e) => e.endsWith('.resolved.json'));
		// The final request file is `minimax-request-<ts>-NNNN.json` —
		// it has no suffix like `.input.` or `.resolved.` or `.msg0.`.
		const hasRequest = entries.some((e) => {
			if (!e.endsWith('.json')) return false;
			if (e.endsWith('.input.json')) return false;
			if (e.endsWith('.resolved.json')) return false;
			if (e.endsWith('.provider-input.json')) return false;
			return e.includes('minimax-request-');
		});
		assert.ok(hasInput, `expected an .input.json snapshot, got: ${entries.join(', ')}`);
		assert.ok(hasResolved, `expected a .resolved.json snapshot, got: ${entries.join(', ')}`);
		assert.ok(hasRequest, `expected a final .json request file, got: ${entries.join(', ')}`);

		// Read the .json to confirm shape
		const requestFile = entries.find((e) => {
			if (!e.endsWith('.json')) return false;
			if (e.endsWith('.input.json')) return false;
			if (e.endsWith('.resolved.json')) return false;
			if (e.endsWith('.provider-input.json')) return false;
			return e.includes('minimax-request-');
		})!;
		const body = await fsp.readFile(path.join(dumpRoot, requestFile), 'utf8');
		const req = JSON.parse(body);
		// Debug: assert the body looks like a MiniMax request
		assert.ok(req && typeof req === 'object', `request body shape: ${body.slice(0, 200)}`);
		assert.equal(req.model, 'MiniMax-M3');
		assert.equal(req.max_tokens, 1000);
	} finally {
		await cleanup();
	}
});

// ---- replay marker counting in input snapshot ------------------------

test('dumpMiniMaxRequest: counts replay markers in the resolved snapshot', async () => {
	const { root, cleanup } = await tmpRoot();
	try {
		mockConfig['minimax.debugMode'] = 'verbose';
		const markerBytes = new TextEncoder().encode(JSON.stringify({ thinkingBlocks: [] }));
		const messageWithMarker = {
			role: 1,
			content: [
				new LanguageModelTextPart('hello') as unknown as import('vscode').LanguageModelTextPart,
				new LanguageModelDataPart(markerBytes, REPLAY_MARKER_MIME) as unknown as import('vscode').LanguageModelDataPart,
			],
		} as unknown as import('vscode').LanguageModelChatRequestMessage;
		dumpMiniMaxRequest(
			{
				model: 'MiniMax-M3',
				messages: [{ role: 'user', content: 'hi' }],
				max_tokens: 1000,
				stream: true,
			},
			{
				globalStorageUri: new UriInstance('vscode-userdata', root, root),
				segment: { segmentId: 'seg-marker', reason: 'first-turn' },
				vscodeModelId: 'MiniMax-M3',
				isThinkingModel: true,
				thinkingEffort: 'adaptive',
				maxTokens: 1000,
				inputMessages: [messageWithMarker],
				resolvedMessages: [messageWithMarker],
				requestOptions: { tools: [], modelOptions: {} } as never,
			},
		);
		await flushPendingDumpWrites();

		const dumpRoot = path.join(root, 'request-dumps', 'seg-marker');
		const entries = await fsp.readdir(dumpRoot);
		// Read the `.input.json` — it includes `hasReplayMarker` per message.
		const inputFile = entries.find((e) => e.endsWith('.input.json'))!;
		const body = JSON.parse(await fsp.readFile(path.join(dumpRoot, inputFile), 'utf8'));
		const hasMarker = body.messages.some((m: { hasReplayMarker?: boolean }) => m.hasReplayMarker === true);
		assert.ok(hasMarker, 'expected at least one message with hasReplayMarker=true');
	} finally {
		await cleanup();
	}
});

// Suppress unused warning on the imported vscodeWindow; some
// helpers use it implicitly.
void vscodeWindow;
