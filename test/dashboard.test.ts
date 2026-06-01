// Unit tests for the dashboard aggregator + platform API parser.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fetchPlanUsage } from '../src/dashboard/api.js';
import { buildDashboardView, totalTokens } from '../src/dashboard/aggregator.js';
import { createUsageStore } from '../src/usage.js';
import { dashboardMessages, pickDashboardLocale } from '../src/dashboard/messages.js';

class FakeMemento {
	private store = new Map<string, unknown>();
	get<T>(key: string): T | undefined {
		return this.store.get(key) as T | undefined;
	}
	update(key: string, value: unknown): Thenable<void> {
		this.store.set(key, value);
		return Promise.resolve();
	}
}

// --- pickDashboardLocale --------------------------------------------------

test('pickDashboardLocale: en fallback for unknown locales', () => {
	assert.equal(pickDashboardLocale(undefined), 'en');
	assert.equal(pickDashboardLocale(''), 'en');
	assert.equal(pickDashboardLocale('fr'), 'en');
	assert.equal(pickDashboardLocale('en-US'), 'en');
	assert.equal(pickDashboardLocale('ja-JP'), 'en');
});

test('pickDashboardLocale: zh for zh / zh-cn / zh-*', () => {
	assert.equal(pickDashboardLocale('zh'), 'zh');
	assert.equal(pickDashboardLocale('zh-cn'), 'zh');
	assert.equal(pickDashboardLocale('zh-CN'), 'zh');
	assert.equal(pickDashboardLocale('zh-tw'), 'zh');
});

// --- dashboardMessages --------------------------------------------------

test('dashboardMessages: en/zh variants both expose all keys', () => {
	for (const locale of ['en', 'zh'] as const) {
		const m = dashboardMessages(locale);
		assert.equal(typeof m.pageTitle, 'string');
		assert.equal(typeof m.refresh, 'string');
		assert.equal(typeof m.noLocalData, 'string');
		assert.equal(typeof m.window7d, 'string');
		assert.equal(typeof m.fieldExpiryDays(3), 'string');
	}
});

test('dashboardMessages: expiry formatter handles past/today/future', () => {
	const zh = dashboardMessages('zh');
	assert.match(zh.fieldExpiryDays(0), /今天|0/);
	assert.match(zh.fieldExpiryDays(7), /7/);
	assert.match(zh.fieldExpiryDays(-3), /过期|3/);
});

// --- fetchPlanUsage --------------------------------------------------

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
			weekly_remains_time: 1000 * 60 * 60 * 24 * 3 + 1000 * 60 * 60 * 5, // 3d5h
			expiry_time: Date.now() + 1000 * 60 * 60 * 24 * 30, // 30 days
		},
	],
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

test('fetchPlanUsage: unconfigured key returns unconfigured', async () => {
	const result = await fetchPlanUsage({ apiKey: '', fetchImpl: () => Promise.resolve(jsonResponse(validPayload)) });
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.equal(result.reason, 'unconfigured');
	}
});

test('fetchPlanUsage: parses a well-formed payload into PlanUsage', async () => {
	const fetchImpl = (input: RequestInfo | URL) => {
		assert.equal(typeof input, 'string');
		assert.match(String(input), /coding_plan\/remains/);
		return Promise.resolve(jsonResponse(validPayload));
	};
	const result = await fetchPlanUsage({ apiKey: 'test-token', fetchImpl });
	assert.equal(result.ok, true);
	if (result.ok) {
		assert.equal(result.usage.modelName, 'MiniMax-M3');
		assert.equal(result.usage.currentTotal, 1000);
		// 75% remaining → 25% used → 250 of 1000
		assert.equal(result.usage.currentUsed, 250);
		assert.equal(result.usage.currentPercentage, 25);
		assert.equal(result.usage.currentResetText, '2h 15m');
		// 90% remaining → 10% used
		assert.equal(result.usage.weeklyPercentage, 10);
		assert.match(result.usage.weeklyResetText, /3d/);
		assert.equal(result.usage.expiryDays, 30);
	}
});

test('fetchPlanUsage: 401 surfaces as error', async () => {
	const result = await fetchPlanUsage({
		apiKey: 'bad',
		fetchImpl: () => Promise.resolve(jsonResponse({}, 401)),
	});
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.equal(result.reason, 'error');
		assert.equal(result.error, 'invalid token');
	}
});

test('fetchPlanUsage: 500 surfaces as error with HTTP status', async () => {
	const result = await fetchPlanUsage({
		apiKey: 'k',
		fetchImpl: () => Promise.resolve(jsonResponse({}, 500)),
	});
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.equal(result.reason, 'error');
		assert.match(result.error ?? '', /HTTP 500/);
	}
});

test('fetchPlanUsage: malformed json surfaces as error', async () => {
	const fetchImpl = () => Promise.resolve(new Response('not json', { status: 200 }));
	const result = await fetchPlanUsage({ apiKey: 'k', fetchImpl });
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.equal(result.reason, 'error');
		assert.match(result.error ?? '', /malformed/);
	}
});

test('fetchPlanUsage: payload without model_remains returns unsupported', async () => {
	const result = await fetchPlanUsage({
		apiKey: 'k',
		fetchImpl: () => Promise.resolve(jsonResponse({ foo: 'bar' })),
	});
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.equal(result.reason, 'unsupported');
	}
});

test('fetchPlanUsage: network error surfaces as error with message', async () => {
	const fetchImpl = () => Promise.reject(new Error('ECONNREFUSED'));
	const result = await fetchPlanUsage({ apiKey: 'k', fetchImpl });
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.equal(result.reason, 'error');
		assert.equal(result.error, 'ECONNREFUSED');
	}
});

test('fetchPlanUsage: caches the response for cacheTtlMs', async () => {
	let calls = 0;
	const fetchImpl = () => {
		calls += 1;
		return Promise.resolve(jsonResponse(validPayload));
	};
	const cache = new Map<string, { value: import('../src/dashboard/types.js').PlanUsage; expiresAt: number }>();
	const a = await fetchPlanUsage({ apiKey: 'k', fetchImpl, cache, cacheTtlMs: 60_000 });
	const b = await fetchPlanUsage({ apiKey: 'k', fetchImpl, cache, cacheTtlMs: 60_000 });
	assert.equal(a.ok && b.ok, true);
	assert.equal(calls, 1);
});

// --- buildDashboardView --------------------------------------------------

test('buildDashboardView: empty store shows local=empty, no plan', async () => {
	const store = createUsageStore(new FakeMemento());
	const view = await buildDashboardView({ store, platform: null });
	assert.equal(view.sources.local, 'empty');
	assert.equal(view.sources.plan, 'unconfigured');
	assert.equal(view.local.today.requests, 0);
	assert.equal(view.local.sevenDay.inputTokens, 0);
	assert.equal(view.local.thirtyDay.requests, 0);
	assert.equal(view.local.dailySeries.length, 30);
	assert.equal(view.plan, undefined);
});

test('buildDashboardView: populates per-model and daily buckets', async () => {
	const store = createUsageStore(new FakeMemento());
	await store.record('MiniMax-M3', { inputTokens: 100, outputTokens: 40, cacheReadTokens: 10 });
	await store.record('MiniMax-M3', { inputTokens: 50, outputTokens: 25, cacheWriteTokens: 5 });
	await store.record('MiniMax-M2.7', { inputTokens: 30, outputTokens: 15 });

	const view = await buildDashboardView({ store, platform: null });
	assert.equal(view.sources.local, 'ok');
	assert.equal(view.local.today.requests, 3);
	assert.equal(view.local.today.inputTokens, 180);
	assert.equal(view.local.today.cacheReadTokens, 10);
	assert.equal(view.local.today.cacheWriteTokens, 5);
	assert.equal(view.local.today.outputTokens, 80);
	assert.equal(view.local.sevenDay.requests, 3);
	assert.equal(view.local.thirtyDay.requests, 3);
	assert.equal(view.local.perModel.length, 2);
	assert.equal(view.local.perModel[0]!.modelId, 'MiniMax-M3');
	assert.equal(view.local.perModel[0]!.usage.requests, 2);
});

test('buildDashboardView: includes plan when platform call succeeds', async () => {
	const store = createUsageStore(new FakeMemento());
	await store.record('MiniMax-M3', { inputTokens: 100, outputTokens: 40 });
	const view = await buildDashboardView({
		store,
		platform: {
			apiKey: 'k',
			fetchImpl: () => Promise.resolve(jsonResponse(validPayload)),
		},
	});
	assert.equal(view.sources.plan, 'ok');
	assert.ok(view.plan);
	assert.equal(view.plan!.modelName, 'MiniMax-M3');
	assert.equal(view.plan!.currentUsed, 250);
});

test('buildDashboardView: marks plan=error and sets planError on failure', async () => {
	const store = createUsageStore(new FakeMemento());
	const view = await buildDashboardView({
		store,
		platform: {
			apiKey: 'k',
			fetchImpl: () => Promise.resolve(jsonResponse({}, 500)),
		},
	});
	assert.equal(view.sources.plan, 'error');
	assert.equal(view.plan, undefined);
	assert.match(view.sources.planError ?? '', /HTTP 500/);
});

test('buildDashboardView: includePlatform=false skips platform call', async () => {
	const store = createUsageStore(new FakeMemento());
	let called = 0;
	const view = await buildDashboardView({
		store,
		platform: {
			apiKey: 'k',
			fetchImpl: () => {
				called += 1;
				return Promise.resolve(jsonResponse(validPayload));
			},
		},
		includePlatform: false,
	});
	assert.equal(called, 0);
	assert.equal(view.sources.plan, 'unsupported');
	assert.equal(view.plan, undefined);
});

// --- totalTokens helper --------------------------------------------------

test('totalTokens: sums all four token buckets', () => {
	assert.equal(
		totalTokens({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, requests: 0 }),
		10,
	);
	assert.equal(totalTokens({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0 }), 0);
});
