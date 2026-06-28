// Background poller that refreshes Token Plan quotas for every named
// API key in the pool. On activation the poller resolves the full
// key pool + secrets, builds a refresh-target list, and runs
// `planCache.refreshAll` on a 5-minute interval (honouring the TTL
// so redundant HTTP calls are avoided).
//
// The poller never installs anything, never logs in, and never sends
// API keys to non-official MiniMax hosts — the host classification
// mirrors the credential-leak guard in `fetchPlanUsage` (see
// `api.ts:host === null`).
//
// Two external callers drive the poller:
//   - The dashboard "Refresh" button → `poller.refresh({ force: true })`
//   - Chat turn end / config change → `poller.refresh()` (non-force,
//     TTL-respecting)

import { logger } from '../logger';
import type { PlanCache, PlanRefreshTarget } from './aggregator';
import type { PlanApiResult } from './api';
import { resolvePlatformHost } from '../consts';
import type { KeyManager } from '../keyManager';

export interface TokenPlanPollerHandle {
	/** Run a refresh cycle. When `force` is `true` the TTL is
	 *  bypassed for every key (used by the dashboard Refresh button).
	 *  Returns one `PlanApiResult` per target in insertion order. */
	refresh(options?: { force?: boolean }): Promise<PlanApiResult[]>;
	/** Stop the periodic timer and release resources. Idempotent. */
	dispose(): void;
	/** Whether this poller has been disposed. */
	readonly disposed: boolean;
}

/** Default polling interval — matches the platform's own auto-sync
 *  cadence for the Token Plan card. */
const DEFAULT_POLL_INTERVAL_MS = 5 * 60_000;

export interface TokenPlanPollerOptions {
	planCache: PlanCache;
	keyManager: KeyManager;
	/** Resolve a key's secret from SecretStorage. Called once per key
	 *  per refresh cycle. Returns `undefined` when the secret is
	 *  missing (the key is skipped). Accepts the keyId as the sole
	 *  argument. */
	fetchSecret: (keyId: string) => Promise<string | undefined>;
	/** Polling interval in ms. Default 5 minutes. */
	intervalMs?: number;
	/** Fetch implementation, injectable for tests. When present it
	 *  is forwarded to `planCache.refreshAll` so the mock replaces
	 *  the real network call. */
	fetchImpl?: typeof fetch;
}

export function createTokenPlanPoller(
	options: TokenPlanPollerOptions,
): TokenPlanPollerHandle {
	const { planCache, keyManager, fetchSecret, intervalMs = DEFAULT_POLL_INTERVAL_MS, fetchImpl } = options;
	let disposed = false;
	let timer: ReturnType<typeof setInterval> | undefined;

	// Subscribe to key-pool changes so a key add/delete/rename
	// triggers a fresh snapshot on the next poll cycle. The listener
	// is intentionally lightweight — it just lets the next `doRefresh`
	// pick up the new pool state; it doesn't force an immediate fetch.
	const changeDisposable = keyManager.onDidChange(() => {
		logger.debug('tokenPlanPoller.poolChanged', { component: 'poller' });
	});

	/**
	 * Resolve secrets for every key in the pool and return a list of
	 * fully-hydrated `PlanRefreshTarget` entries. Keys whose secret
	 * is missing are omitted — the poller never sends a partial or
	 * empty key to the platform.
	 */
	async function resolveTargets(): Promise<PlanRefreshTarget[]> {
		const snap = keyManager.snapshot();
		const targets: PlanRefreshTarget[] = [];
		for (const key of snap.keys) {
			if (key.missingSecret) continue;
			const secret = await fetchSecret(key.id);
			if (!secret) continue;
			const host = resolveHostFromUrl(key.apiBaseUrl);
			const fingerprint = `poll:${key.id}`;
			targets.push({
				keyId: key.id,
				apiKey: secret,
				host,
				fingerprint,
			});
		}
		return targets;
	}

	async function doRefresh(force: boolean): Promise<PlanApiResult[]> {
		if (disposed) return [];
		try {
			const targets = await resolveTargets();
			if (targets.length === 0) return [];
			logger.debug('tokenPlanPoller.refresh.start', {
				component: 'poller',
				targetCount: targets.length,
				force,
			});
			const results = await planCache.refreshAll(targets, { force, fetchImpl });
			const okCount = results.filter((r) => r.ok).length;
			logger.debug('tokenPlanPoller.refresh.end', {
				component: 'poller',
				okCount,
				total: results.length,
			});
			return results;
		} catch (error) {
			logger.warn('tokenPlanPoller.refresh.failed', error);
			return [];
		}
	}

	// Start the timer. The first tick fires immediately via
	// `setTimeout(..., 0)` so the first refresh happens without
	// waiting a full interval.
	timer = setInterval(() => {
		void doRefresh(false);
	}, intervalMs);
	// Immediate first tick — non-force so TTL is respected. Any
	// caller that needs a guaranteed-fresh result can pass `force:
	// true` via the `refresh` method.
	void doRefresh(false);

	return {
		refresh(options) {
			const force = options?.force === true;
			return doRefresh(force);
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			if (timer !== undefined) {
				clearInterval(timer);
				timer = undefined;
			}
			changeDisposable.dispose();
		},
		get disposed() {
			return disposed;
		},
	};
}

/**
 * Resolve a MiniMax base URL to a `host` value for `fetchPlanUsage`.
 * Mirrors the same rules as `commands.ts:detectHost` and
 * `keyManager.ts:resolveHost` — returns `'china'`, `'global'`, or
 * `null` for third-party proxies. The `null` path is the
 * credential-leak guard: `fetchPlanUsage` short-circuits to
 * `unsupported` without sending the key to MiniMax's endpoint.
 */
function resolveHostFromUrl(apiBaseUrl: string): 'china' | 'global' | null {
	const host = resolvePlatformHost(apiBaseUrl);
	if (host === null) return null;
	return host === 'api.minimaxi.com' ? 'china' : 'global';
}
