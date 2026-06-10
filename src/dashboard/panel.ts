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
import { buildCachedDashboardView, buildDashboardView, type PlanCache } from './aggregator';
import { copyMmxInstallPrompt, type MmxCliStatus } from './mmxCli';
import type { MmxCliCache } from './mmxCliCache';
import type { ClaudeCodeIngestHandle } from './claudeCodeIngest';
import type { DashboardView } from './types';

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
	/** Optional platform host override; defaults to the configured base URL. */
	host?: 'china' | 'global';
}

const VIEW_TYPE = 'minimax.dashboard';

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
			DashboardPanel.current.panel.reveal(vscode.ViewColumn.Beside);
			void DashboardPanel.current.refresh();
			return DashboardPanel.current;
		}
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

	/** Forces a fresh fetch + re-render. Used by command palette, etc. */
	async refresh(): Promise<void> {
		if (this.inFlight) {
			return;
		}
		this.inFlight = true;
		try {
			const apiKey = await this.authForRefresh();
			const planSnapshot = this.deps.planCache.read();
			const mmxCliSnapshot = this.deps.mmxCliCache.read();
			const cachedView = buildCachedDashboardView({
				store: this.deps.usageStore,
				planSnapshot,
				planSource: planSnapshot
					? 'ok'
					: apiKey
						? 'loading'
						: 'unconfigured',
				mmxCli: mmxCliSnapshot?.status,
				claudeCodeIngest: this.deps.claudeCodeIngest,
			});
			await this.postData(cachedView);

			// Refresh the plan cache in the background. We kick this off
			// before awaiting `buildDashboardView` so the aggregator can
			// reuse the snapshot we already have on cache hit, instead of
			// issuing a second `fetchPlanUsage` round-trip.
			let planRefreshPromise: Promise<unknown> = Promise.resolve();
			if (apiKey) {
				planRefreshPromise = this.deps.planCache.refresh({
					apiKey,
					host: this.deps.host,
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
			// Read the cache again post-refresh so the final view
			// reflects whatever the background fetch landed.
			const refreshedPlanSnapshot = this.deps.planCache.read();
			const refreshedMmxCliSnapshot = this.deps.mmxCliCache.read();
			const view = await buildDashboardView({
				store: this.deps.usageStore,
				platform: apiKey
					? {
						apiKey,
						host: this.deps.host,
					}
					: null,
				// Hand the aggregator the snapshot we already have so it
				// does NOT re-fetch on its own.
				planSnapshot: refreshedPlanSnapshot,
				mmxCliStatus: refreshedMmxCliSnapshot?.status,
				claudeCodeIngest: this.deps.claudeCodeIngest,
			});
			await this.postData(view);
			await mmxPromise;
		} catch (error) {
			logger.warn('Dashboard refresh failed', error);
			await this.postError(error);
		} finally {
			this.inFlight = false;
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

	private async postData(view: DashboardView): Promise<void> {
		await this.panel.webview.postMessage({
			type: 'data',
			payload: view,
		});
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
		switch (message.type) {
			case 'ready':
				await this.refresh();
				return;
			case 'refresh':
				await this.refresh();
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
				await handleMmxCopyPrompt(this.deps.host ?? 'global');
				return;
			}
			case 'mmxRecheck': {
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
		const nonce = String(Math.floor(Math.random() * 0x7fffffff));
		const i18nJson = JSON.stringify(messages).replace(/</g, '\\u003c');

		return `<!DOCTYPE html>
<html lang="${this.state.locale === 'zh' ? 'zh-CN' : 'en'}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${cspSource}; script-src 'nonce-${nonce}';">
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
section[data-source="claudeCode"] {
	/* Visual distinction from the local (extension) section: a left
	   accent strip so the user can tell at a glance which is which. */
	border-left: 3px solid var(--accent);
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
<script nonce="${nonce}">
(function () {
	const vscode = acquireVsCodeApi();
	const root = document.getElementById('root');
	const updatedStamp = document.querySelector('[data-stamp="updated"]');
	const i18n = JSON.parse(document.getElementById('i18n').textContent);

	function fmtNumber(n) {
		if (typeof n !== 'number' || !isFinite(n)) return '0';
		if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
		if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
		return String(n);
	}
	function fmtFull(n) {
		if (typeof n !== 'number' || !isFinite(n)) return '0';
		return n.toLocaleString('en-US');
	}
	function escapeHtml(value) {
		if (value === null || value === undefined) return '';
		return String(value)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	}
	function progressClass(pct) {
		if (pct >= 85) return 'bad';
		if (pct >= 60) return 'warn';
		return '';
	}
	function card(title, rows) {
		const items = rows.map(([k, v, cls]) => (
			'<div class="kv">' +
				'<span>' + escapeHtml(k) + '</span>' +
				'<span class="' + (cls || '') + '">' + escapeHtml(v) + '</span>' +
			'</div>'
		)).join('');
		return '<div class="card"><h3>' + escapeHtml(title) + '</h3>' + items + '</div>';
	}
	function progressBlock(percentage, used, total) {
		const pct = Math.max(0, Math.min(100, percentage || 0));
		const cls = progressClass(pct);
		// Some quota models (e.g. the platform's "general" model) return a
		// remaining-percent but no matching current_interval_total_count,
		// so we cannot derive a meaningful "used" count from total=0. In
		// that case we render the bar + percentage only and omit the
		// "X / Y" suffix — mirrors minimax-status's behavior when its
		// totalCount is zero.
		const pairHtml = total > 0
			? '<span class="dim">' + fmtFull(used) + ' / ' + fmtFull(total) + '</span>'
			: '';
		return (
			'<div class="progress ' + cls + '"><div class="fill" style="width: ' + pct + '%"></div></div>' +
			'<div class="kv" style="margin-top: 6px;"><span class="dim">' + pct + '%</span>' + pairHtml + '</div>'
		);
	}
	function localCard(title, usage) {
		// Donut centre shows the all-in token total (input + cacheWrite +
		// cacheRead + output) — the same number the per-day totalTokens()
		// helper in aggregator.ts returns and what the price table multiplies
		// against. The legend breaks out the four buckets so the user can
		// see what share of the day's traffic actually hit cache.
		const slices = [
			{ key: i18n.fieldInput, value: usage.inputTokens, color: 'var(--accent)' },
			{ key: i18n.fieldCacheRead, value: usage.cacheReadTokens, color: 'var(--good)' },
			{ key: i18n.fieldCacheWrite, value: usage.cacheWriteTokens, color: 'var(--warn)' },
			{ key: i18n.fieldOutput, value: usage.outputTokens, color: 'var(--bad)' },
		];
		const totalBilled = slices.reduce(function (s, it) { return s + (it.value || 0); }, 0);
		let pieBg;
		if (totalBilled > 0) {
			let cursor = 0;
			const stops = [];
			for (const it of slices) {
				if (!it.value) continue;
				const start = (cursor / totalBilled) * 100;
				cursor += it.value;
				const end = (cursor / totalBilled) * 100;
				stops.push(it.color + ' ' + start.toFixed(2) + '% ' + end.toFixed(2) + '%');
			}
			pieBg = 'conic-gradient(' + stops.join(', ') + ')';
		} else {
			pieBg = 'var(--border)';
		}
		const legend = slices.map(function (it) {
			const pct = totalBilled > 0 ? ((it.value / totalBilled) * 100).toFixed(1) : '0.0';
			return '<li>' +
				'<span class="dot" style="background:' + it.color + '"></span>' +
				'<span class="lbl">' + escapeHtml(it.key) + '</span>' +
				'<span class="val">' + fmtFull(it.value) +
					'<span class="pct">' + pct + '%</span>' +
				'</span>' +
			'</li>';
		}).join('');
		return (
			'<div class="card pie-card"><h3>' + escapeHtml(title) + '</h3>' +
			'<div class="pie-wrap">' +
				'<div class="pie" style="background:' + pieBg + '">' +
					'<div class="pie-center">' +
						'<div class="pie-total">' + escapeHtml(fmtNumber(totalBilled)) + '</div>' +
						'<div class="pie-cap">' + escapeHtml(i18n.fieldTotal) + '</div>' +
					'</div>' +
				'</div>' +
				'<ul class="legend">' + legend + '</ul>' +
			'</div>' +
			'<div class="kv kv-total">' +
				'<span>' + escapeHtml(i18n.fieldRequests) + '</span>' +
				'<span>' + fmtFull(usage.requests) + '</span>' +
			'</div></div>'
		);
	}
	function platformSection(plan) {
		if (!plan) return '';
		// Per the latest design: two cards (5h + weekly) only. The card
		// title is the model name + window; the percentage fills the bar
		// and the reset time sits on the right end of the title row as a
		// small pill. The previous "Used: X / Y" data card and the
		// per-model table were dropped — when total=0 the X/Y would have
		// been a meaningless "0 / 0", and when total>0 the bar already
		// shows the same information at a glance.
		const planBar = (pct) => {
			const clamped = Math.max(0, Math.min(100, pct || 0));
			const cls = progressClass(clamped);
			return (
				'<div class="progress ' + cls + '"><div class="fill" style="width: ' + clamped + '%"></div></div>' +
				'<div class="kv" style="margin-top: 6px;"><span class="dim">' + clamped + '%</span></div>'
			);
		};
		const cardWithReset = (title, pct, resetText) => (
			'<div class="card"><h3>' +
				'<span>' + escapeHtml(title) + '</span>' +
				'<span class="reset-pill">' + escapeHtml(resetText) + '</span>' +
			'</h3>' + planBar(pct) + '</div>'
		);

		const currentCard = cardWithReset(
			plan.modelName + ' · 5h',
			plan.currentPercentage,
			plan.currentResetText,
		);
		const weeklyCard = plan.weeklyUnlimited
			? '<div class="card"><h3><span>' + escapeHtml(i18n.fieldWeekly) + '</span>' +
				'<span class="reset-pill">∞</span></h3>' + planBar(0) + '</div>'
			: cardWithReset(
				i18n.fieldWeekly,
				plan.weeklyPercentage,
				plan.weeklyResetText,
			);

		const expiryCard = plan.expiryDate
			? card(i18n.fieldExpiry, [
					[plan.expiryDate, i18n.fieldExpiryDays(plan.expiryDays ?? 0)],
				])
			: '';

		return (
			'<section><h2>' + escapeHtml(i18n.planSectionTitle) + '</h2>' +
			'<div class="grid grid-2">' +
				currentCard +
				weeklyCard +
			'</div>' +
			expiryCard +
			'</section>'
		);
	}
	function platformBanner(sources) {
		if (sources.plan === 'ok') return '';
		if (sources.plan === 'loading') {
			return '<div class="banner">' + escapeHtml(i18n.platformLoading) + '</div>';
		}
		if (sources.plan === 'unconfigured') {
			return '<div class="banner">' + escapeHtml(i18n.platformUnconfigured) + '</div>';
		}
		if (sources.plan === 'error' || sources.plan === 'unsupported') {
			const detail = sources.planError ? ' — ' + escapeHtml(sources.planError) : '';
			return '<div class="banner">' + escapeHtml(i18n.platformUnavailable) + detail + '</div>';
		}
		return '';
	}
	function localSection(local) {
		const header = '<section data-source="local"><h2>' + escapeHtml(i18n.localSectionTitle) + '</h2>' +
			'<div class="grid grid-3">' +
				localCard(i18n.windowToday, local.today) +
				localCard(i18n.window7d, local.sevenDay) +
				localCard(i18n.window30d, local.thirtyDay) +
			'</div></section>';
		const chart = chartSection(local.dailySeries);
		const models = modelTable(local.perModel);
		return header + chart + models;
	}
	function claudeCodeSection(view) {
		// Three layouts:
		//   - 'disabled'      → thin banner with an "Open Settings" CTA.
		//   - 'empty'         → friendly empty state with an
		//                       "Open log folder" CTA in case the path
		//                       is wrong.
		//   - everything else → full section (header, status row, 3
		//                       window cards, error banner when last
		//                       poll failed, action row, daily chart,
		//                       per-model table).
		if (!view) {
			return (
				'<section data-source="claudeCode"><h2>' + escapeHtml(i18n.claudeCodeSectionTitle) + '</h2>' +
				'<div class="banner">' + escapeHtml(i18n.claudeCodeDisabled) +
				' <button class="link" data-action="claude-code-open-settings">' + escapeHtml(i18n.claudeCodeOpenSettingsBtn) + '</button>' +
				'</div></section>'
			);
		}
		const status = view.status;
		if (status.state === 'empty') {
			return (
				'<section data-source="claudeCode"><h2>' + escapeHtml(i18n.claudeCodeSectionTitle) + '</h2>' +
				'<p class="dim" style="margin: 0 0 10px;">' + escapeHtml(i18n.claudeCodeSubtitle) + '</p>' +
				'<div class="banner">' + escapeHtml(i18n.claudeCodeEmpty) + '</div>' +
				'<div class="mmx-actions" style="margin-top: 12px;">' +
				'<button data-action="claude-code-open-folder">' + escapeHtml(i18n.claudeCodeOpenFolderBtn) + '</button>' +
				'</div></section>'
			);
		}
		const lastSyncText = status.lastSyncAt
			? new Date(status.lastSyncAt).toLocaleString()
			: i18n.claudeCodeNeverSynced;
		const header =
			'<section data-source="claudeCode"><h2>' + escapeHtml(i18n.claudeCodeSectionTitle) + '</h2>' +
			'<p class="dim" style="margin: 0 0 10px;">' + escapeHtml(i18n.claudeCodeSubtitle) + '</p>' +
			'<div class="kv"><span class="dim">' + escapeHtml(i18n.claudeCodeLastSync) + '</span>' +
			'<span>' + escapeHtml(lastSyncText) + '</span></div>' +
			'<div class="kv"><span class="dim">' + escapeHtml(i18n.claudeCodeLogPath) + '</span>' +
			'<span class="path">' + escapeHtml(status.logPath) + '</span></div>';
		const errorBanner = (status.state === 'error' && status.lastError)
			? '<div class="banner">' + escapeHtml(i18n.claudeCodeErrorBanner) + ' — ' + escapeHtml(status.lastError) + '</div>'
			: '';
		const cards =
			'<div class="grid grid-3">' +
				localCard(i18n.windowToday, view.today) +
				localCard(i18n.window7d, view.sevenDay) +
				localCard(i18n.window30d, view.thirtyDay) +
			'</div>';
		const actions =
			'<div class="mmx-actions" style="margin-top: 12px;">' +
				'<button data-action="claude-code-rescan">' + escapeHtml(i18n.claudeCodeRecheckBtn) + '</button>' +
				'<button data-action="claude-code-open-folder">' + escapeHtml(i18n.claudeCodeOpenFolderBtn) + '</button>' +
			'</div>';
		const notes = [];
		if (status.filesTracked > 0) {
			notes.push(escapeHtml(i18n.claudeCodeFilesTracked.replace('{0}', String(status.filesTracked))));
		}
		if (status.parseErrors > 0) {
			notes.push(escapeHtml(i18n.claudeCodeParseErrors.replace('{0}', String(status.parseErrors))));
		}
		const notesHtml = notes.length
			? '<div class="kv"><span class="dim"></span><span>' + notes.join(' · ') + '</span></div>'
			: '';
		const chart = chartSection(view.dailySeries);
		const models = modelTable(view.perModel);
		return header + errorBanner + cards + actions + notesHtml + chart + models + '</section>';
	}
	function chartSection(series) {
		if (!series || series.length === 0) return '';
		const totals = series.map(function (s) {
			return s.usage.inputTokens + s.usage.outputTokens + s.usage.cacheReadTokens + s.usage.cacheWriteTokens;
		});
		const max = Math.max.apply(null, totals.concat([1]));
		const bars = series.map(function (s, i) {
			const t = totals[i];
			const heightPct = max > 0 ? Math.max(2, Math.round((t / max) * 100)) : 2;
			const cls = t === 0 ? 'bar zero' : 'bar';
			return '<div class="' + cls + '" style="height: ' + heightPct + '%" title="' + escapeHtml(s.date) + ' · ' + fmtFull(t) + ' tokens"></div>';
		}).join('');
		return (
			'<section><h2>' + escapeHtml(i18n.dailyChartTitle) + '</h2>' +
			'<div class="bar-chart">' + bars + '</div>' +
			'<div class="chart-axis">' +
				'<span>' + escapeHtml(series[0].date.slice(5)) + '</span>' +
				'<span>' + escapeHtml(series[series.length - 1].date.slice(5)) + '</span>' +
			'</div></section>'
		);
	}
	function modelTable(perModel) {
		if (!perModel || perModel.length === 0) return '';
		const rows = perModel.map(function (row) {
			const u = row.usage;
			return '<tr><td><span class="model-tag">' + escapeHtml(row.modelId) + '</span></td>' +
				'<td class="right">' + fmtFull(u.inputTokens) + '</td>' +
				'<td class="right">' + fmtFull(u.cacheReadTokens) + '</td>' +
				'<td class="right">' + fmtFull(u.cacheWriteTokens) + '</td>' +
				'<td class="right">' + fmtFull(u.outputTokens) + '</td>' +
				'<td class="right">' + fmtFull(u.requests) + '</td></tr>';
		}).join('');
		return (
			'<section><h2>' + escapeHtml(i18n.perModelTitle) + '</h2>' +
			'<table><thead><tr>' +
				'<th></th>' +
				'<th class="right">' + escapeHtml(i18n.fieldInput) + '</th>' +
				'<th class="right">' + escapeHtml(i18n.fieldCacheRead) + '</th>' +
				'<th class="right">' + escapeHtml(i18n.fieldCacheWrite) + '</th>' +
				'<th class="right">' + escapeHtml(i18n.fieldOutput) + '</th>' +
				'<th class="right">' + escapeHtml(i18n.fieldRequests) + '</th>' +
			'</tr></thead><tbody>' + rows + '</tbody></table></section>'
		);
	}
	function emptyState(sources) {
		if (sources.local === 'empty') {
			return '<div class="empty">' + escapeHtml(i18n.noLocalData) + '</div>';
		}
		return '';
	}
	function statusBadge(state, okLabel, missingLabel) {
		if (state === 'installed' || state === 'loggedIn') {
			return '<span class="mmx-badge mmx-badge-ok">● ' + escapeHtml(okLabel) + '</span>';
		}
		if (state === 'unknown') {
			return '<span class="mmx-badge">○ ' + escapeHtml(okLabel) + '</span>';
		}
		return '<span class="mmx-badge mmx-badge-miss">○ ' + escapeHtml(missingLabel) + '</span>';
	}
	function mmxSection(mmx) {
		if (!mmx) return '';
		const install = mmx.install;
		const version = mmx.version || '—';
		const auth = mmx.auth;
		const skill = mmx.skill;

		const installBadge = statusBadge(install, i18n.mmxInstalled, i18n.mmxMissing);
		const authLabel = auth === 'loggedIn'
			? i18n.mmxAuthLoggedIn
			: auth === 'loggedOut'
				? i18n.mmxAuthLoggedOut
				: i18n.mmxAuthUnknown;
		const authBadge = statusBadge(auth, authLabel, i18n.mmxAuthLoggedOut);
		const skillBadge = statusBadge(skill, i18n.mmxSkillInstalled, i18n.mmxSkillMissing);

		// Per-step help lines — only shown for the steps that are
		// NOT yet done, mirroring the "完成了哪个就消失" contract
		// the user asked for. The cards above are the authoritative
		// status; the lines below are the recipe to finish the
		// remaining steps.
		const pendingSteps = [];
		if (install !== 'installed') {
			pendingSteps.push({
				num: pendingSteps.length + 1,
				label: i18n.mmxInstallBtn,
				detail: 'npm install -g mmx-cli',
			});
		}
		if (install === 'installed' && auth !== 'loggedIn') {
			pendingSteps.push({
				num: pendingSteps.length + 1,
				label: i18n.mmxLoginBtn,
				detail: 'mmx auth login --api-key …',
			});
		}
		if (install === 'installed' && skill !== 'installed') {
			pendingSteps.push({
				num: pendingSteps.length + 1,
				label: i18n.mmxInstallSkillBtn,
				detail: 'npx skills add MiniMax-AI/cli -y -g',
			});
		}
		const stepsHtml = pendingSteps.map(function (s) {
			return (
				'<div class="mmx-step">' +
					'<span class="mmx-step-num">' + s.num + '</span>' +
					'<div class="mmx-step-body">' +
						'<div class="mmx-step-label">' + escapeHtml(s.label) + '</div>' +
						'<div class="mmx-step-detail">' + escapeHtml(s.detail) + '</div>' +
					'</div>' +
				'</div>'
			);
		}).join('');

		const buttons = [];
		// The extension only does detection - it never installs the
		// CLI, never runs mmx auth login, and never installs the
		// SKILL. The only user-facing action here is "Copy the
		// official three-step prompt" (in the right language for
		// the configured endpoint) and "Re-check" to re-probe.
		buttons.push('<button data-action="mmx-copy-prompt" class="primary">' + escapeHtml(i18n.mmxCopyPromptBtn) + '</button>');
		buttons.push('<button data-action="mmx-recheck">' + escapeHtml(i18n.mmxRecheckBtn) + '</button>');

		const readyNote = mmx.agentReady
			? '<div class="mmx-ready ok">' + escapeHtml(i18n.mmxAgentReady) + '</div>'
			: (install === 'installed'
				? '<div class="mmx-ready">' + escapeHtml(i18n.mmxAgentNotReady) + '</div>'
				: '');

		const noteHtml = mmx.note
			? '<div class="mmx-note">' + escapeHtml(mmx.note) + '</div>'
			: '';

		return (
			'<section><h2>' + escapeHtml(i18n.mmxSectionTitle) + '</h2>' +
			'<p class="dim" style="margin: 0 0 14px;">' + escapeHtml(i18n.mmxSubtitle) + '</p>' +
			'<div class="mmx-grid">' +
				'<div class="mmx-card"><div class="mmx-card-title">' + escapeHtml(i18n.mmxCommandLabel) + '</div>' + installBadge + '<div class="dim" style="margin-top:6px;">' + escapeHtml(i18n.mmxVersion) + ' ' + escapeHtml(version) + '</div></div>' +
				'<div class="mmx-card"><div class="mmx-card-title">mmx auth</div>' + authBadge + '</div>' +
				'<div class="mmx-card"><div class="mmx-card-title">agent skill</div>' + skillBadge + '</div>' +
			'</div>' +
			(stepsHtml ? '<div class="mmx-steps">' + stepsHtml + '</div>' : '') +
			readyNote +
			noteHtml +
			'<div class="mmx-actions">' + buttons.join('') + '</div>' +
			'</section>'
		);
	}
	function render(view) {
		const banner = platformBanner(view.sources);
		const plan = view.plan ? platformSection(view.plan) : '';
		const local = view.local ? localSection(view.local) : '';
		const claudeCode = claudeCodeSection(view.claudeCode);
		const empty = emptyState(view.sources);
		const mmx = mmxSection(view.mmxCli);
		root.innerHTML = banner + plan + local + claudeCode + mmx + empty;
		updatedStamp.textContent = i18n.fieldUpdated + ': ' + new Date().toLocaleTimeString();
	}
	document.addEventListener('click', function (event) {
		const target = event.target.closest('[data-action]');
		if (!target) return;
		const action = target.getAttribute('data-action');
		if (action === 'refresh') vscode.postMessage({ type: 'refresh' });
		else if (action === 'close') vscode.postMessage({ type: 'close' });
		else if (action === 'reset') vscode.postMessage({ type: 'reset' });
		else if (action === 'mmx-copy-prompt') vscode.postMessage({ type: 'mmxCopyPrompt' });
		else if (action === 'mmx-recheck') vscode.postMessage({ type: 'mmxRecheck' });
		else if (action === 'claude-code-rescan') vscode.postMessage({ type: 'claudeCodeRescan' });
		else if (action === 'claude-code-open-folder') vscode.postMessage({ type: 'claudeCodeOpenFolder' });
		else if (action === 'claude-code-open-settings') vscode.postMessage({ type: 'claudeCodeOpenSettings' });
	});
	window.addEventListener('message', function (event) {
		const message = event.data;
		if (!message || typeof message !== 'object') return;
		if (message.type === 'data') render(message.payload);
		else if (message.type === 'error') {
			root.innerHTML = '<div class="banner">' + escapeHtml(message.payload && message.payload.message || 'error') + '</div>';
		}
	});
	vscode.postMessage({ type: 'ready' });
})();
</script>
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

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

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