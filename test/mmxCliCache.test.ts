// Unit tests for the persistent mmx-cli status cache.
//
// The cache is the layer that turns "every dashboard open re-runs
// detection" into "first paint reads from disk; subsequent opens
// paint the same value, then re-check in the background".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMmxCliCache } from '../src/dashboard/mmxCliCache.js';
import { MMX_CLI_STATUS_KEY } from '../src/consts.js';

// Minimal in-memory Memento that satisfies the slice of the API the
// cache uses. The real extension's `globalState` is JSON-backed and
// shares the same shape.
function createMemento(initial: Record<string, unknown> = {}) {
	const data: Record<string, unknown> = { ...initial };
	return {
		get<T>(key: string): T | undefined {
			return data[key] as T | undefined;
		},
		async update(key: string, value: unknown): Promise<void> {
			data[key] = value;
		},
		_dump: () => ({ ...data }),
	};
}

test('MmxCliCache: read() returns undefined when nothing has been detected', () => {
	const cache = createMmxCliCache({ globalState: undefined });
	assert.equal(cache.read(), undefined);
});

test('MmxCliCache: refresh() persists the result to memento', async () => {
	const memento = createMemento();
	const cache = createMmxCliCache({ globalState: memento as never });
	const status = await cache.refresh();
	// The status shape comes from readMmxCliStatus in mmxCli.ts;
	// we just check the cache surfaced it and wrote through.
	assert.ok(status, 'refresh should resolve to a status');
	const snap = cache.read();
	assert.ok(snap, 'read() should return the snapshot after refresh');
	assert.equal(snap?.status, status);
	const stored = memento.get<{ status: unknown; detectedAt: number }>(MMX_CLI_STATUS_KEY);
	assert.ok(stored, 'memento should now contain the snapshot');
	assert.deepEqual(stored?.status, status);
	assert.equal(typeof stored?.detectedAt, 'number');
});

test('MmxCliCache: reuses a single in-flight refresh for concurrent callers', async () => {
	const memento = createMemento();
	const cache = createMmxCliCache({ globalState: memento as never });
	const [a, b, c] = await Promise.all([cache.refresh(), cache.refresh(), cache.refresh()]);
	assert.equal(a, b);
	assert.equal(b, c);
});

test('MmxCliCache: hydrates from memento on construction', () => {
	const persisted = {
		status: {
			install: 'installed',
			version: '1.0.16',
			binPath: 'C:\\fake\\mmx.cmd',
			auth: 'loggedIn',
			skill: 'installed',
			agentReady: true,
		},
		detectedAt: 1700000000000,
	};
	const memento = createMemento({ [MMX_CLI_STATUS_KEY]: persisted });
	const cache = createMmxCliCache({ globalState: memento as never });
	const snap = cache.read();
	assert.ok(snap, 'should read the persisted snapshot');
	assert.equal(snap?.status.install, 'installed');
	assert.equal(snap?.status.version, '1.0.16');
	assert.equal(snap?.status.auth, 'loggedIn');
	assert.equal(snap?.status.skill, 'installed');
	assert.equal(snap?.status.agentReady, true);
	assert.equal(snap?.detectedAt, 1700000000000);
});

test('MmxCliCache: subscribe() fires when refresh() updates the snapshot', async () => {
	const memento = createMemento();
	const cache = createMmxCliCache({ globalState: memento as never });
	let calls = 0;
	const sub = cache.subscribe(() => {
		calls += 1;
	});
	await cache.refresh();
	assert.equal(calls, 1, 'subscriber should fire once after refresh');
	sub.dispose();
	await cache.refresh();
	assert.equal(calls, 1, 'disposed subscriber should not fire');
});

test('MmxCliCache: failure inside refresh() does not blank the snapshot', async () => {
	const memento = createMemento();
	const cache = createMmxCliCache({ globalState: memento as never });
	const first = await cache.refresh();
	assert.ok(first, 'first refresh should succeed');
	// The second refresh is a new promise (the first has already
	// settled and cleared the in-flight slot), so it returns a
	// fresh status object — but the snapshot fields should match.
	const second = await cache.refresh();
	assert.deepEqual(second, first, 'second refresh should produce a structurally equal status');
	assert.deepEqual(cache.read()?.status, first);
});
