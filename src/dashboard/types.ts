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

/**
 * Snapshot of the MiniMax Web Search MCP provider's current state.
 * The dashboard renders this as a compact "Agent Mode" card next
 * to the existing mmx-cli status. We do NOT enumerate the tools
 * the MCP server exposes — VS Code's Configure Tools picker is the
 * authoritative source, and the MiniMax docs / MCP package evolve
 * independently of our UI.
 */
export interface McpStatus {
	/** `true` when the configured `minimax.apiBaseUrl` resolves to
	 *  a known MiniMax platform AND an API key is present. The
	 *  dashboard renders the "Registered" badge green when this is
	 *  true AND `providerRegistered` is also true (see below). */
	ready: boolean;
	/** `true` when the MiniMax extension has actually called
	 *  `vscode.lm.registerMcpServerDefinitionProvider` for this
	 *  process. Stays `false` until `registerMiniMaxMcpProvider`
	 *  has run, which lets the dashboard distinguish "the
	 *  provider isn't registered yet" (lifecycle error / disabled
	 *  by the user) from "the provider is registered, but the
	 *  current config makes the definition not ready" (missing
	 *  key / unrecognised host). */
	providerRegistered: boolean;
	/** Stable id, surfaced for debugging / logs. */
	providerId: string;
	/** Human-readable label (matches the package.json contribution). */
	providerLabel: string;
	/** Resolved MiniMax API host (e.g. `https://api.minimaxi.com`),
	 *  or `null` for unrecognised / unknown hosts. */
	host: string | null;
	/** `true` when the resolved host came from a third-party proxy
	 *  base URL rather than China / Global. Surfaces the
	 *  credential-leak safety state — the MCP provider refuses to
	 *  inject the key in this case. */
	hostFromProxy: boolean;
	/** `true` when an API key is present in SecretStorage / settings. */
	hasApiKey: boolean;
	/** Launch command (default `uvx`). Configurable per-provider but
	 *  not exposed as a setting yet — always `uvx` today. */
	command: string;
	/** `command -y minimax-coding-plan-mcp` style args, for the
	 *  "Launch command" row. */
	args: string[];
	/** Localised reason the provider is not ready (missing key /
	 *  unknown host). Empty when `ready` is true. */
	reason: string;
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
	/** MiniMax Web Search MCP provider status. Always present so
	 *  the dashboard can render the card unconditionally — the
	 *  user shouldn't have to "enable" anything beyond having an
	 *  API key + a recognised host. */
	mcp: McpStatus;
	/** API key pool summary. Always present (empty when no named
	 *  key has been added yet). Secrets are NEVER included. */
	apiKeys: ApiKeySummary[];
	/** id of the active entry in `apiKeys`, or `undefined` if no
	 *  named key is active (e.g. legacy single-key slot only). */
	activeKeyId?: string;
	/** Which Copilot usage scope the dashboard should render. The
	 *  default is the active key; the user can flip to a per-key
	 *  scope (selected from the API Keys section) or to the
	 *  all-keys aggregate. UI state lives in webview state. */
	usageScope: UsageScope;
	/** All-keys aggregate of the Copilot source, built from
	 *  `usageStore.readAllKeys()`. Always present so the
	 *  dropdown can flip without a re-fetch. */
	allKeysCopilot?: SourceView;
}

/** Selects which slice of Copilot usage the dashboard renders. */
export type UsageScope =
	| { kind: 'all' }
	| { kind: 'key'; keyId: string };

/** Dashboard-facing summary of a single API key. Mirrors
 *  `KeyManager.KeySummary` but is owned by the dashboard module
 *  so the aggregator and the panel don't have to depend on
 *  `keyManager.ts` directly. */
export interface ApiKeySummary {
	id: string;
	name: string;
	region: 'china' | 'global' | 'custom';
	apiBaseUrl: string;
	fingerprint: string;
	createdAt: string;
	updatedAt: string;
	lastUsedAt?: string;
	isLegacy: boolean;
	missingSecret: boolean;
}
