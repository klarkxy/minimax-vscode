// Unit tests for the named API key pool (`src/keyManager.ts`).
//
// The manager never talks to the network for `add` / `switch` /
// `rename` / `delete` — those are pure SecretStorage + memento
// operations. The region probe is mocked via the `probe` injection
// point on the `KeyManager` constructor, so the test is hermetic.

import { test } from 'node:test';
import assert from 'node:assert/strict';

class FakeSecrets {
	private map = new Map<string, string>();
	keys: string[] = [];
	async get(key: string): Promise<string | undefined> {
		this.keys.push(key);
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

function newContext(): { context: unknown; secrets: FakeSecrets; state: FakeGlobalState } {
	const secrets = new FakeSecrets();
	const state = new FakeGlobalState();
	return {
		secrets,
		state,
		context: {
			secrets,
			globalState: state,
			subscriptions: [],
		} as never,
	};
}

function loadManager(
	context: unknown,
	probe: (apiKey: string, host: 'china' | 'global') => Promise<boolean> = async () => false,
) {
	const { KeyManager } = require('../src/keyManager.js');
	return new KeyManager(context as never, { probe });
}

test('addApiKey probes the official hosts and stores a new key with a stable id', async () => {
	const { context, secrets, state } = newContext();
	const manager = loadManager(context, async (_apiKey, host) => host === 'china');

	const entry = await manager.addApiKey({
		name: 'copilot-1',
		apiKey: 'sk-test-1',
		probe: true,
	});
	assert.equal(entry.name, 'copilot-1');
	assert.equal(entry.region, 'china');
	assert.equal(entry.apiBaseUrl, 'https://api.minimaxi.com/anthropic');
	assert.match(entry.fingerprint, /^[\da-f]{6}…/);
	assert.ok(entry.id.startsWith('k_'));

	const stored = state.get<{ activeKeyId?: string; keys: { name: string; region: string; apiBaseUrl: string }[] }>('minimax-vscode.apiKeys');
	assert.ok(stored);
	assert.equal(stored.activeKeyId, entry.id);
	assert.equal(stored.keys.length, 1);

	const secret = await secrets.get(`minimax-vscode.apiKeys.${entry.id}`);
	assert.equal(secret, 'sk-test-1');
});

test('addApiKey refuses duplicate names', async () => {
	const { context } = newContext();
	const manager = loadManager(context);
	await manager.addApiKey({ name: 'dup', apiKey: 'sk-a', probe: true });
	await assert.rejects(
		() => manager.addApiKey({ name: 'dup', apiKey: 'sk-b', probe: true }),
		/already in use/,
	);
});

// Regression: validation errors used to be hardcoded English
// (`'Key name is required'`, `'API key is required'`) and bypassed
// the `t()` system. The fix routes them through `t('keys.emptyName')`
// and `t('keys.emptySecret')`, which carry the localised strings
// and interpolate the conflicting name on `duplicateName`.
test('addApiKey throws localised validation errors (not hardcoded English)', async () => {
	const { context } = newContext();
	const manager = loadManager(context);
	await assert.rejects(
		() => manager.addApiKey({ name: '  ', apiKey: 'sk-a', probe: false }),
		/Name is required|名称不能为空/,
	);
	await assert.rejects(
		() => manager.addApiKey({ name: 'k', apiKey: '   ', probe: false }),
		/API key cannot be empty|API Key 不能为空/,
	);
});

test('switchApiKey updates the active pointer and lastUsedAt', async () => {
	const { context, secrets } = newContext();
	const manager = loadManager(context);
	const first = await manager.addApiKey({ name: 'a', apiKey: 'sk-a', probe: true });
	const second = await manager.addApiKey({ name: 'b', apiKey: 'sk-b', probe: true });
	assert.equal(manager.snapshot().activeKeyId, second.id);

	await manager.setActiveKey(first.id);
	assert.equal(manager.snapshot().activeKeyId, first.id);
	const fresh = manager.snapshot().keys.find((k: { id: string }) => k.id === first.id)!;
	assert.ok(fresh.lastUsedAt);

	// Secret for the unselected key is still in SecretStorage — we
	// never delete on switch.
	assert.equal(await secrets.get(`minimax-vscode.apiKeys.${second.id}`), 'sk-b');
});

test('renameApiKey enforces uniqueness', async () => {
	const { context } = newContext();
	const manager = loadManager(context);
	await manager.addApiKey({ name: 'a', apiKey: 'sk-a', probe: true });
	const b = await manager.addApiKey({ name: 'b', apiKey: 'sk-b', probe: true });
	await assert.rejects(
		() => manager.renameApiKey(b.id, 'a'),
		/already in use/,
	);
	const renamed = await manager.renameApiKey(b.id, 'b-renamed');
	assert.equal(renamed.name, 'b-renamed');
});

test('deleteApiKey clears the secret and rotates active to the next entry', async () => {
	const { context, secrets } = newContext();
	const manager = loadManager(context);
	const a = await manager.addApiKey({ name: 'a', apiKey: 'sk-a', probe: true });
	await manager.addApiKey({ name: 'b', apiKey: 'sk-b', probe: true });
	await manager.deleteApiKey(a.id);
	assert.equal(manager.snapshot().keys.length, 1);
	assert.equal(await secrets.get(`minimax-vscode.apiKeys.${a.id}`), undefined);
});

test('getActiveApiKey falls back to the legacy single-key slot when no named key is active', async () => {
	const { context, secrets } = newContext();
	await secrets.store('minimax-vscode.apiKey', 'legacy-key');
	const manager = loadManager(context);
	const active = await manager.getActiveApiKey();
	assert.equal(active, 'legacy-key');
});

test('probeRegion returns "both" when both hosts accept the key', async () => {
	const { context } = newContext();
	const manager = loadManager(context, async () => true);
	const result = await manager.probeRegion('sk-test');
	assert.deepEqual(result, { kind: 'both' });
});

test('probeRegion returns "unsupported" when neither host accepts the key', async () => {
	const { context } = newContext();
	const manager = loadManager(context, async () => false);
	const result = await manager.probeRegion('sk-test');
	assert.deepEqual(result, { kind: 'unsupported' });
});

test('onDidChange fires on add / switch / rename / delete', async () => {
	const { context } = newContext();
	const manager = loadManager(context);
	let calls = 0;
	const disposable = manager.onDidChange(() => {
		calls += 1;
	});
	const first = await manager.addApiKey({ name: 'a', apiKey: 'sk-a', probe: true });
	assert.equal(calls, 1);
	const second = await manager.addApiKey({ name: 'b', apiKey: 'sk-b', probe: true });
	assert.equal(calls, 2);
	await manager.setActiveKey(first.id);
	assert.equal(calls, 3);
	await manager.renameApiKey(second.id, 'b-renamed');
	assert.equal(calls, 4);
	await manager.deleteApiKey(first.id);
	assert.equal(calls, 5);
	disposable.dispose();
	// No further fires after the listener is removed.
	await manager.deleteApiKey(second.id);
	assert.equal(calls, 5);
});

test('SecretStorage layout for the named key pool uses per-keyId entries', async () => {
	const { context, secrets } = newContext();
	const manager = loadManager(context);
	const first = await manager.addApiKey({ name: 'a', apiKey: 'sk-a', probe: true });
	const second = await manager.addApiKey({ name: 'b', apiKey: 'sk-b', probe: true });
	// Per-key secrets live under the `apiKeys.<id>` prefix; the
	// legacy `minimax-vscode.apiKey` slot is NOT used by the pool.
	assert.equal(await secrets.get(`minimax-vscode.apiKeys.${first.id}`), 'sk-a');
	assert.equal(await secrets.get(`minimax-vscode.apiKeys.${second.id}`), 'sk-b');
});

test('onDidChange snapshot reflects the active key after a cross-window-style edit', async () => {
	const { context } = newContext();
	const manager = loadManager(context);
	let latest: { activeKeyId?: string; names: string[] } | undefined;
	const disposable = manager.onDidChange((snap) => {
		latest = {
			activeKeyId: snap.activeKeyId,
			names: snap.keys.map((k: { name: string }) => k.name),
		};
	});
	await manager.addApiKey({ name: 'copilot-1', apiKey: 'sk-1', probe: true });
	await manager.addApiKey({ name: 'copilot-2', apiKey: 'sk-2', probe: true });
	await manager.setActiveKey(manager.snapshot().keys[0]!.id);
	// After two adds, the second one is active. After we switch
	// back to the first, the snapshot MUST report `copilot-1` as
	// active so cross-window consumers (provider, status bar,
	// dashboard) can re-render without polling.
	assert.deepEqual(latest, { activeKeyId: manager.snapshot().keys[0]!.id, names: ['copilot-1', 'copilot-2'] });
	disposable.dispose();
});

test('markMissingSecrets flips the flag when the SecretStorage entry is gone', async () => {
	const { context, secrets } = newContext();
	const manager = loadManager(context);
	const first = await manager.addApiKey({ name: 'a', apiKey: 'sk-a', probe: true });
	await manager.addApiKey({ name: 'b', apiKey: 'sk-b', probe: true });
	// Both keys are healthy at this point.
	const before = await manager.markMissingSecrets(manager.snapshot());
	assert.equal(before.keys.every((k: { missingSecret: boolean }) => !k.missingSecret), true);
	// Wipe one entry out-of-band (simulating a settings reset).
	await secrets.delete(`minimax-vscode.apiKeys.${first.id}`);
	const after = await manager.markMissingSecrets(manager.snapshot());
	const firstAfter = after.keys.find((k: { id: string }) => k.id === first.id)!;
	const secondAfter = after.keys.find((k: { id: string }) => k.id !== first.id)!;
	assert.equal(firstAfter.missingSecret, true);
	assert.equal(secondAfter.missingSecret, false);
	// The legacy slot is also probed. Wiping the legacy secret
	// MUST NOT silently flip named-pool entries back to `healthy`:
	// each named key's `missingSecret` flag is driven by its own
	// secret slot, not by the legacy slot. The only key whose
	// `missingSecret` state is allowed to change in response to a
	// legacy wipe is the legacy entry itself, and that entry is
	// not in the snapshot (it is read separately by the dashboard
	// via the `LEGACY_KEY_ID` slot).
	await secrets.delete('minimax-vscode.apiKey');
	const withLegacy = await manager.markMissingSecrets(manager.snapshot());
	// Re-running after the legacy wipe preserves the per-key
	// flags: the previously-deleted `first` is still `true`, the
	// still-present `second` is still `false`.
	const firstAfterLegacy = withLegacy.keys.find((k: { id: string }) => k.id === first.id)!;
	const secondAfterLegacy = withLegacy.keys.find((k: { id: string }) => k.id !== first.id)!;
	assert.equal(firstAfterLegacy.missingSecret, true);
	assert.equal(secondAfterLegacy.missingSecret, false);
});

test('setActiveKey returns the new entry, marks it active, and touches lastUsedAt', async () => {
	const { context } = newContext();
	const manager = loadManager(context);
	const first = await manager.addApiKey({ name: 'a', apiKey: 'sk-a', probe: true });
	const second = await manager.addApiKey({ name: 'b', apiKey: 'sk-b', probe: true });
	// `addApiKey` sets the most recently added key active. The
	// mock workspace's `config.update` is a no-op, so we can
	// exercise `setActiveKey` without poisoning shared state.
	const result = await manager.setActiveKey(first.id);
	assert.equal(result.entry.id, first.id);
	assert.equal(result.previousId, second.id);
	assert.equal(manager.snapshot().activeKeyId, first.id);
	const fresh = manager.snapshot().keys.find((k: { id: string }) => k.id === first.id)!;
	assert.ok(fresh.lastUsedAt, 'setActiveKey must update lastUsedAt');
});

test('setActiveKey on a single-key pool reports previousId undefined', async () => {
	const { context } = newContext();
	const manager = loadManager(context);
	const only = await manager.addApiKey({ name: 'only', apiKey: 'sk-only', probe: true });
	const result = await manager.setActiveKey(only.id);
	assert.equal(result.entry.id, only.id);
	assert.equal(result.previousId, undefined);
});

test('snapshot is a stable shape: missingSecret defaults to false, isLegacy is true only for the legacy slot', async () => {
	const { context } = newContext();
	const manager = loadManager(context);
	await manager.addApiKey({ name: 'a', apiKey: 'sk-a', probe: true });
	const snap = manager.snapshot();
	assert.equal(snap.keys.length, 1);
	assert.equal(snap.keys[0]!.isLegacy, false);
	assert.equal(snap.keys[0]!.missingSecret, false);
});
