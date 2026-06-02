// Aggregator: stitches local usage accounting with the (optional)
// platform coding-plan response into a single `DashboardView`.

import { createUsageStore, type ModelUsage, type UsageStore } from '../usage';
import { fetchPlanUsage, type PlanApiOptions, type PlanApiResult } from './api';
import type { DashboardView, PlanUsage } from './types';

export interface AggregatorOptions {
	store: UsageStore;
	platform: PlanApiOptions | null;
	/** When false, skips the platform API call (e.g. user toggle). */
	includePlatform?: boolean;
	/** Clock — overridable for tests. */
	now?: () => Date;
}

// ---- Shared plan cache (Dashboard + status bar) --------------------------
//
// Both the dashboard webview and the status-bar quota items need the
// same coding_plan/remains response. Rather than each one running its
// own fetch on its own schedule, the extension keeps a single in-process
// PlanCache that stores the last successful PlanUsage and broadcasts
// it to any subscribers (status-bar items, the dashboard panel, future
// surfaces). The underlying transport is still throttled by the 8s TTL
// inside fetchPlanUsage so concurrent calls deduplicate cleanly.

export interface PlanSnapshot {
	usage: PlanUsage;
	fetchedAt: number;
}

export interface PlanCache {
	/** Most recent successful snapshot, or undefined before the first fetch. */
	read(): PlanSnapshot | undefined;
	/**
	 * Fetch a fresh snapshot. The same in-flight promise is returned to
	 * concurrent callers so the underlying HTTP request is only ever
	 * made once. Failures are NOT cached; subsequent calls will retry.
	 */
	refresh(platform: PlanApiOptions): Promise<PlanApiResult>;
	/** Subscribe to cache-changed events. Returns a Disposable. */
	subscribe(listener: () => void): { dispose(): void };
	/** Invalidate (e.g. when the user changes the API key). */
	invalidate(): void;
}

/** Create a fresh PlanCache — one per extension host. */
export function createPlanCache(): PlanCache {
	let snapshot: PlanSnapshot | undefined;
	let inFlight: Promise<PlanApiResult> | undefined;
	const listeners = new Set<() => void>();

	function notify(): void {
		for (const fn of listeners) {
			try {
				fn();
			} catch {
				// Listener errors must not poison the broadcaster.
			}
		}
	}

	return {
		read() {
			return snapshot;
		},
		async refresh(platform) {
			if (inFlight) {
				return inFlight;
			}
			const promise = fetchPlanUsage(platform).then((result) => {
				inFlight = undefined;
				if (result.ok) {
					snapshot = { usage: result.usage, fetchedAt: Date.now() };
					notify();
				}
				return result;
			});
			inFlight = promise;
			return promise;
		},
		subscribe(listener) {
			listeners.add(listener);
			return {
				dispose() {
					listeners.delete(listener);
				},
			};
		},
		invalidate() {
			snapshot = undefined;
			inFlight = undefined;
			notify();
		},
	};
}

/**
 * Build a fresh `DashboardView`. The local data fetch is synchronous
 * (in-memory + memento); the platform call is awaited and may fail.
 */
export async function buildDashboardView(
	options: AggregatorOptions,
): Promise<DashboardView> {
	const { store } = options;
	const stats = store.read();
	const total = stats.total;

	const localView: DashboardView['local'] = {
		stats,
		today: store.readToday(),
		sevenDay: store.readRange(7),
		thirtyDay: store.readRange(30),
		perModel: Object.entries(stats.byModel)
			.map(([modelId, usage]) => ({ modelId, usage }))
			.sort((a, b) => b.usage.requests - a.usage.requests),
		dailySeries: store.readDailySeries(30),
	};

	const localSource: DashboardView['sources']['local'] =
		total.requests === 0 ? 'empty' : 'ok';

	let planSection: PlanUsage | undefined;
	let planSource: DashboardView['sources']['plan'] = 'unsupported';
	let planError: string | undefined;

	if (options.includePlatform === false) {
		planSource = 'unsupported';
	} else if (!options.platform) {
		planSource = 'unconfigured';
	} else {
		const result: PlanApiResult = await fetchPlanUsage(options.platform);
		if (result.ok) {
			planSection = result.usage;
			planSource = 'ok';
		} else {
			planSource = result.reason;
			planError = result.error;
		}
	}

	const view: DashboardView = {
		sources: {
			local: localSource,
			plan: planSource,
			planError,
		},
		local: localView,
	};
	if (planSection) {
		view.plan = planSection;
	}
	return view;
}

/** Sum a `ModelUsage` slice into a single total token count. */
export function totalTokens(usage: ModelUsage): number {
	return (
		usage.inputTokens +
		usage.outputTokens +
		usage.cacheReadTokens +
		usage.cacheWriteTokens
	);
}

/** Cached `Memento`-backed factory — re-exported here so the dashboard
 * package owns its dependency surface. */
export { createUsageStore };
