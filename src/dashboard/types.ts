// Types shared across the dashboard module.
//
// The dashboard renders a single view that combines four data sources:
//   - local token accounting (src/usage.ts) — the extension's own
//     `onUsage` callbacks from `src/provider/index.ts:247-253`
//   - Claude Code JSONL log ingest (src/dashboard/claudeCodeIngest.ts)
//     — sibling store fed by the same extension's background poller
//   - platform coding-plan API (/v1/api/openplatform/coding_plan/remains)
//   - platform account/amount API (historical billing)
//
// All four are independent — if any one fails, the dashboard degrades
// gracefully and still renders the rest.

import type { ModelUsage, UsageStats } from '../usage';
import type { MmxCliStatus } from './mmxCli';
import type { ClaudeCodeIngestStatus } from './claudeCodeIngest';

export type { MmxCliStatus, ClaudeCodeIngestStatus };

/** Information returned by the platform `coding_plan/remains` API. */
export interface PlanUsage {
	modelName: string;
	/** Tokens used inside the current 5-hour window. */
	currentUsed: number;
	/** Total tokens allowed in the current 5-hour window. */
	currentTotal: number;
	/** Percentage of the current 5-hour window already used. */
	currentPercentage: number;
	/** Human-readable description of when the current window resets. */
	currentResetText: string;
	/** Tokens used in the current weekly window. */
	weeklyUsed: number;
	/** Total tokens allowed in the current weekly window. */
	weeklyTotal: number;
	/** Percentage of the current weekly window already used. */
	weeklyPercentage: number;
	/** Human-readable description of when the weekly window resets. */
	weeklyResetText: string;
	/** `true` when the plan reports an unlimited weekly budget. */
	weeklyUnlimited: boolean;
	/** ISO date string for the subscription expiry, if reported. */
	expiryDate?: string;
	/** Days until subscription expiry (negative = already expired). */
	expiryDays?: number;
	/** Per-model list (raw `model_remains` from the API). */
	allModels: PlanModelInfo[];
}

export interface PlanModelInfo {
	name: string;
	used: number;
	total: number;
	percentage: number;
}

/** Aggregated Claude Code view-model. Mirrors the shape of `local` so
 *  the dashboard can render both with the same chart / table helpers. */
export interface ClaudeCodeView {
	stats: UsageStats;
	today: ModelUsage;
	sevenDay: ModelUsage;
	thirtyDay: ModelUsage;
	perModel: Array<{ modelId: string; usage: ModelUsage }>;
	dailySeries: Array<{ date: string; usage: ModelUsage }>;
	status: ClaudeCodeIngestStatus;
}

/** Aggregated dashboard view-model. */
export interface DashboardView {
	/** Best-effort status of each upstream source. */
	sources: {
		local: 'ok' | 'empty' | 'error';
		claudeCode: 'ok' | 'empty' | 'disabled' | 'error' | 'loading';
		claudeCodeError?: string;
		plan: 'ok' | 'loading' | 'unconfigured' | 'error' | 'unsupported';
		planError?: string;
	};
	/** Local token accounting, as returned by the usage store. */
	local: {
		stats: UsageStats;
		today: ModelUsage;
		sevenDay: ModelUsage;
		thirtyDay: ModelUsage;
		perModel: Array<{ modelId: string; usage: ModelUsage }>;
		dailySeries: Array<{ date: string; usage: ModelUsage }>;
	};
	/** Claude Code JSONL-derived view. `undefined` when the ingester
	 *  isn't running (e.g. the user has fully uninstalled Claude Code
	 *  AND disabled the setting); the dashboard substitutes a banner. */
	claudeCode?: ClaudeCodeView;
	/** Platform plan usage, only present when `sources.plan === 'ok'`. */
	plan?: PlanUsage;
	/** mmx-cli status. Always present (defaults to "missing"). */
	mmxCli: MmxCliStatus;
}
