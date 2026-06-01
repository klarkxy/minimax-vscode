// Unit tests for the daily-bucket accounting in src/usage.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createUsageStore, todayKey, type UsageStats } from '../src/usage.js';

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

function newStore(): { store: FakeMemento; usage: ReturnType<typeof createUsageStore> } {
	const store = new FakeMemento();
	const usage = createUsageStore(store);
	return { store, usage };
}

test('createUsageStore with undefined globalState is a safe no-op', async () => {
	const usage = createUsageStore(undefined);
	await usage.record('MiniMax-M3', { inputTokens: 100, outputTokens: 50 });
	assert.equal(usage.read().total.requests, 0);
	assert.equal(usage.readToday().requests, 0);
	assert.equal(usage.readRange(7).requests, 0);
	assert.equal(usage.readDailySeries(7).length, 0);
});

test('record() accumulates total, byModel, and today in lockstep', async () => {
	const { usage } = newStore();
	await usage.record('MiniMax-M3', {
		inputTokens: 100,
		outputTokens: 40,
		cacheReadTokens: 200,
		cacheWriteTokens: 0,
	});
	await usage.record('MiniMax-M3', {
		inputTokens: 50,
		outputTokens: 20,
		cacheReadTokens: 0,
		cacheWriteTokens: 80,
	});

	const stats = usage.read();
	assert.equal(stats.total.requests, 2);
	assert.equal(stats.total.inputTokens, 150);
	assert.equal(stats.total.outputTokens, 60);
	assert.equal(stats.total.cacheReadTokens, 200);
	assert.equal(stats.total.cacheWriteTokens, 80);
	assert.deepEqual(Object.keys(stats.byModel), ['MiniMax-M3']);
	assert.equal(stats.byModel['MiniMax-M3']!.requests, 2);

	const today = usage.readToday();
	assert.equal(today.requests, 2);
	assert.equal(today.inputTokens, 150);
	assert.equal(today.cacheWriteTokens, 80);
});

test('record() writes the daily bucket keyed by local YYYY-MM-DD', async () => {
	const { store, usage } = newStore();
	await usage.record('MiniMax-M3', { inputTokens: 10, outputTokens: 5 });
	const raw = store.get<UsageStats>('minimax-vscode.usageStats');
	assert.ok(raw);
	assert.deepEqual(Object.keys(raw.daily), [todayKey()]);
	assert.equal(raw.daily[todayKey()]!.inputTokens, 10);
});

test('readRange() aggregates only the requested window of trailing days', async () => {
	const { store, usage } = newStore();
	// Seed 5 days of history: today, -1, -2, -3, -4
	for (let offset = 0; offset < 5; offset++) {
		const date = new Date();
		date.setDate(date.getDate() - offset);
		const key = todayKey(date);
		const bucket = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0 };
		bucket.inputTokens = (offset + 1) * 100;
		bucket.requests = offset + 1;
		const raw = store.get<UsageStats>('minimax-vscode.usageStats') ?? {
			startedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			total: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0 },
			byModel: {},
			daily: {},
		};
		raw.daily[key] = bucket;
		await store.update('minimax-vscode.usageStats', raw);
	}

	const seven = usage.readRange(7);
	// 100 + 200 + 300 + 400 + 500 = 1500
	assert.equal(seven.inputTokens, 1500);
	assert.equal(seven.requests, 15);
	// readRange(3) only sees offsets 0, 1, 2
	const three = usage.readRange(3);
	assert.equal(three.inputTokens, 100 + 200 + 300);
	assert.equal(three.requests, 6);
});

test('readDailySeries() returns a dense, oldest-first series', async () => {
	const { store, usage } = newStore();
	for (let offset = 2; offset >= 0; offset--) {
		const date = new Date();
		date.setDate(date.getDate() - offset);
		const key = todayKey(date);
		const raw = (store.get<UsageStats>('minimax-vscode.usageStats') ?? {
			startedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			total: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0 },
			byModel: {},
			daily: {},
		}) as UsageStats;
		raw.daily[key] = {
			inputTokens: (3 - offset) * 10,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			requests: 1,
		};
		await store.update('minimax-vscode.usageStats', raw);
	}

	const series = usage.readDailySeries(7);
	assert.equal(series.length, 7);
	// The last 3 entries (today-2, today-1, today) should have non-zero input.
	assert.equal(series[4]!.usage.inputTokens, 10);
	assert.equal(series[5]!.usage.inputTokens, 20);
	assert.equal(series[6]!.usage.inputTokens, 30);
	// The first 4 entries are zero-filled.
	assert.equal(series[0]!.usage.requests, 0);
	// Ordering is oldest → newest.
	const dates = series.map((s) => s.date);
	assert.equal(dates.length, 7);
	assert.equal(dates[0]!, todayKey(new Date(Date.now() - 6 * 24 * 60 * 60 * 1000)));
	assert.equal(dates[6]!, todayKey());
});

test('subscribe() fires after record() and reset()', async () => {
	const { usage } = newStore();
	let calls = 0;
	const disposable = usage.subscribe(() => {
		calls += 1;
	});
	await usage.record('MiniMax-M3', { inputTokens: 1, outputTokens: 1 });
	assert.equal(calls, 1);
	await usage.record('MiniMax-M2.7', { inputTokens: 2, outputTokens: 2 });
	assert.equal(calls, 2);
	await usage.reset();
	assert.equal(calls, 3);
	const after = usage.read();
	assert.equal(after.total.requests, 0);
	assert.equal(after.daily[todayKey()]?.requests ?? 0, 0);
	disposable.dispose();
});

test('todayKey() pads single-digit month/day with leading zero', () => {
	const fixed = new Date(2026, 0, 3); // Jan 3 2026
	assert.equal(todayKey(fixed), '2026-01-03');
});
