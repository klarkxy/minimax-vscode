// Dashboard webview entry point.
//
// This file is bundled separately by esbuild and shipped to the
// webview as a static resource (loaded via `<script src="…">` in
// `panel.ts#renderHtml`). The HTML / CSS / template strings that
// used to live as a 1000-line inline `<script>` in `panel.ts` now
// live here as plain TypeScript — easier to read, easier to test,
// easier to lint, and the webview's CSP only needs a single
// `script-src 'nonce-…'` for the i18n payload.
//
// Communication with the extension host is unchanged: the webview
// reads its initial i18n bundle from the `<script id="i18n">`
// block in the page, posts `{ type: 'ready' | 'refresh' | 'close'
// | … }` messages back, and listens for `{ type: 'data' | 'error' }`
// messages from the host.
//
// The entire render + event-wiring surface is exposed as the
// `start` function so unit tests can drive it with a fake
// `acquireVsCodeApi` + a minimal DOM stub (see
// `test/webviewMain.test.ts`). The IIFE entry at the bottom of
// the file just calls `start(globalThis.acquireVsCodeApi, …)` with
// the real globals.

import { escapeHtml } from '../template';

declare function acquireVsCodeApi(): VsCodeApi;

// ---- Public types -----------------------------------------------------

export interface VsCodeApi {
	postMessage(message: unknown): void;
	getState(): unknown;
	setState(state: unknown): void;
}

export interface I18nBundle {
	[key: string]: unknown;
	tabsTotal: string;
	tabsCopilot: string;
	tabsClaude: string;
	totalSectionTitle: string;
	copilotSectionTitle: string;
	planSectionTitle: string;
	claudeCodeSectionTitle: string;
	claudeCodeSubtitle: string;
	claudeCodeEmpty: string;
	claudeCodeOpenFolderBtn: string;
	claudeCodeRecheckBtn: string;
	claudeCodeLastSync: string;
	claudeCodeLogPath: string;
	claudeCodeNeverSynced: string;
	claudeCodeErrorBanner: string;
	claudeCodeFilesTracked: string;
	claudeCodeParseErrors: string;
	claudeCodeSkippedModels: string;
	dailyChartTitle: string;
	perModelTitle: string;
	noLocalData: string;
	windowToday: string;
	window7d: string;
	window30d: string;
	fieldInput: string;
	fieldOutput: string;
	fieldCacheRead: string;
	fieldCacheWrite: string;
	fieldTotal: string;
	fieldRequests: string;
	fieldUpdated: string;
	fieldWeekly: string;
	fieldExpiry: string;
	fieldExpiryDaysFuture: string;
	fieldExpiryDaysToday: string;
	fieldExpiryDaysPast: string;
	platformLoading: string;
	platformUnconfigured: string;
	platformUnavailable: string;
	mmxInstalled: string;
	mmxMissing: string;
	mmxAuthLoggedIn: string;
	mmxAuthLoggedOut: string;
	mmxAuthUnknown: string;
	mmxSkillInstalled: string;
	mmxSkillMissing: string;
	mmxCopyPromptBtn: string;
	mmxRecheckBtn: string;
	mmxAgentReady: string;
	mmxAgentNotReady: string;
	mmxCommandLabel: string;
	mmxVersion: string;
	mmxInstallBtn: string;
	mmxLoginBtn: string;
	mmxInstallSkillBtn: string;
	mmxSectionTitle: string;
	mmxSubtitle: string;
	mcpSectionTitle: string;
	mcpSubtitle: string;
	mcpProviderLabel: string;
	mcpKeyLabel: string;
	mcpHostLabel: string;
	mcpCommandLabel: string;
	mcpProviderReady: string;
	mcpProviderNotReady: string;
	mcpKeyReady: string;
	mcpKeyMissing: string;
	mcpHostUnrecognised: string;
	mcpRefreshBtn: string;
	// ---- Token Plan key selector ----
	planKeyActive: string;
	planKeyRegion: (region: string) => string;
	planSourceUnsupported: string;
	planSourceNoData: string;
}

export interface UsageBreakdown {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	requests: number;
}

export interface PerModelRow {
	modelId: string;
	usage: UsageBreakdown;
}

export interface DailyPoint {
	date: string;
	usage: UsageBreakdown;
}

export interface SourceView {
	today: UsageBreakdown;
	sevenDay: UsageBreakdown;
	thirtyDay: UsageBreakdown;
	dailySeries: DailyPoint[];
	perModel: PerModelRow[];
}

export interface PlanSection {
	modelName: string;
	currentPercentage: number;
	currentResetText: string;
	currentTotal: number;
	currentUsed: number;
	weeklyPercentage: number;
	weeklyUnlimited: boolean;
	weeklyResetText: string;
	weeklyTotal: number;
	weeklyUsed: number;
	expiryDate?: string;
	expiryDays?: number;
}

/** Snapshot of a single key's Token Plan data, keyed by keyId in
 *  `allKeyPlans`. The `source` field mirrors `DashboardView.sources.plan`
 *  so the UI can render per-key loading / unsupported / error states. */
export interface KeyPlanSnapshot {
	/** The key's display label. */
	label: string;
	/** `true` when this key is currently active. */
	isActive: boolean;
	/** Source status for this key's plan data. */
	source: 'ok' | 'loading' | 'unconfigured' | 'unsupported' | 'error';
	/** The plan usage data, or undefined when the source is not `ok`. */
	usage?: PlanSection;
	/** Error message when `source` is `error`. */
	error?: string;
	/** Region display hint (e.g. 'china', 'global', 'custom'). */
	region?: string;
}

export interface ClaudeCodeStatus {
	state: 'empty' | 'ok' | 'error' | 'loading' | 'disabled';
	logPath: string;
	filesTracked: number;
	parseErrors: number;
	skippedModels: number;
	lastSyncAt?: number;
	lastError?: string;
}

export interface ClaudeCodeView {
	status: ClaudeCodeStatus;
	today: UsageBreakdown;
	sevenDay: UsageBreakdown;
	thirtyDay: UsageBreakdown;
	dailySeries: DailyPoint[];
	perModel: PerModelRow[];
}

export interface McpView {
	ready: boolean;
	hasApiKey: boolean;
	host?: string;
	hostFromProxy?: boolean;
	command?: string;
	args?: string[];
	reason?: string;
}

export interface MmxCliView {
	install: 'installed' | 'missing' | 'unknown';
	version?: string;
	auth: 'loggedIn' | 'loggedOut' | 'unknown';
	skill: 'installed' | 'missing' | 'unknown';
	agentReady?: boolean;
	note?: string;
}

export interface DashboardView {
	sources: {
		copilot: 'ok' | 'empty' | 'error';
		claudeCode: 'ok' | 'empty' | 'disabled' | 'error' | 'loading';
		claudeCodeError?: string;
		plan: 'ok' | 'loading' | 'unconfigured' | 'error' | 'unsupported';
		planError?: string;
	};
	total: SourceView;
	copilot: SourceView;
	claudeCode?: ClaudeCodeView;
	plan?: PlanSection;
	mmxCli?: MmxCliView;
	mcp?: McpView;
	/** Multi-key plan snapshots, keyed by keyId. Populated when the
	 *  Token Plan poller is running. The webview picks the active key's
	 *  entry by default; the user can flip to a different key via the
	 *  key selector in the Token Plan card. */
	allKeyPlans?: Record<string, KeyPlanSnapshot>;
	/** Which key's plan is currently selected in the Token Plan card.
	 *  `'active'` means "show the active key's plan" (default).
	 *  A specific keyId means "show this named key's plan". */
	selectedTokenPlanKeyId?: 'active' | string;
}

// ---- Tab state ---------------------------------------------------------

export const KNOWN_TAB_IDS = ['total', 'copilot', 'claude'] as const;
export type TabId = (typeof KNOWN_TAB_IDS)[number];

export interface Tab {
	id: TabId;
	label: string;
	visible?: boolean;
}

export interface PersistedState {
	activeTab?: string;
	/** Which key's plan is selected in the Token Plan card.
	 *  `'active'` means the active key (default). */
	tokenPlanKey?: string;
}

// ---- Pure helpers (exported for testing) -------------------------------

export function computeVisibleTabs(i18n: I18nBundle, view: DashboardView): Tab[] {
	const all: Tab[] = [
		{ id: 'total', label: i18n.tabsTotal },
		{ id: 'copilot', label: i18n.tabsCopilot, visible: !!view.copilot },
		{
			id: 'claude',
			label: i18n.tabsClaude,
			visible: !!view.claudeCode && view.sources.claudeCode !== 'disabled',
		},
	];
	return all.filter((t) => t.id === 'total' || t.visible);
}

export function renderTabsHtml(tabs: Tab[], activeTab: TabId): string {
	return tabs
		.map((t) => {
			const selected = t.id === activeTab;
			return (
				'<button role="tab" data-tab="' + escapeHtml(t.id) + '"' +
				' aria-selected="' + (selected ? 'true' : 'false') + '">' +
				escapeHtml(t.label) +
				'</button>'
			);
		})
		.join('');
}

export function applyActiveTab(root: HTMLElement, activeTab: TabId): void {
	const panes = root.querySelectorAll<HTMLElement>('[data-tab-pane]');
	panes.forEach((pane) => {
		const id = pane.getAttribute('data-tab-pane') as TabId | null;
		pane.classList.toggle('hidden', id !== activeTab);
	});
	const buttons = root.querySelectorAll<HTMLElement>('.tabs [role="tab"]');
	buttons.forEach((btn) => {
		const id = btn.getAttribute('data-tab') as TabId | null;
		btn.setAttribute('aria-selected', id === activeTab ? 'true' : 'false');
	});
}

/**
 * Apply a refresh-state indicator to the dashboard WITHOUT touching
 * `#root.innerHTML`. The only mutation is a `refreshing` class on
 * the Refresh button (which the static `<style>` block turns into a
 * spinner + disabled state) and an updated footer stamp. This is
 * the load-bearing split for issue #5: a refresh in flight no longer
 * overwrites the previously-rendered dashboard with a "loading"
 * placeholder.
 *
 * The Refresh button lives in the static `<header>` (a SIBLING of
 * `#root`), so the helper accepts the `document` (or any element
 * with a `querySelector` that resolves to the page's full tree)
 * and looks the button up by selector. The webview is responsible
 * for passing the right scope at the message handler.
 */
export function applyRefreshState(refreshing: boolean, opts?: { doc?: DocumentLike | { querySelector(sel: string): Element | null }; root?: HTMLElement }): void {
	const scope = opts?.doc ?? ((opts?.root?.ownerDocument ?? null) as unknown as DocumentLike | null);
	const queryScope = (scope as { querySelector?: (sel: string) => Element | null } | null)
		?? opts?.root
		?? null;
	const button = queryScope && typeof (queryScope as { querySelector?: (sel: string) => Element | null }).querySelector === 'function'
		? (queryScope as { querySelector(sel: string): Element | null }).querySelector('button[data-action="refresh"]')
		: null;
	if (!button) return;
	const classList = (button as { classList?: { toggle(c: string, force?: boolean): void; contains(c: string): boolean; add(c: string): void; remove(c: string): void } }).classList;
	if (classList) {
		if (typeof classList.toggle === 'function') {
			classList.toggle('refreshing', refreshing);
		} else if (refreshing) {
			classList.add?.('refreshing');
		} else {
			classList.remove?.('refreshing');
		}
	}
	const setAttribute = (button as { setAttribute?: (n: string, v: string) => void }).setAttribute;
	const removeAttribute = (button as { removeAttribute?: (n: string) => void }).removeAttribute;
	if (refreshing) {
		setAttribute?.call(button, 'disabled', 'true');
	} else {
		removeAttribute?.call(button, 'disabled');
	}
}

export function fmtNumber(n: unknown): string {
	if (typeof n !== 'number' || !isFinite(n)) return '0';
	const abs = Math.abs(n);
	if (abs >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + 'B';
	if (abs >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
	if (abs >= 1_000) return (n / 1_000).toFixed(1) + 'k';
	return String(n);
}

export function fmtFull(n: unknown): string {
	if (typeof n !== 'number' || !isFinite(n)) return '0';
	return n.toLocaleString('en-US');
}

export function progressClass(pct: number): string {
	if (pct >= 85) return 'bad';
	if (pct >= 60) return 'warn';
	return '';
}

export function card(title: string, rows: Array<[string, string, string?]>): string {
	const items = rows
		.map(
			([k, v, cls]) =>
				'<div class="kv">' +
				'<span>' + escapeHtml(k) + '</span>' +
				'<span class="' + (cls || '') + '">' + escapeHtml(v) + '</span>' +
				'</div>',
		)
		.join('');
	return '<div class="card"><h3>' + escapeHtml(title) + '</h3>' + items + '</div>';
}

export function progressBlock(percentage: number, used: number, total: number): string {
	const pct = Math.max(0, Math.min(100, percentage || 0));
	const cls = progressClass(pct);
	const pairHtml =
		total > 0
			? '<span class="dim">' + fmtFull(used) + ' / ' + fmtFull(total) + '</span>'
			: '';
	return (
		'<div class="progress ' + cls + '"><div class="fill" style="width: ' + pct + '%"></div></div>' +
		'<div class="kv" style="margin-top: 6px;"><span class="dim">' + pct + '%</span>' + pairHtml + '</div>'
	);
}

export function localCard(i18n: I18nBundle, title: string, usage: UsageBreakdown): string {
	const slices = [
		{ key: i18n.fieldInput, value: usage.inputTokens, color: 'var(--accent)' },
		{ key: i18n.fieldCacheRead, value: usage.cacheReadTokens, color: 'var(--good)' },
		{ key: i18n.fieldCacheWrite, value: usage.cacheWriteTokens, color: 'var(--warn)' },
		{ key: i18n.fieldOutput, value: usage.outputTokens, color: 'var(--bad)' },
	];
	const totalBilled = slices.reduce((s, it) => s + (it.value || 0), 0);
	let pieBg: string;
	if (totalBilled > 0) {
		let cursor = 0;
		const stops: string[] = [];
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
	const legend = slices
		.map((it) => {
			const pct = totalBilled > 0 ? ((it.value / totalBilled) * 100).toFixed(1) : '0.0';
			return (
				'<li>' +
				'<span class="dot" style="background:' + it.color + '"></span>' +
				'<span class="lbl">' + escapeHtml(it.key) + '</span>' +
				'<span class="val">' +
				fmtNumber(it.value) +
				'<span class="pct">' + pct + '%</span>' +
				'</span>' +
				'</li>'
			);
		})
		.join('');
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
		'<span>' + fmtNumber(usage.requests) + '</span>' +
		'</div></div>'
	);
}

function planBar(pct: number): string {
	const clamped = Math.max(0, Math.min(100, pct || 0));
	const cls = progressClass(clamped);
	return (
		'<div class="progress ' + cls + '"><div class="fill" style="width: ' + clamped + '%"></div></div>' +
		'<div class="kv" style="margin-top: 6px;"><span class="dim">' + clamped + '%</span></div>'
	);
}

/** Rainbow-shifting progress bar shown when the weekly quota is
 *  unlimited. The motion is paused under `prefers-reduced-motion`. */
function planUnlimitedBar(): string {
	return '<div class="progress rainbow"><div class="fill" style="width: 100%"></div></div>';
}

function renderPlanCards(i18n: I18nBundle, p: PlanSection): string {
	const cardWithReset = (title: string, pct: number, resetText: string) =>
		'<div class="card"><h3>' +
		'<span>' + escapeHtml(title) + '</span>' +
		'<span class="reset-pill">' + escapeHtml(resetText) + '</span>' +
		'</h3>' + planBar(pct) + '</div>';
	const currentCard = cardWithReset(p.modelName + ' · 5h', p.currentPercentage, p.currentResetText);
	const weeklyCard = p.weeklyUnlimited
		? '<div class="card"><h3><span>' + escapeHtml(i18n.fieldWeekly) + '</span>' +
			'<span class="reset-pill">∞</span></h3>' + planUnlimitedBar() + '</div>'
		: cardWithReset(i18n.fieldWeekly, p.weeklyPercentage, p.weeklyResetText);
	const expiryCard = p.expiryDate
		? (() => {
			const days = p.expiryDays ?? 0;
			const template =
				days < 0 ? i18n.fieldExpiryDaysPast :
				days === 0 ? i18n.fieldExpiryDaysToday :
				i18n.fieldExpiryDaysFuture;
			const text = template.replace('{days}', String(Math.abs(days)));
			return card(i18n.fieldExpiry, [[p.expiryDate, text]]);
		})()
		: '';
	return (
		'<div class="grid grid-2">' +
		currentCard +
		weeklyCard +
		'</div>' +
		expiryCard
	);
}

export function tokenPlanSection(
	i18n: I18nBundle,
	plan: PlanSection | undefined,
	allKeyPlans: Record<string, KeyPlanSnapshot> | undefined,
	selectedKeyId: string | undefined,
): string {

	// Build the key selector row: a set of small pill buttons.
	// If there's only one key (or no allKeyPlans), skip the selector.
	const keys = allKeyPlans ? Object.entries(allKeyPlans) : [];
	let selectorHtml = '';
	if (keys.length > 1) {
		const options: Array<{ id: string; label: string }> = [
			{ id: 'active', label: i18n.planKeyActive },
		];
		for (const [keyId, snap] of keys) {
			options.push({ id: keyId, label: snap.label });
		}
		const selected = selectedKeyId ?? 'active';
		selectorHtml = (
			'<div class="plan-key-selector">' +
			options.map((opt) => {
				const active = opt.id === selected;
				return (
					'<button class="plan-key-pill' + (active ? ' active' : '') + '"' +
					' data-action="plan-select-key" data-key-id="' + escapeHtml(opt.id) + '"' +
					(active ? ' aria-current="true"' : '') +
					'>' + escapeHtml(opt.label) + '</button>'
				);
			}).join('') +
			'</div>'
		);
	}

	// Resolve the plan data for the selected key.
	if (allKeyPlans && keys.length > 0) {
		const sel = selectedKeyId ?? 'active';
		let snapshot: KeyPlanSnapshot | undefined;
		if (sel === 'active') {
			// Find the active key's snapshot
			for (const snap of Object.values(allKeyPlans)) {
				if (snap.isActive) { snapshot = snap; break; }
			}
		} else {
			snapshot = allKeyPlans[sel];
		}
		if (!snapshot && sel === 'active' && plan) {
			// Fallback: no multi-key snapshot yet, but we have legacy plan data
			return (
				'<section id="token-plan-section"><h2>' + escapeHtml(i18n.planSectionTitle) + '</h2>' +
				selectorHtml +
				renderPlanCards(i18n, plan) +
				'</section>'
			);
		}
		if (snapshot && snapshot.source === 'ok' && snapshot.usage) {
			return (
				'<section id="token-plan-section"><h2>' + escapeHtml(i18n.planSectionTitle) + '</h2>' +
				selectorHtml +
				renderPlanCards(i18n, snapshot.usage) +
				'</section>'
			);
		}
		if (snapshot && snapshot.source === 'loading') {
			return (
				'<section id="token-plan-section"><h2>' + escapeHtml(i18n.planSectionTitle) + '</h2>' +
				selectorHtml +
				'<div class="banner">' + escapeHtml(i18n.platformLoading) + '</div>' +
				'</section>'
			);
		}
		if (snapshot && snapshot.source === 'unsupported') {
			return (
				'<section id="token-plan-section"><h2>' + escapeHtml(i18n.planSectionTitle) + '</h2>' +
				selectorHtml +
				'<div class="banner">' + escapeHtml(i18n.planSourceUnsupported) + '</div>' +
				'</section>'
			);
		}
		if (snapshot && snapshot.source === 'error') {
			const detail = snapshot.error ? ' — ' + escapeHtml(snapshot.error) : '';
			return (
				'<section id="token-plan-section"><h2>' + escapeHtml(i18n.planSectionTitle) + '</h2>' +
				selectorHtml +
				'<div class="banner">' + escapeHtml(i18n.platformUnavailable) + detail + '</div>' +
				'</section>'
			);
		}
		if (snapshot && snapshot.source === 'unconfigured') {
			return (
				'<section id="token-plan-section"><h2>' + escapeHtml(i18n.planSectionTitle) + '</h2>' +
				selectorHtml +
				'<div class="banner">' + escapeHtml(i18n.platformUnconfigured) + '</div>' +
				'</section>'
			);
		}
		// Key exists in allKeyPlans but has no usage data yet
		return (
			'<section id="token-plan-section"><h2>' + escapeHtml(i18n.planSectionTitle) + '</h2>' +
			selectorHtml +
			'<div class="banner">' + escapeHtml(i18n.planSourceNoData) + '</div>' +
			'</section>'
		);
	}

	// No allKeyPlans: fall back to legacy single-plan rendering.
	if (!plan) return platformBanner(i18n, { plan: 'loading', copilot: 'ok', claudeCode: 'ok' });
	return (
		'<section id="token-plan-section"><h2>' + escapeHtml(i18n.planSectionTitle) + '</h2>' +
		renderPlanCards(i18n, plan) +
		'</section>'
	);
}

/** @deprecated Use `tokenPlanSection` for multi-key support. Kept
 *  for backward compatibility with the `platformBanner` flow. */
export function platformSection(i18n: I18nBundle, plan: PlanSection | undefined): string {
	if (!plan) return '';
	return (
		'<section><h2>' + escapeHtml(i18n.planSectionTitle) + '</h2>' +
		renderPlanCards(i18n, plan) +
		'</section>'
	);
}

export function platformBanner(i18n: I18nBundle, sources: DashboardView['sources']): string {
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

export function sourceSection(i18n: I18nBundle, title: string, source: SourceView): string {
	const header =
		'<section><h2>' + escapeHtml(title) + '</h2>' +
		'<div class="grid grid-3">' +
		localCard(i18n, i18n.windowToday, source.today) +
		localCard(i18n, i18n.window7d, source.sevenDay) +
		localCard(i18n, i18n.window30d, source.thirtyDay) +
		'</div></section>';
	const chart = chartSection(i18n, source.dailySeries);
	const models = modelTable(i18n, source.perModel);
	return header + chart + models;
}

export function claudeCodeSection(i18n: I18nBundle, view: ClaudeCodeView | undefined): string {
	if (!view) return '';
	const status = view.status;
	if (status.state === 'empty') {
		return (
			'<section><h2>' + escapeHtml(i18n.claudeCodeSectionTitle) + '</h2>' +
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
		'<section><h2>' + escapeHtml(i18n.claudeCodeSectionTitle) + '</h2>' +
		'<p class="dim" style="margin: 0 0 10px;">' + escapeHtml(i18n.claudeCodeSubtitle) + '</p>' +
		'<div class="kv"><span class="dim">' + escapeHtml(i18n.claudeCodeLastSync) + '</span>' +
		'<span>' + escapeHtml(lastSyncText) + '</span></div>' +
		'<div class="kv"><span class="dim">' + escapeHtml(i18n.claudeCodeLogPath) + '</span>' +
		'<span class="path">' + escapeHtml(status.logPath) + '</span></div>';
	const errorBanner =
		status.state === 'error' && status.lastError
			? '<div class="banner">' + escapeHtml(i18n.claudeCodeErrorBanner) + ' — ' + escapeHtml(status.lastError) + '</div>'
			: '';
	const cards =
		'<div class="grid grid-3">' +
		localCard(i18n, i18n.windowToday, view.today) +
		localCard(i18n, i18n.window7d, view.sevenDay) +
		localCard(i18n, i18n.window30d, view.thirtyDay) +
		'</div>';
	const actions =
		'<div class="mmx-actions" style="margin-top: 12px;">' +
		'<button data-action="claude-code-rescan">' + escapeHtml(i18n.claudeCodeRecheckBtn) + '</button>' +
		'<button data-action="claude-code-open-folder">' + escapeHtml(i18n.claudeCodeOpenFolderBtn) + '</button>' +
		'</div>';
	const notes: string[] = [];
	if (status.filesTracked > 0) {
		notes.push(escapeHtml(i18n.claudeCodeFilesTracked.replace('{0}', String(status.filesTracked))));
	}
	if (status.parseErrors > 0) {
		notes.push(escapeHtml(i18n.claudeCodeParseErrors.replace('{0}', String(status.parseErrors))));
	}
	if (status.skippedModels > 0) {
		notes.push(escapeHtml(i18n.claudeCodeSkippedModels.replace('{0}', String(status.skippedModels))));
	}
	const notesHtml = notes.length
		? '<div class="kv"><span class="dim"></span><span>' + notes.join(' · ') + '</span></div>'
		: '';
	const chart = chartSection(i18n, view.dailySeries);
	const models = modelTable(i18n, view.perModel);
	return header + errorBanner + cards + actions + notesHtml + chart + models + '</section>';
}

export function chartSection(i18n: I18nBundle, series: DailyPoint[] | undefined): string {
	if (!series || series.length === 0) return '';
	const totals = series.map((s) => s.usage.inputTokens + s.usage.outputTokens + s.usage.cacheReadTokens + s.usage.cacheWriteTokens);
	const max = Math.max(...totals, 1);
	const bars = series
		.map((s, i) => {
			const t = totals[i];
			const heightPct = max > 0 ? Math.max(2, Math.round((t / max) * 100)) : 2;
			const cls = t === 0 ? 'bar zero' : 'bar';
			return (
				'<div class="' + cls + '" style="height: ' + heightPct + '%" title="' + escapeHtml(s.date) + ' · ' + fmtFull(t) + ' tokens"></div>'
			);
		})
		.join('');
	return (
		'<section><h2>' + escapeHtml(i18n.dailyChartTitle) + '</h2>' +
		'<div class="bar-chart">' + bars + '</div>' +
		'<div class="chart-axis">' +
		'<span>' + escapeHtml(series[0].date.slice(5)) + '</span>' +
		'<span>' + escapeHtml(series[series.length - 1].date.slice(5)) + '</span>' +
		'</div></section>'
	);
}

export function modelTable(i18n: I18nBundle, perModel: PerModelRow[] | undefined): string {
	if (!perModel || perModel.length === 0) return '';
	const rows = perModel
		.map(
			(row) =>
				'<tr><td><span class="model-tag">' + escapeHtml(row.modelId) + '</span></td>' +
				'<td class="right">' + fmtNumber(row.usage.inputTokens) + '</td>' +
				'<td class="right">' + fmtNumber(row.usage.cacheReadTokens) + '</td>' +
				'<td class="right">' + fmtNumber(row.usage.cacheWriteTokens) + '</td>' +
				'<td class="right">' + fmtNumber(row.usage.outputTokens) + '</td>' +
				'<td class="right">' + fmtNumber(row.usage.requests) + '</td></tr>',
		)
		.join('');
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

export function emptyState(i18n: I18nBundle, sources: DashboardView['sources']): string {
	if (sources.copilot === 'empty') {
		return '<div class="empty">' + escapeHtml(i18n.noLocalData) + '</div>';
	}
	return '';
}

export function statusBadge(state: string, okLabel: string, missingLabel: string): string {
	if (state === 'installed' || state === 'loggedIn') {
		return '<span class="mmx-badge mmx-badge-ok">● ' + escapeHtml(okLabel) + '</span>';
	}
	if (state === 'unknown') {
		return '<span class="mmx-badge">○ ' + escapeHtml(okLabel) + '</span>';
	}
	return '<span class="mmx-badge mmx-badge-miss">○ ' + escapeHtml(missingLabel) + '</span>';
}

export function mcpSection(i18n: I18nBundle, mcp: McpView | undefined): string {
	if (!mcp) return '';
	const ready = !!mcp.ready;
	const keyReady = !!mcp.hasApiKey;
	const hostText = mcp.host ? mcp.host : i18n.mcpHostUnrecognised;
	const commandText = (mcp.command || 'uvx') + ' ' + (mcp.args || []).join(' ');
	const providerBadge = ready
		? '<span class="mmx-badge mmx-badge-ok">● ' + escapeHtml(i18n.mcpProviderReady) + '</span>'
		: '<span class="mmx-badge mmx-badge-miss">○ ' + escapeHtml(i18n.mcpProviderNotReady) + '</span>';
	const keyBadge = keyReady
		? '<span class="mmx-badge mmx-badge-ok">● ' + escapeHtml(i18n.mcpKeyReady) + '</span>'
		: '<span class="mmx-badge mmx-badge-miss">○ ' + escapeHtml(i18n.mcpKeyMissing) + '</span>';
	const readyNote = ready
		? '<div class="mmx-ready ok">' + escapeHtml(i18n.mcpProviderReady) + '</div>'
		: (mcp.reason
			? '<div class="mmx-note">' + escapeHtml(mcp.reason) + '</div>'
			: '');
	const cards =
		'<div class="mmx-grid">' +
		'<div class="mmx-card"><div class="mmx-card-title">' + escapeHtml(i18n.mcpProviderLabel) + '</div>' + providerBadge + '</div>' +
		'<div class="mmx-card"><div class="mmx-card-title">' + escapeHtml(i18n.mcpKeyLabel) + '</div>' + keyBadge + '</div>' +
		'<div class="mmx-card"><div class="mmx-card-title">' + escapeHtml(i18n.mcpHostLabel) + '</div>' +
		'<div class="dim" style="margin-top:6px; font-family: var(--vscode-editor-font-family, ui-monospace, monospace); word-break: break-all;">' +
		escapeHtml(hostText) +
		'</div>' +
		'</div>' +
		'</div>' +
		'<div class="kv"><span class="dim">' + escapeHtml(i18n.mcpCommandLabel) + '</span>' +
		'<span class="path">' + escapeHtml(commandText) + '</span></div>';
	const actions =
		'<div class="mmx-actions">' +
		'<button data-action="mcp-refresh" class="primary">' + escapeHtml(i18n.mcpRefreshBtn) + '</button>' +
		'</div>';
	return (
		'<section><h2>' + escapeHtml(i18n.mcpSectionTitle) + '</h2>' +
		'<p class="dim" style="margin: 0 0 14px;">' + escapeHtml(i18n.mcpSubtitle) + '</p>' +
		cards + readyNote + actions +
		'</section>'
	);
}

export function mmxSection(i18n: I18nBundle, mmx: MmxCliView | undefined): string {
	if (!mmx) return '';
	const install = mmx.install;
	const version = mmx.version || '—';
	const auth = mmx.auth;
	const skill = mmx.skill;

	const installBadge = statusBadge(install, i18n.mmxInstalled, i18n.mmxMissing);
	const authLabel =
		auth === 'loggedIn'
			? i18n.mmxAuthLoggedIn
			: auth === 'loggedOut'
				? i18n.mmxAuthLoggedOut
				: i18n.mmxAuthUnknown;
	const authBadge = statusBadge(auth, authLabel, i18n.mmxAuthLoggedOut);
	const skillBadge = statusBadge(skill, i18n.mmxSkillInstalled, i18n.mmxSkillMissing);

	const pendingSteps: Array<{ num: number; label: string; detail: string }> = [];
	if (install !== 'installed') {
		pendingSteps.push({ num: pendingSteps.length + 1, label: i18n.mmxInstallBtn, detail: 'npm install -g mmx-cli' });
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
	const stepsHtml = pendingSteps
		.map(
			(s) =>
				'<div class="mmx-step">' +
				'<span class="mmx-step-num">' + s.num + '</span>' +
				'<div class="mmx-step-body">' +
				'<div class="mmx-step-label">' + escapeHtml(s.label) + '</div>' +
				'<div class="mmx-step-detail">' + escapeHtml(s.detail) + '</div>' +
				'</div>' +
				'</div>',
		)
		.join('');

	const buttons: string[] = [];
	buttons.push('<button data-action="mmx-copy-prompt" class="primary">' + escapeHtml(i18n.mmxCopyPromptBtn) + '</button>');
	buttons.push('<button data-action="mmx-recheck">' + escapeHtml(i18n.mmxRecheckBtn) + '</button>');

	const readyNote = mmx.agentReady
		? '<div class="mmx-ready ok">' + escapeHtml(i18n.mmxAgentReady) + '</div>'
		: (install === 'installed'
			? '<div class="mmx-ready">' + escapeHtml(i18n.mmxAgentNotReady) + '</div>'
			: '');

	const noteHtml = mmx.note ? '<div class="mmx-note">' + escapeHtml(mmx.note) + '</div>' : '';

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

// ---- Public entry point -----------------------------------------------

/**
 * Mount the dashboard into a host DOM. Exported for unit tests
 * (pass in a fake `vscode` + a minimal DOM stub + a fake window
 * object). The production IIFE at the bottom of the file calls
 * this with the real `acquireVsCodeApi()` + `document` globals.
 */
export interface WindowLike {
	addEventListener(event: string, listener: (event: unknown) => void): void;
}

export interface DocumentLike {
	addEventListener(event: string, listener: (event: unknown) => void): void;
}

export function start(opts: {
	vscode: VsCodeApi;
	root: HTMLElement;
	updatedStamp: HTMLElement;
	i18n: I18nBundle;
	win?: WindowLike;
	/**
	 * Document used for the global click delegate. The dashboard's
	 * action buttons live in the static header (`<header>`) which is
	 * a SIBLING of `<div id="root">`, not a descendant — clicks on
	 * those buttons never bubble through `root`, so attaching the
	 * listener to `root` silently swallows them. We attach to the
	 * document instead and rely on `event.target.closest()` to
	 * resolve the action regardless of where the button lives.
	 *
	 * Optional so unit tests that only exercise root-internal
	 * rendering can keep passing it as `undefined`.
	 */
	doc?: DocumentLike;
}): void {
	const { vscode, root, updatedStamp, i18n, win } = opts;
	const persisted = (vscode.getState() as PersistedState | null) ?? {};
	let activeTab: TabId = KNOWN_TAB_IDS.indexOf(persisted.activeTab as TabId) !== -1
		? (persisted.activeTab as TabId)
		: 'total';
	let activePlanKey = persisted.tokenPlanKey ?? 'active';
	/** Last view received from the host. Stored so the click handler
	 *  for `plan-select-key` can re-render immediately without waiting
	 *  for the host to echo back a data frame. */
	let lastView: DashboardView | undefined;

	function render(view: DashboardView): void {
		lastView = view;
		const tabs = computeVisibleTabs(i18n, view);
		let activeId: TabId = activeTab;
		if (!tabs.some((t) => t.id === activeId)) {
			activeId = tabs.length > 0 ? tabs[0].id : 'total';
		}
		activeTab = activeId;

		// Token Plan card: rendered BEFORE the tab bar so it stays
		// visible regardless of which tab is selected. The key selector
		// lets the user flip between keys without switching tabs.
		// Use the user's local selection (activePlanKey) which is
		// persisted across re-renders and data frames.
		const planHtml = tokenPlanSection(
			i18n,
			view.plan,
			view.allKeyPlans,
			activePlanKey,
		);

		const tabBar = tabs.length > 1
			? '<nav class="tabs" role="tablist">' + renderTabsHtml(tabs, activeTab) + '</nav>'
			: '';

		const totalPane =
			'<div data-tab-pane="total">' +
			sourceSection(i18n, i18n.totalSectionTitle, view.total) +
			mcpSection(i18n, view.mcp) +
			mmxSection(i18n, view.mmxCli) +
			emptyState(i18n, view.sources) +
			'</div>';
		const claudePane = view.claudeCode && view.sources.claudeCode !== 'disabled'
			? '<div data-tab-pane="claude">' + claudeCodeSection(i18n, view.claudeCode) + '</div>'
			: '';
		const copilotPane = view.copilot
			? '<div data-tab-pane="copilot">' +
				sourceSection(i18n, i18n.copilotSectionTitle, view.copilot) +
				'</div>'
			: '';

		root.innerHTML = planHtml + tabBar + totalPane + claudePane + copilotPane;
		applyActiveTab(root, activeTab);
		updatedStamp.textContent = i18n.fieldUpdated + ': ' + new Date().toLocaleTimeString();
	}

	// Click delegate lives on `document` (not `root`) because the
	// header action buttons are siblings of `#root`. Click bubbles
	// up to `document` for any element in the page, and `closest()`
	// resolves the data-action regardless of nesting depth.
	const clickTarget: { addEventListener?: DocumentLike['addEventListener'] } =
		opts.doc ?? ((globalThis as unknown) as { addEventListener?: DocumentLike['addEventListener'] });
	clickTarget.addEventListener?.('click', (event) => {
		const targetEl = event.target as Element | null;
		if (!targetEl) return;
		const tabEl = targetEl.closest('[data-tab]');
		if (tabEl) {
			const id = tabEl.getAttribute('data-tab') as TabId | null;
			if (id && id !== activeTab) {
				activeTab = id;
				vscode.setState({ activeTab: id });
				applyActiveTab(root, activeTab);
			}
			return;
		}
		const target = targetEl.closest('[data-action]');
		if (!target) return;
		const action = target.getAttribute('data-action');
		// Key selector pills carry a `data-key-id` payload that the
		// host needs to update its diagnostic state. Handle before the
		// generic map so we can attach the payload.
		if (action === 'plan-select-key') {
			const keyId = target.getAttribute('data-key-id') ?? 'active';
			activePlanKey = keyId;
			vscode.setState({ activeTab, tokenPlanKey: keyId });
			// Re-render immediately with the current data so the user
			// sees the switch without waiting for the host echo.
			if (lastView) render(lastView);
			vscode.postMessage({ type: 'planSelectKey', payload: { keyId } });
			return;
		}
		const map: Record<string, string> = {
			'refresh': 'refresh',
			'close': 'close',
			'reset': 'reset',
			'mmx-copy-prompt': 'mmxCopyPrompt',
			'mmx-recheck': 'mmxRecheck',
			'mcp-refresh': 'mcpRefresh',
			'claude-code-rescan': 'claudeCodeRescan',
			'claude-code-open-folder': 'claudeCodeOpenFolder',
			'claude-code-open-settings': 'claudeCodeOpenSettings',
		};
		const type = map[action ?? ''];
		if (type) {
			vscode.postMessage({ type });
		}
	});

	// `window` is only available in a real browser; in tests we pass
	// a fake win so the message handler can be inspected without
	// standing up jsdom. The production IIFE falls through to
	// `globalThis` when `win` is not provided.
	const target: WindowLike | undefined = win ?? ((globalThis as unknown) as WindowLike);
	target?.addEventListener?.('message', (event) => {
		try {
			const message = (event as { data?: unknown }).data as { type?: string; payload?: unknown; traceId?: unknown } | null;
			if (!message || typeof message !== 'object') return;
			if (message.type === 'data') {
				const startedAt = Date.now();
				render(message.payload as DashboardView);
				const view = message.payload as DashboardView;
				vscode.postMessage({
					type: 'renderAck',
					payload: {
						traceId: message.traceId,
						plan: view?.sources?.plan,
						elapsedMs: Date.now() - startedAt,
					},
				});
			} else if (message.type === 'error') {
				const payload = message.payload as { message?: unknown } | undefined;
				const text = payload && typeof payload.message === 'string' ? payload.message : 'error';
				root.innerHTML = '<div class="banner">' + escapeHtml(text) + '</div>';
			} else if (message.type === 'refreshState') {
				// Refresh-state indicator: mutates ONLY the header
				// refresh button (spinner + disabled) and the
				// `data-stamp="updated"` footer. Does NOT touch
				// `root.innerHTML`, so an in-flight refresh no longer
				// overwrites a previously-rendered dashboard with a
				// loading placeholder. The data frame is the ONLY
				// message that may rewrite the main content; this
				// split is the load-bearing fix for the
				// "stuck-on-刷新…" regression.
				const payload = message.payload as { refreshing?: unknown; traceId?: unknown } | undefined;
				const refreshing = payload?.refreshing === true;
				applyRefreshState(refreshing, { doc: clickTarget, root });
				vscode.postMessage({
					type: 'refreshStateAck',
					payload: { refreshing, traceId: payload?.traceId ?? message.traceId },
				});
			}
		} catch (err) {
			// Defensive: a render-path throw must NEVER freeze the
			// dashboard. Surface the failure inline so the next
			// successful `data` payload can repaint, and keep the
			// listener alive for subsequent messages.
			root.innerHTML =
				'<div class="banner">Dashboard render error: ' +
				escapeHtml(err instanceof Error ? err.message : String(err)) +
				'</div>';
			vscode.postMessage({
				type: 'renderError',
				payload: {
					traceId: ((event as { data?: unknown }).data as { traceId?: unknown } | undefined)?.traceId,
					message: err instanceof Error ? err.message : String(err),
				},
			});
		}
	});

	vscode.postMessage({ type: 'ready' });
}

// ---- IIFE entry -------------------------------------------------------

// The test build (esbuild.tests.mjs) does not run this block —
// the file's side-effecting import path is bypassed in tests that
// import the pure helpers directly. Wrapping the call in a
// `typeof acquireVsCodeApi === 'function'` guard keeps Node-side
// imports from triggering the IIFE during test bundling.
if (typeof (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi === 'function') {
	const api = (globalThis as { acquireVsCodeApi: () => VsCodeApi }).acquireVsCodeApi();
	const rootEl = document.getElementById('root');
	const stampEl = document.querySelector<HTMLElement>('[data-stamp="updated"]');
	const i18nEl = document.getElementById('i18n');
	if (rootEl && stampEl && i18nEl) {
		const i18nBundle = JSON.parse(i18nEl.textContent ?? '{}') as I18nBundle;
		start({ vscode: api, root: rootEl, updatedStamp: stampEl, i18n: i18nBundle, doc: document });
	}
}
