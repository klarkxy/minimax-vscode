// Types shared across the dashboard module.
//
// The dashboard renders a single view that combines a few independent
// data sources. The first three are token-accounting sources (one per
// tab in the UI):
//   - `copilot` (the extension's own `onUsage` callbacks — what flows
//     through Copilot Chat using a MiniMax model — see
//     `src/provider/index.ts:247-253`)
//   - `claudeCode` (Claude Code JSONL log ingest — sibling store fed
//     by the same extension's background poller, see
//     `src/dashboard/claudeCodeIngest.ts`)
//   - `codex` / `opencode` — future sources, currently undefined.
// `total` is the *aggregate* of every available token source, used by
// the "总" tab so a user can see the all-in totals at a glance without
// having to add the per-source tabs themselves.
//
// The remaining two are not per-source:
//   - `plan` (platform coding-plan API — per-account quota)
//   - `mmxCli` (CLI detection — system-wide, not a token source)
//
// All of these are independent — if any one fails, the dashboard
// degrades gracefully and still renders the rest.

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
	/** Percentage of the weekly window already used. */
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

/** Per-source token view. Mirrors what the underlying `usageStore`
 *  exposes so the dashboard can use the same chart/table helpers on
 *  any source. `total` in the dashboard is just an aggregate of one or
 *  more of these. */
export interface SourceView {
	today: ModelUsage;
	sevenDay: ModelUsage;
	thirtyDay: ModelUsage;
	perModel: Array<{ modelId: string; usage: ModelUsage }>;
	dailySeries: Array<{ date: string; usage: ModelUsage }>;
}

/** Aggregated Claude Code view-model. Mirrors `SourceView` plus a
 *  status block that the Claude Code section needs to render its
 *  last-sync row, log path, etc. */
export interface ClaudeCodeView extends SourceView {
	stats: UsageStats;
	status: ClaudeCodeIngestStatus;
}

/** Aggregated dashboard view-model. */
export interface DashboardView {
	/** Best-effort status of each upstream source. */
	sources: {
		copilot: 'ok' | 'empty' | 'error';
		claudeCode: 'ok' | 'empty' | 'disabled' | 'error' | 'loading';
		claudeCodeError?: string;
		plan: 'ok' | 'loading' | 'unconfigured' | 'error' | 'unsupported';
		planError?: string;
	};
	/** Aggregate of every available token source. The "总" tab reads
	 *  from here so the all-in totals stay in sync with whatever
	 *  source tabs are visible. With a single source this is
	 *  numerically identical to that source. */
	total: SourceView;
	/** Copilot Chat (extension's own) token accounting. Drives the
	 *  "copilot" tab. Always present — the local store is created at
	 *  extension activation. */
	copilot: SourceView;
	/** Claude Code JSONL-derived view. `undefined` when the ingester
	 *  isn't running (e.g. the user has fully uninstalled Claude Code
	 *  AND disabled the setting); the "claude" tab is hidden. */
	claudeCode?: ClaudeCodeView;
	/** Platform plan usage, only present when `sources.plan === 'ok'`. */
	plan?: PlanUsage;
	/** mmx-cli status. Always present (defaults to "missing"). */
	mmxCli: MmxCliStatus;
}
