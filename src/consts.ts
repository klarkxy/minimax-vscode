/**
 * Compile-time constants shared across the extension.
 *
 * These do NOT depend on the VS Code runtime (no workspace configuration,
 * no secrets API). For run-time settings reads see `config.ts`.
 */

/** VS Code configuration section prefix for all extension settings. */
export const CONFIG_SECTION = 'minimax';

/** Anthropic-compatible base URLs. The SDK appends `/v1/messages` automatically. */
export const DEFAULT_BASE_URL_GLOBAL = 'https://api.minimax.io/anthropic';
export const DEFAULT_BASE_URL_CHINA = 'https://api.minimaxi.com/anthropic';

/** Legacy: kept for backward compatibility with deepseek-style debugMode. */
export const LANGUAGE_MODEL_CHAT_SYSTEM_ROLE = 3;

// ---- Secret keys ----

/** SecretStorage key for the MiniMax API key. */
export const API_KEY_SECRET = 'minimax-vscode.apiKey';

/** memento key tracking whether the welcome walkthrough has been shown. */
export const WELCOME_SHOWN_KEY = 'minimax-vscode.welcomeShown';

/** memento key tracking the user's most recently used commit model. */
export const COMMIT_MODEL_LAST_USED_KEY = 'minimax-vscode.commitModel.lastUsed';

/** memento key for cumulative token usage. Stored as JSON. */
export const USAGE_STATS_KEY = 'minimax-vscode.usageStats';

/** memento key for the last-known mmx-cli status. Stored as JSON. */
export const MMX_CLI_STATUS_KEY = 'minimax-vscode.mmxCliStatus';

/** memento key for cumulative token usage from Claude Code CLI / VSCode
 *  extension JSONL session logs. Same `UsageStats` shape as
 *  `USAGE_STATS_KEY` so the dashboard can render with the same helpers. */
export const CLAUDE_CODE_USAGE_STATS_KEY = 'minimax-vscode.claudeCodeUsageStats';

/** memento key for the per-file byte-offset cursor used by the Claude
 *  Code log ingester. JSON blob — see `src/dashboard/claudeCodeIngest.ts`. */
export const CLAUDE_CODE_INGEST_CURSOR_KEY = 'minimax-vscode.claudeCodeIngestCursor';


// ---- Claude Code log ingest defaults ----

/** Default root directory Claude Code writes JSONL session logs to.
 *  Used when the user has not overridden `minimax.claudeCode.logPath`. */
export const DEFAULT_CLAUDE_CODE_LOG_PATH = '~/.claude/projects';


// ---- Walkthrough ----

/** Walkthrough contribution ID. */
export const WALKTHROUGH_ID = 'minimax-vscode#minimaxGettingStarted';

// ---- Tool call limits ----

/**
 * Conservative ceiling for tool definitions sent in a single chat completion.
 * MiniMax documentation does not publish an exact limit; 128 matches the
 * Anthropic-compatible spec and deepseek-v4-for-copilot defaults.
 */
export const MINIMAX_TOOLS_LIMIT = 128;

// ---- Replay marker ----

/** MIME type used to embed stateful replay markers in chat messages. */
export const REPLAY_MARKER_MIME = 'minimax_marker';

/**
 * MIME type for the per-turn `usage` data part that Copilot Chat uses
 * to populate the context-usage widget in its status bar. The value
 * matches the oai-compatible-copilot upstream and what Copilot Chat
 * expects on the receiving end.
 */
export const COPILOT_USAGE_DATA_PART_MIME = 'usage';
