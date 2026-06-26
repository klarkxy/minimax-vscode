// Lightweight cumulative usage tracker.
//
// Persists per-session totals into a `Memento` so users can see at a
// glance how many tokens MiniMax has produced for them, and which
// models they used. We never store the API key or any message body
// here.
//
// Storage layout (JSON in `globalState[USAGE_STATS_BY_KEY_KEY]`):
//   <keyId>                – per-key `UsageStats` blob; keyId is the
//                            KeyManager id (or `__legacy__` for
//                            pre-pool data). Replaces the previous
//                            single `USAGE_STATS_KEY` layout.
// `globalState[USAGE_STATS_KEY]` is read on first access and
// migrated into the `__legacy__` scope so existing users keep their
// history after upgrading to the named key pool.

import * as vscode from 'vscode';
import { LEGACY_KEY_ID, USAGE_STATS_BY_KEY_KEY, USAGE_STATS_KEY } from './consts';
import type { KeyManager } from './keyManager';

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

export function emptyUsage(): ModelUsage {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		requests: 0,
	};
}

export function defaultStats(): UsageStats {
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
	/** Record usage for the active key. The keyId is resolved at
	 *  write-time via the bound `KeyManager` (or `__legacy__` if no
	 *  named key is active yet, so the previous single-bucket
	 *  behaviour is preserved). */
	record(modelId: string, usage: Partial<ModelUsage>): Promise<void>;
	/** Aggregate stats across the active key's bucket. Equivalent to
	 *  `readForKey(activeKeyId)`. */
	read(): UsageStats;
	/** Per-key stats. `__legacy__` returns the pre-pool history. */
	readForKey(keyId: string): UsageStats;
	/** Per-key snapshot for the dashboard dropdown. */
	readAllKeys(): Record<string, UsageStats>;
	reset(): Promise<void>;
	/** Subscribe to changes — fired after every `record` / `reset`. */
	subscribe(listener: (stats: UsageStats) => void): vscode.Disposable;
	/** Snapshot of today's local-date usage for the active key. */
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
 *
 * `deps.keyManager` is consulted on each `record` to attribute the
 * entry to the active key. When no `KeyManager` is provided (e.g. in
 * a unit test) usage is recorded against `__legacy__` so the old
 * single-bucket shape is preserved.
 */
export function createUsageStore(
	globalState: vscode.Memento | undefined,
	deps: { keyManager?: KeyManager } = {},
): UsageStore {
	if (!globalState) {
		const noopListeners = new Set<(stats: UsageStats) => void>();
		return {
			record: async () => {},
			read: () => defaultStats(),
			readForKey: () => defaultStats(),
			readAllKeys: () => ({}),
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

	// Lazy, idempotent migration from the legacy single-bucket
	// layout to the per-key map. We track the in-flight promise on
	// a per-store basis (not module-level) so the test harness
	// (which constructs a fresh `FakeMemento` per test) gets a
	// clean migration state, and so two usage stores in the same
	// process can't accidentally dedup to the wrong memento. The
	// migration writes are also reflected in the read path via
	// `readAllMap`'s legacy fallback so the dashboard sees the
	// user's history on the first render even before the write
	// lands.
	let migrationPromise: Promise<void> | undefined;
	function ensureMigrated(): Promise<void> {
		if (migrationPromise) return migrationPromise;
		migrationPromise = (async () => {
			const hasNew = state.get<unknown>(USAGE_STATS_BY_KEY_KEY) !== undefined;
			if (hasNew) return;
			const legacy = state.get<UsageStats | undefined>(USAGE_STATS_KEY);
			if (!legacy) {
				// Initialise the new key so future reads can rely
				// on its presence even when there is no legacy
				// data. The fallback in `readAllMap()` also
				// covers this case for in-process reads.
				await state.update(USAGE_STATS_BY_KEY_KEY, {});
				return;
			}
			const map: Record<string, UsageStats> = {
				[LEGACY_KEY_ID]: hydrateStats(legacy),
			};
			await state.update(USAGE_STATS_BY_KEY_KEY, map);
		})();
		return migrationPromise;
	}

	function activeKeyId(): string {
		const snap = deps.keyManager?.snapshot();
		return snap?.activeKeyId ?? LEGACY_KEY_ID;
	}

	function notify(): void {
		const stats = readForKey(state, activeKeyId());
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
			// Gate every write on the migration promise so a
			// record fired immediately after upgrade cannot race
			// the legacy-to-per-key migration write and overwrite
			// it with a fresh empty map.
			await ensureMigrated();
			const keyId = activeKeyId();
			const stats = readForKey(state, keyId);
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
			await writeForKey(state, keyId, stats);
			notify();
		},
		read(): UsageStats {
			return readForKey(state, activeKeyId());
		},
		readForKey(keyId: string): UsageStats {
			return readForKey(state, keyId);
		},
		readAllKeys(): Record<string, UsageStats> {
			return readAllKeys(state);
		},
		async reset(): Promise<void> {
			await ensureMigrated();
			const keyId = activeKeyId();
			await writeForKey(state, keyId, defaultStats());
			notify();
		},
		subscribe(listener) {
			listeners.add(listener);
			return new vscode.Disposable(() => {
				listeners.delete(listener);
			});
		},
		readToday() {
			const stats = readForKey(state, activeKeyId());
			return { ...(stats.daily[todayKey()] ?? emptyUsage()) };
		},
		readRange(days: number) {
			const stats = readForKey(state, activeKeyId());
			return sumRange(stats.daily, days);
		},
		readDailySeries(days: number) {
			const stats = readForKey(state, activeKeyId());
			return buildSeries(stats.daily, days);
		},
	};
}

function readAllMap(store: vscode.Memento): Record<string, UsageStats> {
	const raw = store.get<Record<string, UsageStats> | undefined>(USAGE_STATS_BY_KEY_KEY);
	const result: Record<string, UsageStats> = {};
	if (raw && typeof raw === 'object') {
		for (const [id, value] of Object.entries(raw)) {
			result[id] = hydrateStats(value);
		}
	}
	// Read-side fallback for the migration window: if the new map
	// is still empty (migration write hasn't landed yet), surface
	// the legacy single-bucket data under `__legacy__` so the
	// dashboard renders the user's history on the first frame. The
	// write-side `await ensureMigrated()` in `record`/`reset` is
	// the canonical path that flips the new key on.
	if (Object.keys(result).length === 0) {
		const legacy = store.get<UsageStats | undefined>(USAGE_STATS_KEY);
		if (legacy) {
			result[LEGACY_KEY_ID] = hydrateStats(legacy);
		}
	}
	return result;
}

function readForKey(store: vscode.Memento, keyId: string): UsageStats {
	const map = readAllMap(store);
	const existing = map[keyId];
	return existing ? hydrateStats(existing) : defaultStats();
}

function writeForKey(store: vscode.Memento, keyId: string, stats: UsageStats): Promise<void> {
	const map = readAllMap(store);
	map[keyId] = stats;
	return Promise.resolve(store.update(USAGE_STATS_BY_KEY_KEY, map));
}

function readAllKeys(store: vscode.Memento): Record<string, UsageStats> {
	return readAllMap(store);
}

function hydrateStats(raw: UsageStats | undefined): UsageStats {
	if (!raw) return defaultStats();
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

export function sumRange(
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

export function buildSeries(
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
