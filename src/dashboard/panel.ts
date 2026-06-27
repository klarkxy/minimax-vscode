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
	private readonly storeSubscription: vscode.Disposable;
	private readonly authChangeSubscription: vscode.Disposable;
	private readonly planCacheSubscription: vscode.Disposable;
	private readonly mmxCliCacheSubscription: vscode.Disposable;
	private readonly claudeCodeSubscription: vscode.Disposable | undefined;
	private state: DashboardPanelState = { locale: 'en' };
	private inFlight = false;
	private pendingRefresh = false;
	private pendingRefreshForce = false;
	private refreshSeq = 0;
	private readonly messageListener = (raw: vscode.WebviewMessage) => this.handleMessage(raw);

	private constructor(
		private readonly deps: DashboardPanelDeps,
		panel: vscode.WebviewPanel,
	) {
		this.panel = panel;
		this.state.locale = pickDashboardLocale(vscode.env.language);
		this.storeSubscription = deps.usageStore.subscribe(() => {
			void this.refresh();
		});
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
		// The shared plan cache fires on every successful fetch — keep the
		// dashboard in sync so we don't have to schedule our own timer.
		this.planCacheSubscription = deps.planCache.subscribe(() => {
			void this.refresh();
		});
		// Same pattern for the mmx-cli status cache: when an explicit
		// re-check produces a new snapshot, push it to the dashboard.
		this.mmxCliCacheSubscription = deps.mmxCliCache.subscribe(() => {
			void this.refresh();
		});
		// The Claude Code ingester emits no-arg events on every poll that
		// lands new data; re-rendering on every event keeps the "last
		// sync" timestamp and per-model table fresh.
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
			logger.info(`${LOG_PREFIX} reveal existing panel`);
			DashboardPanel.current.panel.reveal(vscode.ViewColumn.Beside);
			void DashboardPanel.current.refresh();
			return DashboardPanel.current;
		}
		logger.info(`${LOG_PREFIX} create panel`);
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
		this.storeSubscription.dispose();
		this.authChangeSubscription.dispose();
		this.planCacheSubscription.dispose();
		this.mmxCliCacheSubscription.dispose();
		this.claudeCodeSubscription?.dispose();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.disposables.length = 0;
		if (DashboardPanel.current === this) {
			DashboardPanel.current = undefined;
		}
	}

	/**
	 * Re-render. The plan-cache refresh honours the 5-minute TTL
	 * unless `force: true` is passed — the dashboard's Refresh
	 * button does so; the auto-pulse paths (chat turn end, store
	 * subscription, etc.) don't.
	 */
	async refresh(options?: { force?: boolean }): Promise<void> {
		let force = options?.force === true;
		if (this.inFlight) {
			this.pendingRefresh = true;
			this.pendingRefreshForce = this.pendingRefreshForce || force;
			logger.info(`${LOG_PREFIX} refresh queued force=${force} pendingForce=${this.pendingRefreshForce}`);
			return;
		}
		this.inFlight = true;
		logger.info(`${LOG_PREFIX} refresh loop start force=${force}`);
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
			logger.info(`${LOG_PREFIX} refresh loop end`);
		}
	}

	private async refreshOnce(options?: { force?: boolean }): Promise<void> {
		const seq = ++this.refreshSeq;
		const startedAt = Date.now();
		try {
			const apiKey = await this.authForRefresh();
			const platform = apiKey
				? {
					apiKey,
					host: this.deps.getHost?.() ?? null,
				}
				: null;
			logger.info(
				`${LOG_PREFIX} #${seq} start force=${options?.force === true} hasKey=${!!apiKey} host=${platform?.host ?? 'none'}`,
			);
			const planSnapshot = platform ? this.deps.planCache.read(platform) : undefined;
			const mmxCliSnapshot = this.deps.mmxCliCache.read();
			// MCP host/apiKey are stable for the duration of a refresh —
			// `getBaseUrl()` and `authForRefresh()` have already produced
			// their final values above. Compute the MCP card once instead
			// of running the same host picker + provider-registered probe
			// for both the cached and the refreshed view.
			const mcp = await this.computeMcpStatus(apiKey);
			const cachedView = await buildCachedDashboardView({
				store: this.deps.usageStore,
				planSnapshot,
				planSource: planSnapshot
					? 'ok'
					: apiKey
						? 'loading'
						: 'unconfigured',
				mmxCli: mmxCliSnapshot?.status,
				mcp,
				claudeCodeIngest: this.deps.claudeCodeIngest,
			});
			logger.info(
				`${LOG_PREFIX} #${seq} cached view plan=${cachedView.sources.plan} snapshot=${!!planSnapshot}`,
			);
			await this.postData(cachedView, `${seq}:cached`);

			// Refresh the plan cache in the background. We kick this off
			// before awaiting `buildDashboardView` so the aggregator can
			// reuse the snapshot we already have on cache hit, instead of
			// issuing a second `fetchPlanUsage` round-trip.
			//
			// `force: true` is intentionally NOT set here — this is the
			// auto-pulse path (chat turn end, store subscription, etc.),
			// and the 5-minute TTL is the desired rate-limit. The
			// dashboard's explicit Refresh button (see the `case 'refresh'`
			// handler below) passes `force: true` for guaranteed-fresh.
			const force = options?.force === true;
			let planRefreshError: string | undefined;
			let planRefreshPromise: Promise<unknown> = Promise.resolve();
			if (platform) {
				logger.info(`${LOG_PREFIX} #${seq} plan refresh start force=${force}`);
				planRefreshPromise = this.deps.planCache.refresh(
					platform,
					{ force },
				).catch((error) => {
					planRefreshError = error instanceof Error ? error.message : String(error);
					logger.warn('plan cache refresh failed', error);
					return null;
				});
			}
			// Refresh the mmx-cli detection in the background. The
			// cached view above already shows the last-known state, so
			// the user does not see an "unknown → green" flicker on
			// dashboard open. Failure here does NOT clear the cache —
			// the previous snapshot is preserved.
			const mmxPromise = this.deps.mmxCliCache.refresh().catch((error) => {
				logger.warn('mmx-cli cache refresh failed', error);
				return null;
			});
			await planRefreshPromise;
			logger.info(`${LOG_PREFIX} #${seq} plan refresh end error=${planRefreshError ? 'yes' : 'no'}`);
			// Read the cache again post-refresh so the final view
			// reflects whatever the background fetch landed.
			const refreshedPlanSnapshot = platform ? this.deps.planCache.read(platform) : undefined;
			const refreshedMmxCliSnapshot = this.deps.mmxCliCache.read();
			const view = planRefreshError && !refreshedPlanSnapshot
				? await buildCachedDashboardView({
					store: this.deps.usageStore,
					planSource: 'error',
					planError: planRefreshError,
					mmxCli: refreshedMmxCliSnapshot?.status,
					mcp,
					claudeCodeIngest: this.deps.claudeCodeIngest,
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
				});
			logger.info(
				`${LOG_PREFIX} #${seq} final view plan=${view.sources.plan} elapsedMs=${Date.now() - startedAt}`,
			);
			await this.postData(view, `${seq}:final`);
			await mmxPromise;
		} catch (error) {
			logger.warn(`${LOG_PREFIX} #${seq} refresh failed`, error);
			await this.postError(error);
		}
	}

	/**
	 * Read the API key from the auth manager. Wrapped so the panel can
	 * later swap in a faster path (e.g. cached from secrets.onDidChange)
	 * without touching the rest of `refresh`.
	 */
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

	private async postData(view: DashboardView, traceId: string): Promise<void> {
		const ok = await this.panel.webview.postMessage({
			type: 'data',
			traceId,
			payload: view,
		});
		logger.info(`${LOG_PREFIX} post data trace=${traceId} ok=${ok} plan=${view.sources.plan}`);
	}

	private async postError(error: unknown): Promise<void> {
		const message = error instanceof Error ? error.message : String(error);
		await this.panel.webview.postMessage({
			type: 'error',
			payload: { message },
		});
	}

	private async handleMessage(raw: vscode.WebviewMessage): Promise<void> {
		const message = raw as { type?: string; payload?: unknown };
		logger.info(`${LOG_PREFIX} webview message type=${message.type ?? 'unknown'}`);
		switch (message.type) {
			case 'ready':
				await this.refresh();
				return;
			case 'renderAck': {
				const payload = message.payload as { traceId?: unknown; plan?: unknown; elapsedMs?: unknown } | undefined;
				logger.info(
					`${LOG_PREFIX} render ack trace=${String(payload?.traceId ?? '?')} plan=${String(payload?.plan ?? '?')} elapsedMs=${String(payload?.elapsedMs ?? '?')}`,
				);
				return;
			}
			case 'renderError': {
				const payload = message.payload as { traceId?: unknown; message?: unknown } | undefined;
				logger.warn(
					`${LOG_PREFIX} render error trace=${String(payload?.traceId ?? '?')} message=${String(payload?.message ?? '?')}`,
				);
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
		// only attached to the inline `<script id="i18n">` payload —
		// the main webview JS is loaded as a separately-built file
		// (`out/dashboard-webview.js`) through `asWebviewUri`, which
		// is implicitly trusted by the webview host and does not
		// need a nonce.
		const nonce = randomBytes(16).toString('base64');
		const i18nJson = escapeJsonForScript(messages);
		const webviewScriptUri = this.panel.webview.asWebviewUri(
			vscode.Uri.joinPath(this.deps.extensionUri, 'out', 'dashboard-webview.js'),
		);

		return `<!DOCTYPE html>
<html lang="${htmlLangFor(this.state.locale)}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${cspSource}; script-src 'nonce-${nonce}' ${webviewScriptUri};">
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
<script src="${webviewScriptUri}"></script>
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
