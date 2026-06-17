// Aggregator: stitches local Copilot-Chat usage accounting with the
// (optional) platform coding-plan response and the Claude Code JSONL
// ingest into a single `DashboardView`. The view carries per-source
// tabs (`copilot`, `claudeCode`, ...) and a `total` field that is the
// element-wise sum of every available source.

import { createHash } from 'node:crypto';
import { createUsageStore, type ModelUsage, type UsageStore } from '../usage';
import { fetchPlanUsage, type PlanApiOptions, type PlanApiResult } from './api';
import { readMmxCliStatus, type MmxCliStatus } from './mmxCli';
import type { ClaudeCodeIngestHandle } from './claudeCodeIngest';
import type { CodexIngestHandle } from './codexIngest';
import type { OpencodeIngestHandle } from './opencodeIngest';
import type { ClaudeCodeView, CodexView, OpencodeView, DashboardView, PlanUsage, SourceView } from './types';

export interface AggregatorOptions {
	store: UsageStore;
	platform: PlanApiOptions | null;
	/** When false, skips the platform API call (e.g. user toggle). */
	includePlatform?: boolean;
	/** Optional Claude Code ingester. When present, the view includes
	 *  a `claudeCode` section; when absent, the section is omitted. */
	claudeCodeIngest?: ClaudeCodeIngestHandle;
	/** Optional Codex ingester. When present, the view includes a
	 *  `codex` section; when absent, the section is omitted. */
	codexIngest?: CodexIngestHandle;
	/** Optional OpenCode ingester. When present, the view includes an
	 *  `opencode` section; when absent, the section is omitted. */
	opencodeIngest?: OpencodeIngestHandle;
	/** Clock — overridable for tests. */
	now?: () => Date;
	/**
	 * Optional pre-fetched platform snapshot. When provided, the
	 * aggregator reuses it instead of issuing a new `fetchPlanUsage`
	 * call — saves a round-trip on the common refresh path where the
	 * dashboard panel has just consulted the shared PlanCache.
	 */
	planSnapshot?: PlanSnapshot;
	/**
	 * Optional pre-fetched mmx-cli status. When provided, the aggregator
	 * reuses it instead of calling `readMmxCliStatus` again. Mirrors the
	 * `planSnapshot` contract: the dashboard consults `MmxCliCache`
	 * before calling the aggregator.
	 */
	mmxCliStatus?: MmxCliStatus;
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
	/** Most recent successful snapshot for this identity, or the latest snapshot overall when omitted. */
	read(platform?: PlanApiOptions): PlanSnapshot | undefined;
	/**
	 * Fetch a fresh snapshot. The same in-flight promise is returned to
	 * concurrent callers with the same `(apiKey, host)` fingerprint so
	 * the underlying HTTP request is only ever made once per identity.
	 * Failures are NOT cached; subsequent calls will retry.
	 *
	 * `force: true` bypasses the TTL window — used by the dashboard's
	 * Refresh button and any caller that needs a guaranteed-fresh
	 * round-trip.
	 */
	refresh(platform: PlanApiOptions, options?: { force?: boolean }): Promise<PlanApiResult>;
	/** Subscribe to cache-changed events. Returns a Disposable. */
	subscribe(listener: () => void): { dispose(): void };
	/**
	 * Invalidate. By default clears every fingerprint's snapshot
	 * AND in-flight slot. With a `fingerprint` argument, only that
	 * one identity is cleared (e.g. an API-key replacement should
	 * drop the old key's snapshot but leave other keys' snapshots
	 * intact, if any).
	 */
	invalidate(fingerprint?: string): void;
}

/**
 * Stable, low-cardinality identity for a `(apiKey, host)` tuple. Used
 * as the map key in `createPlanCache`'s snapshot / in-flight maps.
 * 16 hex chars of SHA-256 is more than enough to disambiguate
 * distinct (key, host) combinations without storing the secret in
 * the key. Matches the `sha256(...).slice(0, 16)` pattern already in
 * use at `src/provider/debug/dump.ts:424-426`.
 */
export function planCacheFingerprint(platform: PlanApiOptions): string {
	const host = platform.host ?? 'china';
	return createHash('sha256')
		.update(`${host}|${platform.apiKey}`)
		.digest('hex')
		.slice(0, 16);
}

/** Create a fresh PlanCache — one per extension host. */
export function createPlanCache(options?: { ttlMs?: number }): PlanCache {
	const ttlMs = options?.ttlMs ?? DEFAULT_PLAN_CACHE_TTL_MS;
	// Snapshots and in-flight promises are keyed by fingerprint, so a
	// switch from key A to key B (or from China to a third-party
	// proxy) doesn't serve the old identity's data. Codex's
	// adversarial review Finding 2 closed this; the previous single-
	// snapshot implementation returned the old account's quota
	// under the new identity for up to 5 minutes.
	const snapshots = new Map<string, PlanSnapshot>();
	const inFlight = new Map<string, Promise<PlanApiResult>>();
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
		read(platform) {
			if (platform) {
				return snapshots.get(planCacheFingerprint(platform));
			}
			// Return the most recently written snapshot. The cache is
			// designed for one primary identity (the current key +
			// host) — older fingerprints, if any, are still cached for
			// fast read but won't be returned unless no other
			// fingerprint has been written yet. The dashboard code
			// calls `invalidate(fingerprint)` before swapping, so in
			// practice this is always the active identity.
			let mostRecent: PlanSnapshot | undefined;
			for (const snap of snapshots.values()) {
				if (!mostRecent || snap.fetchedAt > mostRecent.fetchedAt) {
					mostRecent = snap;
				}
			}
			return mostRecent;
		},
		async refresh(platform, options) {
			// Skip the network round-trip when the cached snapshot
			// for THIS fingerprint is still inside the TTL window.
			// `force: true` bypasses the TTL (used by the dashboard's
			// Refresh button).
			const fp = planCacheFingerprint(platform);
			const cached = snapshots.get(fp);
			const force = options?.force === true;
			if (!force && cached && Date.now() - cached.fetchedAt < ttlMs) {
				return { ok: true, usage: cached.usage };
			}
			// Deduplicate concurrent calls per fingerprint: while a
			// fetch is in flight, every caller with the same identity
			// shares the same promise. Different fingerprints (e.g.
			// China vs global vs proxy) have independent in-flight
			// promises — the previous single-`inFlight` slot would
			// either force China callers to wait on a global fetch
			// (or vice versa) or replay a stale promise. The
			// `.finally()` release covers both success and failure
			// paths.
			const pending = inFlight.get(fp);
			if (pending) {
				return pending;
			}
			const promise = fetchPlanUsage(platform)
				.then((result) => {
					if (result.ok) {
						snapshots.set(fp, {
							usage: result.usage,
							fetchedAt: Date.now(),
						});
						notify();
					}
					return result;
				})
				.finally(() => {
					inFlight.delete(fp);
				});
			inFlight.set(fp, promise);
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
		invalidate(fingerprint) {
			if (fingerprint === undefined) {
				snapshots.clear();
				inFlight.clear();
			} else {
				snapshots.delete(fingerprint);
				inFlight.delete(fingerprint);
			}
			notify();
		},
	};
}

/**
 * Default in-process TTL for the PlanCache. Five minutes matches the
 * cadence the platform's own UI shows when it auto-syncs the Token
 * Plan card — a burst of `refresh()` calls (e.g. one per chat turn)
 * collapses into a single HTTP round-trip per window. Overridable
 * per-instance for tests.
 */
const DEFAULT_PLAN_CACHE_TTL_MS = 5 * 60_000;

/**
 * Build the Copilot-Chat portion of the dashboard view from the usage
 * store. Always present — the local store is created at extension
 * activation. The returned shape matches `SourceView` so the
 * dashboard's chart / table helpers work for both the per-source
 * tabs and the aggregate "总" tab.
 */
function buildCopilotView(store: UsageStore): SourceView {
	return {
		today: store.readToday(),
		sevenDay: store.readRange(7),
		thirtyDay: store.readRange(30),
		perModel: Object.entries(store.read().byModel)
			.map(([modelId, usage]) => ({ modelId, usage }))
			.sort((a, b) => b.usage.requests - a.usage.requests),
		dailySeries: store.readDailySeries(30),
	};
}

/**
 * Build the Claude Code portion of the dashboard view. Returns
 * `undefined` when no ingester is running — the "claude" tab is hidden
 * in that case. The returned shape extends `SourceView` so the
 * dashboard can use the same chart/table helpers plus the status row.
 */
function buildClaudeCodeView(
	handle: ClaudeCodeIngestHandle | undefined,
): ClaudeCodeView | undefined {
	if (!handle) return undefined;
	const store = handle.store;
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
		status: handle.status(),
	};
}

/** Build the Codex portion of the dashboard view. Mirrors
 *  `buildClaudeCodeView` — the three ingest tabs are
 *  indistinguishable to the webview. */
function buildCodexView(
	handle: CodexIngestHandle | undefined,
): CodexView | undefined {
	if (!handle) return undefined;
	const store = handle.store;
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
		status: handle.status(),
	};
}

/** Build the OpenCode portion of the dashboard view. Same shape as
 *  `buildClaudeCodeView` / `buildCodexView`. */
function buildOpencodeView(
	handle: OpencodeIngestHandle | undefined,
): OpencodeView | undefined {
	if (!handle) return undefined;
	const store = handle.store;
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
		status: handle.status(),
	};
}

/** Add two `ModelUsage` buckets element-wise. */
function addUsage(a: ModelUsage, b: ModelUsage): ModelUsage {
	return {
		inputTokens: a.inputTokens + b.inputTokens,
		cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
		cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
		outputTokens: a.outputTokens + b.outputTokens,
		requests: a.requests + b.requests,
	};
}

const EMPTY_USAGE: ModelUsage = {
	inputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	outputTokens: 0,
	requests: 0,
};

/**
 * Sum a list of per-source views into a single aggregate. Used for
 * the "总" tab so a user with N source tabs sees a single set of
 * all-in totals without having to add the tabs themselves.
 *
 * Aggregation rules:
 *   - `today` / `sevenDay` / `thirtyDay` are summed element-wise.
 *   - `perModel` entries are merged by `modelId` (the same model used
 *     by two sources still shows up as one row).
 *   - `dailySeries` is merged by date and re-sorted ascending.
 *
 * Returns an empty `SourceView` when no sources are passed.
 */
function aggregateSourceViews(views: SourceView[]): SourceView {
	if (views.length === 0) {
		return {
			today: { ...EMPTY_USAGE },
			sevenDay: { ...EMPTY_USAGE },
			thirtyDay: { ...EMPTY_USAGE },
			perModel: [],
			dailySeries: [],
		};
	}
	const today = views.reduce<ModelUsage>(
		(acc, v) => addUsage(acc, v.today),
		{ ...EMPTY_USAGE },
	);
	const sevenDay = views.reduce<ModelUsage>(
		(acc, v) => addUsage(acc, v.sevenDay),
		{ ...EMPTY_USAGE },
	);
	const thirtyDay = views.reduce<ModelUsage>(
		(acc, v) => addUsage(acc, v.thirtyDay),
		{ ...EMPTY_USAGE },
	);
	const perModel = new Map<string, ModelUsage>();
	for (const v of views) {
		for (const row of v.perModel) {
			const existing = perModel.get(row.modelId) ?? { ...EMPTY_USAGE };
			perModel.set(row.modelId, addUsage(existing, row.usage));
		}
	}
	const dailySeries = new Map<string, ModelUsage>();
	for (const v of views) {
		for (const row of v.dailySeries) {
			const existing = dailySeries.get(row.date) ?? { ...EMPTY_USAGE };
			dailySeries.set(row.date, addUsage(existing, row.usage));
		}
	}
	return {
		today,
		sevenDay,
		thirtyDay,
		perModel: Array.from(perModel.entries())
			.map(([modelId, usage]) => ({ modelId, usage }))
			.sort((a, b) => b.usage.requests - a.usage.requests),
		dailySeries: Array.from(dailySeries.entries())
			.map(([date, usage]) => ({ date, usage }))
			.sort((a, b) => a.date.localeCompare(b.date)),
	};
}

export function buildCachedDashboardView(options: {
	store: UsageStore;
	planSnapshot?: PlanSnapshot;
	planSource: DashboardView['sources']['plan'];
	planError?: string;
	mmxCli?: MmxCliStatus;
	claudeCodeIngest?: ClaudeCodeIngestHandle;
	codexIngest?: CodexIngestHandle;
	opencodeIngest?: OpencodeIngestHandle;
}): DashboardView {
	const copilotView = buildCopilotView(options.store);
	const claudeCode = buildClaudeCodeView(options.claudeCodeIngest);
	const codex = buildCodexView(options.codexIngest);
	const opencode = buildOpencodeView(options.opencodeIngest);
	const sourceViews: SourceView[] = [copilotView];
	if (claudeCode) sourceViews.push(claudeCode);
	if (codex) sourceViews.push(codex);
	if (opencode) sourceViews.push(opencode);
	const total = aggregateSourceViews(sourceViews);
	return {
		sources: {
			copilot: copilotView.today.requests === 0 && copilotView.sevenDay.requests === 0 ? 'empty' : 'ok',
			claudeCode: claudeCode?.status.state ?? 'disabled',
			claudeCodeError: claudeCode?.status.lastError ?? undefined,
			codex: codex?.status.state ?? 'disabled',
			codexError: codex?.status.lastError ?? undefined,
			opencode: opencode?.status.state ?? 'disabled',
			opencodeError: opencode?.status.lastError ?? undefined,
			plan: options.planSource,
			planError: options.planError,
		},
		total,
		copilot: copilotView,
		claudeCode,
		codex,
		opencode,
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
	const copilotView = buildCopilotView(options.store);
	const copilotSource: DashboardView['sources']['copilot'] =
		copilotView.today.requests === 0 && copilotView.sevenDay.requests === 0 ? 'empty' : 'ok';
	const claudeCode = buildClaudeCodeView(options.claudeCodeIngest);
	const sourceViews: SourceView[] = [copilotView];
	if (claudeCode) sourceViews.push(claudeCode);
	const total = aggregateSourceViews(sourceViews);

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
		const mmxStatus: MmxCliStatus = options.mmxCliStatus ?? (await mmxPromise);
		const codex = buildCodexView(options.codexIngest);
		const opencode = buildOpencodeView(options.opencodeIngest);
		if (codex) sourceViews.push(codex);
		if (opencode) sourceViews.push(opencode);
		const totalNoPlan = aggregateSourceViews(sourceViews);
		return {
			sources: {
				copilot: copilotSource,
				claudeCode: claudeCode?.status.state ?? 'disabled',
				claudeCodeError: claudeCode?.status.lastError ?? undefined,
				codex: codex?.status.state ?? 'disabled',
				codexError: codex?.status.lastError ?? undefined,
				opencode: opencode?.status.state ?? 'disabled',
				opencodeError: opencode?.status.lastError ?? undefined,
				plan: planSource,
			},
			total: totalNoPlan,
			copilot: copilotView,
			claudeCode,
			codex,
			opencode,
			mmxCli: mmxStatus,
		};
	}

	// Reuse a pre-fetched snapshot when the caller has one — that's
	// the common dashboard path, where the panel consults the shared
	// PlanCache before calling the aggregator. Without this, every
	// refresh would issue a second `fetchPlanUsage` even when the
	// cache already has fresh data.
	//
	// `planSnapshot` takes precedence over `platform` — a snapshot
	// was already obtained against a (now possibly stale) platform
	// config and is authoritative for this refresh. Without this
	// precedence, a caller that flips `includePlatform` to true and
	// passes a snapshot captured under the old key would see
	// `planSource` flip to `'unconfigured'` after the snapshot
	// resolved as `{ ok: true, ... }`, hiding the snapshot's data.
	const planPromise: Promise<PlanApiResult> = options.planSnapshot
		? Promise.resolve<PlanApiResult>({ ok: true, usage: options.planSnapshot.usage })
		: options.platform
			? fetchPlanUsage(options.platform)
			: Promise.resolve<PlanApiResult>({ ok: false, reason: 'unconfigured' });

	const [planResult, mmxStatus] = await Promise.all([planPromise, mmxPromise]);

	if (planResult.ok) {
		planSection = planResult.usage;
		planSource = 'ok';
	} else if (!options.platform && !options.planSnapshot) {
		// `!platform` alone is the "user has not configured a key"
		// signal; if they HAVE configured a key but the fetch just
		// failed, fall through to surface the failure reason below.
		planSource = 'unconfigured';
	} else {
		planSource = planResult.reason;
		planError = planResult.error;
	}

	const codex = buildCodexView(options.codexIngest);
	const opencode = buildOpencodeView(options.opencodeIngest);
	if (codex) sourceViews.push(codex);
	if (opencode) sourceViews.push(opencode);
	const totalWithPlan = aggregateSourceViews(sourceViews);

	const view: DashboardView = {
		sources: {
			copilot: copilotSource,
			claudeCode: claudeCode?.status.state ?? 'disabled',
			claudeCodeError: claudeCode?.status.lastError ?? undefined,
			codex: codex?.status.state ?? 'disabled',
			codexError: codex?.status.lastError ?? undefined,
			opencode: opencode?.status.state ?? 'disabled',
			opencodeError: opencode?.status.lastError ?? undefined,
			plan: planSource,
			planError,
		},
		total: totalWithPlan,
		copilot: copilotView,
		claudeCode,
		codex,
		opencode,
		mmxCli: options.mmxCliStatus ?? mmxStatus,
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
