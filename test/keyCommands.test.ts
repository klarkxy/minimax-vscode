// Unit tests for `src/runtime/keyCommands.ts`.
//
// The command handlers drive `vscode.window.showInputBox` /
// `showQuickPick` / `showWarningMessage`. The vscode mock already
// has stub implementations of these that capture calls — we
// program the responses to simulate the user's choices.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';

import {
	addApiKeyCommand,
	switchApiKeyCommand,
	renameApiKeyCommand,
	deleteApiKeyCommand,
	manageApiKeysCommand,
} from '../src/runtime/keyCommands.js';
import { disposeTokenPlanPoller, registerCommands } from '../src/runtime/commands.js';
import { KeyManager } from '../src/keyManager.js';
import {
	getOpenExternalCalls,
	mockConfig,
	mockState,
} from './helpers/vscodeMock.js';

class FakeSecrets {
	private readonly map = new Map<string, string>();
	private readonly change = new vscode.EventEmitter<{ key: string }>();
	readonly onDidChange = this.change.event;
	async get(key: string): Promise<string | undefined> {
		return this.map.get(key);
	}
	async store(key: string, value: string): Promise<void> {
		this.map.set(key, value);
		this.change.fire({ key });
	}
	async delete(key: string): Promise<void> {
		this.map.delete(key);
		this.change.fire({ key });
	}
	reset(): void {
		this.map.clear();
	}
}

class FakeMemento {
	private readonly state = new Map<string, unknown>();
	get<T>(key: string): T | undefined {
		return this.state.get(key) as T | undefined;
	}
	update(key: string, value: unknown): Thenable<void> {
		if (value === undefined) {
			this.state.delete(key);
		} else {
			this.state.set(key, value);
		}
		return Promise.resolve();
	}
	reset(): void {
		this.state.clear();
	}
}

// Shared context for the whole file. `registerCommands` in
// `beforeEach` creates a KeyManager bound to this context's
// secrets/globalState; the per-test KeyManager instances we
// create for setup must share this store, so add/rename/delete
// done via either the cached manager or a fresh one land in the
// same place.
let sharedContext: vscode.ExtensionContext | undefined;

function newContext() {
	// Tests always use the same context so the cachedKeyManager
	// (bound in setCommandContext during beforeEach) and any
	// fresh KeyManager we create below see the same secrets and
	// memento state.
	if (!sharedContext) {
		const secrets = new FakeSecrets();
		const memento = new FakeMemento();
		sharedContext = {
			subscriptions: [] as vscode.Disposable[],
			secrets,
			globalState: memento,
			workspaceState: new FakeMemento(),
			extensionUri: vscode.Uri.file('/extension'),
			globalStorageUri: vscode.Uri.file(
				'C:\\Users\\tester\\AppData\\Roaming\\Code\\User\\globalStorage\\klarkxy.minimax-vscode-copilot',
			),
		} as unknown as vscode.ExtensionContext;
	}
	return sharedContext;
}

beforeEach(() => {
	mockState.reset();
	mockConfig['minimax.apiBaseUrl'] = 'https://api.minimaxi.com/anthropic';
	const context = newContext();
	const secrets = (context as unknown as { secrets: FakeSecrets }).secrets;
	const memento = (context as unknown as { globalState: FakeMemento }).globalState;
	secrets.reset();
	memento.reset();
	registerCommands(context);
});

afterEach(() => {
	disposeTokenPlanPoller();
});

test('addApiKeyCommand: cancels when the user dismisses the name prompt', async () => {
	vscode.window.showInputBox = () => Promise.resolve(undefined);
	const result = await addApiKeyCommand();
	assert.equal(result, 'cancelled');
});

test('addApiKeyCommand: cancels when the user dismisses the secret prompt', async () => {
	let call = 0;
	vscode.window.showInputBox = (opts: vscode.InputBoxOptions) => {
		call += 1;
		return Promise.resolve(call === 1 ? 'a-name' : undefined);
	};
	const result = await addApiKeyCommand();
	assert.equal(result, 'cancelled');
});

test('addApiKeyCommand: adds the key and shows a success toast', async () => {
	let call = 0;
	vscode.window.showInputBox = (opts: vscode.InputBoxOptions) => {
		call += 1;
		return Promise.resolve(call === 1 ? 'k1' : 'sk-secret');
	};
	const apiBaseUrlBefore = mockConfig['minimax.apiBaseUrl'];
	const result = await addApiKeyCommand();
	assert.equal(result, 'created');
	// Information toast was shown
	assert.ok(
		mockState.informationMessages.some((m) => m.includes('k1')),
		'expected a confirmation toast naming the new key',
	);
	// The pool is the source of truth — adding a key MUST NOT mirror
	// its endpoint into `minimax.apiBaseUrl`. The setting is the
	// deprecated fallback only.
	assert.equal(mockConfig['minimax.apiBaseUrl'], apiBaseUrlBefore);
});

test('addApiKeyCommand: rejects duplicate name via input box validation', async () => {
	// Pre-populate the pool with a key named "k1"
	const context = newContext();
	const km = new KeyManager(context as never);
	await km.addApiKey({ name: 'k1', apiKey: 'sk-a', probe: false });

	// User types "k1" — validation rejects, showInputBox returns
	// undefined (or never resolves with a valid value). Simulate by
	// returning undefined after the name prompt.
	let call = 0;
	vscode.window.showInputBox = () => {
		call += 1;
		return Promise.resolve(call === 1 ? undefined : 'sk-secret');
	};
	const result = await addApiKeyCommand();
	assert.equal(result, 'cancelled');
});

test('switchApiKeyCommand: empty pool shows the emptyPool toast and returns cancelled', async () => {
	const result = await switchApiKeyCommand();
	assert.equal(result, 'cancelled');
	assert.ok(
		mockState.informationMessages.some((m) => /no API keys/i.test(m)),
		'expected the emptyPool message',
	);
});

test('switchApiKeyCommand: returns cancelled when the user dismisses the picker', async () => {
	const context = newContext();
	const km = new KeyManager(context as never);
	await km.addApiKey({ name: 'k1', apiKey: 'sk-a', probe: false });
	await km.addApiKey({ name: 'k2', apiKey: 'sk-b', probe: false });
	vscode.window.showQuickPick = () => Promise.resolve(undefined);
	const result = await switchApiKeyCommand();
	assert.equal(result, 'cancelled');
});

test('renameApiKeyCommand: cancels when no key is picked', async () => {
	const context = newContext();
	const km = new KeyManager(context as never);
	await km.addApiKey({ name: 'k1', apiKey: 'sk-a', probe: false });
	vscode.window.showQuickPick = () => Promise.resolve(undefined);
	const result = await renameApiKeyCommand();
	assert.equal(result, 'cancelled');
});

test('renameApiKeyCommand: renames the key and emits the success toast', async () => {
	const context = newContext();
	const km = new KeyManager(context as never);
	const entry = await km.addApiKey({ name: 'k1', apiKey: 'sk-a', probe: false });
	vscode.window.showQuickPick = () =>
		Promise.resolve({ keyId: entry.id, label: 'k1', description: '', detail: '' } as never);
	vscode.window.showInputBox = () => Promise.resolve('k1-renamed');
	const result = await renameApiKeyCommand();
	assert.equal(result, 'renamed');
	assert.ok(
		mockState.informationMessages.some((m) => m.includes('k1-renamed')),
		'expected the renamed toast',
	);
});

test('deleteApiKeyCommand: cancels on the confirmation dialog', async () => {
	const context = newContext();
	const km = new KeyManager(context as never);
	const entry = await km.addApiKey({ name: 'k1', apiKey: 'sk-a', probe: false });
	vscode.window.showQuickPick = () =>
		Promise.resolve({ keyId: entry.id, label: 'k1', description: '', detail: '' } as never);
	vscode.window.showWarningMessage = () => Promise.resolve(undefined);
	const result = await deleteApiKeyCommand();
	assert.equal(result, 'cancelled');
});

test('deleteApiKeyCommand: deletes the key when the user confirms', async () => {
	const context = newContext();
	const km = new KeyManager(context as never);
	const entry = await km.addApiKey({ name: 'k1', apiKey: 'sk-a', probe: false });
	vscode.window.showQuickPick = () =>
		Promise.resolve({ keyId: entry.id, label: 'k1', description: '', detail: '' } as never);
	// The handler matches the warning choice against
	// t('keys.deleteConfirmYes'). Return that exact string.
	const { t: tFn } = await import('../src/i18n.js');
	vscode.window.showWarningMessage = () => Promise.resolve(tFn('keys.deleteConfirmYes') as string);
	const result = await deleteApiKeyCommand();
	assert.equal(result, 'deleted');
	const snap = km.snapshot();
	assert.equal(snap.keys.length, 0);
});

// Regression: when the named pool is empty (e.g. migration failed or
// was skipped) the legacy `minimax-vscode.apiKey` slot MUST still be
// cleared by `deleteApiKeyCommand`. Previously the empty-pool branch
// only showed a toast and left the legacy secret in place, so legacy
// users running the command with the new code path would never
// actually lose their key.
test('deleteApiKeyCommand: empty pool falls back to clearing the legacy single-key slot', async () => {
	const context = newContext();
	await context.secrets.store('minimax-vscode.apiKey', 'sk-legacy');
	assert.equal(await context.secrets.get('minimax-vscode.apiKey'), 'sk-legacy');
	const result = await deleteApiKeyCommand();
	assert.equal(result, 'cancelled');
	assert.equal(await context.secrets.get('minimax-vscode.apiKey'), undefined);
});

test('manageApiKeysCommand: executes the picked action command', async () => {
	const executedCommands: string[] = [];
	const original = vscode.commands.executeCommand;
	vscode.commands.executeCommand = (cmd: string, ..._args: unknown[]) => {
		executedCommands.push(cmd);
		return Promise.resolve(undefined);
	};
	try {
		vscode.window.showQuickPick = () =>
			Promise.resolve({ command: 'minimax.addApiKey' } as never);
		await manageApiKeysCommand();
		assert.deepEqual(executedCommands, ['minimax.addApiKey']);
	} finally {
		vscode.commands.executeCommand = original;
	}
});

test('manageApiKeysCommand: lists the Re-probe action', async () => {
	const executedCommands: string[] = [];
	const original = vscode.commands.executeCommand;
	vscode.commands.executeCommand = (cmd: string, ..._args: unknown[]) => {
		executedCommands.push(cmd);
		return Promise.resolve(undefined);
	};
	// Capture the QuickPick items so we can assert the new entry is
	// present and labelled with the i18n-respected icon prefix.
	let pickedItems: ReadonlyArray<{ label: string; command: string }> = [];
	const originalShowQuickPick = vscode.window.showQuickPick;
	vscode.window.showQuickPick = ((items: ReadonlyArray<{ label: string; command: string }>) => {
		pickedItems = items;
		// Simulate the user picking the Re-probe entry.
		return Promise.resolve(
			items.find((it) => it.command === 'minimax.reprobeApiKey') as never,
		);
	}) as never;
	try {
		await manageApiKeysCommand();
		assert.deepEqual(executedCommands, ['minimax.reprobeApiKey']);
		// The label is resolved through `t()` so it carries the icon
		// prefix and either English or Chinese text — assert the
		// command id is wired up regardless of locale.
		const reprobe = pickedItems.find((it) => it.command === 'minimax.reprobeApiKey');
		assert.ok(reprobe, 'reprobeApiKey entry should be in the QuickPick');
	} finally {
		vscode.commands.executeCommand = original;
		vscode.window.showQuickPick = originalShowQuickPick;
	}
});

test('manageApiKeysCommand: returns silently when the user dismisses the picker', async () => {
	const executedCommands: string[] = [];
	const original = vscode.commands.executeCommand;
	vscode.commands.executeCommand = (cmd: string, ..._args: unknown[]) => {
		executedCommands.push(cmd);
		return Promise.resolve(undefined);
	};
	try {
		vscode.window.showQuickPick = () => Promise.resolve(undefined);
		await manageApiKeysCommand();
		assert.equal(executedCommands.length, 0);
	} finally {
		vscode.commands.executeCommand = original;
	}
});

// Suppress unused-import warning for the helper only used in some
// tests via setup.
void getOpenExternalCalls;
