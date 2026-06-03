// Aggregator: stitches local usage accounting with the (optional)
// platform coding-plan response into a single `DashboardView`.

import { createUsageStore, type ModelUsage, type UsageStore } from '../usage';
import { fetchPlanUsage, type PlanApiOptions, type PlanApiResult } from './api';
import { readMmxCliStatus, type MmxCliStatus } from './mmxCli';
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
 * Build the local portion of the dashboard view from the usage store.
 */
function buildLocalView(store: UsageStore): DashboardView['local'] {
	const stats = store.read();
	return {
		stats,
		today: store.readToday(),
		sevenDay: store.readRange(7),
		thirtyDay: store.readRange(30),
		perModel: Object.entries(stats.byModel)
			.map(([modelId, usage]) => ({ modelId, usage }))
			.sort((a, b) => b.usage.requests - a.usage.requests),
		dailySeries: store.readDailySeries(30),
	};
}

export function buildCachedDashboardView(options: {
	store: UsageStore;
	planSnapshot?: PlanSnapshot;
	planSource: DashboardView['sources']['plan'];
	planError?: string;
	mmxCli?: MmxCliStatus;
}): DashboardView {
	const localView = buildLocalView(options.store);
	return {
		sources: {
			local: localView.stats.total.requests === 0 ? 'empty' : 'ok',
			plan: options.planSource,
			planError: options.planError,
		},
		local: localView,
		plan: options.planSnapshot?.usage,
		mmxCli: options.mmxCli ?? {
			install: 'unknown',
			version: null,
			binPath: null,
			auth: 'unknown',
			skill: 'unknown',
			agentReady: false,
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
	const localView = buildLocalView(options.store);
	const localSource: DashboardView['sources']['local'] =
		localView.stats.total.requests === 0 ? 'empty' : 'ok';

	let planSection: PlanUsage | undefined;
	let planSource: DashboardView['sources']['plan'] = 'unsupported';
	let planError: string | undefined;

	const mmxPromise = readMmxCliStatus().catch((): MmxCliStatus => ({
		install: 'unknown',
		version: null,
		binPath: null,
		auth: 'unknown',
		skill: 'unknown',
		agentReady: false,
	}));

	if (options.includePlatform === false) {
		planSource = 'unsupported';
		const mmxStatus: MmxCliStatus = await mmxPromise;
		return {
			sources: {
				local: localSource,
				plan: planSource,
			},
			local: localView,
			mmxCli: mmxStatus,
		};
	}

	const planPromise = options.platform
		? fetchPlanUsage(options.platform)
		: Promise.resolve<PlanApiResult>({ ok: false, reason: 'unconfigured' });

	const [planResult, mmxStatus] = await Promise.all([planPromise, mmxPromise]);

	if (!options.platform) {
		planSource = 'unconfigured';
	} else if (planResult.ok) {
		planSection = planResult.usage;
		planSource = 'ok';
	} else {
		planSource = planResult.reason;
		planError = planResult.error;
	}

	const view: DashboardView = {
		sources: {
			local: localSource,
			plan: planSource,
			planError,
		},
		local: localView,
		mmxCli: mmxStatus,
	};
	if (planSection) {
		view.plan = planSection;
	}
	return view;
}

/**
 * All-in tokens billed for the slice — input + cacheWrite + cacheRead + output.
 *
 * This is the number the dashboard's "Today" donut centre displays and
 * what you should multiply against the per-model price table to estimate
 * spend. Anthropic reports `usage.input_tokens` as the **incremental,
 * non-cached** input and reports `cache_creation_input_tokens` /
 * `cache_read_input_tokens` **on top of** that; both cache fields still
 * count toward spend (writes at the full rate, reads at the discounted
 * cache rate), so the all-in sum is the right one for "how much did I
 * touch?". The legend breaks out the four buckets individually so the
 * user can see what share of the traffic actually hit cache.
 */
export function totalTokens(usage: ModelUsage): number {
	return (
		usage.inputTokens +
		usage.cacheWriteTokens +
		usage.cacheReadTokens +
		usage.outputTokens
	);
}

/**
 * Net new tokens (incremental input that wasn't cached, plus output).
 * Useful for "how much actual new work did I do today" — the cache
 * prefix doesn't count here.
 */
export function totalNetTokens(usage: ModelUsage): number {
	return usage.inputTokens + usage.outputTokens;
}

/** Cached `Memento`-backed factory — re-exported here so the dashboard
 * package owns its dependency surface. */
export { createUsageStore };
