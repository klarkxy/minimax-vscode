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
 * Map a "remaining percent" (0-100) to a VS Code status-bar theme color.
 * Mirrors minimax-status's mapping: green when plenty left, red when low.
 * Uses the *Foreground theme tokens only — no background tinting — so the
 * items blend with the rest of the status bar (which is theme-default)
 * instead of looking like five different buttons in a row.
 * Returns undefined (theme default) for null/undefined.
 */
function remainingColor(pct: number | null | undefined): vscode.ThemeColor | undefined {
	if (pct == null) return undefined;
	if (pct >= 60) return new vscode.ThemeColor('statusBarItem.remoteForeground');
	if (pct >= 30) return new vscode.ThemeColor('statusBarItem.warningForeground');
	return new vscode.ThemeColor('statusBarItem.errorForeground');
}

/** Compute the "remaining percent" for a quota (inverts the platform's USED %). */
function remainingPctOf(plan: PlanUsage, key: 'current' | 'weekly'): number | null {
	if (key === 'weekly' && plan.weeklyUnlimited) return null;
	if (key === 'current') {
		if (plan.currentPercentage == null) return null;
		return 100 - plan.currentPercentage;
	}
	if (plan.weeklyPercentage == null) return null;
	return 100 - plan.weeklyPercentage;
}

function renderQuota(
	state: RenderState,
	key: 'current' | 'weekly',
	labelEn: string,
	labelZh: string,
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
	const pct = remainingPctOf(plan, key);
	if (pct == null) {
		return {
			text: `${label} ${emptyText(plan, key, isZh)}`,
			tooltip: isZh
				? 'Token Plan 周限额为无限'
				: 'Weekly limit: unlimited',
			color: undefined,
		};
	}

	const remainingText = `${pct}%`;
	const color = remainingColor(pct);
	const resetText = key === 'current' ? plan.currentResetText : plan.weeklyResetText;
	const total = key === 'current' ? plan.currentTotal : plan.weeklyTotal;
	const used = key === 'current' ? plan.currentUsed : plan.weeklyUsed;

	// Long-form tooltip. Mirrors the dashboard's "X / Y · reset" layout
	// but only when the platform actually reported a total — for the
	// "general" model the total is 0 and the dashboard hides the pair.
	const pairLine = total > 0
		? isZh
			? `剩余 ${used.toLocaleString('en-US')} / ${total.toLocaleString('en-US')}`
			: `Remaining ${used.toLocaleString('en-US')} / ${total.toLocaleString('en-US')}`
		: '';

	const tooltip = [
		`${label}: ${remainingText} ${isZh ? '剩余' : 'remaining'}`,
		pairLine,
		`${isZh ? '重置' : 'Resets in'}: ${resetText}`,
		isZh ? '点击打开 Dashboard 查看详情' : 'Click to open the dashboard for details',
	].filter(Boolean).join(' · ');

	return { text: `${label} ${remainingText}`, tooltip, color };
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

	function render(): void {
		const snap = deps.cache.read();
		const state: RenderState = { key: lastKey, usage: snap?.usage };
		const five = renderQuota(state, 'current', '5h', '5小时');
		fiveHour.text = five.text;
		fiveHour.tooltip = five.tooltip;
		fiveHour.color = five.color;
		fiveHour.show();

		const week = renderQuota(state, 'weekly', 'Week', '周');
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
