// Tests for ClaudeCodeBridge (src/claudeCode/bridge.ts): what it sets on the
// extension host's `process.env` as routing is turned on / off, when the
// window shuts down, and when several windows share (or must not share)
// one proxy port; and how it cleans up the `claudeCode.environmentVariables`
// entries older builds wrote. Each bridge plays one VS Code window;
// `mockConfig` plays the settings and FakeGlobalState the extension's memento
// (one per person: it lives on the VS Code client).

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import * as net from 'node:net';
import * as vscode from 'vscode';

import { ClaudeCodeBridge } from '../src/claudeCode/bridge';
import { MANAGED_ENV_NAMES } from '../src/claudeCode/env';
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
const USER_ENV = [{ name: 'FOO', value: '1' }];

let port: number;
/** Every bridge a test creates; shut down afterwards so a failed assertion
 *  cannot leave a proxy listening and hang the run. */
const bridges: ClaudeCodeBridge[] = [];
const extensions = vscode.extensions as unknown as { getExtension: (id: string) => unknown };
const originalGetExtension = extensions.getExtension;
let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
	mockState.reset();
	port = await freePort();
	mockConfig['minimax.claudeCode.routing.port'] = port;
	mockConfig[ENV] = structuredClone(USER_ENV);
	extensions.getExtension = (id: string) => (id === 'anthropic.claude-code' ? {} : undefined);
	savedEnv = {};
	for (const name of MANAGED_ENV_NAMES) {
		savedEnv[name] = process.env[name];
		delete process.env[name];
	}
});

afterEach(async () => {
	extensions.getExtension = originalGetExtension;
	await Promise.all(bridges.splice(0).map((b) => b.shutdown()));
	for (const name of MANAGED_ENV_NAMES) {
		if (savedEnv[name] === undefined) {
			delete process.env[name];
		} else {
			process.env[name] = savedEnv[name];
		}
	}
});

function enable(on: boolean): void {
	mockConfig['minimax.claudeCode.routing.enabled'] = on;
}

function managedEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const name of MANAGED_ENV_NAMES) {
		if (process.env[name] !== undefined) {
			env[name] = process.env[name]!;
		}
	}
	return env;
}

function post(url: string, body: unknown): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = http.request(url, { method: 'POST' }, (res) => {
			const chunks: Buffer[] = [];
			res.on('data', (c: Buffer) => chunks.push(c));
			res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
		});
		req.on('error', reject);
		req.end(JSON.stringify(body));
	});
}

describe('ClaudeCodeBridge env handling', () => {
	it('is opt-in: with routing off it sets nothing and starts no proxy', async () => {
		const { bridge, collection } = newWindow(new FakeGlobalState());
		await bridge.refresh();
		assert.deepEqual(mockConfig[ENV], USER_ENV);
		assert.deepEqual(managedEnv(), {});
		assert.equal(bridge.currentState.kind, 'off');
		assert.equal(collection.vars.size, 0);
		assert.equal(collection.persistent, false);
		assert.equal(await isListening(port), false);
	});

	it('sets nothing when routing is on but there is no API key', async () => {
		enable(true);
		const { bridge } = newWindow(new FakeGlobalState(), null);
		await bridge.refresh();
		assert.deepEqual(managedEnv(), {});
		assert.deepEqual(bridge.currentState, { kind: 'off', reason: 'noKey' });
	});

	it('routes through this process env only, behind a secret, and restores it when turned off', async () => {
		process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'claude-opus-custom';
		enable(true);
		const { bridge, collection } = newWindow(new FakeGlobalState());
		await bridge.refresh();
		assert.deepEqual(bridge.currentState, { kind: 'owner', port });

		const env = managedEnv();
		assert.match(env.ANTHROPIC_BASE_URL, new RegExp(`^http://127\\.0\\.0\\.1:${port}/[\\w-]{32}$`));
		assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'MiniMax-M3');
		assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'claude-opus-custom', 'unrouted tiers are left alone');
		assert.equal(collection.vars.get('ANTHROPIC_BASE_URL')?.value, env.ANTHROPIC_BASE_URL);
		assert.deepEqual(mockConfig[ENV], USER_ENV, 'the shared setting is never written');
		assert.equal(mockState.informationMessages.length, 1);

		enable(false);
		await bridge.refresh();
		assert.deepEqual(managedEnv(), { ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-custom' });
		assert.equal(collection.vars.size, 0);
		assert.equal(mockState.informationMessages.length, 2);
	});

	it('refuses requests without the secret, e.g. from someone else on a shared server', async () => {
		enable(true);
		const { bridge } = newWindow(new FakeGlobalState());
		await bridge.refresh();
		const refused = await post(`http://127.0.0.1:${port}/v1/messages`, { model: 'MiniMax-M3' });
		assert.equal(refused.status, 403);
		assert.equal(JSON.parse(refused.body).error.type, 'permission_error');
	});

	it('forwards non-MiniMax traffic to the base URL the process inherited', async () => {
		const seen: string[] = [];
		const gateway = http.createServer((req, res) => {
			seen.push(req.url ?? '');
			res.end('ok');
		});
		await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
		process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(gateway.address() as net.AddressInfo).port}/prefix`;
		enable(true);
		const { bridge } = newWindow(new FakeGlobalState());
		try {
			await bridge.refresh();
			const res = await post(`${process.env.ANTHROPIC_BASE_URL}/v1/messages`, { model: 'claude-sonnet-x' });
			assert.equal(res.status, 200);
			assert.deepEqual(seen, ['/prefix/v1/messages']);
		} finally {
			gateway.close();
		}
	});

	it('removes entries older builds wrote to the setting, restoring recorded originals', async () => {
		const state = new FakeGlobalState();
		await state.update('minimax-vscode.claudeCodeEnvOwnership', {
			ANTHROPIC_BASE_URL: { original: 'https://gateway.example', injected: `http://127.0.0.1:${port}` },
			ANTHROPIC_DEFAULT_HAIKU_MODEL: { injected: 'MiniMax-M3' },
		});
		mockConfig[ENV] = [
			{ name: 'FOO', value: '1' },
			{ name: 'ANTHROPIC_BASE_URL', value: `http://127.0.0.1:${port}` },
			{ name: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', value: 'MiniMax-M3' },
		];
		const { bridge } = newWindow(state);
		await bridge.refresh();
		assert.deepEqual(mockConfig[ENV], [
			{ name: 'FOO', value: '1' },
			{ name: 'ANTHROPIC_BASE_URL', value: 'https://gateway.example' },
		]);
		assert.equal(state.get('minimax-vscode.claudeCodeEnvOwnership'), undefined);
	});

	it('removes unrecorded entries pointing at the proxy, e.g. in another person\'s window', async () => {
		mockConfig[ENV] = [
			{ name: 'ANTHROPIC_BASE_URL', value: `http://127.0.0.1:${port}` },
			{ name: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', value: 'MiniMax-M3' },
		];
		const { bridge } = newWindow(new FakeGlobalState());
		await bridge.refresh();
		assert.equal(ENV in mockConfig, false);
	});

	it('warns once when the setting overrides a routed variable', async () => {
		mockConfig[ENV] = [{ name: 'ANTHROPIC_BASE_URL', value: 'https://gateway.example' }];
		enable(true);
		const { bridge } = newWindow(new FakeGlobalState());
		await bridge.refresh();
		await bridge.refresh();
		assert.equal(mockState.warningMessages.length, 1);
		assert.match(mockState.warningMessages[0], /ANTHROPIC_BASE_URL/);
		assert.deepEqual(mockConfig[ENV], [{ name: 'ANTHROPIC_BASE_URL', value: 'https://gateway.example' }]);
	});
});

describe('ClaudeCodeBridge lifecycle', () => {
	it('releases the env on shutdown and re-injects silently on the next activation', async () => {
		enable(true);
		const state = new FakeGlobalState();
		const first = newWindow(state);
		await first.bridge.refresh();
		const routed = managedEnv();
		assert.equal(mockState.informationMessages.length, 1);

		await first.bridge.shutdown();
		assert.deepEqual(managedEnv(), {}, 'no dead localhost URL left behind');
		assert.equal(await isListening(port), false);

		const next = newWindow(state);
		await next.bridge.refresh();
		assert.deepEqual(managedEnv(), routed, 'same secret across windows of one person');
		assert.equal(mockState.informationMessages.length, 1, 'same env is not announced twice');
	});

	it('shares the proxy with a window of the same person, which leaves it running on shutdown', async () => {
		enable(true);
		const state = new FakeGlobalState();
		const owner = newWindow(state);
		const standby = newWindow(state);
		await owner.bridge.refresh();
		await standby.bridge.refresh();
		assert.deepEqual(standby.bridge.currentState, { kind: 'shared', port });

		await standby.bridge.shutdown();
		assert.equal(await isListening(port), true, 'the owner is still serving');
		await owner.bridge.shutdown();
		assert.equal(await isListening(port), false);
	});

	it('refuses a proxy started by someone else (another secret)', async () => {
		enable(true);
		const other = newWindow(new FakeGlobalState());
		const self = newWindow(new FakeGlobalState());
		await other.bridge.refresh();
		await self.bridge.refresh();
		assert.equal(self.bridge.currentState.kind, 'error');
		assert.match((self.bridge.currentState as { message: string }).message, /another MiniMax routing proxy/);
		assert.equal(self.collection.vars.size, 0, 'terminals are not pointed at the foreign proxy');
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
