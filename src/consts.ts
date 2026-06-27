/**
 * Compile-time constants shared across the extension.
 *
 * These do NOT depend on the VS Code runtime (no workspace configuration,
 * no secrets API). For run-time settings reads see `config.ts`.
 */

/**
 * Single source of truth for "is the user's locale Chinese?". The
 * previous setup had three independent rules in `i18n.ts`,
 * `models/registry.ts`, and `dashboard/messages.ts` that disagreed
 * about edge cases like `zh-hant` / `zh-hans-cn` — the i18n
 * dictionary would pick English while the pricing layer picked CNY
 * and the dashboard webview picked Chinese. This helper is the
 * authoritative predicate; every locale-dependent call site should
 * import it. Accepts any BCP-47 / POSIX tag (`zh`, `zh-cn`,
 * `zh-hant-hk`, `zh_hans_CN`, …) and is case-insensitive.
 */
export function isChineseLocale(language?: string): boolean {
	if (!language) {
		return false;
	}
	const lower = language.toLowerCase();
	return lower === 'zh' || lower.startsWith('zh-') || lower.startsWith('zh_');
}

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

/**
 * Map a MiniMax Anthropic-compatible base URL to the user-facing
 * platform URL (`https://platform.minimax.io` for international,
 * `https://platform.minimaxi.com` for China). The 401/402
 * "Set API Key" / "Create API Key" action buttons and the
 * `auth.prompt` / `pricing.note` i18n strings both render this URL
 * for the user, so getting the endpoint wrong here ships the user
 * off to a platform they don't have an account on.
 *
 * Returns `null` for unrecognised hosts / malformed URLs — callers
 * MUST handle the `null` case (e.g. fall back to a generic prompt
 * that doesn't claim a specific platform, or skip the action button
 * entirely). Uses the same hardened URL parser as `resolvePlatformHost`,
 * so spoofing vectors (userinfo `https://api.minimax.io@evil.com`,
 * suffix `https://api.minimax.io.evil.example`, path
 * `https://proxy.example/api.minimax.io/v1`) all return `null` —
 * see `resolvePlatformHost` for the rationale.
 */
export function resolvePlatformUrl(apiBaseUrl: string | undefined | null): string | null {
	const host = resolvePlatformHost(apiBaseUrl);
	if (host === PLATFORM_HOST_CHINA) return PLATFORM_URL_CHINA;
	if (host === PLATFORM_HOST_GLOBAL) return PLATFORM_URL_GLOBAL;
	return null;
}

/**
 * Resolve a base URL to a user-facing string suitable for embedding
 * in a prompt or note. The mapping is:
 *
 * - `api.minimax.io` → `https://platform.minimax.io` (international)
 * - `api.minimaxi.com` → `https://platform.minimaxi.com` (China)
 * - anything else → the raw `apiBaseUrl` (third-party proxies, etc.)
 *
 * Unrecognised hosts return the raw URL so the user sees exactly
 * what they configured — better than showing them a wrong platform
 * link.
 *
 * Used by `auth.prompt` (the API-key input box prompt) and
 * `pricing.note` (the Show Pricing doc footer) — both of which used
 * to hard-code one of the two platform hosts regardless of the
 * user's actual endpoint, sending the wrong-half user to a platform
 * they don't have an account on.
 */
export function displayPlatformUrl(apiBaseUrl: string | undefined | null): string {
	return resolvePlatformUrl(apiBaseUrl) ?? apiBaseUrl ?? '';
}

/**
 * Resolve the official pricing docs URL for a given base URL — the
 * `https://platform.<host>/docs/guides/pricing-paygo` page the
 * `pricing.note` string links to. Returns `null` for unrecognised
 * hosts; the caller can fall back to `displayPlatformUrl(apiBaseUrl)`
 * to show the user's configured URL verbatim.
 */
export function resolvePricingDocsUrl(apiBaseUrl: string | undefined | null): string | null {
	const platformUrl = resolvePlatformUrl(apiBaseUrl);
	return platformUrl ? `${platformUrl}/docs/guides/pricing-paygo` : null;
}

/** Legacy: kept for backward compatibility with deepseek-style debugMode. */
export const LANGUAGE_MODEL_CHAT_SYSTEM_ROLE = 3;

// ---- Secret keys ----

/** SecretStorage key for the MiniMax API key (legacy single-key slot). */
export const API_KEY_SECRET = 'minimax-vscode.apiKey';

/** SecretStorage key prefix for the named key pool. The full key is
 *  `minimax-vscode.apiKeys.<keyId>`; the extension stores the raw API
 *  key here and keeps the matching metadata (name, region, etc.) in
 *  the `API_KEYS_METADATA_KEY` memento. The legacy `API_KEY_SECRET`
 *  is preserved as a fallback for users who upgrade without
 *  re-running the `Add API Key` flow. */
export const API_KEY_SECRET_PREFIX = 'minimax-vscode.apiKeys.';

/** memento key for the named key pool metadata. Stored as JSON:
 *  `{ activeKeyId?: string; keys: KeyMetadata[] }`. No secrets
 *  live here — only display name, region, endpoint, fingerprint,
 *  timestamps. */
export const API_KEYS_METADATA_KEY = 'minimax-vscode.apiKeys';

/** Special keyId for the legacy single-key slot. The legacy key is
 *  read-only here; it surfaces in the dashboard as a "Default" entry
 *  and remains functional until the user explicitly adds a new key
 *  through the manager. */
export const LEGACY_KEY_ID = '__legacy__';

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

/** Symbolic region labels for a named API key. The host actually
 *  used for requests comes from `KeyMetadata.apiBaseUrl`; the
 *  `region` is a display hint that drives the auto-select flow and
 *  the platform URL shown in toasts. `custom` means the user picked
 *  a non-official `apiBaseUrl` and dashboard quota lookup should be
 *  suppressed (matches the existing `host === null` rule). */
export type KeyRegion = 'china' | 'global' | 'custom';

/** Public metadata for a single named API key. Secrets live in
 *  SecretStorage; only this metadata is persisted to `globalState`. */
export interface KeyMetadata {
	/** Stable identifier; matches the SecretStorage suffix. */
	id: string;
	/** User-visible name; unique within the pool. */
	name: string;
	/** Display hint; defaults to the resolved host. */
	region: KeyRegion;
	/** The endpoint this key was bound to when added. Switching the
	 *  active key updates `minimax.apiBaseUrl` to this value. */
	apiBaseUrl: string;
	/** Last 6 chars of the secret, plus a per-key sha256 prefix.
	 *  NEVER use as a credential — only for UI display and to keep
	 *  PlanCache keys stable across renames. */
	fingerprint: string;
	createdAt: string;
	updatedAt: string;
	lastUsedAt?: string;
}

/** On-disk shape of the named key pool metadata. Persisted under
 *  `API_KEYS_METADATA_KEY`. */
export interface KeyPoolMetadata {
	activeKeyId?: string;
	keys: KeyMetadata[];
}

/** memento key for per-API-key Copilot usage. Stored as JSON
 *  (`Record<keyId, UsageStats>`) so the dashboard can switch the
 *  Copilot usage scope by key name (`copilot-1`, `copilot-2`, …).
 *  Replaces the previous single `USAGE_STATS_KEY` schema; legacy
 *  data is migrated into the `__legacy__` scope on first read. */
export const USAGE_STATS_BY_KEY_KEY = 'minimax-vscode.usageStatsByKey';

/** MIME type for the per-turn `usage` data part that Copilot Chat uses
 *  to populate the context-usage widget in its status bar. The value
 *  matches the oai-compatible-copilot upstream and what Copilot Chat
 *  expects on the receiving end. */
export const COPILOT_USAGE_DATA_PART_MIME = 'usage';

/**
 * Debug-mode request-dump retention knobs. The verbose dump mode writes
 * full request payloads to disk under `<globalStorage>/request-dumps/`.
 * Without bounds this grows without limit under heavy use, so we cap
 * concurrency (memory ceiling on the in-process write queue) and disk
 * usage (per-segment directory count + observations-file size).
 */
export const REQUEST_DUMP_MAX_CONCURRENT_WRITES = 3;
/** Maximum number of `<segmentId>/` directories retained under
 *  `request-dumps/`. Older segments are pruned FIFO when exceeded. */
export const REQUEST_DUMP_MAX_SEGMENT_DIRS = 50;
/** Maximum size of the `_request-observations.jsonl` rollover file before
 *  it is rotated. */
export const REQUEST_DUMP_OBSERVATIONS_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Claude Code JSONL ingester knobs. The polling reader walks the
 * `~/.claude/projects/` directory recursively; without per-tick size
 * caps a chatty session can produce a single file that grows to
 * hundreds of MB between polls and would be slurped into a single
 * string.
 */
export const CLAUDE_CODE_INGEST_MAX_READ_BYTES = 10 * 1024 * 1024;
/** Maximum recursion depth when walking the JSONL log directory. Caps the
 *  blast radius of symlink cycles / pathological nesting. */
export const CLAUDE_CODE_INGEST_MAX_DISCOVERY_DEPTH = 4;
