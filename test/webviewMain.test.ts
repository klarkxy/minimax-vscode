// Unit tests for `src/dashboard/webview/main.ts`.
//
// The webview module runs in a real browser via the `acquireVsCodeApi`
// global that VS Code injects; we don't have that here. So the
// tests bypass the IIFE entry and drive the exported pure helpers
// (`computeVisibleTabs`, `renderTabsHtml`, `applyActiveTab`,
// `fmtNumber`, `progressClass`, `card`, `progressBlock`,
// `localCard`, `platformSection`, `platformBanner`, `sourceSection`,
// `claudeCodeSection`, `chartSection`, `modelTable`, `emptyState`,
// `statusBadge`, `mcpSection`, `mmxSection`) directly. The
// `start()` entry is exercised through a tiny DOM stub that
// captures `innerHTML` writes and click events.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
	applyActiveTab,
	applyRefreshState,
	card,
	chartSection,
	claudeCodeSection,
	computeVisibleTabs,
	emptyState,
	fmtFull,
	fmtNumber,
	localCard,
	mcpSection,
	mmxSection,
	modelTable,
	platformBanner,
	platformSection,
	progressBlock,
	progressClass,
	renderTabsHtml,
	sourceSection,
	start,
	statusBadge,
	tokenPlanSection,
	type DashboardView,
	type I18nBundle,
	type KeyPlanSnapshot,
	type TabId,
} from '../src/dashboard/webview/main.js';

// ---- I18n fixture -----------------------------------------------------

function i18n(): I18nBundle {
	return {
		tabsTotal: '总',
		tabsCopilot: 'copilot',
		tabsClaude: 'claude',
		totalSectionTitle: 'Total',
		copilotSectionTitle: 'Copilot',
		planSectionTitle: 'Token Plan',
		claudeCodeSectionTitle: 'Claude Code',
		claudeCodeSubtitle: 'JSONL log ingestion',
		claudeCodeEmpty: 'No JSONL files yet',
		claudeCodeOpenFolderBtn: 'Open folder',
		claudeCodeRecheckBtn: 'Re-scan',
		claudeCodeLastSync: 'Last sync',
		claudeCodeLogPath: 'Log path',
		claudeCodeNeverSynced: 'Never synced',
		claudeCodeErrorBanner: 'Ingestion error',
		claudeCodeFilesTracked: '{0} files',
		claudeCodeParseErrors: '{0} parse errors',
		claudeCodeSkippedModels: '{0} non-MiniMax lines skipped',
		dailyChartTitle: 'Daily tokens',
		perModelTitle: 'Per model',
		noLocalData: 'No local data yet.',
		windowToday: 'Today',
		window7d: '7d',
		window30d: '30d',
		fieldInput: 'in',
		fieldOutput: 'out',
		fieldCacheRead: 'cacheRead',
		fieldCacheWrite: 'cacheWrite',
		fieldTotal: 'total',
		fieldRequests: 'req',
		fieldUpdated: 'updated',
		fieldWeekly: 'Week',
		fieldExpiry: 'Expiry',
		fieldExpiryDaysFuture: '{days} day(s) remaining',
		fieldExpiryDaysToday: 'expires today',
		fieldExpiryDaysPast: 'expired {days}d ago',
		platformLoading: 'Loading…',
		platformUnconfigured: 'Not configured',
		platformUnavailable: 'Unavailable',
		mmxInstalled: 'installed',
		mmxMissing: 'missing',
		mmxAuthLoggedIn: 'logged in',
		mmxAuthLoggedOut: 'logged out',
		mmxAuthUnknown: 'unknown',
		mmxSkillInstalled: 'installed',
		mmxSkillMissing: 'missing',
		mmxCopyPromptBtn: 'Copy prompt',
		mmxRecheckBtn: 'Re-check',
		mmxAgentReady: 'agent ready',
		mmxAgentNotReady: 'agent not ready',
		mmxCommandLabel: 'CLI',
		mmxVersion: 'v',
		mmxInstallBtn: 'Install',
		mmxLoginBtn: 'Login',
		mmxInstallSkillBtn: 'Install skill',
		mmxSectionTitle: 'mmx-cli',
		mmxSubtitle: 'detection',
		mcpSectionTitle: 'MCP',
		mcpSubtitle: 'Web Search',
		mcpProviderLabel: 'Provider',
		mcpKeyLabel: 'API key',
		mcpHostLabel: 'Host',
		mcpCommandLabel: 'Launch',
		mcpProviderReady: 'ready',
		mcpProviderNotReady: 'not ready',
		mcpKeyReady: 'key set',
		mcpKeyMissing: 'no key',
		mcpHostUnrecognised: 'unrecognised',
		mcpRefreshBtn: 'Refresh',
	} as unknown as I18nBundle;
}

// Document-level click handlers. The production webview attaches
// its action delegate to `document` rather than `root` because the
// header action buttons live in a sibling subtree (see the
// `start({ doc })` doc comment in `src/dashboard/webview/main.ts`).
// Each test that exercises a click registers one here via
// `makeFakeDoc`; reset between tests via `resetDocHandlers()`.
const docClickHandlers: Array<(event: unknown) => void> = [];

function resetDocHandlers(): void {
	docClickHandlers.length = 0;
}

// ---- Minimal DOM stub -----------------------------------------------

interface StubElement {
	_id: number;
	tagName: string;
	children: StubElement[];
	parent: StubElement | null;
	attributes: Map<string, string>;
	classList: { add(c: string): void; remove(c: string): void; toggle(c: string, force?: boolean): void; contains(c: string): boolean };
	textContent: string;
	innerHTML: string;
	style: Record<string, string>;
	dataset: Record<string, string>;
	// EventTarget-like surface
	listeners: Map<string, Array<(e: unknown) => void>>;
	// DOM-like helpers
	querySelector(sel: string): StubElement | null;
	querySelectorAll(sel: string): StubElement[];
	closest(sel: string): StubElement | null;
	getAttribute(name: string): string | null;
	setAttribute(name: string, value: string): void;
	removeAttribute(name: string): void;
	addEventListener(event: string, listener: (e: unknown) => void): void;
	dispatchEvent(event: { type: string; target?: unknown }): void;
	appendChild(child: StubElement): void;
	remove(): void;
	click(): void;
}

let nextId = 0;
function makeElement(tagName: string): StubElement {
	const el: StubElement = {
		_id: ++nextId,
		tagName,
		children: [],
		parent: null,
		attributes: new Map(),
		classList: makeClassList(),
		textContent: '',
		innerHTML: '',
		style: {},
		dataset: {},
		listeners: new Map(),
		querySelector(sel) {
			for (const c of el.children) {
				if (matchesSelector(c, sel)) return c;
			}
			return null;
		},
		querySelectorAll(sel) {
			const out: StubElement[] = [];
			function walk(node: StubElement) {
				for (const c of node.children) {
					if (matchesSelector(c, sel)) out.push(c);
					walk(c);
				}
			}
			walk(el);
			return out;
		},
		closest(sel) {
			let cur: StubElement | null = el;
			while (cur) {
				if (matchesSelector(cur, sel)) return cur;
				cur = cur.parent;
			}
			return null;
		},
		getAttribute(name) { return this.attributes.get(name) ?? null; },
		setAttribute(name, value) { this.attributes.set(name, value); },
		removeAttribute(name) { this.attributes.delete(name); },
		addEventListener(event, listener) {
			const list = this.listeners.get(event) ?? [];
			list.push(listener);
			this.listeners.set(event, list);
		},
		dispatchEvent(event) {
			const list = this.listeners.get(event.type) ?? [];
			for (const fn of list) fn({ type: event.type, target: el });
		},
		appendChild(child) {
			child.parent = el;
			el.children.push(child);
		},
		remove() {
			if (el.parent) {
				const idx = el.parent.children.indexOf(el);
				if (idx >= 0) el.parent.children.splice(idx, 1);
				el.parent = null;
			}
		},
		click() {
			const event = { type: 'click', target: el };
			const list = el.listeners.get('click') ?? [];
			for (const fn of list) fn(event);
			// bubble to parent
			let p = el.parent;
			while (p) {
				const plist = p.listeners.get('click') ?? [];
				for (const fn of plist) fn(event);
				p = p.parent;
			}
			// Fire document-level click handlers. The production
			// delegate lives on `document` (not `root`) because the
			// header action buttons are siblings of `#root`, so
			// bubble-up never reaches them through the stub tree.
			for (const fn of docClickHandlers) fn(event);
		},
	};
	return el;
}

function matchesSelector(node: StubElement, sel: string): boolean {
	// Just enough CSS to drive the webview's selectors: tag, [attr],
	// and simple compound selectors like `.tabs [role="tab"]`.
	const trimmed = sel.trim();
	if (!trimmed) return false;
	// Compound selectors (descendant combinator)
	if (trimmed.includes(' ')) {
		const parts = trimmed.split(/\s+/);
		// Recursive: look for any node that matches `parts[0]` and
		// has an ancestor that matches the rest of the chain.
		if (matchesSelector(node, parts[parts.length - 1])) {
			let cur: StubElement | null = node.parent;
			const earlier = parts.slice(0, -1);
			while (cur) {
				if (matchesSelector(cur, earlier[earlier.length - 1])) {
					// Check the full ancestor chain
					const ancestors = [cur, ...ancestorsOf(cur)].map((n) => n);
					let idx = 0;
					let ok = false;
					for (const a of ancestors) {
						if (matchesSelector(a, earlier[idx])) {
							idx += 1;
							if (idx === earlier.length) { ok = true; break; }
						}
					}
					if (ok) return true;
				}
				cur = cur.parent;
			}
		}
		return false;
	}
	// [attr] and [attr=value]
	const attrMatch = trimmed.match(/^\[([a-zA-Z-]+)(?:="([^"]*)")?\]$/);
	if (attrMatch) {
		const name = attrMatch[1];
		const val = attrMatch[2];
		const got = node.attributes.get(name);
		if (val === undefined) return got !== undefined;
		return got === val;
	}
	// .class
	if (trimmed.startsWith('.')) {
		return node.classList.contains(trimmed.slice(1));
	}
	// tag
	return node.tagName === trimmed.toUpperCase() || node.tagName === trimmed;
}

function ancestorsOf(node: StubElement): StubElement[] {
	const out: StubElement[] = [];
	let cur: StubElement | null = node.parent;
	while (cur) {
		out.push(cur);
		cur = cur.parent;
	}
	return out;
}

function makeClassList() {
	const set = new Set<string>();
	return {
		add(c: string) { set.add(c); },
		remove(c: string) { set.delete(c); },
		toggle(c: string, force?: boolean) {
			if (force === true) set.add(c);
			else if (force === false) set.delete(c);
			else if (set.has(c)) set.delete(c);
			else set.add(c);
		},
		contains(c: string) { return set.has(c); },
	};
}

interface FakeWindow {
	root: StubElement;
	stamp: StubElement;
	messageHandlers: Array<(event: unknown) => void>;
}

function makeFakeWin(w: FakeWindow) {
	return {
		addEventListener(_event: string, listener: (event: unknown) => void) {
			w.messageHandlers.push(listener);
		},
	};
}

function makeFakeDoc(_w: FakeWindow) {
	// `document` also needs `querySelector` so the
	// `applyRefreshState` helper can find the header refresh
	// button (which is a sibling of `#root`, not a descendant —
	// see the regression note on issue #5). The default
	// implementation returns nothing; tests that need a
	// discoverable refresh button swap this out (or call
	// `applyRefreshState` directly with a `doc` that resolves).
	return {
		addEventListener(_event: string, listener: (event: unknown) => void) {
			docClickHandlers.push(listener);
		},
		querySelector(_sel: string): Element | null {
			return null;
		},
	};
}

function setupFakeWindow(): FakeWindow {
	const root = makeElement('div');
	root.attributes.set('id', 'root');
	const stamp = makeElement('span');
	stamp.attributes.set('data-stamp', 'updated');

	const win: FakeWindow = {
		root,
		stamp,
		messageHandlers: [],
	};
	return win;
}

// ---- Tests on pure helpers -----------------------------------------

test('fmtNumber: K / M / B scaling', () => {
	assert.equal(fmtNumber(0), '0');
	assert.equal(fmtNumber(999), '999');
	assert.equal(fmtNumber(1_500), '1.5k');
	assert.equal(fmtNumber(18_234_290), '18.23M');
	assert.equal(fmtNumber(2_500_000_000), '2.50B');
	assert.equal(fmtNumber(-1_500), '-1.5k');
});

test('fmtNumber: non-finite / non-number → "0"', () => {
	assert.equal(fmtNumber(NaN), '0');
	assert.equal(fmtNumber(Infinity), '0');
	assert.equal(fmtNumber('1'), '0');
	assert.equal(fmtNumber(null), '0');
});

test('fmtFull: locale-formatted with en-US', () => {
	assert.equal(fmtFull(1234567), '1,234,567');
	assert.equal(fmtFull(NaN), '0');
	assert.equal(fmtFull('x'), '0');
});

test('progressClass: 85+ → bad, 60+ → warn, else empty', () => {
	assert.equal(progressClass(0), '');
	assert.equal(progressClass(59), '');
	assert.equal(progressClass(60), 'warn');
	assert.equal(progressClass(84), 'warn');
	assert.equal(progressClass(85), 'bad');
	assert.equal(progressClass(100), 'bad');
});

test('card: title + kv rows, third arg becomes the value class', () => {
	const html = card('Hello', [['k1', 'v1', 'clsA'], ['k2', 'v2']]);
	assert.match(html, /<h3>Hello<\/h3>/);
	assert.match(html, /<div class="kv">/);
	assert.match(html, /<span>k1<\/span>/);
	assert.match(html, /<span class="clsA">v1<\/span>/);
	assert.match(html, /<span class="">v2<\/span>/);
});

test('progressBlock: clamps to 0-100, omits pair when total=0', () => {
	const clamped = progressBlock(150, 5, 0);
	assert.match(clamped, /width: 100%/);
	assert.doesNotMatch(clamped, /5 \/ 0/);
	const pair = progressBlock(50, 5, 10);
	assert.match(pair, /50%/);
	assert.match(pair, /5 \/ 10/);
});

// ---- computeVisibleTabs + renderTabsHtml ----------------------------

test('computeVisibleTabs: only the "总" tab is always shown when no sources are present', () => {
	const v: DashboardView = {
		sources: { copilot: 'empty', claudeCode: 'disabled', plan: 'ok' },
		total: emptySource(),
		copilot: undefined as unknown as ReturnType<typeof emptySource>,
	};
	const tabs = computeVisibleTabs(i18n(), v);
	assert.equal(tabs.length, 1);
	assert.equal(tabs[0].id, 'total');
});

test('computeVisibleTabs: copilot is shown when the source is present', () => {
	const v: DashboardView = {
		sources: { copilot: 'ok', claudeCode: 'disabled', plan: 'ok' },
		total: emptySource(),
		copilot: emptySource(),
	};
	const tabs = computeVisibleTabs(i18n(), v);
	assert.equal(tabs.length, 2);
	assert.ok(tabs.some((t) => t.id === 'copilot'));
});

test('computeVisibleTabs: claude tab is hidden when claudeCode state is disabled', () => {
	const v: DashboardView = {
		sources: { copilot: 'ok', claudeCode: 'disabled', plan: 'ok' },
		total: emptySource(),
		copilot: emptySource(),
		claudeCode: undefined,
	};
	const tabs = computeVisibleTabs(i18n(), v);
	assert.ok(!tabs.some((t) => t.id === 'claude'));
});

test('computeVisibleTabs: claude tab is hidden when no Claude Code logs are detected', () => {
	const v: DashboardView = {
		sources: { copilot: 'ok', claudeCode: 'empty', plan: 'ok' },
		total: emptySource(),
		copilot: emptySource(),
		claudeCode: {
			status: {
				state: 'empty',
				logPath: '~/.claude/projects',
				filesTracked: 0,
				parseErrors: 0,
				skippedModels: 0,
			},
			today: emptyBreakdown(),
			sevenDay: emptyBreakdown(),
			thirtyDay: emptyBreakdown(),
			dailySeries: [],
			perModel: [],
		},
	};
	const tabs = computeVisibleTabs(i18n(), v);
	assert.ok(!tabs.some((t) => t.id === 'claude'));
});

test('renderTabsHtml: marks the active tab with aria-selected=true', () => {
	const html = renderTabsHtml(
		[{ id: 'total', label: '总' }, { id: 'copilot', label: 'Copilot' }],
		'copilot',
	);
	assert.match(html, /data-tab="total" aria-selected="false"/);
	assert.match(html, /data-tab="copilot" aria-selected="true"/);
});

// ---- platformBanner / platformSection -------------------------------

test('platformBanner: returns empty when plan is ok', () => {
	assert.equal(platformBanner(i18n(), { copilot: 'ok', claudeCode: 'ok', plan: 'ok' }), '');
});

test('platformBanner: surfaces planError on error/unsupported', () => {
	const out = platformBanner(i18n(), {
		copilot: 'ok', claudeCode: 'ok', plan: 'error', planError: 'HTTP 500',
	});
	assert.match(out, /HTTP 500/);
});

test('platformSection: returns empty when plan is undefined', () => {
	assert.equal(platformSection(i18n(), undefined), '');
});

test('platformSection: weekly unlimited shows ∞', () => {
	const out = platformSection(i18n(), makePlan({ weeklyUnlimited: true }));
	assert.match(out, /∞/);
});

test('platformSection: weekly unlimited renders the rainbow progress bar', () => {
	// Pinned regression: the PR that introduced the rainbow bar only
	// updated the multi-key `tokenPlanSection` path. The single-key
	// `platformSection` fallback (still used by the `platformBanner`
	// flow) kept rendering the old empty `planBar(0)` strip — same
	// `weeklyUnlimited: true` flag, two different visuals in the
	// same dashboard. Both paths now share `renderPlanCards`, so the
	// rainbow class must appear in BOTH outputs.
	const out = platformSection(i18n(), makePlan({ weeklyUnlimited: true }));
	assert.match(out, /class="progress rainbow"/);
	assert.match(out, /<div class="fill" style="width: 100%"/);
});

test('platformSection: weekly limited does not render the rainbow bar', () => {
	const out = platformSection(i18n(), makePlan({ weeklyUnlimited: false }));
	assert.doesNotMatch(out, /class="progress rainbow"/);
});

test('tokenPlanSection: weekly unlimited renders the rainbow progress bar (multi-key path)', () => {
	// With `allKeyPlans: undefined` the function falls through to the
	// single-plan branch which still calls the shared `renderPlanCards`.
	// A plan with `weeklyUnlimited: true` must render the rainbow class
	// — the regression we're guarding against was the OPPOSITE (the
	// multi-key branch updated, the single-key branch forgotten).
	const out = tokenPlanSection(i18n(), makePlan({ weeklyUnlimited: true }), undefined, undefined);
	assert.match(out, /∞/);
	assert.match(out, /class="progress rainbow"/);
});

test('tokenPlanSection: multi-key snapshot with weekly unlimited also renders the rainbow bar', () => {
	// The full multi-key path: a `KeyPlanSnapshot` whose `usage` is
	// populated with `weeklyUnlimited: true` must produce the rainbow
	// bar through the resolved-snapshot branch (not just the
	// single-plan fallback). The active key is the only one in the
	// pool, so the selector is omitted and the rendering is
	// structurally equivalent to the single-key test above.
	const snap: KeyPlanSnapshot = {
		label: 'primary',
		isActive: true,
		source: 'ok',
		usage: makePlan({ weeklyUnlimited: true }),
	};
	const out = tokenPlanSection(
		i18n(),
		undefined,
		{ primary: snap },
		undefined,
	);
	assert.match(out, /class="progress rainbow"/);
});

test('platformSection: expiry date renders with formatted days', () => {
	const out = platformSection(i18n(), makePlan({ expiryDate: '2026-12-31', expiryDays: 5 }));
	assert.match(out, /2026-12-31/);
	assert.match(out, /5 day\(s\) remaining/);
});

test('platformSection: past expiry renders absolute day count', () => {
	const out = platformSection(i18n(), makePlan({ expiryDate: '2025-01-01', expiryDays: -3 }));
	assert.match(out, /3d ago/);
});

test('platformSection: same-day expiry renders the today label', () => {
	const out = platformSection(i18n(), makePlan({ expiryDate: '2026-06-27', expiryDays: 0 }));
	assert.match(out, /expires today/);
});

// ---- chartSection / modelTable / emptyState ---------------------------

test('chartSection: empty series returns empty string', () => {
	assert.equal(chartSection(i18n(), []), '');
	assert.equal(chartSection(i18n(), undefined), '');
});

test('chartSection: produces one bar per day plus axis labels', () => {
	const series = [
		{ date: '2026-06-01', usage: emptyBreakdown() },
		{ date: '2026-06-02', usage: { ...emptyBreakdown(), inputTokens: 100 } },
	];
	const out = chartSection(i18n(), series);
	assert.match(out, /bar-chart/);
	// Non-zero bar: matches "class=\"bar\"" followed by something
	// that is NOT " zero". The negative lookahead drops the
	// "class=\"bar zero\"" hits.
	assert.equal((out.match(/class="bar"(?! zero)/g) || []).length, 1);
	assert.equal((out.match(/class="bar zero"/g) || []).length, 1);
});

test('modelTable: empty input returns empty string', () => {
	assert.equal(modelTable(i18n(), []), '');
	assert.equal(modelTable(i18n(), undefined), '');
});

test('modelTable: one row per model with right-aligned numeric cells', () => {
	const out = modelTable(i18n(), [
		{ modelId: 'MiniMax-M3', usage: { ...emptyBreakdown(), inputTokens: 100 } },
		{ modelId: 'MiniMax-M2.7', usage: { ...emptyBreakdown(), inputTokens: 50 } },
	]);
	// Count <tr> elements inside <tbody>; the header row uses
	// the same <tr> tag so we can't count them globally.
	const tbodyMatch = out.match(/<tbody>([\s\S]*?)<\/tbody>/);
	assert.ok(tbodyMatch);
	assert.equal((tbodyMatch![1].match(/<tr>/g) || []).length, 2);
	assert.match(out, /model-tag[^>]*>MiniMax-M3</);
});

test('emptyState: shows the noLocalData banner when copilot is empty', () => {
	const out = emptyState(i18n(), { copilot: 'empty', claudeCode: 'ok', plan: 'ok' });
	assert.match(out, /No local data yet/);
});

test('emptyState: hidden when copilot is ok', () => {
	const out = emptyState(i18n(), { copilot: 'ok', claudeCode: 'ok', plan: 'ok' });
	assert.equal(out, '');
});

// ---- claudeCodeSection -----------------------------------------------

test('claudeCodeSection: empty state shows the open-folder CTA', () => {
	const out = claudeCodeSection(i18n(), {
		status: { state: 'empty', logPath: '~/.claude/projects', filesTracked: 0, parseErrors: 0, skippedModels: 0 },
		today: emptyBreakdown(), sevenDay: emptyBreakdown(), thirtyDay: emptyBreakdown(), dailySeries: [], perModel: [],
	});
	assert.match(out, /No JSONL files yet/);
	assert.match(out, /data-action="claude-code-open-folder"/);
});

test('claudeCodeSection: error state includes the lastError', () => {
	const out = claudeCodeSection(i18n(), {
		status: { state: 'error', logPath: '/p', filesTracked: 0, parseErrors: 0, skippedModels: 0, lastError: 'EACCES' },
		today: emptyBreakdown(), sevenDay: emptyBreakdown(), thirtyDay: emptyBreakdown(), dailySeries: [], perModel: [],
	});
	assert.match(out, /EACCES/);
});

test('claudeCodeSection: notes count for filesTracked / parseErrors / skippedModels', () => {
	const out = claudeCodeSection(i18n(), {
		status: { state: 'ok', logPath: '/p', filesTracked: 3, parseErrors: 1, skippedModels: 7, lastSyncAt: Date.now() },
		today: emptyBreakdown(), sevenDay: emptyBreakdown(), thirtyDay: emptyBreakdown(), dailySeries: [], perModel: [],
	});
	assert.match(out, /3 files/);
	assert.match(out, /1 parse errors/);
	assert.match(out, /7 non-MiniMax lines skipped/);
});

// ---- statusBadge / mcpSection / mmxSection ---------------------------

test('statusBadge: installed/loggedIn → ok, missing → miss, else neutral', () => {
	assert.match(statusBadge('installed', 'OK', 'MISS'), /ok/);
	assert.match(statusBadge('missing', 'OK', 'MISS'), /miss/);
	assert.match(statusBadge('unknown', 'OK', 'MISS'), /○/);
});

test('mcpSection: returns empty when mcp is undefined', () => {
	assert.equal(mcpSection(i18n(), undefined), '');
});

test('mcpSection: not-ready surfaces the reason', () => {
	const out = mcpSection(i18n(), { ready: false, hasApiKey: true, host: 'h', hostFromProxy: false, command: 'uvx', args: [], reason: 'no key' });
	assert.match(out, /no key/);
});

test('mcpSection: unrecognised host falls back to mcpHostUnrecognised', () => {
	const out = mcpSection(i18n(), { ready: false, hasApiKey: true, hostFromProxy: true, command: 'uvx', args: [] });
	assert.match(out, /unrecognised/);
});

test('mmxSection: returns empty when mmx is undefined', () => {
	assert.equal(mmxSection(i18n(), undefined), '');
});

test('mmxSection: install=missing lists the install step', () => {
	const out = mmxSection(i18n(), {
		install: 'missing', auth: 'unknown', skill: 'unknown',
	});
	assert.match(out, /npm install -g mmx-cli/);
});

test('mmxSection: all-installed + loggedIn + skill installed → no pending steps', () => {
	const out = mmxSection(i18n(), {
		install: 'installed', version: '1.0.0', auth: 'loggedIn', skill: 'installed', agentReady: true,
	});
	assert.doesNotMatch(out, /npm install -g mmx-cli/);
	assert.doesNotMatch(out, /mmx auth login/);
	assert.doesNotMatch(out, /npx skills add/);
	assert.match(out, /agent ready/);
});

// ---- sourceSection ---------------------------------------------------

test('sourceSection: composes header + 3 cards + chart + table', () => {
	const out = sourceSection(i18n(), 'Total', {
		...emptySource(),
		perModel: [{ modelId: 'm', usage: emptyBreakdown() }],
		dailySeries: [{ date: '2026-06-01', usage: emptyBreakdown() }],
	});
	assert.match(out, /<h2>Total<\/h2>/);
	// The 3 window cards use the localised labels 'Today', '7d', '30d'
	// (not the i18n keys).
	assert.match(out, /<h3>Today<\/h3>/);
	assert.match(out, /<h3>7d<\/h3>/);
	assert.match(out, /<h3>30d<\/h3>/);
	assert.match(out, /model-tag/);
	assert.match(out, /bar-chart/);
});

// ---- start() end-to-end (fake DOM) -----------------------------------

// Each `start()` call registers a fresh click delegate via
// `makeFakeDoc`. The stub's `click()` fans the event out to every
// handler ever registered, so without a reset earlier suites
// (e.g. ones that exercise the `refresh` action) leak handlers
// into later tests and make postMessage assertions over-count.
beforeEach(() => {
	resetDocHandlers();
});

test('start: ready message fires once at mount', () => {
	const w = setupFakeWindow();
	try {
		const messages: unknown[] = [];
		const vscode = {
			postMessage: (m: unknown) => { messages.push(m); },
			getState: () => null,
			setState: () => {},
		};
		start({ vscode, root: w.root, updatedStamp: w.stamp, i18n: i18n(), win: makeFakeWin(w), doc: makeFakeDoc(w) });
		assert.deepEqual(messages, [{ type: 'ready' }]);
	} finally {

	}
});

test('start: clicking a tab button posts nothing but updates aria', () => {
	const w = setupFakeWindow();
	try {
		const setStateCalls: unknown[] = [];
		const vscode = {
			postMessage: () => {},
			getState: () => null,
			setState: (s: unknown) => { setStateCalls.push(s); },
		};
		start({ vscode, root: w.root, updatedStamp: w.stamp, i18n: i18n(), win: makeFakeWin(w), doc: makeFakeDoc(w) });

		// Build a fake <nav class="tabs"> containing the active +
		// inactive tab buttons. applyActiveTab() walks via
		// `querySelectorAll('.tabs [role="tab"]')` so the buttons
		// must live inside that container.
		const nav = makeElement('nav');
		nav.classList.add('tabs');
		const totalBtn = makeElement('button');
		totalBtn.attributes.set('data-tab', 'total');
		totalBtn.attributes.set('aria-selected', 'true');
		totalBtn.attributes.set('role', 'tab');
		nav.appendChild(totalBtn);
		const copilotBtn = makeElement('button');
		copilotBtn.attributes.set('data-tab', 'copilot');
		copilotBtn.attributes.set('aria-selected', 'false');
		copilotBtn.attributes.set('role', 'tab');
		nav.appendChild(copilotBtn);
		w.root.appendChild(nav);

		// Click "copilot" — should set state, swap aria-selected.
		copilotBtn.click();

		// The setState call carries the new active tab id.
		assert.deepEqual(setStateCalls, [{ activeTab: 'copilot' }]);
		assert.equal(copilotBtn.attributes.get('aria-selected'), 'true');
		assert.equal(totalBtn.attributes.get('aria-selected'), 'false');
	} finally {

	}
});

test('start: clicking an action button posts the right message', () => {
	const w = setupFakeWindow();
	try {
		const messages: Array<{ type: string }> = [];
		const vscode = {
			postMessage: (m: unknown) => { messages.push(m as { type: string }); },
			getState: () => null,
			setState: () => {},
		};
		start({ vscode, root: w.root, updatedStamp: w.stamp, i18n: i18n(), win: makeFakeWin(w), doc: makeFakeDoc(w) });
		// start() emits { type: 'ready' } before any user action.
		// Drop that prefix so the assertion only covers the click.
		messages.length = 0;

		// Build an action button
		const btn = makeElement('button');
		btn.attributes.set('data-action', 'refresh');
		w.root.appendChild(btn);
		btn.click();

		assert.deepEqual(messages, [{ type: 'refresh' }]);
	} finally {

	}
});

// Regression: the dashboard's header buttons (refresh / reset /
// close) live in the static `<header>` block, which is a SIBLING
// of `<div id="root">`. The previous implementation attached the
// click delegate to `root`, so clicks on those buttons never
// reached the listener — both Refresh and Close looked dead to
// the user. The fix moves the delegate to `document`; this test
// asserts the buttons fire their `postMessage` even when they
// share no ancestor with `root` (so the bubble path through
// `root` is impossible).
test('start: header action buttons fire even when not nested in root', () => {
	const w = setupFakeWindow();
	try {
		const messages: Array<{ type: string }> = [];
		const vscode = {
			postMessage: (m: unknown) => { messages.push(m as { type: string }); },
			getState: () => null,
			setState: () => {},
		};
		start({ vscode, root: w.root, updatedStamp: w.stamp, i18n: i18n(), win: makeFakeWin(w), doc: makeFakeDoc(w) });
		messages.length = 0;

		// Simulate the production HTML: a `<header>` whose children
		// include action buttons. The header is a sibling of root,
		// so a click on the button never bubbles through root.
		const header = makeElement('header');
		const closeBtn = makeElement('button');
		closeBtn.attributes.set('data-action', 'close');
		header.appendChild(closeBtn);
		const resetBtn = makeElement('button');
		resetBtn.attributes.set('data-action', 'reset');
		header.appendChild(resetBtn);
		closeBtn.click();
		resetBtn.click();

		assert.deepEqual(messages, [{ type: 'close' }, { type: 'reset' }]);
	} finally {

	}
});

test('start: message with type=data renders into the root', () => {
	const w = setupFakeWindow();
	try {
		const vscode = { postMessage: () => {}, getState: () => null, setState: () => {} };
		start({ vscode, root: w.root, updatedStamp: w.stamp, i18n: i18n(), win: makeFakeWin(w), doc: makeFakeDoc(w) });

		// Find the message handler registered on globalThis
		const handlers = w.messageHandlers;
		assert.equal(handlers.length, 1);
		handlers[0]({ data: { type: 'data', payload: makeView() } });
		// The render() call writes into root.innerHTML.
		assert.match(w.root.innerHTML, /Total/);
	} finally {

	}
});

test('start: message with type=error shows the error banner', () => {
	const w = setupFakeWindow();
	try {
		const vscode = { postMessage: () => {}, getState: () => null, setState: () => {} };
		start({ vscode, root: w.root, updatedStamp: w.stamp, i18n: i18n(), win: makeFakeWin(w), doc: makeFakeDoc(w) });
		w.messageHandlers[0]({ data: { type: 'error', payload: { message: 'oops' } } });
		assert.match(w.root.innerHTML, /oops/);
	} finally {

	}
});

test('start: invalid messages are ignored', () => {
	const w = setupFakeWindow();
	try {
		const vscode = { postMessage: () => {}, getState: () => null, setState: () => {} };
		start({ vscode, root: w.root, updatedStamp: w.stamp, i18n: i18n(), win: makeFakeWin(w), doc: makeFakeDoc(w) });
		const before = w.root.innerHTML;
		w.messageHandlers[0]({ data: null });
		w.messageHandlers[0]({ data: { type: 'unknown' } });
		// No render — innerHTML untouched (we never call render for
		// unknown types).
		assert.equal(w.root.innerHTML, before);
	} finally {

	}
});

// Regression for issue #5: refreshState messages are the only path
// for in-flight indicators, and they must NEVER touch `#root.innerHTML`.
// The previous two-frame model posted a 'loading' data frame on
// every refresh and the webview's render() rewrote `#root` — the
// user observed a dashboard permanently stuck on "刷新…". The
// new contract splits the responsibilities: `data` is the only
// message that may rewrite the main content; `refreshState` only
// mutates the header / spinner.
test('start: refreshState message mutates the refresh button but NEVER #root.innerHTML', () => {
	const w = setupFakeWindow();
	try {
		const messages: Array<{ type: string; payload?: unknown }> = [];
		const vscode = {
			postMessage: (m: unknown) => { messages.push(m as { type: string; payload?: unknown }); },
			getState: () => null,
			setState: () => {},
		};

		// The refresh button is a SIBLING of #root (it lives in
		// the static <header>), so we register it on the fake
		// `doc` directly. `applyRefreshState` queries the `doc`
		// for the button by selector, so the fake `doc.querySelector`
		// must resolve it.
		const refreshBtn = makeElement('button');
		refreshBtn.attributes.set('data-action', 'refresh');
		const fakeDoc = {
			addEventListener(_event: string, listener: (event: unknown) => void) {
				docClickHandlers.push(listener);
			},
			querySelector(sel: string): Element | null {
				return sel === 'button[data-action="refresh"]' ? (refreshBtn as unknown as Element) : null;
			},
		};

		start({ vscode, root: w.root, updatedStamp: w.stamp, i18n: i18n(), win: makeFakeWin(w), doc: fakeDoc });

		// Seed a real dashboard frame so we have something in
		// `#root.innerHTML` to protect against overwrite.
		w.messageHandlers[0]({ data: { type: 'data', payload: makeView() } });
		const before = w.root.innerHTML;
		assert.match(before, /Total/, 'sanity: data frame rendered dashboard content');

		// Now flip refreshState on. The button must receive the
		// `refreshing` class + `disabled` attribute; `#root` must
		// remain untouched.
		w.messageHandlers[0]({ data: { type: 'refreshState', payload: { refreshing: true, traceId: 't1' } } });
		assert.equal(refreshBtn.classList.contains('refreshing'), true, 'refreshing class should be set');
		assert.equal(refreshBtn.attributes.get('disabled'), 'true', 'button should be disabled while refreshing');
		assert.equal(w.root.innerHTML, before, '#root.innerHTML must NOT change on refreshState');

		// Flip it back off — class clears, disabled removed,
		// `#root` still untouched. The stub's `removeAttribute`
		// returns `undefined`, while the real DOM contract is
		// `getAttribute('disabled')` returning `null` once the
		// attribute is removed — both are acceptable signals that
		// the attribute is gone, so accept either.
		w.messageHandlers[0]({ data: { type: 'refreshState', payload: { refreshing: false, traceId: 't2' } } });
		assert.equal(refreshBtn.classList.contains('refreshing'), false, 'refreshing class should clear');
		const disabled = refreshBtn.attributes.get('disabled');
		assert.ok(
			disabled === null || disabled === undefined,
			`button should re-enable (disabled attribute removed). got '${disabled}'`,
		);
		assert.equal(w.root.innerHTML, before, '#root.innerHTML must STILL be untouched after refreshState=false');

		// The webview must echo a refreshStateAck so the host's
		// diagnostic channel can stitch the traceId.
		const acks = messages.filter((m) => m.type === 'refreshStateAck');
		assert.equal(acks.length, 2, 'host should receive one refreshStateAck per refreshState message');
		assert.deepEqual(acks[0]?.payload, { refreshing: true, traceId: 't1' });
		assert.deepEqual(acks[1]?.payload, { refreshing: false, traceId: 't2' });
	} finally {

	}
});

test('applyActiveTab: sets aria-selected on tab buttons', () => {
	const root = makeElement('div');
	const pane = makeElement('div');
	pane.attributes.set('data-tab-pane', 'total');
	root.appendChild(pane);
	const nav = makeElement('nav');
	nav.classList.add('tabs');
	root.appendChild(nav);
	const btn1 = makeElement('button');
	btn1.attributes.set('data-tab', 'total');
	btn1.attributes.set('aria-selected', 'false');
	btn1.attributes.set('role', 'tab');
	nav.appendChild(btn1);
	const btn2 = makeElement('button');
	btn2.attributes.set('data-tab', 'copilot');
	btn2.attributes.set('aria-selected', 'true');
	btn2.attributes.set('role', 'tab');
	nav.appendChild(btn2);

	applyActiveTab(root, 'total');
	assert.equal(btn1.attributes.get('aria-selected'), 'true');
	assert.equal(btn2.attributes.get('aria-selected'), 'false');
});

// applyRefreshState is the in-flight indicator. It toggles a
// `refreshing` class + `disabled` attribute on the refresh button
// and is the ONLY way the host signals progress without rewriting
// `#root.innerHTML` (the load-bearing split for issue #5).
test('applyRefreshState: toggles refreshing class + disabled attribute on the refresh button', () => {
	const root = makeElement('div');
	const refreshBtn = makeElement('button');
	refreshBtn.attributes.set('data-action', 'refresh');
	const fakeDoc = {
		querySelector(sel: string): Element | null {
			return sel === 'button[data-action="refresh"]' ? (refreshBtn as unknown as Element) : null;
		},
	};
	applyRefreshState(true, { doc: fakeDoc, root });
	assert.equal(refreshBtn.classList.contains('refreshing'), true);
	assert.equal(refreshBtn.attributes.get('disabled'), 'true');

	applyRefreshState(false, { doc: fakeDoc, root });
	assert.equal(refreshBtn.classList.contains('refreshing'), false);
	const disabled = refreshBtn.attributes.get('disabled');
	assert.ok(
		disabled === null || disabled === undefined,
		`disabled attribute should be removed after refreshing=false. got '${disabled}'`,
	);
});

test('applyRefreshState: no-op when the refresh button is absent (no throw, no mutation)', () => {
	const root = makeElement('div');
	const fakeDoc = {
		querySelector(_sel: string): Element | null { return null; },
	};
	// Should not throw.
	applyRefreshState(true, { doc: fakeDoc, root });
	applyRefreshState(false, { doc: fakeDoc, root });
	// root is untouched.
	assert.equal(root.innerHTML, '');
});

// ---- localCard edge cases -------------------------------------------

test('localCard: zero totals render grey background + 0.0% legend', () => {
	const out = localCard(i18n(), 'Today', emptyBreakdown());
	assert.match(out, /var\(--border\)/);
	assert.match(out, /0.0%/);
});

test('localCard: non-zero totals produce a conic-gradient', () => {
	const out = localCard(i18n(), 'Today', { ...emptyBreakdown(), inputTokens: 100, outputTokens: 50 });
	assert.match(out, /conic-gradient\(/);
});

// ---- helpers --------------------------------------------------------

function emptyBreakdown() {
	return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0 };
}

function emptySource() {
	return { today: emptyBreakdown(), sevenDay: emptyBreakdown(), thirtyDay: emptyBreakdown(), dailySeries: [], perModel: [] };
}

function makePlan(over: Partial<ReturnType<typeof blankPlan>> = {}) {
	return { ...blankPlan(), ...over };
}

function blankPlan() {
	return {
		modelName: 'MiniMax-M3',
		currentPercentage: 50,
		currentResetText: '2h',
		currentTotal: 1000,
		currentUsed: 500,
		weeklyPercentage: 30,
		weeklyUnlimited: false,
		weeklyResetText: '5d',
		weeklyTotal: 5000,
		weeklyUsed: 1500,
	};
}

function makeView(): DashboardView {
	return {
		sources: { copilot: 'ok', claudeCode: 'disabled', plan: 'ok' },
		total: emptySource(),
		copilot: emptySource(),
	};
}
