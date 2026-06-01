// Status-bar item that mirrors `minimax-status` style: a low-key
// button at the bottom of the editor that shows today's total token
// count, and opens the Dashboard on click.
//
// The status bar re-renders whenever the underlying usage store
// emits a change event, so the counter stays current without the
// user having to manually refresh.

import * as vscode from 'vscode';
import { t } from '../i18n';
import type { UsageStore } from '../usage';
import { totalTokens } from './aggregator';
import type { AuthManager } from '../auth';

export interface StatusBarDeps {
	store: UsageStore;
	auth: AuthManager;
	/** Command id that should fire when the user clicks the item. */
	command: string;
}

export interface UsageStatusBar {
	dispose(): void;
}

const SHOW_COMMAND = 'minimax.openDashboard';

export function createUsageStatusBar(deps: StatusBarDeps): UsageStatusBar {
	const item = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Right,
		50,
	);
	item.command = SHOW_COMMAND;
	item.name = 'MiniMax Usage';
	item.tooltip = t('status.tooltip', 'MiniMax Usage');
	item.show();

	function render(): void {
		const usage = deps.store.readToday();
		const total = totalTokens(usage);
		if (total === 0 && usage.requests === 0) {
			item.text = '$(graph) MiniMax';
			item.tooltip = t('status.tooltipEmpty');
		} else {
			item.text = `$(graph) MiniMax ${formatCompact(total)}`;
			item.tooltip = t(
				'status.tooltipActive',
				formatFull(total),
				String(usage.requests),
			);
		}
	}

	const subscription = deps.store.subscribe(render);
	// Render once initially — the store may already have data from
	// a previous session.
	render();

	return {
		dispose() {
			subscription.dispose();
			item.dispose();
		},
	};
}

function formatCompact(n: number): string {
	if (n >= 1_000_000) {
		return (n / 1_000_000).toFixed(2) + 'M';
	}
	if (n >= 1_000) {
		return (n / 1_000).toFixed(1) + 'k';
	}
	return String(n);
}

function formatFull(n: number): string {
	return n.toLocaleString('en-US');
}
