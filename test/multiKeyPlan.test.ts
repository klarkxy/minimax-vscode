// Unit tests for the multi-key PlanCache extensions and the
// TokenPlanPoller. The PlanCache tests exercise `readForKey`,
// `readAll`, `refreshKey`, `refreshAll`, and `invalidateKey` —
// all added in the multi-key Token Plan commit. The poller tests
// verify the background refresh cycle, missing-secret handling,
// proxy-key skipping, and the force-refresh path.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	createPlanCache,
	planCacheFingerprint,
	type PlanCache,
	type PlanRefreshTarget,
} from '../src/dashboard/aggregator.js';
import { createTokenPlanPoller, type TokenPlanPollerHandle } from '../src/dashboard/tokenPlanPoller.js';
import type { PlanUsage } from '../src/dashboard/types.js';

// ---- Helpers -----------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

const validPayload = {
	model_remains: [
		{
			model_name: 'MiniMax-M3',
			current_interval_total_count: 1000,
			current_interval_usage_count: 250,
			current_interval_remaining_percent: 75,
			remains_time: 1000 * 60 * 60 * 2 + 1000 * 60 * 15, // 2h15m
			current_weekly_total_count: 5000,
			current_weekly_usage_count: 500,
			current_weekly_remaining_percent: 90,
			weekly_remains_time: 1000 * 60 * 60 * 24 * 3 + 1000 * 60 * 60 * 5,
			expiry_time: Date.now() + 1000 * 60 * 60 * 24 * 30,
		},
	],
};

function makeTarget(keyId: string, apiKey = `key-${keyId}`, host: 'china' | 'global' | null = 'china'): PlanRefreshTarget {
	return {
		keyId,
		apiKey,
		host,
		fingerprint: `fp:${keyId}`,
	};
}

let fetchCalls = 0;
function countingFetchImpl(): typeof fetch {
	return (() => {
		fetchCalls += 1;
		return Promise.resolve(jsonResponse(validPayload));
	}) as unknown as typeof fetch;
}

// ---- PlanCache multi-key tests -----------------------------------------

test('PlanCache: readForKey returns snapshot after refreshKey', async () => {
	fetchCalls = 0;
	const cache = createPlanCache({ ttlMs: 60_000 });
	const target = makeTarget('k1', 'secret1', 'china');
	await cache.refreshKey(target, { fetchImpl: countingFetchImpl() });

	const snap = cache.readForKey('k1');
	assert.ok(snap, 'snapshot should exist for k1');
	assert.equal(snap.keyId, 'k1');
	assert.equal(snap.usage.modelName, 'MiniMax-M3');
});

test('PlanCache: readForKey returns undefined for unknown keyId', () => {
	const cache = createPlanCache({ ttlMs: 60_000 });
	assert.equal(cache.readForKey('nonexistent'), undefined);
});

test('PlanCache: multiple keys store independently', async () => {
	fetchCalls = 0;
	const cache = createPlanCache({ ttlMs: 60_000 });
	const fi = countingFetchImpl();
	await cache.refreshKey(makeTarget('k1', 'secret1'), { fetchImpl: fi });
	await cache.refreshKey(makeTarget('k2', 'secret2'), { fetchImpl: fi });
	assert.equal(fetchCalls, 2);

	const all = cache.readAll();
	assert.equal(all.size, 2);
	assert.ok(all.has('k1'));
	assert.ok(all.has('k2'));
	assert.equal(all.get('k1')!.keyId, 'k1');
	assert.equal(all.get('k2')!.keyId, 'k2');
});

test('PlanCache: refreshKey honours TTL (non-force returns cached)', async () => {
	fetchCalls = 0;
	const cache = createPlanCache({ ttlMs: 60_000 });
	const fi = countingFetchImpl();
	await cache.refreshKey(makeTarget('k1', 'secret1'), { fetchImpl: fi });
	assert.equal(fetchCalls, 1);

	// Non-force refresh within TTL — should reuse.
	const result = await cache.refreshKey(makeTarget('k1', 'secret1'), { fetchImpl: fi });
	assert.equal(fetchCalls, 1, 'should not fetch again');
	assert.ok(result.ok);
});

test('PlanCache: refreshKey force bypasses TTL', async () => {
	fetchCalls = 0;
	const cache = createPlanCache({ ttlMs: 60_000 });
	const fi = countingFetchImpl();
	await cache.refreshKey(makeTarget('k1', 'secret1'), { fetchImpl: fi });
	assert.equal(fetchCalls, 1);

	await cache.refreshKey(makeTarget('k1', 'secret1'), { force: true, fetchImpl: fi });
	assert.equal(fetchCalls, 2, 'force should re-fetch');
});

test('PlanCache: unsupported host returns unsupported without fetching', async () => {
	fetchCalls = 0;
	const cache = createPlanCache({ ttlMs: 60_000 });
	const fi = countingFetchImpl();
	const result = await cache.refreshKey(makeTarget('k1', 'secret1', null), { fetchImpl: fi });
	assert.equal(fetchCalls, 0, 'unsupported host should not fetch');
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.equal(result.reason, 'unsupported');
	}
});

test('PlanCache: refreshAll iterates all targets', async () => {
	fetchCalls = 0;
	const cache = createPlanCache({ ttlMs: 60_000 });
	const fi = countingFetchImpl();
	const targets = [makeTarget('a', 'sa'), makeTarget('b', 'sb'), makeTarget('c', 'sc')];
	const results = await cache.refreshAll(targets, { fetchImpl: fi });
	assert.equal(fetchCalls, 3);
	assert.equal(results.length, 3);
	for (const r of results) assert.ok(r.ok);

	const all = cache.readAll();
	assert.equal(all.size, 3);
});

test('PlanCache: refreshAll with force bypasses TTL for all', async () => {
	fetchCalls = 0;
	const cache = createPlanCache({ ttlMs: 60_000 });
	const fi = countingFetchImpl();
	const targets = [makeTarget('a', 'sa'), makeTarget('b', 'sb')];
	await cache.refreshAll(targets, { fetchImpl: fi });
	assert.equal(fetchCalls, 2);

	// Non-force: all cached, no new fetches.
	await cache.refreshAll(targets, { fetchImpl: fi });
	assert.equal(fetchCalls, 2);

	// Force: all re-fetched.
	await cache.refreshAll(targets, { force: true, fetchImpl: fi });
	assert.equal(fetchCalls, 4);
});

test('PlanCache: invalidateKey clears snapshot for one key', async () => {
	fetchCalls = 0;
	const cache = createPlanCache({ ttlMs: 60_000 });
	const fi = countingFetchImpl();
	await cache.refreshKey(makeTarget('a', 'sa'), { fetchImpl: fi });
	await cache.refreshKey(makeTarget('b', 'sb'), { fetchImpl: fi });
	assert.equal(cache.readAll().size, 2);

	cache.invalidateKey('a');
	assert.equal(cache.readForKey('a'), undefined);
	assert.ok(cache.readForKey('b'), 'b should still exist');

	// readAll should now only have b.
	const all = cache.readAll();
	assert.equal(all.size, 1);
	assert.ok(all.has('b'));
});

test('PlanCache: readAll filters expired snapshots', async () => {
	const cache = createPlanCache({ ttlMs: 1 }); // 1ms TTL
	const fi = countingFetchImpl();
	await cache.refreshKey(makeTarget('k1', 's1'), { fetchImpl: fi });
	// Wait for TTL to expire.
	await new Promise((r) => setTimeout(r, 10));
	const all = cache.readAll();
	assert.equal(all.size, 0, 'expired snapshot should be filtered');
});

test('PlanCache: legacy read(platform) still works for backward compat', async () => {
	fetchCalls = 0;
	const cache = createPlanCache({ ttlMs: 60_000 });
	const fi = countingFetchImpl();
	const platform = { apiKey: 'A', host: 'china' as const, fetchImpl: fi };
	await cache.refresh(platform);
	assert.equal(fetchCalls, 1);

	// read(platform) should return the snapshot.
	const snap = cache.read(platform);
	assert.ok(snap);
	assert.equal(snap.usage.modelName, 'MiniMax-M3');
});

test('PlanCache: invalidate(fp) clears legacy fingerprint entry', async () => {
	fetchCalls = 0;
	const cache = createPlanCache({ ttlMs: 60_000 });
	const fi = countingFetchImpl();
	await cache.refresh({ apiKey: 'A', host: 'china', fetchImpl: fi });
	await cache.refresh({ apiKey: 'B', host: 'china', fetchImpl: fi });
	assert.equal(fetchCalls, 2);

	const fpA = planCacheFingerprint({ apiKey: 'A', host: 'china' });
	cache.invalidate(fpA);
	// Re-fetch A should hit network.
	await cache.refresh({ apiKey: 'A', host: 'china', fetchImpl: fi });
	assert.equal(fetchCalls, 3, 'A should be re-fetched');
	// Re-fetch B should reuse cache.
	await cache.refresh({ apiKey: 'B', host: 'china', fetchImpl: fi });
	assert.equal(fetchCalls, 3, 'B should be reused');
});

// ---- TokenPlanPoller tests ---------------------------------------------

test('TokenPlanPoller: refreshAll iterates all keys in pool', async () => {
	fetchCalls = 0;
	const cache = createPlanCache({ ttlMs: 60_000 });
	const keyPool = [
		{ id: 'a', name: 'key-a', region: 'china' as const, apiBaseUrl: 'https://api.minimaxi.com/anthropic', fingerprint: 'fp-a', createdAt: '', updatedAt: '', isLegacy: false, missingSecret: false },
		{ id: 'b', name: 'key-b', region: 'global' as const, apiBaseUrl: 'https://api.minimax.io/anthropic', fingerprint: 'fp-b', createdAt: '', updatedAt: '', isLegacy: false, missingSecret: false },
	];
	const poller = createTokenPlanPoller({
		planCache: cache,
		keyManager: {
			snapshot: () => ({ keys: keyPool, activeKeyId: 'a' }),
			onDidChange: () => ({ dispose() {} }),
		} as any,
		fetchSecret: (keyId) => Promise.resolve(`secret-${keyId}`),
		intervalMs: 60_000,
		fetchImpl: countingFetchImpl(),
	});

	const results = await poller.refresh();
	assert.equal(results.length, 2);
	assert.equal(results.every((r) => r.ok), true);
	assert.ok(
		cache.read({ apiKey: 'secret-a', host: 'china' }),
		'active-key read(platform) should see the poller-populated snapshot',
	);
	assert.equal(cache.readAll().size, 2);
	poller.dispose();
});

test('TokenPlanPoller: missing secret keys are skipped', async () => {
	fetchCalls = 0;
	const cache = createPlanCache({ ttlMs: 60_000 });
	const keyPool = [
		{ id: 'a', name: 'key-a', region: 'china' as const, apiBaseUrl: 'https://api.minimaxi.com/anthropic', fingerprint: 'fp-a', createdAt: '', updatedAt: '', isLegacy: false, missingSecret: false },
		{ id: 'b', name: 'key-b', region: 'global' as const, apiBaseUrl: 'https://api.minimax.io/anthropic', fingerprint: 'fp-b', createdAt: '', updatedAt: '', isLegacy: false, missingSecret: false },
	];
	const poller = createTokenPlanPoller({
		planCache: cache,
		keyManager: {
			snapshot: () => ({ keys: keyPool, activeKeyId: 'a' }),
			onDidChange: () => ({ dispose() {} }),
		} as any,
		fetchSecret: (keyId) => keyId === 'a' ? Promise.resolve('secret-a') : Promise.resolve(undefined),
		intervalMs: 60_000,
		fetchImpl: countingFetchImpl(),
	});

	const results = await poller.refresh();
	// Key 'a' should be fetched; key 'b' should be skipped (secret missing).
	assert.equal(results.length, 1, 'only key a should be in results');
	assert.ok(results[0].ok);
	poller.dispose();
});

test('TokenPlanPoller: proxy key does not call fetch', async () => {
	fetchCalls = 0;
	const cache = createPlanCache({ ttlMs: 60_000 });
	const keyPool = [
		{ id: 'p', name: 'proxy-key', region: 'custom' as const, apiBaseUrl: 'https://my-proxy.example.com/anthropic', fingerprint: 'fp-p', createdAt: '', updatedAt: '', isLegacy: false, missingSecret: false },
	];
	const poller = createTokenPlanPoller({
		planCache: cache,
		keyManager: {
			snapshot: () => ({ keys: keyPool, activeKeyId: 'p' }),
			onDidChange: () => ({ dispose() {} }),
		} as any,
		fetchSecret: () => Promise.resolve('proxy-secret'),
		intervalMs: 60_000,
	});

	const results = await poller.refresh();
	assert.equal(fetchCalls, 0, 'proxy key should not trigger fetch');
	assert.equal(results.length, 1);
	assert.equal(results[0].ok, false);
	if (!results[0].ok) {
		assert.equal(results[0].reason, 'unsupported');
	}
	poller.dispose();
});

test('TokenPlanPoller: force refresh bypasses TTL', async () => {
	fetchCalls = 0;
	const cache = createPlanCache({ ttlMs: 60_000 });
	const keyPool = [
		{ id: 'a', name: 'key-a', region: 'china' as const, apiBaseUrl: 'https://api.minimaxi.com/anthropic', fingerprint: 'fp-a', createdAt: '', updatedAt: '', isLegacy: false, missingSecret: false },
	];
	const poller = createTokenPlanPoller({
		planCache: cache,
		keyManager: {
			snapshot: () => ({ keys: keyPool, activeKeyId: 'a' }),
			onDidChange: () => ({ dispose() {} }),
		} as any,
		fetchSecret: () => Promise.resolve('secret-a'),
		intervalMs: 60_000,
		fetchImpl: countingFetchImpl(),
	});

	await poller.refresh();
	assert.equal(fetchCalls, 1);

	// Non-force: TTL cache hit, no new fetches.
	await poller.refresh();
	assert.equal(fetchCalls, 1);

	// Force: re-fetches.
	await poller.refresh({ force: true });
	assert.equal(fetchCalls, 2);
	poller.dispose();
});

test('TokenPlanPoller: dispose stops the timer', async () => {
	const cache = createPlanCache({ ttlMs: 60_000 });
	const poller = createTokenPlanPoller({
		planCache: cache,
		keyManager: {
			snapshot: () => ({ keys: [], activeKeyId: undefined }),
			onDidChange: () => ({ dispose() {} }),
		} as any,
		fetchSecret: () => Promise.resolve(undefined),
		intervalMs: 1000,
	});
	assert.equal(poller.disposed, false);
	poller.dispose();
	assert.equal(poller.disposed, true);
	// Double dispose is safe.
	poller.dispose();
	assert.equal(poller.disposed, true);
});

test('TokenPlanPoller: empty pool returns empty results', async () => {
	const cache = createPlanCache({ ttlMs: 60_000 });
	const poller = createTokenPlanPoller({
		planCache: cache,
		keyManager: {
			snapshot: () => ({ keys: [], activeKeyId: undefined }),
			onDidChange: () => ({ dispose() {} }),
		} as any,
		fetchSecret: () => Promise.resolve(undefined),
		intervalMs: 60_000,
	});

	const results = await poller.refresh();
	assert.equal(results.length, 0);
	poller.dispose();
});
