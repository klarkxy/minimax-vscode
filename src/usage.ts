// Lightweight cumulative usage tracker.
//
// Persists per-session totals into a `Memento` so users can see at a
// glance how many tokens MiniMax has produced for them, and which
// models they used. We never store the API key or any message body
// here.
//
// Storage layout (JSON in `globalState[USAGE_STATS_KEY]`):
//   startedAt / updatedAt – ISO timestamps
//   total                 – cumulative ModelUsage across the whole history
//   byModel               – ModelUsage bucketed by API model id
//   daily                 – ModelUsage bucketed by local YYYY-MM-DD date
//                           (used by the dashboard to render today /
//                           7-day / 30-day windows)

import * as vscode from 'vscode';
import { USAGE_STATS_KEY } from './consts';

export interface ModelUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	requests: number;
}

export interface UsageStats {
	startedAt: string;
	updatedAt: string;
	total: ModelUsage;
	byModel: Record<string, ModelUsage>;
	/** Keyed by local date string `YYYY-MM-DD`. */
	daily: Record<string, ModelUsage>;
}

function emptyUsage(): ModelUsage {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		requests: 0,
	};
}

function defaultStats(): UsageStats {
	const now = new Date().toISOString();
	return {
		startedAt: now,
		updatedAt: now,
		total: emptyUsage(),
		byModel: {},
		daily: {},
	};
}

export interface UsageStore {
	record(modelId: string, usage: Partial<ModelUsage>): Promise<void>;
	read(): UsageStats;
	reset(): Promise<void>;
	/** Subscribe to changes — fired after every `record` / `reset`. */
	subscribe(listener: (stats: UsageStats) => void): vscode.Disposable;
	/** Snapshot of today's local-date usage. */
	readToday(): ModelUsage;
	/** Aggregate usage across the trailing `days` calendar days (inclusive of today). */
	readRange(days: number): ModelUsage;
	/** Per-day totals sorted oldest → newest; sparse dates are filled with zeros. */
	readDailySeries(days: number): Array<{ date: string; usage: ModelUsage }>;
}

/**
 * Build a usage store backed by the extension's `globalState`. Pass
 * `undefined` to fall back to a no-op store (used in tests / before
 * the extension is activated).
 */
export function createUsageStore(
	globalState: vscode.Memento | undefined,
): UsageStore {
	if (!globalState) {
		const noopListeners = new Set<(stats: UsageStats) => void>();
		return {
			record: async () => {},
			read: () => defaultStats(),
			reset: async () => {},
			subscribe: (l) => {
				noopListeners.add(l);
				return new vscode.Disposable(() => {
					noopListeners.delete(l);
				});
			},
			readToday: () => emptyUsage(),
			readRange: () => emptyUsage(),
			readDailySeries: () => [],
		};
	}

	const listeners = new Set<(stats: UsageStats) => void>();
	const state: vscode.Memento = globalState;

	function notify(): void {
		const stats = readStats(state);
		for (const listener of listeners) {
			try {
				listener(stats);
			} catch {
				// Listener errors must not break the recorder.
			}
		}
	}

	return {
		async record(modelId: string, usage: Partial<ModelUsage>): Promise<void> {
			const stats = readStats(state);
			applyUsage(stats.total, usage);
			stats.total.requests += 1;
			const bucket = (stats.byModel[modelId] ??= emptyUsage());
			applyUsage(bucket, usage);
			bucket.requests += 1;
			const dayKey = todayKey();
			const dayBucket = (stats.daily[dayKey] ??= emptyUsage());
			applyUsage(dayBucket, usage);
			dayBucket.requests += 1;
			stats.updatedAt = new Date().toISOString();
			await state.update(USAGE_STATS_KEY, stats);
			notify();
		},
		read(): UsageStats {
			return readStats(state);
		},
		async reset(): Promise<void> {
			await state.update(USAGE_STATS_KEY, defaultStats());
			notify();
		},
		subscribe(listener) {
			listeners.add(listener);
			return new vscode.Disposable(() => {
				listeners.delete(listener);
			});
		},
		readToday() {
			const stats = readStats(state);
			return { ...(stats.daily[todayKey()] ?? emptyUsage()) };
		},
		readRange(days: number) {
			const stats = readStats(state);
			return sumRange(stats.daily, days);
		},
		readDailySeries(days: number) {
			const stats = readStats(state);
			return buildSeries(stats.daily, days);
		},
	};
}

function readStats(store: vscode.Memento): UsageStats {
	const raw = store.get<UsageStats | undefined>(USAGE_STATS_KEY);
	if (!raw) {
		return defaultStats();
	}
	// Re-hydrate mutable defaults; Memento serialises through JSON so
	// nested objects always come back as fresh POJOs.
	return {
		startedAt: raw.startedAt,
		updatedAt: raw.updatedAt,
		total: { ...emptyUsage(), ...raw.total },
		byModel: Object.fromEntries(
			Object.entries(raw.byModel ?? {}).map(([id, usage]) => [
				id,
				{ ...emptyUsage(), ...usage },
			]),
		),
		daily: Object.fromEntries(
			Object.entries(raw.daily ?? {}).map(([date, usage]) => [
				date,
				{ ...emptyUsage(), ...usage },
			]),
		),
	};
}

function applyUsage(target: ModelUsage, usage: Partial<ModelUsage>): void {
	if (typeof usage.inputTokens === 'number') {
		target.inputTokens += usage.inputTokens;
	}
	if (typeof usage.outputTokens === 'number') {
		target.outputTokens += usage.outputTokens;
	}
	if (typeof usage.cacheReadTokens === 'number') {
		target.cacheReadTokens += usage.cacheReadTokens;
	}
	if (typeof usage.cacheWriteTokens === 'number') {
		target.cacheWriteTokens += usage.cacheWriteTokens;
	}
}

/** Local-date `YYYY-MM-DD` key — anchored to the user's wall clock so
 * "today" lines up with the dashboard even if the host timezone shifts. */
export function todayKey(now: Date = new Date()): string {
	const y = now.getFullYear();
	const m = String(now.getMonth() + 1).padStart(2, '0');
	const d = String(now.getDate()).padStart(2, '0');
	return `${y}-${m}-${d}`;
}

function shiftDays(base: Date, delta: number): Date {
	const d = new Date(base);
	d.setDate(d.getDate() + delta);
	return d;
}

function sumRange(
	daily: Record<string, ModelUsage>,
	days: number,
): ModelUsage {
	const total = emptyUsage();
	if (days <= 0) {
		return total;
	}
	const today = new Date();
	for (let i = 0; i < days; i++) {
		const key = todayKey(shiftDays(today, -i));
		const bucket = daily[key];
		if (!bucket) {
			continue;
		}
		addInto(total, bucket);
	}
	return total;
}

function buildSeries(
	daily: Record<string, ModelUsage>,
	days: number,
): Array<{ date: string; usage: ModelUsage }> {
	if (days <= 0) {
		return [];
	}
	const today = new Date();
	const series: Array<{ date: string; usage: ModelUsage }> = [];
	for (let i = days - 1; i >= 0; i--) {
		const key = todayKey(shiftDays(today, -i));
		const usage = daily[key];
		series.push({
			date: key,
			usage: usage ? { ...usage } : emptyUsage(),
		});
	}
	return series;
}

function addInto(target: ModelUsage, source: ModelUsage): void {
	target.inputTokens += source.inputTokens;
	target.outputTokens += source.outputTokens;
	target.cacheReadTokens += source.cacheReadTokens;
	target.cacheWriteTokens += source.cacheWriteTokens;
	target.requests += source.requests;
}
