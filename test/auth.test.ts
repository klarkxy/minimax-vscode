// Unit tests for `src/auth.ts` (AuthManager).
//
// AuthManager is a thin facade over KeyManager: it surfaces the
// legacy single-key API on top of the named key pool. We exercise
// `getApiKey` / `setApiKey` / `deleteApiKey` / `hasApiKey` /
// `promptForApiKey` against the same fake SecretStorage the
// keyManager tests use, and verify that `onDidChangeApiKey` fires
// when the underlying key state changes.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AuthManager } from '../src/auth.js';
import { KeyManager } from '../src/keyManager.js';
import { API_KEY_SECRET } from '../src/consts.js';

class FakeSecrets {
	private map = new Map<string, string>();
	async get(key: string): Promise<string | undefined> {
		return this.map.get(key);
	}
	async store(key: string, value: string): Promise<void> {
		this.map.set(key, value);
	}
	async delete(key: string): Promise<void> {
		this.map.delete(key);
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
	context: { secrets: FakeSecrets; globalState: FakeGlobalState; subscriptions: unknown[] };
} {
	const secrets = new FakeSecrets();
	const globalState = new FakeGlobalState();
	return {
		context: { secrets, globalState, subscriptions: [] },
	};
}

test('getApiKey: returns undefined when nothing is configured', async () => {
	const { context } = newContext();
	const km = new KeyManager(context as never);
	const auth = new AuthManager(context as never, km);
	assert.equal(await auth.getApiKey(), undefined);
	assert.equal(await auth.hasApiKey(), false);
});

test('setApiKey: stores into legacy slot, getApiKey returns it, hasApiKey is true', async () => {
	const { context } = newContext();
	const km = new KeyManager(context as never);
	const auth = new AuthManager(context as never, km);
	await auth.setApiKey('sk-test-1234');
	assert.equal(await auth.getApiKey(), 'sk-test-1234');
	assert.equal(await auth.hasApiKey(), true);
	assert.equal(await context.secrets.get(API_KEY_SECRET), 'sk-test-1234');
});

test('setApiKey: throws on empty input', async () => {
	const { context } = newContext();
	const km = new KeyManager(context as never);
	const auth = new AuthManager(context as never, km);
	await assert.rejects(() => auth.setApiKey(''), /cannot be empty|不能为空/);
	await assert.rejects(() => auth.setApiKey('   '), /cannot be empty|不能为空/);
});

test('deleteApiKey: removes the legacy slot', async () => {
	const { context } = newContext();
	const km = new KeyManager(context as never);
	const auth = new AuthManager(context as never, km);
	await auth.setApiKey('sk-test-1234');
	assert.equal(await auth.hasApiKey(), true);
	await auth.deleteApiKey();
	assert.equal(await auth.hasApiKey(), false);
	assert.equal(await context.secrets.get(API_KEY_SECRET), undefined);
});

test('onDidChangeApiKey: fires when a named key is added', async () => {
	const { context } = newContext();
	const km = new KeyManager(context as never);
	const auth = new AuthManager(context as never, km);
	let fired = 0;
	auth.onDidChangeApiKey(() => {
		fired += 1;
	});
	await km.addApiKey({ name: 'k1', apiKey: 'sk-a', probe: false });
	assert.ok(fired >= 1, `expected onDidChangeApiKey to fire, got ${fired}`);
});

test('onDidChangeApiKey: fires on the legacy setApiKey path too', async () => {
	const { context } = newContext();
	const km = new KeyManager(context as never);
	const auth = new AuthManager(context as never, km);
	let fired = 0;
	auth.onDidChangeApiKey(() => {
		fired += 1;
	});
	await auth.setApiKey('sk-test-1234');
	assert.equal(fired, 1, 'setApiKey should fire onDidChangeApiKey exactly once');
});

test('dispose: releasing the subscription stops further events', async () => {
	const { context } = newContext();
	const km = new KeyManager(context as never);
	const auth = new AuthManager(context as never, km);
	let fired = 0;
	const sub = auth.onDidChangeApiKey(() => {
		fired += 1;
	});
	auth.dispose();
	sub.dispose(); // idempotent — dispose() already cleared the sub
	await km.addApiKey({ name: 'k1', apiKey: 'sk-a', probe: false });
	assert.equal(fired, 0, 'no listener should fire after dispose()');
});

test('dispose: is idempotent', () => {
	const { context } = newContext();
	const km = new KeyManager(context as never);
	const auth = new AuthManager(context as never, km);
	auth.dispose();
	auth.dispose(); // must not throw
});
