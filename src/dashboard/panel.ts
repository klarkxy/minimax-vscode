// Dashboard webview panel.
//
// The panel owns its own lifetime: callers invoke `DashboardPanel.show`
// and we either reveal the existing panel or create a new one. Data
// is pushed in via `setData` (which re-renders) and via subscriptions
// to the usage store, so a fresh chat that lands a token record will
// cause the panel to re-render with up-to-date numbers.
//
// Messages from the webview are routed through the small switch in
// `handleMessage`. The webview only receives the data it needs; we
// never expose the raw store object.

import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { logger } from '../logger';
import { t } from '../i18n';
import type { UsageStore } from '../usage';
import type { AuthManager } from '../auth';
import {
	DASHBOARD_LOCALE_CHANGE,
	dashboardMessages,
	pickDashboardLocale,
	type DashboardLocale,
	type DashboardMessages,
} from './messages';
import { buildCachedDashboardView, buildDashboardView, buildMcpStatus, type PlanCache } from './aggregator';
import { copyMmxInstallPrompt, type MmxCliStatus } from './mmxCli';
import { getBaseUrl } from '../config';
import { pickMcpApiHost } from '../runtime/mcp';
import type { MmxCliCache } from './mmxCliCache';
import type { ClaudeCodeIngestHandle } from './claudeCodeIngest';
import type { TokenPlanPollerHandle } from './tokenPlanPoller';
import type { DashboardView } from './types';
import { escapeHtml, escapeJsonForScript, htmlLangFor } from './template';

export interface DashboardPanelDeps {
	extensionUri: vscode.Uri;
	auth: AuthManager;
	usageStore: UsageStore;
	/** Shared plan cache (status bar reads from this too). */
	planCache: PlanCache;
	/** Shared mmx-cli status cache. The dashboard reads it on the
	 *  first paint so the section shows the last-known state instead
	 *  of "unknown" while the next refresh runs. */
	mmxCliCache: MmxCliCache;
	/** Optional Claude Code JSONL ingester. When present, the
	 *  dashboard subscribes to its store and renders the "Claude Code
	 *  usage" section. When absent (e.g. extension loaded before the
	 *  ingester's `activate()` call), the section is rendered as a
	 *  thin "disabled" placeholder. */
	claudeCodeIngest?: ClaudeCodeIngestHandle;
	/** Optional Token Plan poller. When present, the dashboard's
	 *  Refresh button triggers `poller.refresh({ force: true })`
	 *  which refreshes all named keys in one batch. Without the
	 *  poller the panel falls back to `planCache.refresh(platform)`
	 *  for the active key only (backward-compatible). */
	tokenPlanPoller?: TokenPlanPollerHandle;
	/**
	 * Resolver for the live platform host. Evaluated at every
	 * refresh / install-prompt dispatch, NOT captured at construction
	 * — the user can change `minimax.apiBaseUrl` while the panel is
	 * open, and the next refresh must reflect that change (otherwise
	 * the PlanCache would forward the user's key to whichever host
	 * the panel was opened against, which is the same credential-leak
	 * path that the upstream `fetchPlanUsage` short-circuit was
	 * designed to close).
	 *
	 * `null` means the user is on a third-party proxy — the dashboard
	 * renders the plan section as `'unsupported'` and the mmx
	 * install-prompt falls back to the international variant.
	 */
	getHost?: () => 'china' | 'global' | null;
	/**
	 * Resolver for the live MCP provider "is registered" state.
	 * Defaults to `false` when not supplied (e.g. unit tests that
	 * don't wire up the runtime). The dashboard uses this to
	 * distinguish "the extension has registered the MCP provider
	 * with VS Code" from "the provider is missing or the lifecycle
	 * skipped registration" — the difference is invisible to the
	 * user-facing ready flag, which only reflects whether the
	 * current config would yield a working definition.
	 */
	getMcpProviderRegistered?: () => boolean;
}

const VIEW_TYPE = 'minimax.dashboard';
const LOG_PREFIX = '[MiniMax Dashboard]';

interface DashboardPanelState {
	locale: DashboardLocale;
}

export class DashboardPanel {
	private static current: DashboardPanel | undefined;

	private readonly panel: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly authChangeSubscription: vscode.Disposable;
	private readonly claudeCodeSubscription: vscode.Disposable | undefined;
	private state: DashboardPanelState = { locale: 'en' };
	private inFlight = false;
	private pendingRefresh = false;
	private pendingRefreshForce = false;
	private refreshSeq = 0;
	/**
	 * Whether a `data` frame has EVER been delivered to this webview.
	 * Drives the first-paint behaviour: the very first refresh posts
	 * an "initial loading" data frame (so the user sees something
	 * better than the static `<div class="empty">刷新…</div>`
	 * placeholder); subsequent refreshes never re-post that loading
	 * frame even when they have to await a plan fetch — they keep
	 * showing the previous data and only swap it once the new view is
	 * built. This is the load-bearing flag that closes the
	 * "cached-loading overwrites final-ok" bug from issue #5.
	 */
	private hasPostedInitialData = false;
	/**
	 * Trailing-edge debounce timer for `scheduleRefresh`. Non-zero
	 * when a refresh was scheduled but not yet started — the timer
	 * fires after `SCHEDULE_DEBOUNCE_MS` and runs the actual
	 * `refresh()`. The leading-edge behaviour is intentional: the
	 * FIRST schedule call starts the refresh immediately so the user
	 * does not wait `SCHEDULE_DEBOUNCE_MS` for the first paint, and
	 * subsequent schedule calls within the window coalesce into the
	 * single pending refresh that already exists.
	 */
	private scheduleTimer: NodeJS.Timeout | undefined;
	/**
	 * The highest-priority `force` flag among coalesced schedule
	 * calls. Stored so that if a user-driven `force=true` schedule
	 * arrives while a non-force refresh is in flight, the pending
	 * follow-up runs with `force=true`.
	 */
	private scheduleForce = false;
	/**
	 * Lifecycle gate set by `dispose()`. `refreshOnce` checks this
	 * after every `await` and `safePostMessage` short-circuits when
	 * it is `true`, so a refresh that started before the user closed
	 * the panel cannot deliver a message to a torn-down webview. The
	 * mock mirrors what VS Code does in production: postMessage to a
	 * disposed webview throws synchronously. Catching the throw is
	 * the last line of defence; preventing the call is the first.
	 */
	private disposed = false;
	/**
	 * Last `DashboardView` posted to the webview. Stored so the
	 * `planSelectKey` handler can re-post with an updated
	 * `selectedTokenPlanKeyId` without re-running the full refresh
	 * pipeline.
	 */
	private lastView: DashboardView | undefined;
	private readonly messageListener = (raw: vscode.WebviewMessage) => this.handleMessage(raw);

	private constructor(
		private readonly deps: DashboardPanelDeps,
		panel: vscode.WebviewPanel,
	) {
		this.panel = panel;
		this.state.locale = pickDashboardLocale(vscode.env.language);
		// NOTE — the dashboard is intentionally a ONE-WAY, EXPLICITLY
		// DRIVEN view. The previous design subscribed to
		// `usageStore`, `planCache`, AND `mmxCliCache` and
		// re-rendered the whole panel on every notification. That
		// produced a self-reinforcing refresh loop in which:
		//   1. `planCache.refresh()` (called from inside the
		//      panel's own `refreshOnce`) fired `notify()` on
		//      success.
		//   2. The panel's `planCache.subscribe` listener
		//      scheduled another `refresh()`, which called
		//      `planCache.refresh()` again, which fired `notify()`
		//      again, ad infinitum.
		//   3. `mmxCliCache.refresh()` had the same shape — a
		//      second self-reinforcing loop, harder to spot
		//      because the user's `mmxRecheck` button ALSO calls
		//      `panel.refresh()`, so the listener was not
		//      obviously redundant.
		// Compounding the loop, every SSE `usage` event also
		// fired `usageStore.subscribe` and kicked off a full
		// re-render. Combined with the cached-view + final-view
		// "two-frame" pattern (where the first frame carries
		// `planSource='loading'` and the second carries the real
		// data), the webview `render()` rewrote `#root.innerHTML`
		// over and over — the user observed a dashboard that was
		// permanently stuck on "刷新…".
		//
		// The new model: explicit triggers only. Every refresh now
		// requires a deliberate call to `refresh()` or
		// `scheduleRefresh()`. Caches that change state simply
		// update their in-memory snapshot; the next time the
		// panel is asked to refresh (by the user, by a config
		// change, by an explicit ingester signal) it consults the
		// cache and ships one final view. The only remaining
		// subscriber is `claudeCodeIngest`, whose `notify()` is
		// fired from its OWN poll loop (never from inside the
		// panel's `refreshOnce`), so it is not self-reinforcing.
		this.authChangeSubscription = deps.auth.onDidChangeApiKey(() => {
			// An API-key change is a credential-boundary event: even
			// if the new key is on the same host, the cached snapshot
			// (and any in-flight promise) belongs to the old key and
			// must NOT be served under the new identity. Invalidate
			// the cache before the next refresh so the new (apiKey,
			// host) fingerprint is fetched fresh. This also closes
			// the "open panel + new key + same host" stale-snapshot
			// path.
			deps.planCache.invalidate();
			void this.refresh();
		});
		// The Claude Code ingester emits no-arg events on every poll
		// that lands new data. Polls are bounded by the 30s default
		// interval (clamped to `[5_000, 600_000]`), so a single
		// refresh per event is well within acceptable cost — and the
		// value is the per-model table freshness the user actually
		// cares about. The ingester's `notify()` is fired from its
		// OWN poll loop, never from inside the panel's
		// `refreshOnce`, so this listener is not self-reinforcing
		// (unlike the removed `planCache` and `mmxCliCache`
		// subscriptions — both of those called `notify()` from
		// inside `panel.refresh()`, which is exactly the bug this
		// commit fixes).
		this.claudeCodeSubscription = deps.claudeCodeIngest?.subscribe(() => {
			void this.refresh();
		});

		this.panel.webview.options = {
			enableScripts: true,
			localResourceRoots: [deps.extensionUri],
		};
		this.panel.webview.html = this.renderHtml(dashboardMessages(this.state.locale));
		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
		this.panel.webview.onDidReceiveMessage(this.messageListener, null, this.disposables);
		this.panel.onDidChangeViewState(() => {
			if (this.panel.visible) {
				void this.refresh();
			}
		}, null, this.disposables);
	}

	static show(deps: DashboardPanelDeps): DashboardPanel {
		if (DashboardPanel.current) {
			logger.info('dashboard.panel.reveal', { component: 'dashboard' });
			DashboardPanel.current.panel.reveal(vscode.ViewColumn.Beside);
			void DashboardPanel.current.refresh();
			return DashboardPanel.current;
		}
		logger.info('dashboard.panel.create', { component: 'dashboard' });
		const panel = vscode.window.createWebviewPanel(
			VIEW_TYPE,
			'MiniMax Dashboard',
			vscode.ViewColumn.Beside,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [deps.extensionUri],
			},
		);
		const instance = new DashboardPanel(deps, panel);
		DashboardPanel.current = instance;
		void instance.refresh();
		return instance;
	}

	dispose(): void {
		// Lifecycle gate. Once we've been disposed:
		//  - `safePostMessage` becomes a no-op (returns false), so an
		//    in-flight `refreshOnce` cannot land a `postMessage` on a
		//    torn-down webview and trip VS Code's "Webview is disposed"
		//    error.
		//  - `pendingRefresh` is cleared so a late notification
		//    (auth.onDidChangeApiKey, mmxCliCache.subscribe, etc.) does
		//    NOT schedule a follow-up refresh against a panel whose
		//    listeners have already been disposed below.
		//  - `scheduleTimer` is cleared so a debounced refresh never
		//    fires after the panel has been torn down — the timer's
		//    callback would otherwise queue a refresh that immediately
		//    short-circuits at the entry checkpoint, which is harmless
		//    but pollutes the diagnostic channel.
		// Set this BEFORE disposing the subscriptions so any callback
		// they fire during teardown observes the new state.
		this.disposed = true;
		this.lastView = undefined;
		this.pendingRefresh = false;
		this.pendingRefreshForce = false;
		if (this.scheduleTimer !== undefined) {
			clearTimeout(this.scheduleTimer);
			this.scheduleTimer = undefined;
		}
		this.scheduleForce = false;
		this.authChangeSubscription.dispose();
		this.claudeCodeSubscription?.dispose();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.disposables.length = 0;
		if (DashboardPanel.current === this) {
			DashboardPanel.current = undefined;
		}
		logger.debug('dashboard.panel.dispose', { component: 'dashboard' });
	}

	/**
	 * `true` if the panel is past the point of no return — either we
	 * have called `dispose()`, or the underlying webview has already
	 * been torn down by VS Code (signalled via the "Webview is
	 * disposed" error from `webview.postMessage`). Either condition
	 * means every subsequent `postMessage` would throw, and every
	 * subsequent `await` afterwards would be wasted work.
	 */
	private isTornDown(): boolean {
		return this.disposed;
	}

	/**
	 * Recognise the error VS Code throws when callers reach into a
	 * webview that has already been disposed. We treat it as a
	 * lifecycle event, not a business failure, and suppress the
	 * `refresh failed` warning that previously polluted the
	 * diagnostics channel.
	 */
	private isWebviewDisposedError(error: unknown): boolean {
		const msg = error instanceof Error ? error.message : String(error);
		return /webview is disposed/i.test(msg);
	}

	/**
	 * Trailing-edge debounce window for `scheduleRefresh`. The first
	 * call lands IMMEDIATELY (leading-edge); subsequent calls within
	 * the window collapse into the same in-flight refresh. The window
	 * is short (500 ms) — long enough to coalesce a burst of `usage
	 * recorded` notifications or a config-change + mmx-poll arriving
	 * in the same tick, short enough that the user never perceives
	 * latency on a deliberate action.
	 */
	private static readonly SCHEDULE_DEBOUNCE_MS = 500;

	/**
	 * Schedule a refresh, coalescing bursts of calls into a single
	 * actual `refresh()`. Leading-edge: the FIRST call starts the
	 * refresh right away; subsequent calls within the debounce window
	 * either coalesce into an in-flight refresh (if one is already
	 * running) or piggyback on the timer-scheduled one (if the
	 * leading refresh already finished before the next call arrived).
	 *
	 * `reason` is logged with the refresh operation so the
	 * diagnostic channel can attribute a refresh to the trigger that
	 * caused it (e.g. `'chat_turn_end'`, `'config_change'`,
	 * `'mmx_recheck'`). The list of reasons is intentionally free-form;
	 * anything that helps a future maintainer reconstruct the call
	 * graph is welcome.
	 *
	 * `options.force === true` lifts the plan-cache TTL — pass it
	 * only for user-driven actions (Refresh button, key swap). For
	 * auto-pulse / poll-driven triggers, leave it false so the TTL
	 * continues to rate-limit the platform round-trip.
	 */
	scheduleRefresh(reason: string, options?: { force?: boolean }): void {
		if (this.disposed) return;
		const force = options?.force === true;
		if (this.inFlight) {
			// Coalesce into the pending refresh that's already
			// queued by the in-flight loop. `pendingRefreshForce` is
			// a sticky OR: if the user hit Refresh while a
			// non-forced refresh was running, the follow-up will run
			// with `force=true`.
			this.pendingRefresh = true;
			this.pendingRefreshForce = this.pendingRefreshForce || force;
			logger.debug('dashboard.refresh.coalesced', {
				component: 'dashboard',
				reason,
				force,
				pendingForce: this.pendingRefreshForce,
			});
			return;
		}
		if (this.scheduleTimer !== undefined) {
			// A debounced refresh is already pending; piggyback on it.
			this.scheduleForce = this.scheduleForce || force;
			logger.debug('dashboard.refresh.debounced', {
				component: 'dashboard',
				reason,
				force,
				pendingForce: this.scheduleForce,
			});
			return;
		}
		// Leading edge: run the refresh right away, then arm a
		// trailing timer in case more triggers land while the
		// refresh is running.
		logger.debug('dashboard.refresh.scheduled', {
			component: 'dashboard',
			reason,
			force,
			leading: true,
		});
		void this.refresh({ force }).finally(() => {
			if (this.disposed) return;
			if (this.scheduleTimer !== undefined) return;
			const pendingForce = this.scheduleForce;
			this.scheduleForce = false;
			this.scheduleTimer = setTimeout(() => {
				this.scheduleTimer = undefined;
				if (this.disposed) return;
				void this.refresh({ force: pendingForce });
			}, DashboardPanel.SCHEDULE_DEBOUNCE_MS);
		});
	}

	/**
	 * Re-render. The plan-cache refresh honours the 5-minute TTL
	 * unless `force: true` is passed — the dashboard's Refresh
	 * button does so; the auto-pulse paths (chat turn end, etc.)
	 * don't.
	 *
	 * The do/while loop coalesces bursts: while a `refreshOnce` is
	 * running, any further `refresh()` call sets `pendingRefresh`
	 * instead of spawning a parallel run. When the current
	 * `refreshOnce` returns, the loop checks `pendingRefresh` and
	 * runs at most ONE follow-up. After issue #5's root-cause fix
	 * the reverse subscriptions on `planCache` and `usageStore`
	 * are gone, so the only remaining source of coalesced bursts is
	 * user-driven actions (Refresh + mmxRecheck arriving close
	 * together) and the mmx / claude-code explicit subscribers.
	 */
	async refresh(options?: { force?: boolean }): Promise<void> {
		if (this.disposed) return;
		let force = options?.force === true;
		if (this.inFlight) {
			this.pendingRefresh = true;
			this.pendingRefreshForce = this.pendingRefreshForce || force;
			logger.debug('dashboard.refresh.queued', {
				component: 'dashboard',
				force,
				pendingForce: this.pendingRefreshForce,
			});
			return;
		}
		this.inFlight = true;
		logger.info('dashboard.refresh.loop.start', {
			component: 'dashboard',
			force,
		});
		try {
			do {
				force = force || this.pendingRefreshForce;
				this.pendingRefresh = false;
				this.pendingRefreshForce = false;
				await this.refreshOnce({ force });
				force = false;
			} while (this.pendingRefresh);
		} finally {
			this.inFlight = false;
			logger.info('dashboard.refresh.loop.end', { component: 'dashboard' });
		}
	}

	private async refreshOnce(options?: { force?: boolean }): Promise<void> {
		const seq = ++this.refreshSeq;
		// Reuse `refreshSeq` as the traceId. The webview echoes this
		// back on `renderAck` / `renderError`, so a single identifier
		// stitches the host-side refresh and the front-end render into
		// one traceable operation. `dashboard.refresh#<seq>` is
		// guaranteed unique per panel instance.
		const traceId = `dashboard.refresh#${seq}`;
		const op = logger.operation('dashboard.refresh', {
			component: 'dashboard',
			traceId,
			fields: {
				force: options?.force === true,
				seq,
			},
		});
		const startedAt = Date.now();
		if (this.isTornDown()) {
			op.end({ status: 'skipped', reason: 'disposed_before_start' });
			return;
		}
		// ONE FRAME PER REFRESH. The previous design posted a
		// `cachedView` with `planSource='loading'` first and then a
		// `finalView` with the real data. That second-frame
		// overwrite was the root cause of the issue #5 "stuck on
		// 刷新…" symptom: while the cached-loading frame was on
		// screen, the plan-cache fetch returned and a *coalesced
		// follow-up refresh* kicked in, which re-posted the cached
		// loading frame before the second frame could land.
		//
		// The new contract: at most one `data` message per refresh.
		// On the very first refresh (`hasPostedInitialData === false`)
		// we post a single loading frame so the user sees a clear
		// "loading" state instead of the static HTML placeholder;
		// on every subsequent refresh we wait for the plan fetch to
		// finish and post one final frame. The plan-status
		// indicator (refresh-state spinner / stamp) is updated via
		// `postRefreshState(true|false)` instead, which the webview
		// applies locally without touching `#root.innerHTML`.
		try {
			await this.postRefreshState(true, traceId);
			if (this.isTornDown()) {
				op.end({ status: 'skipped', reason: 'disposed_after_state' });
				return;
			}
			const apiKey = await this.authForRefresh();
			if (this.isTornDown()) {
				op.end({ status: 'skipped', reason: 'disposed_after_auth' });
				return;
			}
			const platform = apiKey
				? {
					apiKey,
					host: this.deps.getHost?.() ?? null,
				}
				: null;
			op.info('start', {
				hasKey: !!apiKey,
				host: platform?.host ?? 'none',
			});

			// First refresh on this panel: ship the loading frame
			// BEFORE we await the plan fetch so the user sees a
			// "loading" placeholder instead of the static HTML.
			// Subsequent refreshes skip this — they keep showing the
			// previous frame until the new one is ready, which is
			// the whole point of the single-frame contract.
			if (!this.hasPostedInitialData) {
				const loadingView = await buildCachedDashboardView({
					store: this.deps.usageStore,
					planSource: apiKey ? 'loading' : 'unconfigured',
					claudeCodeIngest: this.deps.claudeCodeIngest,
				});
				if (this.isTornDown()) {
					op.end({ status: 'skipped', reason: 'disposed_before_initial_post' });
					return;
				}
				const initialPosted = await this.postData(loadingView, traceId);
				if (!initialPosted) {
					op.end({ status: 'skipped', reason: 'initial_post_failed' });
					return;
				}
				this.hasPostedInitialData = true;
				op.info('initial.post', { plan: loadingView.sources.plan });
			}

			// Refresh the plan cache in the background. When the
			// multi-key poller is available and this is a force
			// refresh, we trigger the poller which refreshes ALL
			// named keys in one batch — the dashboard will soon need
			// the full key pool. Without the poller, or for non-force
			// auto-pulse refreshes, we only refresh the active key.
			//
			// `force: true` is intentionally reserved for the user
			// pressing the dashboard's Refresh button. All
			// auto-pulse paths (chat turn end, config change, etc.)
			// honour the TTL — the platform's own UI auto-syncs the
			// Token Plan card on the same cadence.
			const force = options?.force === true;
			let planRefreshError: string | undefined;
			let planRefreshPromise: Promise<unknown> = Promise.resolve();
			if (platform) {
				op.info('plan.refresh.start', { force });
				if (force && this.deps.tokenPlanPoller) {
					// Force-refresh ALL keys via the poller. The
					// poller resolves secrets and refreshes
					// everything, so we just await its completion.
					planRefreshPromise = this.deps.tokenPlanPoller
						.refresh({ force: true })
						.catch((error) => {
							planRefreshError =
								error instanceof Error ? error.message : String(error);
							op.warn('plan.refresh.poller.fail', undefined, error);
							return null;
						});
				} else {
					// Non-force: only refresh the active key (TTL
					// will likely short-circuit this). The poller's
					// background cycle covers all keys on its own.
					planRefreshPromise = this.deps.planCache
						.refresh(platform, { force })
						.catch((error) => {
							planRefreshError =
								error instanceof Error ? error.message : String(error);
							op.warn('plan.refresh.fail', { host: platform.host }, error);
							return null;
						});
				}
			}
			// Refresh the mmx-cli detection in the background. The
			// previous frame already shows the last-known state, so
			// the user does not see an "unknown → green" flicker on
			// refresh. Failure here does NOT clear the cache — the
			// previous snapshot is preserved.
			const mmxPromise = this.deps.mmxCliCache.refresh().catch((error) => {
				op.warn('mmx.refresh.fail', undefined, error);
				return null;
			});
			await planRefreshPromise;
			if (this.isTornDown()) {
				op.end({ status: 'skipped', reason: 'disposed_after_plan_refresh' });
				return;
			}
			op.info('plan.refresh.end', {
				error: planRefreshError ? 'yes' : 'no',
			});
			// Read the cache again post-refresh so the final view
			// reflects whatever the background fetch landed.
			const refreshedPlanSnapshot = platform ? this.deps.planCache.read(platform) : undefined;
			const refreshedMmxCliSnapshot = this.deps.mmxCliCache.read();
			// Build the multi-key plan snapshot map for the Token
			// Plan card's key selector. Reads all cached plan
			// snapshots from the shared PlanCache and pairs them
			// with key pool metadata (name, region, active status).
			const allKeyPlans = this.buildAllKeyPlans();
			// The MCP status depends on `getBaseUrl()` and
			// `getMcpProviderRegistered`; both are stable across a
			// single refresh, so compute once.
			const mcp = await this.computeMcpStatus(apiKey);
			const view = planRefreshError && !refreshedPlanSnapshot
				? await buildCachedDashboardView({
					store: this.deps.usageStore,
					planSource: 'error',
					planError: planRefreshError,
					mmxCli: refreshedMmxCliSnapshot?.status,
					mcp,
					claudeCodeIngest: this.deps.claudeCodeIngest,
					allKeyPlans,
				})
				: await buildDashboardView({
					store: this.deps.usageStore,
					platform,
					// Hand the aggregator the snapshot we already have so it
					// does NOT re-fetch on its own.
					planSnapshot: refreshedPlanSnapshot,
					mmxCliStatus: refreshedMmxCliSnapshot?.status,
					mcp,
					claudeCodeIngest: this.deps.claudeCodeIngest,
					allKeyPlans,
				});
			op.info('final.build', {
				plan: view.sources.plan,
				elapsedMs: Date.now() - startedAt,
			});
			if (this.isTornDown()) {
				op.end({ status: 'skipped', reason: 'disposed_before_final_post' });
				return;
			}
			const finalPosted = await this.postData(view, traceId);
			if (!finalPosted) {
				op.end({ status: 'skipped', reason: 'final_post_failed' });
				return;
			}
			op.info('final.post', { plan: view.sources.plan });
			this.hasPostedInitialData = true;
			await mmxPromise;
			await this.postRefreshState(false, traceId);
			op.end({ plan: view.sources.plan });
		} catch (error) {
			// Lifecycle event, not a business failure. VS Code throws
			// "Webview is disposed" the moment a `postMessage` lands
			// after the panel has been torn down (user closed the
			// panel, or the extension is shutting down). The throw
			// is the host's way of saying "nobody's listening", and
			// the previous behaviour of logging it as
			// "Dashboard refresh failed" was a false alarm that
			// drowned out real failures. Close the span with
			// `status: 'skipped'` so the diagnostic export sees a
			// completed operation, not an open one.
			if (this.isWebviewDisposedError(error) || this.isTornDown()) {
				op.end({
					status: 'skipped',
					reason: 'disposed_after_throw',
					elapsedMs: Date.now() - startedAt,
				});
				return;
			}
			op.fail(error, { elapsedMs: Date.now() - startedAt });
			// `postError` is itself a `safePostMessage` wrapper, so if
			// the panel was torn down between the throw and this line
			// it short-circuits silently — no double-fault.
			if (!this.isTornDown()) {
				await this.postError(error, traceId);
			}
		}
	}

	/**
	 * Read the API key from the auth manager. Wrapped so the panel can
	 * later swap in a faster path (e.g. cached from secrets.onDidChange)
	 * without touching the rest of `refresh`.
	 */
	/**
	 * Build the multi-key plan snapshot map for the Token Plan card's
	 * key selector. Reads all cached plan snapshots from the shared
	 * PlanCache and pairs them with key pool metadata (name, region,
	 * active status). Returns `undefined` when the cache is empty.
	 */
	private buildAllKeyPlans(): Record<string, import('./types').KeyPlanSnapshot> | undefined {
		// Guard: planCache may lack the multi-key API in tests or
		// when the extension is loaded with an older cache shape.
		if (typeof this.deps.planCache.readAll !== 'function') return undefined;
		const allSnap = this.deps.planCache.readAll();
		if (!allSnap || allSnap.size === 0) return undefined;
		let pool: { keys: Array<{ id: string; name: string; region: string; missingSecret: boolean }>; activeKeyId?: string } | undefined;
		try {
			pool = this.deps.auth.keyManagerInstance?.snapshot();
		} catch {
			// KeyManager not available (e.g. unit tests without a full
			// runtime). Fall through: labels will be the raw keyId.
		}
		const activeId = pool?.activeKeyId;
		const result: Record<string, import('./types').KeyPlanSnapshot> = {};
		for (const [keyId, snap] of allSnap) {
			const entry = pool?.keys.find((k) => k.id === keyId);
			const label = entry?.name ?? keyId;
			const isActive = keyId === activeId;
			const region = entry?.region ?? 'custom';
			result[keyId] = {
				keyId,
				label,
				isActive,
				source: 'ok',
				usage: snap.usage,
				region,
			};
		}
		return result;
	}

	private async authForRefresh(): Promise<string | undefined> {
		return this.deps.auth.getApiKey();
	}

	/**
	 * Build the `mcp` field of the dashboard view. The aggregator
	 * does the heavy lifting (host mapping, ready flag); this helper
	 * only translates the localised reason for the "not ready" case
	 * into the dashboard's current locale.
	 *
	 * Reads the configured `minimax.apiBaseUrl` live so a host switch
	 * is reflected on the very next refresh, mirroring the credential
	 * boundary rationale used by `DashboardPanelDeps.getHost`.
	 */
	private async computeMcpStatus(apiKey: string | undefined): Promise<DashboardView['mcp']> {
		const apiBaseUrl = getBaseUrl();
		const hasApiKey = typeof apiKey === 'string' && apiKey.trim().length > 0;
		const { fromProxy } = pickMcpApiHost(apiBaseUrl);
		const providerRegistered = this.deps.getMcpProviderRegistered?.() ?? false;
		// Pick the most specific localised reason. Empty when ready.
		let reason = '';
		if (!hasApiKey) {
			reason = t('mcp.resolveError.missingKey');
		} else if (fromProxy) {
			reason = t('mcp.resolveError.unsupportedHost', apiBaseUrl);
		} else {
			// hasApiKey + unknown host is also unreachable today (we
			// don't expose an `mcp.apiHostOverride` yet) — surface the
			// same "unsupported" message so the dashboard shows a
			// clear, single-line explanation rather than a blank badge.
			reason = t('mcp.resolveError.unknownHost', apiBaseUrl);
		}
		return buildMcpStatus({ apiBaseUrl, hasApiKey, providerRegistered, reason });
	}

	/**
	 * `webview.postMessage` with the lifecycle guard baked in. Returns
	 * `false` (and emits a debug log) when:
	 *   - the panel has been disposed (`disposed === true`), or
	 *   - VS Code throws "Webview is disposed" because the host
	 *     tore down the webview between our last `isTornDown()`
	 *     check and the call (race between two `await`s in
	 *     `refreshOnce`).
	 *
	 * The boolean return mirrors VS Code's own contract: `true` if
	 * the message was queued, `false` if the webview is no longer
	 * alive. Production callers MUST treat a `false` here as
	 * "abort the refresh" — never as a transport error.
	 */
	private async safePostMessage(message: unknown, traceId: string): Promise<boolean> {
		if (this.isTornDown()) {
			logger.debug('dashboard.post.skip', {
				component: 'dashboard',
				traceId,
				reason: 'disposed',
			});
			return false;
		}
		try {
			return await this.panel.webview.postMessage(message);
		} catch (error) {
			if (this.isWebviewDisposedError(error)) {
				// First-line defence did not catch the race; the
				// webview was torn down between the `isTornDown`
				// check and the call. Mark ourselves disposed so the
				// rest of the refresh short-circuits, and do NOT
				// rethrow — the panel is past the point of no return.
				this.disposed = true;
				logger.debug('dashboard.post.skip', {
					component: 'dashboard',
					traceId,
					reason: 'disposed_throw',
				});
				return false;
			}
			throw error;
		}
	}

	/**
	 * Returns `true` if the message was delivered to a live
	 * webview, `false` if the panel was torn down (or the
	 * webview was disposed out from under the call). Callers
	 * MUST treat a `false` here as "abort the refresh" —
	 * continuing to log `cached.post` / `final.post` / `end`
	 * would tell the diagnostic export the user saw a fresh
	 * dashboard when they did not.
	 */
	private async postData(view: DashboardView, traceId: string): Promise<boolean> {
		this.lastView = view;
		const ok = await this.safePostMessage(
			{ type: 'data', traceId, payload: view },
			traceId,
		);
		logger.info('dashboard.post.data', {
			component: 'dashboard',
			traceId,
			ok,
			plan: view.sources.plan,
		});
		return ok;
	}

	private async postError(error: unknown, traceId: string): Promise<void> {
		const message = error instanceof Error ? error.message : String(error);
		await this.safePostMessage(
			{ type: 'error', payload: { message, traceId } },
			traceId,
		);
	}

	/**
	 * Push a refresh-state indicator to the webview WITHOUT touching
	 * the data frame. The webview applies this to the header's
	 * spinner / refresh button / stamp and leaves `#root.innerHTML`
	 * alone, so a refresh in flight no longer overwrites the
	 * previously-rendered dashboard with a loading placeholder. The
	 * webview echoes `traceId` back on its `refreshStateAck` message
	 * for diagnostic stitching (same traceId discipline as `data`).
	 */
	private async postRefreshState(refreshing: boolean, traceId: string): Promise<boolean> {
		const ok = await this.safePostMessage(
			{ type: 'refreshState', payload: { refreshing, traceId } },
			traceId,
		);
		logger.debug('dashboard.refresh.state', {
			component: 'dashboard',
			traceId,
			refreshing,
			ok,
		});
		return ok;
	}

	private async handleMessage(raw: vscode.WebviewMessage): Promise<void> {
		const message = raw as { type?: string; payload?: unknown };
		logger.debug('dashboard.webview.message', {
			component: 'dashboard',
			type: message.type ?? 'unknown',
		});
		switch (message.type) {
			case 'ready':
				await this.refresh();
				return;
			case 'renderAck': {
				const payload = message.payload as { traceId?: unknown; plan?: unknown; elapsedMs?: unknown } | undefined;
				logger.info('dashboard.webview.render.ack', {
					component: 'dashboard',
					traceId: String(payload?.traceId ?? '?'),
					plan: String(payload?.plan ?? '?'),
					elapsedMs: Number(payload?.elapsedMs ?? 0),
				});
				return;
			}
			case 'renderError': {
				const payload = message.payload as { traceId?: unknown; message?: unknown } | undefined;
				logger.warn('dashboard.webview.render.error', {
					component: 'dashboard',
					traceId: String(payload?.traceId ?? '?'),
					message: String(payload?.message ?? '?'),
				});
				return;
			}
			case 'planSelectKey': {
					// The user clicked a key selector pill in the Token Plan
					// card. Re-post the current view with the updated
					// `selectedTokenPlanKeyId` so the webview can re-render
					// the plan card in-place. The webview already applied
					// the selection locally; this echo ensures the host's
					// diagnostic state stays in sync and the next refresh
					// carries the correct selection.
					const keyId = typeof (message.payload as { keyId?: unknown })?.keyId === 'string'
						? (message.payload as { keyId: string }).keyId
						: 'active';
					logger.debug('dashboard.webview.planSelectKey', {
						component: 'dashboard',
						keyId,
					});
					if (this.lastView) {
						const updated: DashboardView = {
							...this.lastView,
							selectedTokenPlanKeyId: keyId,
						};
						this.lastView = updated;
						void this.postData(updated, `planSelectKey:${keyId}`);
					}
					return;
				}
				case 'refresh':
				// The dashboard's Refresh button is the user's explicit
				// "I want a fresh snapshot" gesture. Pass `force: true`
				// through so the plan cache skips its 5-minute TTL and
				// issues a guaranteed-fresh round-trip to the platform.
				// Without this, clicking Refresh inside the TTL was a
				// no-op (the cache returned the same stale snapshot)
				// flagged this gap.
				await this.refresh({ force: true });
				return;
			case 'close':
				this.panel.dispose();
				return;
			case 'setLocale': {
				const next = pickDashboardLocale(
					typeof message.payload === 'string' ? message.payload : undefined,
				);
				if (next !== this.state.locale) {
					this.state.locale = next;
					this.panel.webview.html = this.renderHtml(
						dashboardMessages(this.state.locale),
					);
				}
				return;
			}
			case 'reset': {
				const confirm = t('usage.resetDone');
				const choice = await vscode.window.showWarningMessage(
					dashboardMessages(this.state.locale).resetConfirm,
					{ modal: true },
					dashboardMessages(this.state.locale).reset,
				);
				if (choice === dashboardMessages(this.state.locale).reset) {
					await this.deps.usageStore.reset();
					vscode.window.showInformationMessage(confirm);
					await this.refresh();
				}
				return;
			}
			case 'mmxCopyPrompt': {
				await handleMmxCopyPrompt(this.deps.getHost?.() ?? 'global');
				return;
			}
			case 'mmxRecheck': {
				await this.refresh();
				return;
			}
			case 'mcpRefresh': {
				// The MCP card's "Refresh" button: kick the user's
				// command so the extension re-evaluates the provider
				// state and fires `onDidChangeMcpServerDefinitions`,
				// prompting VS Code to re-resolve on the next MCP
				// call. We deliberately do NOT reach into VS Code's
				// MCP cache here — the command + the natural
				// `onDidChange` event are the supported integration
				// surface.
				await vscode.commands.executeCommand('minimax.refreshMcp');
				await this.refresh();
				return;
			}
			case 'claudeCodeRescan': {
				await this.deps.claudeCodeIngest?.refresh();
				await this.refresh();
				return;
			}
			case 'claudeCodeOpenFolder': {
				await vscode.commands.executeCommand('minimax.openClaudeCodeLogFolder');
				return;
			}
			case 'claudeCodeOpenSettings': {
				await vscode.commands.executeCommand(
					'workbench.action.openSettings',
					'minimax.dashboard.includeClaudeCode',
				);
				return;
			}
		}
	}

	private renderHtml(messages: DashboardMessages): string {
		const cspSource = this.panel.webview.cspSource;
		const themeKind = vscode.ColorThemeKind[vscode.window.activeColorTheme.kind] ?? '';
		const bodyClass = themeKind === 'Light' ? 'theme-light' : 'theme-dark';
		// Use a CSPRNG for the CSP nonce. `Math.random()` is predictable
		// and would weaken the CSP's defense-in-depth value. 16 random
		// bytes (128 bits) is the conservative default. The nonce is
		// attached to the inline `<script id="i18n">` payload and the
		// separately-built webview JS. The main script is still loaded
		// through `asWebviewUri`, but the CSP must allow the webview
		// resource origin (`cspSource`) rather than a concrete URI:
		// VS Code may serve `file+` URLs while the URI string encodes
		// that authority as `file%2B`, which does not match in CSP.
		const nonce = randomBytes(16).toString('base64');
		const i18nJson = escapeJsonForScript(messages);
		const webviewScriptUri = this.panel.webview.asWebviewUri(
			vscode.Uri.joinPath(this.deps.extensionUri, 'out', 'dashboard-webview.js'),
		);

		return `<!DOCTYPE html>
<html lang="${htmlLangFor(this.state.locale)}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${cspSource}; script-src 'nonce-${nonce}' ${cspSource};">
<style>
:root {
	--bg: var(--vscode-editor-background);
	--bg-elev: var(--vscode-editorWidget-background);
	--fg: var(--vscode-editor-foreground);
	--fg-mute: var(--vscode-descriptionForeground);
	--border: var(--vscode-panel-border);
	--accent: var(--vscode-textLink-foreground);
	--good: #10b981;
	--warn: #f59e0b;
	--bad: #ef4444;
	--chip: var(--vscode-badge-background);
	--chip-fg: var(--vscode-badge-foreground);
}
* { box-sizing: border-box; }
body {
	margin: 0;
	padding: 24px;
	background: var(--bg);
	color: var(--fg);
	font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
	font-size: 13px;
	line-height: 1.5;
}
.app { max-width: 1100px; margin: 0 auto; }
header {
	display: flex; align-items: flex-start; justify-content: space-between;
	gap: 16px; margin-bottom: 24px;
}
header h1 { margin: 0; font-size: 22px; font-weight: 600; }
header p { margin: 6px 0 0; color: var(--fg-mute); }
.actions { display: flex; gap: 8px; flex-shrink: 0; }
button {
	background: var(--vscode-button-secondaryBackground);
	color: var(--vscode-button-secondaryForeground);
	border: 1px solid var(--border);
	padding: 6px 12px;
	border-radius: 6px;
	cursor: pointer;
	font-size: 12px;
}
button:hover { background: var(--vscode-button-secondaryHoverBackground); }
button.primary {
	background: var(--vscode-button-background);
	color: var(--vscode-button-foreground);
}
/* Refresh-button spinner. Activated by applyRefreshState on a
 * refreshState message (NEVER on a data message -- the split is
 * what keeps the dashboard visible during in-flight refreshes).
 * Pure CSS animation, no extra markup needed: the :before
 * pseudo-element hosts the rotating bar. */
button[data-action="refresh"].refreshing {
	opacity: 0.6;
	cursor: progress;
	position: relative;
	color: transparent;
}
button[data-action="refresh"].refreshing::before {
	content: '';
	position: absolute;
	inset: 0;
	margin: auto;
	width: 12px;
	height: 12px;
	border: 2px solid currentColor;
	border-top-color: transparent;
	border-radius: 50%;
	color: var(--vscode-button-foreground);
	animation: dashboard-spin 0.8s linear infinite;
}
@keyframes dashboard-spin {
	to { transform: rotate(360deg); }
}
section {
	background: var(--bg-elev);
	border: 1px solid var(--border);
	border-radius: 10px;
	padding: 18px 20px;
	margin-bottom: 20px;
}
section h2 {
	margin: 0 0 14px;
	font-size: 14px;
	font-weight: 600;
	letter-spacing: 0.02em;
	text-transform: uppercase;
	color: var(--fg-mute);
}
.grid { display: grid; gap: 14px; }
.grid-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.grid-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
@media (max-width: 720px) { .grid-3, .grid-2 { grid-template-columns: 1fr; } }
.card {
	background: var(--bg);
	border: 1px solid var(--border);
	border-radius: 8px;
	padding: 14px 16px;
}
.card h3 {
	margin: 0 0 10px;
	font-size: 12px;
	font-weight: 600;
	color: var(--fg-mute);
	text-transform: uppercase;
	letter-spacing: 0.04em;
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
}
.card h3 .reset-pill {
	text-transform: none;
	letter-spacing: 0;
	font-size: 11px;
	font-weight: 500;
	color: var(--fg-mute);
	font-variant-numeric: tabular-nums;
}
.kv { display: flex; justify-content: space-between; padding: 4px 0; }
.kv span:first-child { color: var(--fg-mute); }
.kv span:last-child { font-variant-numeric: tabular-nums; font-weight: 500; }
.progress {
	height: 8px;
	border-radius: 999px;
	background: var(--vscode-progressBar-background, rgba(127,127,127,0.25));
	overflow: hidden;
	margin-top: 8px;
}
.progress > .fill {
	height: 100%;
	border-radius: inherit;
	transition: width 0.3s ease;
	background: var(--good);
}
.progress.warn > .fill { background: var(--warn); }
.progress.bad > .fill { background: var(--bad); }
.progress.rainbow > .fill {
	background: linear-gradient(
		90deg,
		var(--accent) 0%,
		var(--good) 25%,
		var(--warn) 50%,
		var(--bad) 75%,
		var(--accent) 100%
	);
	background-size: 200% 100%;
	animation: rainbow-shift 4s linear infinite;
}
@keyframes rainbow-shift {
	from { background-position: 0% 50%; }
	to { background-position: 200% 50%; }
}
@media (prefers-reduced-motion: reduce) {
	.progress.rainbow > .fill { animation: none; }
}
.empty {
	padding: 32px 16px;
	text-align: center;
	color: var(--fg-mute);
	border: 1px dashed var(--border);
	border-radius: 8px;
}
.banner {
	padding: 10px 14px;
	border-radius: 6px;
	font-size: 12px;
	margin-bottom: 12px;
	border-left: 3px solid var(--warn);
	background: rgba(245, 158, 11, 0.08);
	color: var(--fg);
}
table { width: 100%; border-collapse: collapse; }
th, td {
	text-align: left;
	padding: 8px 6px;
	border-bottom: 1px solid var(--border);
	font-variant-numeric: tabular-nums;
}
th { color: var(--fg-mute); font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
td.right, th.right { text-align: right; }
.bar-chart {
	display: flex; align-items: flex-end; gap: 3px;
	height: 100px; margin: 12px 0 4px;
}
.bar-chart .bar {
	flex: 1; min-width: 6px;
	background: var(--accent);
	border-radius: 2px 2px 0 0;
	transition: opacity 0.2s;
	opacity: 0.85;
}
.bar-chart .bar.zero { background: var(--border); opacity: 0.5; }
.bar-chart .bar:hover { opacity: 1; }
.chart-axis {
	display: flex; justify-content: space-between;
	color: var(--fg-mute); font-size: 11px; margin-top: 2px;
}
.pie-card { display: flex; flex-direction: column; }
.pie-wrap {
	display: flex; align-items: center; gap: 12px;
	margin: 4px 0 10px;
}
.pie {
	flex: 0 0 auto;
	width: 88px; height: 88px;
	border-radius: 50%;
	position: relative;
}
.pie::before {
	content: '';
	position: absolute;
	inset: 28%;
	border-radius: 50%;
	background: var(--bg);
}
.pie-center {
	position: absolute;
	inset: 0;
	display: flex; flex-direction: column;
	align-items: center; justify-content: center;
	font-variant-numeric: tabular-nums;
	line-height: 1.1;
	pointer-events: none;
}
.pie-total { font-size: 12px; font-weight: 600; }
.pie-cap {
	font-size: 9px; color: var(--fg-mute);
	text-transform: uppercase; letter-spacing: 0.04em;
	margin-top: 1px;
}
.legend {
	list-style: none; margin: 0; padding: 0;
	flex: 1; min-width: 0;
}
.legend li {
	display: flex; align-items: center; gap: 6px;
	padding: 2px 0;
	font-size: 12px;
}
.legend .dot {
	width: 9px; height: 9px;
	border-radius: 2px;
	flex: 0 0 auto;
}
.legend .lbl {
	color: var(--fg-mute);
	flex: 1; min-width: 0;
	overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.legend .val { font-variant-numeric: tabular-nums; font-weight: 500; }
.legend .pct {
	color: var(--fg-mute);
	font-weight: 400;
	margin-left: 4px;
	font-size: 11px;
}
.pie-card .kv-total {
	border-top: 1px solid var(--border);
	padding-top: 8px;
	margin-top: auto;
}
@media (max-width: 480px) {
	.pie-wrap { flex-direction: column; align-items: flex-start; }
}
.model-tag {
	display: inline-block;
	background: var(--chip);
	color: var(--chip-fg);
	padding: 2px 6px;
	border-radius: 4px;
	font-size: 11px;
	margin-right: 4px;
}
.metric { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
.metric-sub { color: var(--fg-mute); font-size: 12px; }
.dim { color: var(--fg-mute); }
footer {
	margin-top: 24px;
	color: var(--fg-mute);
	font-size: 11px;
	display: flex;
	justify-content: space-between;
}

/* mmx-cli section */
.mmx-grid {
	display: grid;
	grid-template-columns: repeat(3, minmax(0, 1fr));
	gap: 10px;
	margin-bottom: 14px;
}
@media (max-width: 720px) { .mmx-grid { grid-template-columns: 1fr; } }
.mmx-card {
	background: var(--bg);
	border: 1px solid var(--border);
	border-radius: 8px;
	padding: 12px 14px;
}
.mmx-card-title {
	font-size: 11px;
	text-transform: uppercase;
	letter-spacing: 0.04em;
	color: var(--fg-mute);
	margin-bottom: 8px;
}
.mmx-badge {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	padding: 2px 8px;
	border-radius: 999px;
	font-size: 11px;
	font-weight: 500;
	background: var(--chip);
	color: var(--chip-fg);
}
.mmx-badge-ok { color: var(--good); }
.mmx-badge-miss { color: var(--warn); }
.mmx-steps {
	display: flex;
	flex-direction: column;
	gap: 6px;
	margin: 10px 0 12px;
}
.mmx-step {
	display: flex;
	gap: 10px;
	padding: 8px 10px;
	border: 1px solid var(--border);
	border-radius: 6px;
	background: var(--bg);
}
.mmx-step.done { border-color: var(--good); }
.mmx-step-num {
	flex: 0 0 auto;
	width: 22px; height: 22px;
	border-radius: 50%;
	background: var(--border);
	color: var(--fg);
	display: flex; align-items: center; justify-content: center;
	font-size: 12px; font-weight: 600;
}
.mmx-step.done .mmx-step-num { background: var(--good); color: #0b1014; }
.mmx-step-body { flex: 1; min-width: 0; }
.mmx-step-label { font-size: 12px; font-weight: 500; }
.mmx-step-detail {
	font-size: 11px;
	color: var(--fg-mute);
	font-family: var(--vscode-editor-font-family, ui-monospace, monospace);
	margin-top: 2px;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.mmx-ready {
	padding: 8px 12px;
	border-radius: 6px;
	background: rgba(127, 127, 127, 0.08);
	border-left: 3px solid var(--fg-mute);
	font-size: 12px;
	margin-bottom: 10px;
}
.mmx-ready.ok {
	border-left-color: var(--good);
	background: rgba(16, 185, 129, 0.08);
}
.mmx-note {
	padding: 8px 12px;
	border-radius: 6px;
	border-left: 3px solid var(--warn);
	background: rgba(245, 158, 11, 0.08);
	font-size: 12px;
	margin-bottom: 10px;
}
.mmx-actions {
	display: flex;
	gap: 8px;
	flex-wrap: wrap;
}

/* ---- Tab bar ---- */
.tabs {
	display: flex; gap: 0; flex-wrap: wrap;
	border-bottom: 1px solid var(--border);
	margin-bottom: 16px;
}
.tabs button[role="tab"] {
	background: transparent;
	border: none;
	border-bottom: 2px solid transparent;
	border-radius: 0;
	padding: 8px 16px;
	color: var(--fg-mute);
	font-size: 13px;
	cursor: pointer;
	margin-bottom: -1px; /* overlap the bottom border */
}
.tabs button[role="tab"]:hover {
	background: var(--vscode-list-hoverBackground);
}
.tabs button[role="tab"][aria-selected="true"] {
	color: var(--fg);
	border-bottom-color: var(--accent);
}
[data-tab-pane].hidden { display: none; }

/* ---- Token Plan key selector ---- */
.plan-key-selector {
	display: flex;
	gap: 6px;
	flex-wrap: wrap;
	margin-bottom: 12px;
}
.plan-key-pill {
	background: var(--vscode-button-secondaryBackground);
	color: var(--vscode-button-secondaryForeground);
	border: 1px solid var(--border);
	padding: 3px 10px;
	border-radius: 999px;
	cursor: pointer;
	font-size: 11px;
	font-weight: 500;
	transition: background 0.15s, border-color 0.15s;
}
.plan-key-pill:hover {
	background: var(--vscode-button-secondaryHoverBackground);
}
.plan-key-pill.active {
	background: var(--vscode-textLink-foreground);
	color: var(--vscode-editor-background);
	border-color: var(--vscode-textLink-foreground);
}
</style>
</head>
<body class="${bodyClass}">
<div class="app">
<header>
	<div>
		<h1>${escapeHtml(messages.pageTitle)}</h1>
		<p>${escapeHtml(messages.subtitle)}</p>
	</div>
	<div class="actions">
		<button data-action="refresh" class="primary">${escapeHtml(messages.refresh)}</button>
		<button data-action="reset">${escapeHtml(messages.reset)}</button>
		<button data-action="close">${escapeHtml(messages.close)}</button>
	</div>
</header>

<div id="root">
	<div class="empty">${escapeHtml(messages.refresh)}…</div>
</div>

<footer>
	<span>MiniMax Copilot</span>
	<span data-stamp="updated"></span>
</footer>
</div>

<script id="i18n" type="application/json" nonce="${nonce}">${i18nJson}</script>
<script nonce="${nonce}" src="${webviewScriptUri}"></script>
</body>
</html>`;
	}
}

// --- Module augmentation so `vscode.WebviewMessage` is permissive enough
// to carry our ad-hoc `{ type, payload }` shape without TS errors. We
// keep this strictly local to the panel — production code that wants
// typed messages should use a discriminated union instead. ---
declare module 'vscode' {
	export type WebviewMessage = { type?: string; payload?: unknown };
}

// --- helpers ---

// `escapeHtml` lives in `./template.ts` so it can be unit-tested
// and shared with the inline webview JS through the same module.
// The previous copy here was a near-duplicate of the inline
// implementation inside the `renderHtml` template; the shared
// helper now covers both.

// --- mmx-cli action helpers --------------------------------------------
//
// These are called from `handleMessage` when the user clicks one of the
// buttons in the mmx-cli section. Each function:
//   1. Runs the underlying shell command via the mmxCli module.
//   2. Shows the result to the user via a notification + the "MiniMax:
//      Show Logs" channel.
//   3. Returns; the caller re-renders the dashboard so the new status
//      is reflected immediately.
//
// We do the install in a foreground task with a `Progress` so the user
// sees a spinner. The login + skill-install paths are quick and don't
// need the spinner.

async function handleMmxCopyPrompt(
	host: 'china' | 'global',
): Promise<void> {
	// The extension does not install anything, log in, or run any
	// shell command on the user's behalf here. It just copies the
	// verbatim prompt from the official MiniMax docs to the
	// clipboard, in the language matching the configured endpoint.
	// The user is fully in control of what they do with the prompt
	// next (paste it into a chat, run the commands themselves, etc.).
	const result = await copyMmxInstallPrompt(host);
	if (!result.copied) {
		vscode.window.showErrorMessage(t('mmx.copyFailed'));
		return;
	}
	vscode.window.showInformationMessage(t('mmx.promptCopied'));
}
