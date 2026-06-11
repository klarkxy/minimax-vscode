import * as vscode from 'vscode';
import * as path from 'node:path';
import {
	CONFIG_SECTION,
	DEFAULT_BASE_URL_GLOBAL,
	DEFAULT_CLAUDE_CODE_LOG_PATH,
} from './consts';

export type DebugMode = 'minimal' | 'metadata' | 'verbose';

/**
 * Get the MiniMax Anthropic-compatible API base URL. The Anthropic SDK
 * appends `/v1/messages` automatically, so the configured URL is the host
 * prefix (e.g. `https://api.minimaxi.com/anthropic`).
 *
 * Defaults to the international endpoint when not configured.
 */
export function getBaseUrl(): string {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const url = config.get<string>('apiBaseUrl');
	if (typeof url === 'string' && url.trim().length > 0) {
		return url.trim();
	}
	return DEFAULT_BASE_URL_GLOBAL;
}

/**
 * Resolve the API model ID to send to the endpoint.
 *
 * Users can override model IDs via the `modelIdOverrides` setting object
 * (e.g. for third-party API proxies). Falls back to the VS Code model ID
 * when no override is configured.
 */
export function getApiModelId(vscodeModelId: string): string {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const overrides = config.get<Record<string, string>>('modelIdOverrides');
	const override = overrides?.[vscodeModelId]?.trim();
	return override || vscodeModelId;
}

/**
 * Diagnostic mode. `verbose` also enables metadata logs.
 */
export function getDebugMode(): DebugMode {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	return normalizeDebugMode(config.get<unknown>('debugMode')) ?? 'minimal';
}

/**
 * Whether to log privacy-preserving diagnostic debug information.
 */
export function getDebugLoggingEnabled(): boolean {
	return getDebugMode() !== 'minimal';
}

/**
 * Whether to write full MiniMax request payloads to disk.
 */
export function getRequestDumpEnabled(): boolean {
	return getDebugMode() === 'verbose';
}

/**
 * Resolve the configured max output tokens limit.
 * Returns `undefined` when set to 0 (API default — no limit).
 */
export function getMaxTokens(): number | undefined {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const value = config.get<number>('maxTokens', 0);
	return value > 0 ? value : undefined;
}

/**
 * Whether the user has lifted MiniMax-M3 from the safe 512K default
 * to the official 1M context window via `minimax.enableM31MContext`.
 *
 * Default is `false`. The toggle is wired through the
 * `minimax.toggleM31MContext` command (see `runtime/commands.ts`),
 * which pops a modal warning about the 2× billing rate and the need
 * for sales-granted >512K access before flipping the setting. Going
 * through the command (rather than editing `settings.json` directly)
 * is what makes the warning visible to the user.
 */
export function isM31MContextEnabled(): boolean {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	return config.get<boolean>('enableM31MContext', false);
}

/**
 * Target context window for MiniMax-M3 in the picker. Returns the
 * 1M cap when `minimax.enableM31MContext` is on, otherwise the
 * safe 512K default. The picker indicator is rendered against this
 * number, so changing this is what makes the "上下文窗口: N / M"
 * label update live (the provider listens to
 * `onDidChangeConfiguration` on this setting and fires
 * `onDidChangeLanguageModelChatInformation`).
 */
export function getM3ContextWindow(): number {
	return isM31MContextEnabled() ? 1_000_000 : 512_000;
}

export function getStabilizeToolListEnabled(): boolean {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	return config.get<boolean>('experimental.stabilizeToolList', false);
}

/**
 * Whether the usage dashboard should also ingest token usage from
 * Claude Code CLI / the Claude Code VSCode extension. Reads
 * JSONL session files under `~/.claude/projects` (configurable via
 * `minimax.claudeCode.logPath`) on a 30 s poll. Default `true`.
 */
export function getIncludeClaudeCode(): boolean {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	return config.get<boolean>('dashboard.includeClaudeCode', true);
}

/**
 * Absolute path to the directory containing Claude Code JSONL session
 * logs. Defaults to `~/.claude/projects` on all platforms.
 *
 * Supports a leading `~` (expanded to the user's home directory via
 * `process.env.HOME` on POSIX and `process.env.USERPROFILE` on
 * Windows). Other tilde forms (`~user/foo`) are left verbatim — the
 * local install is always for the current user.
 */
export function getClaudeCodeLogPath(): string {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const raw = config.get<string>('claudeCode.logPath', DEFAULT_CLAUDE_CODE_LOG_PATH);
	return expandHome(raw);
}

/**
 * Poll interval (in milliseconds) for the Claude Code log ingester.
 * Default `30 000` (30 s); clamped to `[5 000, 600 000]` even if the
 * user edits `settings.json` to a value outside the published schema.
 */
export function getClaudeCodePollIntervalMs(): number {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const value = config.get<number>('claudeCode.pollIntervalMs', 30_000);
	if (!Number.isFinite(value)) return 30_000;
	if (value < 5_000) return 5_000;
	if (value > 600_000) return 600_000;
	return value;
}

/**
 * Default allowlist of model IDs the Claude Code ingester counts in the
 * dashboard. Mirrors the official picker model IDs (M3 / M2.7 /
 * M2.7-highspeed) plus the M2.x family the docs still reference. Users
 * can override this via `minimax.claudeCode.allowedModels`.
 *
 * The Claude Code JSONL session log records every model the CLI / VSCode
 * extension talked to — not just MiniMax. If the user has Claude Code
 * configured to talk to a different provider (or a local LLM with the
 * same Anthropic-compatible surface), those rows show up in the JSONL
 * too. The dashboard's job is to count MiniMax usage, so we filter to
 * this allowlist before recording anything.
 */
export const DEFAULT_CLAUDE_CODE_ALLOWED_MODELS: readonly string[] = [
	'MiniMax-M3',
	'MiniMax-M2.7',
	'MiniMax-M2.7-highspeed',
	'MiniMax-M2.5',
	'MiniMax-M2.5-highspeed',
	'MiniMax-M2.1',
	'MiniMax-M2.1-highspeed',
	'MiniMax-M2',
];

/**
 * Read the configured `minimax.claudeCode.allowedModels`, falling back
 * to `DEFAULT_CLAUDE_CODE_ALLOWED_MODELS` when the setting is missing
 * or malformed. Empty arrays collapse to the default so a user who
 * accidentally wipes the list does not silently disable the dashboard.
 */
export function getClaudeCodeAllowedModels(): readonly string[] {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const raw = config.get<unknown>('claudeCode.allowedModels');
	if (!Array.isArray(raw)) return DEFAULT_CLAUDE_CODE_ALLOWED_MODELS;
	const filtered = raw.filter(
		(value): value is string => typeof value === 'string' && value.trim().length > 0,
	);
	return filtered.length > 0 ? filtered : DEFAULT_CLAUDE_CODE_ALLOWED_MODELS;
}

function expandHome(p: string): string {
	if (!p || !p.startsWith('~')) return p;
	const home = process.env.HOME || process.env.USERPROFILE || '';
	if (!home) return p;
	if (p === '~') return home;
	if (p.startsWith('~/') || p.startsWith('~\\')) {
		return path.join(home, p.slice(2));
	}
	return p;
}

function normalizeDebugMode(value: unknown): DebugMode | undefined {
	if (value === 'minimal' || value === 'metadata' || value === 'verbose') {
		return value;
	}
	return undefined;
}
