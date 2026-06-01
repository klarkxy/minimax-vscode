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
