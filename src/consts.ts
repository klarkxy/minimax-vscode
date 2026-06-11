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

/**
 * The two API hostnames the user can be talking to. Used to populate
 * the i18n `{1}` placeholder inside the 401/402 toast text — the
 * user-facing summary that says "endpoint (api.minimax.io)" and
 * similar. NOT used to build platform-link URLs; for that see
 * `PLATFORM_URL_GLOBAL` / `PLATFORM_URL_CHINA` below.
 *
 * Kept as a literal-type so call sites that branch on the value get
 * exhaustiveness checks. `DEFAULT_PLATFORM_HOST` is preserved for
 * callers that genuinely need a non-null fallback (none in the
 * production code path; the test helper uses it).
 */
export const PLATFORM_HOST_GLOBAL = 'api.minimax.io' as const;
export const PLATFORM_HOST_CHINA = 'api.minimaxi.com' as const;
export const DEFAULT_PLATFORM_HOST = PLATFORM_HOST_CHINA;

/**
 * The two *platform* (user-facing) hostnames — the ones the user
 * actually visits to buy API keys or check the Token Plan. Note the
 * `platform.` prefix; do NOT confuse with the `api.` prefix used by
 * `PLATFORM_HOST_*` above. The 401/402 "Set API Key" / "Create API
 * Key" action buttons are built from these constants.
 */
export const PLATFORM_URL_GLOBAL = 'https://platform.minimax.io';
export const PLATFORM_URL_CHINA = 'https://platform.minimaxi.com';

/**
 * Type of the values returned by `resolvePlatformHost`. Three-state:
 * the two known API hosts, or `null` for unrecognised / empty
 * inputs. `null` is the signal that the user is on a third-party
 * proxy (or some test fixture) — the caller MUST decide what to do
 * (e.g. `fetchPlanUsage` short-circuits to `'unsupported'`, the
 * 401/402 button gets no platform link).
 */
export type PlatformHost =
	| typeof PLATFORM_HOST_GLOBAL
	| typeof PLATFORM_HOST_CHINA
	| null;

/**
 * Map a MiniMax Anthropic-compatible base URL to its API hostname.
 *
 * Used to populate the i18n `{1}` placeholder inside the 401/402
 * toast text. Unrecognised hosts (self-hosted proxies, empty
 * strings) return `null` so the caller can suppress outbound calls
 * that would otherwise leak the user's proxy credential to a
 * default-on-China endpoint. The previous implementation collapsed
 * unknowns to the China default — that was the credential-leak path
 * surfaced by Codex's adversarial review (see `.learnings/LEARNINGS.md`
 * LRN-20260611-002 follow-up + LRN-20260611-005).
 *
 * Hostname matching is done via `new URL(...).hostname` with strict
 * equality — NOT `String.prototype.includes` on the raw URL. Substring
 * matching on the raw URL is spoofable: `https://api.minimax.io@my-
 * proxy.example.com/v1` contains `api.minimax.io` as userinfo, and
 * `https://api.minimax.io.evil.example/v1` is a different host whose
 * name happens to start with the same prefix. The URL parser treats
 * the `@` as the userinfo delimiter and the `.evil.example` as a
 * distinct TLD, so the strict-equality hostname comparison rejects
 * both cases.
 */
export function resolvePlatformHost(apiBaseUrl: string | undefined | null): PlatformHost {
	if (typeof apiBaseUrl !== 'string' || apiBaseUrl.length === 0) {
		return null;
	}
	let hostname: string;
	try {
		hostname = new URL(apiBaseUrl).hostname.toLowerCase();
	} catch {
		// Malformed URLs (e.g. `not-a-url`, `://broken`) are unsupported.
		return null;
	}
	if (hostname === PLATFORM_HOST_GLOBAL) {
		return PLATFORM_HOST_GLOBAL;
	}
	if (hostname === PLATFORM_HOST_CHINA) {
		return PLATFORM_HOST_CHINA;
	}
	return null;
}

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
