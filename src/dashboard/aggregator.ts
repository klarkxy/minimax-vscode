// Aggregator: stitches local Copilot-Chat usage accounting with the
// (optional) platform coding-plan response and the Claude Code JSONL
// ingest into a single `DashboardView`. The view carries per-source
// tabs (`copilot`, `claudeCode`) and a `total` field that is the
// element-wise sum of every available source.

import { createHash } from 'node:crypto';
import { createUsageStore, defaultStats, emptyUsage, sumRange, buildSeries, todayKey, type ModelUsage, type UsageStats, type UsageStore } from '../usage';
import { fetchPlanUsage, type PlanApiOptions, type PlanApiResult } from './api';
import { readMmxCliStatus, type MmxCliStatus } from './mmxCli';
import type { ClaudeCodeIngestHandle } from './claudeCodeIngest';
import type { ApiKeySummary, ClaudeCodeView, DashboardView, McpStatus, PlanUsage, SourceView, UsageScope } from './types';
import { MCP_PACKAGE_ARGS, MCP_PROVIDER_ID, MCP_PROVIDER_LABEL, pickMcpApiHost } from '../runtime/mcp';

export interface AggregatorOptions {
	store: UsageStore;
	platform: PlanApiOptions | null;
	/** When false, skips the platform API call (e.g. user toggle). */
	includePlatform?: boolean;
	/** Optional Claude Code ingester. When present, the view includes
	 *  a `claudeCode` section; when absent, the section is omitted. */
	claudeCodeIngest?: ClaudeCodeIngestHandle;
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
	/**
	 * Optional pre-computed MiniMax Web Search MCP provider snapshot.
	 * When omitted the aggregator emits the "not registered yet"
	 * placeholder so the cached path stays usable before the runtime
	 * module has had a chance to compute the real status (e.g. unit
	 * tests that don't wire up `registerMiniMaxMcpProvider`).
	 */
	mcp?: McpStatus;
	/** Resolver for the named API key pool. When present the view
	 *  surfaces the pool summary + active key id. Resolved on every
	 *  build, not captured, so the panel reflects the live state. */
	getKeyPool?: () => Promise<{ keys: ApiKeySummary[]; activeKeyId?: string }> | { keys: ApiKeySummary[]; activeKeyId?: string } | undefined;
	/** Selects which slice of Copilot usage the view exposes. The
	 *  default is `all`; the dashboard lets the user flip to a
	 *  per-key scope from the API Keys section. */
	usageScope?: UsageScope;
	/**
	 * Optional pre-computed multi-key plan snapshots. Built by the
	 *  panel from `PlanCache.readAll()` + the key pool snapshot so
	 *  the dashboard's Token Plan card can render the key selector
	 *  and per-key quota data. When omitted, the legacy `plan` field
	 *  is still populated for backward compat.
	 */
	allKeyPlans?: Record<string, import('./types').KeyPlanSnapshot>;
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
	/** The keyId this snapshot belongs to. Populated when the snapshot
	 *  was written through the multi-key API (`refreshKey` /
	 *  `refreshAll`). Legacy snapshots (written through the
	 *  single-key `refresh(platform)`) may leave this `undefined`. */
	keyId?: string;
}

/**
 * A single key that the poller / dashboard refresh loop should
 * refresh. Bundles the (apiKey, host) pair the underlying
 * `fetchPlanUsage` needs, plus the `keyId` so the cache can store
 * the snapshot under the right key.
 */
export interface PlanRefreshTarget {
	keyId: string;
	apiKey: string;
	host: 'china' | 'global' | null;
	fingerprint: string;
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
	 *
	 * When `options.keyId` is provided, the resulting snapshot is
	 * stored under that keyId so it can be retrieved via `readForKey`.
	 * Without a `keyId` the snapshot is only stored under its
	 * fingerprint (legacy behaviour preserved for callers that don't
	 * know about the multi-key layer yet).
	 */
	refresh(platform: PlanApiOptions, options?: { force?: boolean; keyId?: string }): Promise<PlanApiResult>;
	/** Read the snapshot for one specific keyId, if any. */
	readForKey(keyId: string): PlanSnapshot | undefined;
	/** Read every non-expired snapshot keyed by keyId. Used by the
	 *  dashboard to render the Token Plan card and by the status bar
	 *  to compose the all-keys tooltip. Expired snapshots are
	 *  filtered out — callers that want TTL-bypass should pass
	 *  `force: true` to `refreshKey` / `refreshAll`. */
	readAll(): Map<string, PlanSnapshot>;
	/** Refresh a single key. Honours the TTL window unless `force:
	 *  true` is passed. Returns the same result shape as
	 *  `fetchPlanUsage` (callers can decide whether to surface
	 *  errors). */
	refreshKey(target: PlanRefreshTarget, options?: { force?: boolean; fetchImpl?: typeof fetch }): Promise<PlanApiResult>;
	/** Refresh every supplied target. The 5-minute TTL is honoured
	 *  unless `force: true` is passed. In-flight dedup is keyed by
	 *  fingerprint so a parallel `refresh(platform)` for the same
	 *  identity still rides the same promise. */
	refreshAll(targets: PlanRefreshTarget[], options?: { force?: boolean; fetchImpl?: typeof fetch }): Promise<PlanApiResult[]>;
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
	/**
	 * Drop the snapshot + in-flight slot for one keyId. Mirrors
	 * `invalidate(fingerprint)` but keyed by keyId — used by the
	 * TokenPlanPoller when a key is deleted from the pool so the
	 * dead entry doesn't linger in the dashboard's `readAll()` map.
	 */
	invalidateKey(keyId: string): void;
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
	// Snapshots are keyed by keyId (primary) and fingerprint (legacy
	// reverse index). `read(platform)` continues to use the
	// fingerprint-based reverse lookup so existing callers see no
	// change. `readForKey` / `readAll` / `refreshKey` / `refreshAll`
	// all use the primary keyId index.
	const snapshots = new Map<string, PlanSnapshot>();
	/** fingerprint → keyId reverse index. Populated by `refresh` when
	 *  `platform.keyId` is provided. Used by `read(platform)` and
	 *  `readAll` to bridge the single-key and multi-key APIs. */
	const fingerprintToKeyId = new Map<string, string>();
	// In-flight dedup is keyed by fingerprint so a parallel
	// `refresh(platform)` and `refreshAll` for the same identity
	// still share the same HTTP promise.
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
				const fp = planCacheFingerprint(platform);
				const kid = fingerprintToKeyId.get(fp);
				return snapshots.get(kid ?? fp);
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
			const kid = options?.keyId;
			const storeKey = kid ?? fp;
			const cached = snapshots.get(storeKey);
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
						snapshots.set(storeKey, {
							usage: result.usage,
							fetchedAt: Date.now(),
							keyId: kid,
						});
						if (kid) {
							fingerprintToKeyId.set(fp, kid);
						}
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

		// ---- Multi-key API ----

		readForKey(keyId) {
			return snapshots.get(keyId);
		},
		readAll() {
			const result = new Map<string, PlanSnapshot>();
			const now = Date.now();
			for (const [keyId, snap] of snapshots) {
				// Skip fingerprint-only (legacy, non-keyId) entries
				// and expired snapshots.
				if (!snap.keyId) continue;
				if (now - snap.fetchedAt >= ttlMs) continue;
				result.set(keyId, snap);
			}
			return result;
		},
		async refreshKey(target, options) {
			const force = options?.force === true;
			const cached = snapshots.get(target.keyId);
			if (!force && cached && Date.now() - cached.fetchedAt < ttlMs) {
				return { ok: true, usage: cached.usage };
			}
			const fp = target.fingerprint;
			const pending = inFlight.get(fp);
			if (pending) {
				return pending;
			}
			const apiOptions: PlanApiOptions = {
				apiKey: target.apiKey,
				host: target.host,
				fetchImpl: options?.fetchImpl,
			};
			const promise = fetchPlanUsage(apiOptions)
				.then((result) => {
					if (result.ok) {
						snapshots.set(target.keyId, {
							usage: result.usage,
							fetchedAt: Date.now(),
							keyId: target.keyId,
						});
						fingerprintToKeyId.set(fp, target.keyId);
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
		async refreshAll(targets, options) {
			const force = options?.force === true;
			const results: PlanApiResult[] = [];
			for (const target of targets) {
				const result = await this.refreshKey(target, { force, fetchImpl: options?.fetchImpl });
				results.push(result);
			}
			return results;
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
				fingerprintToKeyId.clear();
			} else {
				// Support both legacy (snapshot stored under
				// fingerprint directly, no keyId) and new (snapshot
				// stored under keyId, fingerprint in reverse map)
				// entries. Without this, `invalidate(fp)` on a
				// legacy snapshot is a no-op.
				const kid = fingerprintToKeyId.get(fingerprint);
				if (kid) {
					snapshots.delete(kid);
					fingerprintToKeyId.delete(fingerprint);
				} else {
					snapshots.delete(fingerprint);
				}
				inFlight.delete(fingerprint);
			}
			notify();
		},
		invalidateKey(keyId) {
			snapshots.delete(keyId);
			// Also remove the fingerprint → keyId reverse mapping
			// for this key so a subsequent `read(platform)` doesn't
			// resolve to a deleted keyId.
			for (const [fp, kid] of fingerprintToKeyId) {
				if (kid === keyId) {
					fingerprintToKeyId.delete(fp);
					inFlight.delete(fp);
				}
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

/** Build a `SourceView` from a single `UsageStats` blob. Used both
 *  for the per-key scope and as the building block for the
 *  all-keys aggregate. */
function viewFromStats(stats: UsageStats): SourceView {
	return {
		today: { ...(stats.daily[todayKey()] ?? emptyUsage()) },
		sevenDay: sumRange(stats.daily, 7),
		thirtyDay: sumRange(stats.daily, 30),
		perModel: Object.entries(stats.byModel)
			.map(([modelId, usage]) => ({ modelId, usage }))
			.sort((a, b) => b.usage.requests - a.usage.requests),
		dailySeries: buildSeries(stats.daily, 30),
	};
}

/** Sum every key's `UsageStats` into one virtual `UsageStats`.
 *  Used for the all-keys Copilot usage view in the dashboard.
 *  Defensive: empty / null maps produce a fresh default. */
function aggregateKeyScopes(map: Record<string, UsageStats>): UsageStats {
	const out: UsageStats = defaultStats();
	for (const value of Object.values(map)) {
		if (!value) continue;
		// `addUsage` is pure and returns a new `ModelUsage`; the
		// accumulator slots on `out` (total, per-model, per-day) must
		// be replaced with the merged value, otherwise every `add`
		// silently no-ops and the all-keys aggregate stays empty.
		out.total = addUsage(out.total, value.total);
		for (const [modelId, usage] of Object.entries(value.byModel)) {
			const prev = out.byModel[modelId] ?? emptyUsage();
			out.byModel[modelId] = addUsage(prev, usage);
		}
		for (const [date, usage] of Object.entries(value.daily)) {
			const prev = out.daily[date] ?? emptyUsage();
			out.daily[date] = addUsage(prev, usage);
		}
	}
	return out;
}

/** Build a per-key `SourceView` from the store's readAllKeys map. */
function buildCopilotViewForKeyId(store: UsageStore, keyId: string): SourceView {
	return viewFromStats(store.readForKey(keyId));
}

/** Build the all-keys aggregate `SourceView`. */
function buildCopilotViewAllKeys(store: UsageStore): SourceView {
	return viewFromStats(aggregateKeyScopes(store.readAllKeys()));
}

/** Resolve the key pool resolver, accepting either a sync or
 *  async result. The dashboard prefers the async form so it can
 *  enrich the snapshot with per-key `missingSecret` flags
 *  without blocking the metadata read. Returns `undefined` when
 *  the resolver is missing or returns a falsy snapshot. */
async function resolveKeyPool(
	resolver: (() => Promise<{ keys: ApiKeySummary[]; activeKeyId?: string }> | { keys: ApiKeySummary[]; activeKeyId?: string } | undefined) | undefined,
): Promise<{ keys: ApiKeySummary[]; activeKeyId?: string } | undefined> {
	if (!resolver) return undefined;
	const out = resolver();
	if (out instanceof Promise) {
		return await out;
	}
	return out;
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
 * Build the `mcp` field of the dashboard view. Kept here (rather
 * than inside `panel.ts`) so the cached and the live paths compute
 * the same shape — they MUST be byte-identical or the webview will
 * flicker on every refresh.
 *
 * Pure data: no VS Code API, no `vscode.workspace` reads. The
 * `apiBaseUrl` and `hasApiKey` are passed in by the caller so the
 * aggregator stays testable. When the host is unknown, `reason`
 * carries the localised explanation string the dashboard renders.
 */
export function buildMcpStatus(options: {
	apiBaseUrl: string;
	hasApiKey: boolean;
	/**
	 * Whether the MiniMax extension has actually called
	 * `vscode.lm.registerMcpServerDefinitionProvider` for this
	 * process. The dashboard uses this to distinguish "provider
	 * registered with VS Code, but the current config makes the
	 * definition not ready" (e.g. missing key) from "the provider
	 * hasn't been registered yet at all" (lifecycle error).
	 */
	providerRegistered: boolean;
	/** Localised explanation string for the dashboard to render
	 *  inline when `ready` is `false`. Empty when `ready` is true.
	 *  Kept as a parameter so the aggregator never depends on
	 *  `i18n.ts` (UI strings live in the dashboard layer). */
	reason: string;
}): McpStatus {
	const { host, fromProxy } = pickMcpApiHost(options.apiBaseUrl);
	const ready = options.hasApiKey && host !== null;
	return {
		ready,
		providerRegistered: options.providerRegistered,
		providerId: MCP_PROVIDER_ID,
		providerLabel: MCP_PROVIDER_LABEL,
		host,
		hostFromProxy: fromProxy,
		hasApiKey: options.hasApiKey,
		command: 'uvx',
		args: MCP_PACKAGE_ARGS.slice(),
		reason: ready ? '' : options.reason,
	};
}

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

export async function buildCachedDashboardView(options: {
	store: UsageStore;
	planSnapshot?: PlanSnapshot;
	planSource: DashboardView['sources']['plan'];
	planError?: string;
	mmxCli?: MmxCliStatus;
	/** Optional pre-computed MCP provider snapshot. When omitted
	 *  we fall back to the "not registered yet" placeholder so
	 *  the cached path can be invoked before the runtime module
	 *  has had a chance to compute the real status (e.g. unit
	 *  tests). */
	mcp?: McpStatus;
	claudeCodeIngest?: ClaudeCodeIngestHandle;
	/** Mirror of `AggregatorOptions.getKeyPool`. Resolved at build
	 *  time so the panel reflects the live state. */
	getKeyPool?: () => Promise<{ keys: ApiKeySummary[]; activeKeyId?: string }> | { keys: ApiKeySummary[]; activeKeyId?: string } | undefined;
	/** Selects which slice of Copilot usage the view exposes. The
	 *  default is `all`; the dashboard lets the user flip to a
	 *  per-key scope from the API Keys section. */
	usageScope?: UsageScope;
	/**
	 * Optional pre-computed multi-key plan snapshots. Built by the
	 *  panel from `PlanCache.readAll()` + the key pool snapshot so
	 *  the dashboard's Token Plan card can render the key selector
	 *  and per-key quota data. When omitted, the legacy `plan` field
	 *  is still populated for backward compat.
	 */
	allKeyPlans?: Record<string, import('./types').KeyPlanSnapshot>;
}): Promise<DashboardView> {
	const usageScope: UsageScope = options.usageScope ?? { kind: 'all' };
	const copilotView = resolveCopilotView(options.store, usageScope);
	const allKeysCopilot = buildCopilotViewAllKeys(options.store);
	const claudeCode = buildClaudeCodeView(options.claudeCodeIngest);
	const sourceViews: SourceView[] = [copilotView];
	if (claudeCode) sourceViews.push(claudeCode);
	const total = aggregateSourceViews(sourceViews);
	const keyPool = await resolveKeyPool(options.getKeyPool);
	return {
		sources: {
			copilot: copilotView.today.requests === 0 && copilotView.sevenDay.requests === 0 ? 'empty' : 'ok',
			claudeCode: claudeCode?.status.state ?? 'disabled',
			claudeCodeError: claudeCode?.status.lastError ?? undefined,
			plan: options.planSource,
			planError: options.planError,
		},
		total,
		copilot: copilotView,
		claudeCode,
		plan: options.planSnapshot?.usage,
		allKeyPlans: undefined,
		mmxCli: options.mmxCli ?? {
			install: 'unknown',
			version: null,
			binPath: null,
			auth: 'unknown',
			skill: 'unknown',
			agentReady: false,
		},
		mcp: options.mcp ?? {
			ready: false,
			providerRegistered: false,
			providerId: MCP_PROVIDER_ID,
			providerLabel: MCP_PROVIDER_LABEL,
			host: null,
			hostFromProxy: false,
			hasApiKey: false,
			command: 'uvx',
			args: MCP_PACKAGE_ARGS.slice(),
			reason: '',
		},
		apiKeys: keyPool?.keys ?? [],
		activeKeyId: keyPool?.activeKeyId,
		usageScope,
		allKeysCopilot,
	};
}

/** Resolve the Copilot usage view based on the dashboard's
 *  current `usageScope`. `all` returns the all-keys aggregate so
 *  the "总" tab is always the cross-key total; per-key scopes are
 *  used when the user explicitly opens a key in the dropdown. */
function resolveCopilotView(store: UsageStore, scope: UsageScope): SourceView {
	if (scope.kind === 'key') {
		return buildCopilotViewForKeyId(store, scope.keyId);
	}
	return buildCopilotViewAllKeys(store);
}

/**
 * Build a fresh `DashboardView`. The local data fetch is synchronous
 * (in-memory + memento); the platform call is awaited and may fail.
 */
export async function buildDashboardView(
	options: AggregatorOptions,
): Promise<DashboardView> {
	const usageScope: UsageScope = options.usageScope ?? { kind: 'all' };
	const copilotView = resolveCopilotView(options.store, usageScope);
	const allKeysCopilot = buildCopilotViewAllKeys(options.store);
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
		const keyPool = await resolveKeyPool(options.getKeyPool);
		return {
			sources: {
				copilot: copilotSource,
				claudeCode: claudeCode?.status.state ?? 'disabled',
				claudeCodeError: claudeCode?.status.lastError ?? undefined,
				plan: planSource,
			},
			total,
			copilot: copilotView,
			claudeCode,
			mmxCli: mmxStatus,
			mcp: options.mcp ?? {
				ready: false,
				providerRegistered: false,
				providerId: MCP_PROVIDER_ID,
				providerLabel: MCP_PROVIDER_LABEL,
				host: null,
				hostFromProxy: false,
				hasApiKey: false,
				command: 'uvx',
				args: MCP_PACKAGE_ARGS.slice(),
				reason: '',
			},
			apiKeys: keyPool?.keys ?? [],
			activeKeyId: keyPool?.activeKeyId,
			usageScope,
			allKeysCopilot,
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

	// Defensive: `fetchPlanUsage` resolves (never rejects) in the
	// current implementation, but a future custom `fetchImpl` injected
	// by a caller, or a runtime bug in the JSON parser, could throw
	// and crash the whole dashboard render. Anchor the failure to
	// `planSource = 'error'` so the user sees the platform card as
	// failed rather than a blank / broken dashboard.
	const safePlanPromise = planPromise.catch((error: unknown) => ({
		ok: false as const,
		reason: 'error' as const,
		error: error instanceof Error ? error.message : String(error),
	}));

	const [planResult, mmxStatus] = await Promise.all([safePlanPromise, mmxPromise]);

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

	const keyPool = await resolveKeyPool(options.getKeyPool);
	const view: DashboardView = {
		sources: {
			copilot: copilotSource,
			claudeCode: claudeCode?.status.state ?? 'disabled',
			claudeCodeError: claudeCode?.status.lastError ?? undefined,
			plan: planSource,
			planError,
		},
		total,
		copilot: copilotView,
		claudeCode,
		mmxCli: options.mmxCliStatus ?? mmxStatus,
		allKeyPlans: options.allKeyPlans,
		mcp: options.mcp ?? {
			ready: false,
			providerRegistered: false,
			providerId: MCP_PROVIDER_ID,
			providerLabel: MCP_PROVIDER_LABEL,
			host: null,
			hostFromProxy: false,
			hasApiKey: false,
			command: 'uvx',
			args: MCP_PACKAGE_ARGS.slice(),
			reason: '',
		},
		apiKeys: keyPool?.keys ?? [],
		activeKeyId: keyPool?.activeKeyId,
		usageScope,
		allKeysCopilot,
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
