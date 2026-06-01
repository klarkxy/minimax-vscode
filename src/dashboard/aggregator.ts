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
