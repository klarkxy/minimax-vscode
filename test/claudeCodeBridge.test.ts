// Tests for ClaudeCodeBridge (src/claudeCode/bridge.ts): what it writes to
// `claudeCode.environmentVariables` as routing is turned on / off, when the
// window shuts down, and when several windows share (or must not share)
// one proxy port. Each bridge plays one VS Code window; `mockConfig` plays
// the user's settings.json and FakeGlobalState the extension's memento.

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import * as net from 'node:net';
import * as vscode from 'vscode';

import { ClaudeCodeBridge } from '../src/claudeCode/bridge';
import { mockConfig, mockState } from './helpers/vscodeMock';

class FakeGlobalState {
	private state = new Map<string, unknown>();
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

function fakeCollection() {
	const vars = new Map<string, { value: string }>();
	return {
		persistent: true,
		description: undefined as unknown,
		get: (name: string) => vars.get(name),
		replace: (name: string, value: string) => void vars.set(name, { value }),
		delete: (name: string) => void vars.delete(name),
		vars,
	};
}

function newWindow(globalState: FakeGlobalState, apiKey: string | null = 'mm-key') {
	const collection = fakeCollection();
	const context = { globalState, environmentVariableCollection: collection, subscriptions: [] };
	const keyManager = {
		getActiveApiKey: async () => apiKey ?? undefined,
		getActiveApiBaseUrl: async () => 'http://127.0.0.1:1/anthropic',
		onDidChange: () => new vscode.Disposable(() => {}),
	};
	const bridge = new ClaudeCodeBridge(context as never, keyManager as never);
	bridges.push(bridge);
	return { bridge, collection };
}

function freePort(): Promise<number> {
	return new Promise((resolve) => {
		const server = net.createServer();
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address() as net.AddressInfo;
			server.close(() => resolve(port));
		});
	});
}

const ENV = 'claudeCode.environmentVariables';
const USER_ENV = [
	{ name: 'FOO', value: '1' },
	{ name: 'ANTHROPIC_BASE_URL', value: 'https://gateway.example' },
	{ name: 'ANTHROPIC_DEFAULT_OPUS_MODEL', value: 'claude-opus-custom' },
];

let port: number;
/** Every bridge a test creates; shut down afterwards so a failed assertion
 *  cannot leave a proxy listening and hang the run. */
const bridges: ClaudeCodeBridge[] = [];
const extensions = vscode.extensions as unknown as { getExtension: (id: string) => unknown };
const originalGetExtension = extensions.getExtension;

beforeEach(async () => {
	mockState.reset();
	port = await freePort();
	mockConfig['minimax.claudeCode.routing.port'] = port;
	mockConfig[ENV] = structuredClone(USER_ENV);
	extensions.getExtension = (id: string) => (id === 'anthropic.claude-code' ? {} : undefined);
});

afterEach(async () => {
	extensions.getExtension = originalGetExtension;
	await Promise.all(bridges.splice(0).map((b) => b.shutdown()));
});

function enable(on: boolean): void {
	mockConfig['minimax.claudeCode.routing.enabled'] = on;
}

const routedEnv = () => [
	{ name: 'FOO', value: '1' },
	{ name: 'ANTHROPIC_BASE_URL', value: `http://127.0.0.1:${port}` },
	{ name: 'ANTHROPIC_DEFAULT_OPUS_MODEL', value: 'claude-opus-custom' },
	{ name: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', value: 'MiniMax-M3' },
];

describe('ClaudeCodeBridge settings handling', () => {
	it('is opt-in: with routing off it neither writes settings nor starts a proxy', async () => {
		const { bridge, collection } = newWindow(new FakeGlobalState());
		await bridge.refresh();
		assert.deepEqual(mockConfig[ENV], USER_ENV);
		assert.equal(bridge.currentState.kind, 'off');
		assert.equal(collection.vars.size, 0);
		assert.equal(collection.persistent, false);
		await bridge.shutdown();
	});

	it('leaves the user env alone when routing is on but there is no API key', async () => {
		enable(true);
		const { bridge } = newWindow(new FakeGlobalState(), null);
		await bridge.refresh();
		assert.deepEqual(mockConfig[ENV], USER_ENV);
		assert.deepEqual(bridge.currentState, { kind: 'off', reason: 'noKey' });
		await bridge.shutdown();
	});

	it('injects only routed variables and restores the previous values when turned off', async () => {
		enable(true);
		const { bridge, collection } = newWindow(new FakeGlobalState());
		await bridge.refresh();
		assert.deepEqual(bridge.currentState, { kind: 'owner', port });
		assert.deepEqual(mockConfig[ENV], routedEnv());
		assert.equal(collection.vars.get('ANTHROPIC_BASE_URL')?.value, `http://127.0.0.1:${port}`);
		assert.equal(mockState.informationMessages.length, 1);

		enable(false);
		await bridge.refresh();
		assert.deepEqual(mockConfig[ENV], USER_ENV);
		assert.equal(collection.vars.size, 0);
		await bridge.shutdown();
	});

	it('removes the setting entirely when the user had none', async () => {
		delete mockConfig[ENV];
		enable(true);
		const { bridge } = newWindow(new FakeGlobalState());
		await bridge.refresh();
		enable(false);
		await bridge.refresh();
		assert.equal(ENV in mockConfig, false);
		await bridge.shutdown();
	});

	it('cleans up entries written by builds that did not record ownership', async () => {
		mockConfig[ENV] = [
			{ name: 'ANTHROPIC_BASE_URL', value: `http://127.0.0.1:${port}` },
			{ name: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', value: 'MiniMax-M3' },
		];
		const { bridge } = newWindow(new FakeGlobalState());
		await bridge.refresh();
		assert.equal(ENV in mockConfig, false);
		await bridge.shutdown();
	});

	it('forwards non-MiniMax traffic to the base URL it replaced', async () => {
		const seen: string[] = [];
		const gateway = http.createServer((req, res) => {
			seen.push(req.url ?? '');
			res.end('ok');
		});
		await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
		const gatewayUrl = `http://127.0.0.1:${(gateway.address() as net.AddressInfo).port}/prefix`;
		mockConfig[ENV] = [{ name: 'ANTHROPIC_BASE_URL', value: gatewayUrl }];
		enable(true);
		const { bridge } = newWindow(new FakeGlobalState());
		try {
			await bridge.refresh();
			const status = await new Promise<number>((resolve, reject) => {
				const req = http.request(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST' }, (res) => {
					res.resume();
					resolve(res.statusCode ?? 0);
				});
				req.on('error', reject);
				req.end(JSON.stringify({ model: 'claude-sonnet-x' }));
			});
			assert.equal(status, 200);
			assert.deepEqual(seen, ['/prefix/v1/messages']);
		} finally {
			await bridge.shutdown();
			gateway.close();
		}
	});
});

describe('ClaudeCodeBridge lifecycle', () => {
	it('releases the env on shutdown and re-injects silently on the next activation', async () => {
		enable(true);
		const state = new FakeGlobalState();
		const first = newWindow(state);
		await first.bridge.refresh();
		assert.equal(mockState.informationMessages.length, 1);

		await first.bridge.shutdown();
		assert.deepEqual(mockConfig[ENV], USER_ENV, 'no dead localhost URL left behind');
		assert.equal(await isListening(port), false);

		const next = newWindow(state);
		await next.bridge.refresh();
		assert.deepEqual(mockConfig[ENV], routedEnv());
		assert.equal(mockState.informationMessages.length, 1, 'same env is not announced twice');
		await next.bridge.shutdown();
		assert.deepEqual(mockConfig[ENV], USER_ENV);
	});

	it('shares the proxy with a window of the same scope, which does not release on shutdown', async () => {
		enable(true);
		const state = new FakeGlobalState();
		const owner = newWindow(state);
		const standby = newWindow(state);
		await owner.bridge.refresh();
		await standby.bridge.refresh();
		assert.deepEqual(standby.bridge.currentState, { kind: 'shared', port });

		await standby.bridge.shutdown();
		assert.deepEqual(mockConfig[ENV], routedEnv(), 'the owner is still serving');
		assert.equal(await isListening(port), true);
		await owner.bridge.shutdown();
		assert.deepEqual(mockConfig[ENV], USER_ENV);
	});

	it('refuses a proxy that serves another key pool / settings store', async () => {
		enable(true);
		const other = newWindow(new FakeGlobalState());
		await other.bridge.refresh();

		// This window has its own memento (another install / profile) and
		// its own settings, modelled here by not touching settings.json.
		extensions.getExtension = () => undefined;
		const self = newWindow(new FakeGlobalState());
		await self.bridge.refresh();
		assert.equal(self.bridge.currentState.kind, 'error');
		assert.match((self.bridge.currentState as { message: string }).message, /another MiniMax routing proxy/);
		assert.equal(self.collection.vars.size, 0, 'terminals are not pointed at the foreign proxy');

		await self.bridge.shutdown();
		await other.bridge.shutdown();
	});
});

function isListening(target: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.connect(target, '127.0.0.1');
		socket.once('connect', () => {
			socket.destroy();
			resolve(true);
		});
		socket.once('error', () => resolve(false));
	});
}
