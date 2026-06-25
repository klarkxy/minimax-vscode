// Status-bar items that mirror the dashboard's Token Plan section.
//
// Two items live next to the existing "MiniMax 1.2k" usage counter:
//   $(bolt) 5h 73%   — 5-hour reset window, remaining %
//   $(calendar) Week 11% — weekly limit, remaining %
//
// Both items are fed by the shared `PlanCache` so they don't add any
// extra HTTP traffic on top of the dashboard's own polling. When the
// user has no API key configured, both items render a muted em-dash
// placeholder and the tooltip nudges them to run "MiniMax: Set API Key".

import * as vscode from 'vscode';
import type { PlanCache } from './aggregator';
import type { PlanUsage } from './types';

const SHOW_COMMAND = 'minimax.openDashboard';

export interface PlanStatusBarDeps {
	cache: PlanCache;
	/** Optional notifier for the active key's display name. When set,
	 *  the status bar shows the name next to the quota (e.g.
	 *  `copilot-1 5h 73%`) and the tooltip lists every key in the
	 *  pool. */
	getActiveKeyLabel?: () => string | undefined;
	/** Optional notifier for the full key pool summary. The status
	 *  bar formats each entry in the tooltip; the quota numbers
	 *  themselves still come from the shared `cache`. */
	getKeyPool?: () => Array<{ name: string; region: string; fingerprint: string; isActive: boolean }> | undefined;
}

export interface PlanStatusBar {
	dispose(): void;
	/**
	 * Tell the status bar whether the user has an API key configured.
	 * `set` shows the live quota, `unset` shows the em-dash placeholder
	 * with a tooltip that nudges the user to set a key, and `unknown`
	 * is the brief interval before the first read completes.
	 */
	setKeyState(state: 'unknown' | 'set' | 'unset'): void;
	/** Re-render the active-key label and pool summary. Cheap; safe
	 *  to call on every `KeyManager.onDidChange` fire. */
	refreshKeyLabel(): void;
}

/** What we know about whether the user has an API key, for rendering. */
type KeyState = 'unknown' | 'set' | 'unset';

interface RenderState {
	key: KeyState;
	usage?: PlanUsage;
	error?: string;
}

function emptyText(usage: PlanUsage, key: 'current' | 'weekly', isZh: boolean): string {
	if (key === 'weekly' && usage.weeklyUnlimited) {
		return isZh ? '无限' : '∞';
	}
	return '';
}

/**
 * Map a "used percent" (0-100) to a VS Code status-bar theme color.
 * Semantics: green = plenty of headroom, red = running out. Thresholds
 * match the dashboard's progressClass so the two surfaces agree.
 * Uses the *Foreground theme tokens only — no background tinting — so the
 * items blend with the rest of the status bar (which is theme-default)
 * instead of looking like five different buttons in a row.
 * Returns undefined (theme default) for null/undefined.
 */
function usedColor(usedPct: number | null | undefined): vscode.ThemeColor | undefined {
	if (usedPct == null) return undefined;
	if (usedPct >= 85) return new vscode.ThemeColor('statusBarItem.errorForeground');
	if (usedPct >= 60) return new vscode.ThemeColor('statusBarItem.warningForeground');
	return new vscode.ThemeColor('statusBarItem.remoteForeground');
}

/** Get the platform's reported USED percent (0-100) for a quota. */
function usedPctOf(plan: PlanUsage, key: 'current' | 'weekly'): number | null {
	if (key === 'weekly' && plan.weeklyUnlimited) return null;
	if (key === 'current') {
		return plan.currentPercentage ?? null;
	}
	return plan.weeklyPercentage ?? null;
}

/** Get the platform's reported REMAINING percent (0-100) for a quota. */
function remainingPctOf(plan: PlanUsage, key: 'current' | 'weekly'): number | null {
	if (key === 'weekly' && plan.weeklyUnlimited) return null;
	if (key === 'current') {
		if (plan.currentPercentage == null) return null;
		return 100 - plan.currentPercentage;
	}
	if (plan.weeklyPercentage == null) return null;
	return 100 - plan.weeklyPercentage;
}

function buildPoolTooltip(
	isZh: boolean,
	pool: Array<{ name: string; region: string; fingerprint: string; isActive: boolean }> | undefined,
	activeName: string | undefined,
): string {
	if (!pool || pool.length === 0) return '';
	const lines = pool.map((entry) => {
		const marker = entry.isActive ? (isZh ? ' ●当前' : ' ● active') : '';
		return `• ${entry.name}${marker}  ${entry.region}  ${entry.fingerprint}`;
	});
	if (activeName) {
		return isZh
			? `当前 Key: ${activeName}\n${lines.join('\n')}`
			: `Active key: ${activeName}\n${lines.join('\n')}`;
	}
	return lines.join('\n');
}

function renderQuota(
	state: RenderState,
	key: 'current' | 'weekly',
	labelEn: string,
	labelZh: string,
	activeName: string | undefined,
	poolTooltip: string,
): { text: string; tooltip: string; color: vscode.ThemeColor | undefined } {
	const isZh = vscode.env.language.toLowerCase().startsWith('zh');
	const label = isZh ? labelZh : labelEn;

	if (state.key !== 'set') {
		return {
			text: `${label} —`,
			tooltip: isZh
				? '未配置 API Key，无法读取 Token Plan。运行 "MiniMax: Set API Key" 配置。'
				: 'No API key configured. Run "MiniMax: Set API Key" to fetch the Token Plan quota.',
			color: undefined,
		};
	}
	if (!state.usage) {
		return {
			text: `${label} ...`,
			tooltip: isZh ? '正在加载 Token Plan ...' : 'Loading Token Plan ...',
			color: undefined,
		};
	}

	const plan = state.usage;
	const usedPct = usedPctOf(plan, key);
	if (usedPct == null) {
		return {
			text: `${label} ${emptyText(plan, key, isZh)}`,
			tooltip: isZh
				? 'Token Plan 周限额为无限'
				: 'Weekly limit: unlimited',
			color: undefined,
		};
	}

	const remainingPct = remainingPctOf(plan, key);
	const usedText = `${usedPct}%`;
	const color = usedColor(usedPct);
	const resetText = key === 'current' ? plan.currentResetText : plan.weeklyResetText;
	const total = key === 'current' ? plan.currentTotal : plan.weeklyTotal;
	const used = key === 'current' ? plan.currentUsed : plan.weeklyUsed;

	// Long-form tooltip. The status bar text shows the USED percent (so
	// the number + colour match the user's intuition — "54%" means I've
	// used 54%, not "54% remains"). Tooltip carries both halves for
	// the user who wants to do the subtraction.
	const pairLine = total > 0
		? isZh
			? `已用 ${used.toLocaleString('en-US')} / ${total.toLocaleString('en-US')}`
			: `Used ${used.toLocaleString('en-US')} / ${total.toLocaleString('en-US')}`
		: '';
	const remainingLine = remainingPct != null
		? isZh
			? `剩余 ${remainingPct}%`
			: `${remainingPct}% remaining`
		: '';

	const tooltip = [
		`${label}: ${usedText} ${isZh ? '已用' : 'used'}`,
		pairLine,
		remainingLine,
		`${isZh ? '重置' : 'Resets in'}: ${resetText}`,
		poolTooltip,
		isZh ? '点击打开 Dashboard 查看详情' : 'Click to open the dashboard for details',
	].filter(Boolean).join('\n');

	return { text: `${label} ${usedText}`, tooltip, color };
}

export function createPlanStatusBar(deps: PlanStatusBarDeps): PlanStatusBar {
	const isZh = vscode.env.language.toLowerCase().startsWith('zh');
	const fiveHour = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 60);
	const weekly = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 59);
	fiveHour.command = SHOW_COMMAND;
	weekly.command = SHOW_COMMAND;
	fiveHour.name = 'MiniMax Token Plan (5h)';
	weekly.name = 'MiniMax Token Plan (weekly)';

	let lastKey: KeyState = 'unknown';

	function poolTooltip(): string {
		return buildPoolTooltip(isZh, deps.getKeyPool?.(), deps.getActiveKeyLabel?.());
	}

	function activeLabel(): string | undefined {
		return deps.getActiveKeyLabel?.();
	}

	function render(): void {
		const snap = deps.cache.read();
		const state: RenderState = { key: lastKey, usage: snap?.usage };
		const pool = poolTooltip();
		const five = renderQuota(state, 'current', '5h', '5小时', activeLabel(), pool);
		fiveHour.text = activeLabel() && five.text.startsWith('5h')
			? `${activeLabel()} ${five.text}`
			: five.text;
		fiveHour.tooltip = five.tooltip;
		fiveHour.color = five.color;
		fiveHour.show();

		const week = renderQuota(state, 'weekly', 'Week', '周', activeLabel(), pool);
		weekly.text = week.text;
		weekly.tooltip = week.tooltip;
		weekly.color = week.color;
		weekly.show();
	}

	const subscription = deps.cache.subscribe(() => {
		render();
	});
	render();

	// The status bar needs to know whether the user has an API key
	// configured. The cache itself doesn't carry that signal — only
	// the snapshot does. We expose `setKeyState` so the extension
	// host can call it from `AuthManager.onDidChangeApiKey`.
	const handle: PlanStatusBar = {
		setKeyState(state) {
			if (state === lastKey) return;
			lastKey = state;
			render();
		},
		refreshKeyLabel() {
			render();
		},
		dispose() {
			subscription.dispose();
			fiveHour.dispose();
			weekly.dispose();
		},
	};

	// Suppress unused warning on `isZh` in case we later add a tooltip
	// that needs it directly (renderQuota is already bilingual).
	void isZh;
	return handle;
}
