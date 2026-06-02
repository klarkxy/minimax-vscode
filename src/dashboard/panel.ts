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
import { buildDashboardView } from './aggregator';
import type { DashboardView } from './types';

export interface DashboardPanelDeps {
	extensionUri: vscode.Uri;
	auth: AuthManager;
	usageStore: UsageStore;
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
	private state: DashboardPanelState = { locale: 'en' };
	private refreshTimer: NodeJS.Timeout | undefined;
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

		this.panel.webview.options = {
			enableScripts: true,
			localResourceRoots: [deps.extensionUri],
		};
		this.panel.webview.html = this.renderHtml(dashboardMessages(this.state.locale), null);
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
		if (refreshTimerHandle(this)) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = undefined;
		}
		this.storeSubscription.dispose();
		this.authChangeSubscription.dispose();
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
			const apiKey = await this.deps.auth.getApiKey();
			const view = await buildDashboardView({
				store: this.deps.usageStore,
				platform: apiKey
					? {
							apiKey,
							host: this.deps.host,
						}
					: null,
			});
			await this.postData(view);
		} catch (error) {
			logger.warn('Dashboard refresh failed', error);
			await this.postError(error);
		} finally {
			this.inFlight = false;
		}
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
						null,
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
		}
	}

	private renderHtml(messages: DashboardMessages, _placeholder: unknown): string {
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
		return (
			'<div class="progress ' + cls + '"><div class="fill" style="width: ' + pct + '%"></div></div>' +
			'<div class="kv" style="margin-top: 6px;"><span class="dim">' + pct + '%</span>' +
			'<span class="dim">' + fmtFull(used) + ' / ' + fmtFull(total) + '</span></div>'
		);
	}
	function localCard(title, usage) {
		const slices = [
			{ key: i18n.fieldInput, value: usage.inputTokens, color: 'var(--accent)' },
			{ key: i18n.fieldCacheRead, value: usage.cacheReadTokens, color: 'var(--good)' },
			{ key: i18n.fieldCacheWrite, value: usage.cacheWriteTokens, color: 'var(--warn)' },
			{ key: i18n.fieldOutput, value: usage.outputTokens, color: 'var(--bad)' },
		];
		const total = slices.reduce(function (s, it) { return s + (it.value || 0); }, 0);
		let pieBg;
		if (total > 0) {
			let cursor = 0;
			const stops = [];
			for (const it of slices) {
				if (!it.value) continue;
				const start = (cursor / total) * 100;
				cursor += it.value;
				const end = (cursor / total) * 100;
				stops.push(it.color + ' ' + start.toFixed(2) + '% ' + end.toFixed(2) + '%');
			}
			pieBg = 'conic-gradient(' + stops.join(', ') + ')';
		} else {
			pieBg = 'var(--border)';
		}
		const legend = slices.map(function (it) {
			const pct = total > 0 ? ((it.value / total) * 100).toFixed(1) : '0.0';
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
						'<div class="pie-total">' + escapeHtml(fmtNumber(total)) + '</div>' +
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
		const current = card(plan.modelName, [
			[i18n.fieldUsed, fmtFull(plan.currentUsed) + ' / ' + fmtFull(plan.currentTotal)],
			[i18n.fieldResetsIn, plan.currentResetText],
		]);
		const currentProgress = (
			'<div style="margin-top: 10px;">' + progressBlock(plan.currentPercentage, plan.currentUsed, plan.currentTotal) + '</div>'
		);
		const weekly = plan.weeklyUnlimited
			? card(i18n.fieldRemaining, [[i18n.fieldWeeklyReset, '∞']])
			: card(i18n.fieldRemaining, [
					[i18n.fieldUsed, fmtFull(plan.weeklyUsed) + ' / ' + fmtFull(plan.weeklyTotal)],
					[i18n.fieldWeeklyReset, plan.weeklyResetText],
				]);
		const weeklyProgress = plan.weeklyUnlimited
			? ''
			: '<div style="margin-top: 10px;">' + progressBlock(plan.weeklyPercentage, plan.weeklyUsed, plan.weeklyTotal) + '</div>';
		const expiryCard = plan.expiryDate
			? card(i18n.fieldExpiry, [
					[plan.expiryDate, i18n.fieldExpiryDays(plan.expiryDays ?? 0)],
				])
			: '';
		const modelsTable = (plan.allModels && plan.allModels.length)
			? '<table style="margin-top: 14px;"><thead><tr><th>' + escapeHtml(i18n.platformModelHeader) + '</th><th class="right">' + escapeHtml(i18n.fieldUsed) + '</th><th class="right">' + escapeHtml(i18n.fieldTotal) + '</th><th class="right">%</th></tr></thead><tbody>' +
				plan.allModels.map(function (m) {
					return '<tr><td>' + escapeHtml(m.name) + '</td><td class="right">' + fmtFull(m.used) + '</td><td class="right">' + fmtFull(m.total) + '</td><td class="right">' + m.percentage + '%</td></tr>';
				}).join('') + '</tbody></table>'
			: '';
		return (
			'<section><h2>' + escapeHtml(i18n.planSectionTitle) + '</h2>' +
			'<div class="grid grid-2">' +
				'<div class="card"><h3>' + escapeHtml(plan.modelName) + ' · 5h</h3>' + currentProgress + '</div>' +
				weeklyProgress + '' +
				expiryCard +
			'</div>' +
			(current + '') +
			(weekly + '') +
			modelsTable +
			'</section>'
		);
	}
	function platformBanner(sources) {
		if (sources.plan === 'ok') return '';
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
		const header = '<section><h2>' + escapeHtml(i18n.localSectionTitle) + '</h2>' +
			'<div class="grid grid-3">' +
				localCard(i18n.windowToday, local.today) +
				localCard(i18n.window7d, local.sevenDay) +
				localCard(i18n.window30d, local.thirtyDay) +
			'</div></section>';
		const chart = chartSection(local.dailySeries);
		const models = modelTable(local.perModel);
		return header + chart + models;
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
	function render(view) {
		const banner = platformBanner(view.sources);
		const plan = view.plan ? platformSection(view.plan) : '';
		const local = view.local ? localSection(view.local) : '';
		const empty = emptyState(view.sources);
		root.innerHTML = banner + plan + local + empty;
		updatedStamp.textContent = i18n.fieldUpdated + ': ' + new Date().toLocaleTimeString();
	}
	document.addEventListener('click', function (event) {
		const target = event.target.closest('[data-action]');
		if (!target) return;
		const action = target.getAttribute('data-action');
		if (action === 'refresh') vscode.postMessage({ type: 'refresh' });
		else if (action === 'close') vscode.postMessage({ type: 'close' });
		else if (action === 'reset') vscode.postMessage({ type: 'reset' });
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

function refreshTimerHandle(panel: DashboardPanel): boolean {
	// Timer is intentionally opt-in (currently unused; reserved for
	// future auto-refresh). We still expose the field so dispose()
	// stays correct if a future caller starts the timer.
	const value = (panel as unknown as { refreshTimer?: NodeJS.Timeout })
		.refreshTimer;
	return value !== undefined;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}
