import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
	getOpenExternalCalls,
	getRegisteredCommand,
	mockConfig,
	mockState,
} from './helpers/vscodeMock.js';
import { registerCommands } from '../src/runtime/commands.js';

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
}

function newContext() {
	const globalState = new FakeMemento();
	return {
		subscriptions: [] as vscode.Disposable[],
		secrets: new FakeSecrets(),
		globalState,
		workspaceState: new FakeMemento(),
		extensionUri: vscode.Uri.file('/extension'),
		globalStorageUri: vscode.Uri.file(
			'C:\\Users\\tester\\AppData\\Roaming\\Code\\User\\globalStorage\\klarkxy.minimax-vscode-copilot',
		),
	} as unknown as vscode.ExtensionContext;
}

beforeEach(() => {
	for (const panel of mockState.webviewPanels.slice()) {
		panel.dispose();
	}
	mockState.reset();
	mockConfig['minimax.apiBaseUrl'] = 'https://api.minimaxi.com/anthropic';
});

test('registerCommands wires the command context and creates the plan status bar', () => {
	const context = newContext();

	registerCommands(context);

	assert.equal(
		mockState.statusBarItems.length,
		2,
		'setCommandContext should create the 5h and weekly plan status-bar items',
	);
	assert.deepEqual(
		mockState.statusBarItems.map((item) => item.command),
		['minimax.openDashboard', 'minimax.openDashboard'],
	);
	assert.ok(
		getRegisteredCommand('minimax.openDashboard'),
		'registerCommands should expose the dashboard command',
	);
	assert.ok(
		context.subscriptions.length >= 2,
		'registerCommands should attach command/status-bar disposables to the extension context',
	);
});

test('registered reprobeApiKey command runs against the active key (no-op when no key)', async () => {
	const context = newContext();
	registerCommands(context);

	const command = getRegisteredCommand('minimax.reprobeApiKey');
	assert.ok(command, 'reprobeApiKey command should be registered');
	// No active key → the no-active toast. No apiBaseUrl write.
	const before = mockConfig['minimax.apiBaseUrl'];
	await command();
	assert.equal(mockConfig['minimax.apiBaseUrl'], before, 'reprobe must not write apiBaseUrl');
	assert.ok(
		mockState.informationMessages.some((m) => /no active api key/i.test(m)),
		'expected the no-active-key toast',
	);
});

test('registered openRequestDumpsFolder command uses globalStorageUri and opens a file URI', async () => {
	const context = newContext();
	registerCommands(context);

	const command = getRegisteredCommand('minimax.openRequestDumpsFolder');
	assert.ok(command, 'openRequestDumpsFolder command should be registered');
	await command();
	await new Promise((resolve) => setImmediate(resolve));

	const calls = getOpenExternalCalls();
	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.scheme, 'file');
	assert.match(calls[0]!.uri.fsPath.replace(/\\/g, '/'), /request-dumps$/);
});

test('registered openDashboard command creates a webview panel through the VS Code surface', async () => {
	const context = newContext();
	registerCommands(context);

	const command = getRegisteredCommand('minimax.openDashboard');
	assert.ok(command, 'openDashboard command should be registered');
	await command();
	await new Promise((resolve) => setImmediate(resolve));

	assert.equal(mockState.webviewPanels.length, 1);
	const panel = mockState.webviewPanels[0]!;
	assert.equal(panel.viewType, 'minimax.dashboard');
	assert.equal(panel.title, 'MiniMax Dashboard');
	assert.match(panel.webview.html, /MiniMax Usage Dashboard/);
	assert.ok(
		panel.webview.postedMessages.some(
			(message) => !!message && typeof message === 'object' && (message as { type?: string }).type === 'data',
		),
		'dashboard refresh should post at least one data payload to the webview',
	);
	panel.dispose();
	await new Promise((resolve) => setImmediate(resolve));
});
