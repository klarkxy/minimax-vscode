// Unit tests for `src/provider/index.ts` (MiniMaxChatProvider).
//
// The provider implements `vscode.LanguageModelChatProvider` and
// pulls in KeyManager / AuthManager / the global usage store on
// construction. The two public methods most of the extension calls
// (`hasApiKey`, `configureApiKey`, `clearApiKey`,
// `refreshModelPicker`, `prepareForDeactivate`, and
// `provideLanguageModelChatInformation`) are straightforward to
// exercise against the vscode mock. The streaming
// `provideLanguageModelChatResponse` needs the Anthropic SDK
// stream which is not the focus of this test; we keep coverage on
// the public command surface here.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { MiniMaxChatProvider } from '../src/provider/index.js';
import {
	mockConfig,
	resetMockConfig,
	UriInstance,
	window as vscodeWindow,
} from './helpers/vscodeMock.js';

class FakeSecrets {
	private map = new Map<string, string>();
	private listeners: Array<(e: { key: string }) => void> = [];
	async get(key: string): Promise<string | undefined> {
		return this.map.get(key);
	}
	async store(key: string, value: string): Promise<void> {
		this.map.set(key, value);
		this.listeners.forEach((l) => l({ key }));
	}
	async delete(key: string): Promise<void> {
		this.map.delete(key);
		this.listeners.forEach((l) => l({ key }));
	}
	onDidChange(listener: (e: { key: string }) => void): { dispose: () => void } {
		this.listeners.push(listener);
		return { dispose: () => {
			const idx = this.listeners.indexOf(listener);
			if (idx >= 0) this.listeners.splice(idx, 1);
		} };
	}
}

class FakeGlobalState {
	private state = new Map<string, unknown>();
	get<T>(key: string): T | undefined {
		return this.state.get(key) as T | undefined;
	}
	update(key: string, value: unknown): Thenable<void> {
		this.state.set(key, value);
		return Promise.resolve();
	}
}

function newContext(): {
	context: {
		extensionUri: UriInstance;
		secrets: FakeSecrets;
		globalState: FakeGlobalState;
		subscriptions: Array<{ dispose: () => void }>;
	};
} {
	const secrets = new FakeSecrets();
	const globalState = new FakeGlobalState();
	const extensionUri = new UriInstance('vscode-userdata', '/ext', '/ext');
	return {
		context: {
			extensionUri,
			secrets,
			globalState,
			subscriptions: [],
		},
	};
}

beforeEach(() => {
	resetMockConfig();
});

// ---- Construction ---------------------------------------------------

test('construction: registers disposables (emitter + workspace + secrets + keyManager listener) into subscriptions', () => {
	const { context } = newContext();
	const provider = new MiniMaxChatProvider(context as never);
	// The constructor pushes 4 disposables (one per event source):
	//  - the onDidChangeLanguageModelChatInformationEmitter
	//  - workspace.onDidChangeConfiguration
	//  - secrets.onDidChange
	//  - keyManager.onDidChange
	assert.ok(context.subscriptions.length >= 4, `expected ≥4 subscriptions, got ${context.subscriptions.length}`);
	assert.equal(provider.dispose(), undefined);
});

// ---- hasApiKey / prepareForDeactivate --------------------------------

test('hasApiKey: returns false when no key is set anywhere', async () => {
	const { context } = newContext();
	const provider = new MiniMaxChatProvider(context as never);
	assert.equal(await provider.hasApiKey(), false);
});

test('hasApiKey: returns true after the legacy single-key slot is populated', async () => {
	const { context } = newContext();
	const provider = new MiniMaxChatProvider(context as never);
	await provider.clearApiKey(); // ensure clean state
	await context.secrets.store('minimax-vscode.apiKey', 'sk-test-1234');
	assert.equal(await provider.hasApiKey(), true);
});

test('refreshModelPicker: fires the change event', () => {
	const { context } = newContext();
	const provider = new MiniMaxChatProvider(context as never);
	let fired = 0;
	provider.onDidChangeLanguageModelChatInformation(() => {
		fired += 1;
	});
	provider.refreshModelPicker();
	assert.equal(fired, 1);
});

test('prepareForDeactivate: flips isActive so subsequent model-info returns []', async () => {
	const { context } = newContext();
	const provider = new MiniMaxChatProvider(context as never);
	await provider.prepareForDeactivate();
	const infos = await provider.provideLanguageModelChatInformation(
		{} as never,
		{} as never,
	);
	assert.deepEqual(infos, []);
});

test('dispose: is idempotent', () => {
	const { context } = newContext();
	const provider = new MiniMaxChatProvider(context as never);
	provider.dispose();
	provider.dispose(); // no throw
});

// ---- provideLanguageModelChatInformation ---------------------------

test('provideLanguageModelChatInformation: returns one entry per visible model when active', async () => {
	const { context } = newContext();
	const provider = new MiniMaxChatProvider(context as never);
	mockConfig['minimax.visibleModels'] = ['MiniMax-M3', 'MiniMax-M2.7'];
	// M3 + M2.7 are both registered; provider should emit both
	// when there's an active key.
	await context.secrets.store('minimax-vscode.apiKey', 'sk-test');
	const infos = await provider.provideLanguageModelChatInformation(
		{} as never,
		{} as never,
	);
	assert.ok(Array.isArray(infos));
	assert.ok(infos.length >= 2);
	const ids = infos.map((i) => i.id);
	assert.ok(ids.includes('MiniMax-M3'));
	assert.ok(ids.includes('MiniMax-M2.7'));
});

test('provideLanguageModelChatInformation: honours visibleModels setting (drops others)', async () => {
	const { context } = newContext();
	const provider = new MiniMaxChatProvider(context as never);
	// Hide M2.7.
	mockConfig['minimax.visibleModels'] = ['MiniMax-M3'];
	await context.secrets.store('minimax-vscode.apiKey', 'sk-test');
	const infos = await provider.provideLanguageModelChatInformation(
		{} as never,
		{} as never,
	);
	assert.ok(infos.every((i) => i.id === 'MiniMax-M3'));
});

// ---- clearApiKey -----------------------------------------------------

test('clearApiKey: with an empty pool, falls back to clearing the legacy single-key slot', async () => {
	const { context } = newContext();
	const provider = new MiniMaxChatProvider(context as never);
	await context.secrets.store('minimax-vscode.apiKey', 'sk-legacy');
	assert.equal(await context.secrets.get('minimax-vscode.apiKey'), 'sk-legacy');
	await provider.clearApiKey();
	assert.equal(await context.secrets.get('minimax-vscode.apiKey'), undefined);
});
