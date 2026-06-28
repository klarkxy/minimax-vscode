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
import { t } from '../i18n';
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
	getKeyPool?: () => Array<{ id: string; name: string; region: string; fingerprint: string; isActive: boolean }> | undefined;
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

function emptyText(usage: PlanUsage, key: 'current' | 'weekly'): string {
	if (key === 'weekly' && usage.weeklyUnlimited) {
		return t('statusBar.plan.unlimitedText');
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

export function buildPoolTooltip(
	pool: Array<{ id: string; name: string; region: string; fingerprint: string; isActive: boolean }> | undefined,
	activeName: string | undefined,
	allSnaps?: Map<string, { usage?: PlanUsage }> | null,
): string {
	if (!pool || pool.length === 0) return '';

	const activeEntry = pool.find((e) => e.isActive);
	const otherEntries = pool.filter((e) => !e.isActive);
	const lines: string[] = [];

	// Active key: detailed view with full plan data and region
	if (activeEntry) {
		const label = activeName ?? activeEntry.name;
		const snap = allSnaps?.get(activeEntry.id);
		lines.push(`★ ${label}  ${activeEntry.region}`);
		if (snap?.usage) {
			const u = snap.usage;
			const fiveH = u.currentPercentage != null ? `${u.currentPercentage}%` : '?';
			const wk = u.weeklyPercentage != null ? `${u.weeklyPercentage}%` : '∞';
			const reset = u.currentResetText ? `  ${t('statusBar.plan.resetsIn')} ${u.currentResetText}` : '';
			lines.push(`  5h ${fiveH}  ${t('statusBar.plan.weekly')} ${wk}${reset}`);
		} else {
			lines.push(`  loading`);
		}
	}

	// Other keys: compact one-line each (name + 5h% + week%)
	for (const entry of otherEntries) {
		const snap = allSnaps?.get(entry.id);
		if (snap?.usage) {
			const u = snap.usage;
			const fiveH = u.currentPercentage != null ? String(u.currentPercentage) : '?';
			const wk = u.weeklyPercentage != null ? String(u.weeklyPercentage) : '?';
			lines.push(t('statusBar.plan.otherKeyCompact', entry.name, fiveH, wk));
		} else {
			lines.push(t('statusBar.plan.otherKeyCompact', entry.name, '?', '?'));
		}
	}

	return lines.join('\n');
}

function renderQuota(
	state: RenderState,
	key: 'current' | 'weekly',
	label: string,
	activeName: string | undefined,
	poolTooltip: string,
): { text: string; tooltip: string; color: vscode.ThemeColor | undefined } {
	if (state.key !== 'set') {
		return {
			text: `${label} —`,
			tooltip: t('statusBar.plan.noKey'),
			color: undefined,
		};
	}
	if (!state.usage) {
		return {
			text: `${label} ...`,
			tooltip: t('statusBar.plan.loading'),
			color: undefined,
		};
	}

	const plan = state.usage;
	const usedPct = usedPctOf(plan, key);
	if (usedPct == null) {
		return {
			text: `${label} ${emptyText(plan, key)}`,
			tooltip: t('statusBar.plan.weeklyUnlimited'),
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
		? t('statusBar.plan.usedPair', used.toLocaleString('en-US'), total.toLocaleString('en-US'))
		: '';
	const remainingLine = remainingPct != null
		? t('statusBar.plan.remaining', String(remainingPct))
		: '';

	const tooltip = [
		t('statusBar.plan.usedHeader', usedText),
		pairLine,
		remainingLine,
		`${t('statusBar.plan.resetsIn')}: ${resetText}`,
		poolTooltip,
		t('statusBar.plan.openDashboard'),
	].filter(Boolean).join('\n');

	return { text: `${label} ${usedText}`, tooltip, color };
}

export function createPlanStatusBar(deps: PlanStatusBarDeps): PlanStatusBar {
	const fiveHour = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 60);
	const weekly = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 59);
	fiveHour.command = SHOW_COMMAND;
	weekly.command = SHOW_COMMAND;
	fiveHour.name = 'MiniMax Token Plan (5h)';
	weekly.name = 'MiniMax Token Plan (weekly)';

	let lastKey: KeyState = 'unknown';

	function poolTooltip(): string {
		return buildPoolTooltip(deps.getKeyPool?.(), deps.getActiveKeyLabel?.(), deps.cache.readAll());
	}

	function activeLabel(): string | undefined {
		return deps.getActiveKeyLabel?.();
	}

	function render(): void {
		const snap = deps.cache.read();
		const state: RenderState = { key: lastKey, usage: snap?.usage };
		const pool = poolTooltip();
		const fiveLabel = t('statusBar.plan.fiveHour');
		const weekLabel = t('statusBar.plan.weekly');
		const five = renderQuota(state, 'current', fiveLabel, activeLabel(), pool);
		fiveHour.text = activeLabel() && five.text.startsWith(fiveLabel)
			? `${activeLabel()} ${five.text}`
			: five.text;
		fiveHour.tooltip = five.tooltip;
		fiveHour.color = five.color;
		fiveHour.show();

		const week = renderQuota(state, 'weekly', weekLabel, activeLabel(), pool);
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
	return handle;
}
