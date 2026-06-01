// Lightweight cumulative usage tracker.
//
// Persists per-session totals into a `Memento` so users can see at a
// glance how many tokens MiniMax has produced for them, and which
// models they used. We never store the API key or any message body
// here.

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
	};
}

export interface UsageStore {
	record(modelId: string, usage: Partial<ModelUsage>): Promise<void>;
	read(): UsageStats;
	reset(): Promise<void>;
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
		return {
			record: async () => {},
			read: () => defaultStats(),
			reset: async () => {},
		};
	}
	return {
		async record(modelId: string, usage: Partial<ModelUsage>): Promise<void> {
			const stats = readStats(globalState);
			applyUsage(stats.total, usage);
			const bucket = (stats.byModel[modelId] ??= emptyUsage());
			applyUsage(bucket, usage);
			bucket.requests += 1;
			stats.updatedAt = new Date().toISOString();
			await globalState.update(USAGE_STATS_KEY, stats);
		},
		read(): UsageStats {
			return readStats(globalState);
		},
		async reset(): Promise<void> {
			await globalState.update(USAGE_STATS_KEY, defaultStats());
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
