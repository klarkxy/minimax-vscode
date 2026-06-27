// Registers the official MiniMax Web Search MCP server as a VS Code
// MCP server definition provider.
//
// The extension never spawns the MCP process itself — VS Code's MCP
// runtime (`vscode.lm`) starts `uvx minimax-coding-plan-mcp -y` on
// demand, owns its lifecycle (start / trust dialog / restart /
// show output), and exposes the tools it discovers through the
// Configure Tools picker in Copilot Chat's Agent Mode.
//
// What we do here:
//   1. Add `contributes.mcpServerDefinitionProviders` in package.json
//      with a stable id (`minimax-web-search`) so VS Code can
//      render our provider in the MCP UI.
//   2. Implement `McpServerDefinitionProvider` against that id,
//      returning an `McpStdioServerDefinition` for the MiniMax MCP
//      package. The command / args / version come from the
//      `McpServerDefinition` we hand back; the API key and host are
//      injected as env when VS Code actually resolves the server.
//   3. Resolve the API key from `AuthManager` (SecretStorage) at
//      resolve time. The key never leaves the extension host
//      process except as a child-process environment variable, and
//      we don't surface it in any log line or telemetry.
//   4. Translate `minimax.apiBaseUrl` (the Anthropic-compatible base
//      URL the chat model provider also uses) into the API host the
//      MCP server wants, stripping the `/anthropic` suffix.
//   5. Fire `onDidChangeMcpServerDefinitions` when the API key or the
//      configured host changes, so VS Code re-resolves / restarts
//      the MCP server with the new env.
//
// Scope (intentionally tight, see `.learnings/LEARNINGS.md` and
// the issue tracker):
//
//   * We do NOT install `uvx` or run any remote-install script. If
//     `uvx` isn't on PATH the resolve call returns a definition
//     anyway — VS Code will surface the spawn failure in the MCP
//     output channel, where the user can fix it. The README
//     documents the official install command for both platforms.
//   * We do NOT auto-detect / fall back to the China endpoint when
//     the configured `apiBaseUrl` is a third-party proxy. Unknown
//     hosts yield `host = null` and we refuse to inject a key into
//     the wrong platform — matches the existing credential-leak
//     policy elsewhere in the extension.
//   * We do NOT enumerate / render the tools the MCP server exposes.
//     The official MCP package may add or remove tools at any time
//     (the Web Search MCP guide currently lists `web_search` only
//     on the international site); the authoritative list lives in
//     Copilot Chat's Configure Tools picker, not in our UI.

import * as vscode from 'vscode';
import {
	PLATFORM_HOST_CHINA,
	PLATFORM_HOST_GLOBAL,
	resolvePlatformHost,
} from '../consts';
import { getApiHostForPlatform, getBaseUrl } from '../config';
import { t } from '../i18n';
import { logger } from '../logger';
import type { AuthManager } from '../auth';

/** Resolver the MCP provider consults at every VS Code-driven
 *  `provideMcpServerDefinitions` / `resolveMcpServerDefinition` call
 *  to decide which `apiBaseUrl` the server definition should inject
 *  as `MINIMAX_API_HOST`. Defaults to the deprecated
 *  `minimax.apiBaseUrl` setting for backward compatibility, but
 *  production code MUST pass the active-key resolver so the MCP
 *  server definition follows the same `getActiveApiBaseUrl()` path
 *  the chat model provider uses — otherwise switching the active
 *  key would split-brain the chat request host from the MCP spawn
 *  env. The resolver is called once per definition / resolve, not
 *  cached, so live `minimax.apiKey` and `KeyManager` changes
 *  propagate without a manual refresh. */
export type McpApiBaseUrlResolver = () => Promise<string> | string;

/** Stable id matched by `contributes.mcpServerDefinitionProviders`
 *  in package.json. Changing this is a breaking config change. */
export const MCP_PROVIDER_ID = 'minimax-web-search';

/** Human-readable label shown in the MCP UI. */
export const MCP_PROVIDER_LABEL = 'MiniMax Web Search MCP';

/** The official MCP package. Pinned in args (no host/path), so a
 *  `uvx` install on PATH picks the latest stable release. */
const MCP_PACKAGE = 'minimax-coding-plan-mcp';
/** Arguments passed to `uvx`. Modern `uvx` (`uv tool run`) installs
 *  and runs the package without prompting by default, so we do not
 *  pass `-y`; older / alternate `uvx` implementations may reject
 *  `-y` as an unknown flag (see issue #3). Exported because the
 *  dashboard aggregator mirrors the same args into its status
 *  snapshot. */
export const MCP_PACKAGE_ARGS = [MCP_PACKAGE];

/** Bump this whenever we change the args, command, or env shape so
 *  VS Code invalidates its cached tool list. */
const MCP_PROVIDER_VERSION = '1';

/** Short tag added to the resolve-failure log so we can grep the
 *  logs channel when triaging user reports. */
const LOG_TAG = '[MiniMax MCP]';

/**
 * Resolved MiniMax MCP server definition, including the env that VS
 * Code should hand to the child process. Pure data; no VS Code API
 * held inside, which makes it trivial to unit-test.
 */
export interface MiniMaxMcpDefinition extends vscode.McpStdioServerDefinition {
	/** Resolved MiniMax API host URL, or `null` if the configured
	 *  `apiBaseUrl` doesn't map to a known platform. */
	readonly host: string | null;
	/** `true` when the host came from the user's configured
	 *  `minimax.apiBaseUrl` (i.e. they did NOT pick China or Global
	 *  explicitly). Used by the dashboard to surface a warning. */
	readonly hostFromProxy: boolean;
}

/**
 * Handle returned by `registerMiniMaxMcpProvider`. The handle is a
 * `Disposable` (so `context.subscriptions.push(handle)` tears the
 * provider down on deactivation) plus one imperative method,
 * `refreshDefinitions()`, that fires the underlying
 * `onDidChangeMcpServerDefinitions` event so VS Code re-resolves
 * the provider on the next MCP call.
 *
 * Exposing the fire path is what makes the
 * `MiniMax: Refresh MiniMax Web Search MCP` command (and the
 * dashboard's "Refresh" button) actually do what the README / CHANGELOG
 * promise — fire the change signal so the next Agent Mode call sees
 * the fresh env, rather than just confirming that a resolve call
 * would succeed.
 */
export interface MiniMaxMcpHandle extends vscode.Disposable {
	/**
	 * Fire `onDidChangeMcpServerDefinitions` so VS Code re-resolves
	 * the provider on the next MCP call. Safe to call multiple times;
	 * no-op after `dispose()`. Does NOT mutate the API key or
	 * `minimax.apiBaseUrl` — it just signals VS Code that the
	 * current definitions should be considered stale.
	 */
	refreshDefinitions(): void;
	/**
	 * `true` when the provider has been registered with VS Code
	 * via `vscode.lm.registerMcpServerDefinitionProvider` and has
	 * not yet been disposed. Distinguishes "provider is live, but
	 * the current config makes the definition not ready" (key
	 * missing / unrecognised host) from "the extension hasn't
	 * wired up the provider at all" — the dashboard's "Registered"
	 * badge should reflect this signal rather than the resolve
	 * outcome.
	 */
	isRegistered(): boolean;
}

/**
 * Outcome of resolving an MCP server definition. Exposed for tests
 * and the dashboard.
 */
export interface MiniMaxMcpResolution {
	/** `true` when the env can be safely injected into the child
	 *  process. When `false`, `reason` is one of the `mcp.resolveError.*`
	 *  i18n keys. */
	readonly ready: boolean;
	/** Human-readable reason in the user's display language. */
	readonly reason: string;
	/** Set when `ready === true`. */
	readonly definition?: MiniMaxMcpDefinition;
}

/**
 * Pick the API host URL the MCP server should hit, based on the
 * user's configured `minimax.apiBaseUrl`. Returns `null` for
 * unrecognised hosts so the caller refuses to inject a credential
 * rather than silently routing it to a default platform.
 *
 * The MCP package expects a bare `https://api.…` host (no path,
 * no `/anthropic` suffix). The chat model provider uses
 * `…/anthropic` because the Anthropic SDK appends `/v1/messages`;
 * the MCP package builds its own request URL, so we strip the
 * suffix here.
 */
export function pickMcpApiHost(apiBaseUrl: string): {
	host: string | null;
	fromProxy: boolean;
} {
	const platformHost = resolvePlatformHost(apiBaseUrl);
	if (platformHost === PLATFORM_HOST_GLOBAL) {
		return { host: `https://${PLATFORM_HOST_GLOBAL}`, fromProxy: false };
	}
	if (platformHost === PLATFORM_HOST_CHINA) {
		return { host: `https://${PLATFORM_HOST_CHINA}`, fromProxy: false };
	}
	// Unrecognised host — could be a third-party Anthropic-compatible
	// proxy. We do NOT default to China; the user must explicitly
	// configure the MCP host themselves (not yet exposed as a
	// setting — see `.learnings/LEARNINGS.md` LRN-20260611-005).
	return { host: null, fromProxy: true };
}

/**
 * Build a `McpStdioServerDefinition` that VS Code can spawn. The
 * returned object is meant to be `resolveMcpServerDefinition`'s
 * output — VS Code will then start `command` with `args` and the
 * `env` we inject.
 *
 * The default command is `uvx` (matches the official MiniMax docs
 * and is what every MiniMax client installs). It can be overridden
 * by tests / future settings via the `command` parameter.
 */
export function buildMiniMaxMcpDefinition(options: {
	host: string;
	apiKey: string;
	command?: string;
}): MiniMaxMcpDefinition {
	const env: Record<string, string> = {
		MINIMAX_API_KEY: options.apiKey,
		MINIMAX_API_HOST: options.host,
	};
	const definition = new vscode.McpStdioServerDefinition(
		MCP_PROVIDER_LABEL,
		options.command ?? 'uvx',
		MCP_PACKAGE_ARGS,
		env,
		MCP_PROVIDER_VERSION,
	);
	return Object.assign(definition, {
		host: options.host,
		hostFromProxy: false,
	}) as MiniMaxMcpDefinition;
}

/**
 * Default `provideMcpServerDefinitions` body. Returns a single
 * definition whenever the user has an API key AND the configured
 * base URL maps to a known MiniMax platform. Returns an empty array
 * otherwise so VS Code hides the server from the MCP UI rather than
 * surfacing a "will always fail" entry — the dashboard surfaces
 * the actual reason (`reasonKey`) under a different surface.
 *
 * Splitting this from the provider object lets the dashboard and
 * the tests reuse the same policy without instantiating a VS Code
 * provider.
 */
export async function provideMiniMaxMcpServers(
	auth: AuthManager,
	apiBaseUrl: string,
): Promise<MiniMaxMcpResolution> {
	const apiKey = await auth.getApiKey();
	if (!apiKey || apiKey.trim().length === 0) {
		return { ready: false, reason: t('mcp.resolveError.missingKey') };
	}
	const { host, fromProxy } = pickMcpApiHost(apiBaseUrl);
	if (host === null) {
		return {
			ready: false,
			reason: fromProxy
				? t('mcp.resolveError.unsupportedHost')
				: t('mcp.resolveError.unknownHost'),
		};
	}
	const definition = buildMiniMaxMcpDefinition({ host, apiKey });
	return { ready: true, reason: '', definition };
}

/**
 * Register the MCP server definition provider with VS Code. Returns
 * a `MiniMaxMcpHandle` that tears down the provider, the change
 * emitter, and the configuration / auth subscriptions on dispose —
 * and exposes `refreshDefinitions()` so the manual "Refresh MCP"
 * command (and the dashboard's "Refresh" button) can fire the
 * `onDidChangeMcpServerDefinitions` event VS Code watches for.
 *
 * The `getApiBaseUrl` resolver decides which URL the server
 * definition picks up at every `provide` / `resolve` call. Callers
 * should pass `() => keyManager.getActiveApiBaseUrl()` so the MCP
 * spawn env matches the chat request host; if omitted, the
 * provider falls back to the deprecated `minimax.apiBaseUrl`
 * setting (kept for tests and the historical single-key path).
 *
 * Call this from `activate()` after `AuthManager` is initialised.
 */
export function registerMiniMaxMcpProvider(
	context: vscode.ExtensionContext,
	auth: AuthManager,
	opts: { getApiBaseUrl?: McpApiBaseUrlResolver } = {},
): MiniMaxMcpHandle {
	const disposables: vscode.Disposable[] = [];
	// Snapshot the resolver at registration time so the
	// `provideMcpServerDefinitions` / `resolveMcpServerDefinition`
	// callbacks read whatever was current at `activate()`. The
	// AuthManager's `onDidChangeApiKey` subscription (which
	// re-fires on every KeyManager change) takes care of the
	// re-resolve path — VS Code re-asks the provider after the
	// change event fires, and the resolver picks up the new URL.
	const resolveApiBaseUrl: McpApiBaseUrlResolver = opts.getApiBaseUrl ?? (() => getBaseUrl());

	// `onDidChangeMcpServerDefinitions` is the signal VS Code uses
	// to invalidate its cached tool list and re-call
	// `provideMcpServerDefinitions`. We fire it whenever the
	// credentials or the configured endpoint might have changed.
	const changeEmitter = new vscode.EventEmitter<void>();
	disposables.push(changeEmitter);

	const provider: vscode.McpServerDefinitionProvider = {
		onDidChangeMcpServerDefinitions: changeEmitter.event,
		async provideMcpServerDefinitions(token) {
			void token;
			// Resolve on every call so cross-window edits to the
			// active key (via `secrets.onDidChange`) and direct
			// `KeyManager` writes both land on the next MCP call
			// without needing a manual `refreshMcp` invocation.
			const apiBaseUrl = await resolveApiBaseUrl();
			const resolution = await provideMiniMaxMcpServers(auth, apiBaseUrl);
			if (!resolution.ready || !resolution.definition) {
				// Don't surface the server until it's ready. VS Code
				// hides the entry from MCP: List Servers when the
				// array is empty; the dashboard renders the reason
				// separately.
				return [];
			}
			return [resolution.definition];
		},
		async resolveMcpServerDefinition(server, token) {
			void token;
			// Re-resolve so the env (especially the API key + the
			// active key's URL) is always fresh at spawn time —
			// VS Code may keep the previous definition cached
			// between sessions.
			const apiBaseUrl = await resolveApiBaseUrl();
			const resolution = await provideMiniMaxMcpServers(auth, apiBaseUrl);
			if (!resolution.ready || !resolution.definition) {
				logger.warn(
					`${LOG_TAG} refusing to start MCP server: ${resolution.reason}`,
				);
				throw new Error(resolution.reason);
			}
			return resolution.definition;
		},
	};

	disposables.push(
		vscode.lm.registerMcpServerDefinitionProvider(MCP_PROVIDER_ID, provider),
	);

	// API key changed (set / cleared / replaced, OR the active key
	// in the pool was switched) → re-emit so VS Code re-resolves
	// with the new key + URL. `AuthManager.onDidChangeApiKey` is
	// driven by `KeyManager.onDidChange`, so any pool mutation
	// (add / switch / rename / delete) lands here.
	disposables.push(
		auth.onDidChangeApiKey(() => {
			logger.info(`${LOG_TAG} API key changed; firing onDidChangeMcpServerDefinitions`);
			changeEmitter.fire();
		}),
	);

	// `minimax.apiBaseUrl` changed (China ↔ Global switch, or the
	// user moved to a third-party proxy) → re-emit so the host env
	// is refreshed. Note: the active-key resolver does NOT
	// consult this setting for keys with a non-empty
	// `apiBaseUrl`; this listener covers the legacy migration
	// window where the pool's active entry has an empty URL and
	// the setting is the actual source of truth.
	disposables.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('minimax.apiBaseUrl')) {
				logger.info(
					`${LOG_TAG} apiBaseUrl changed (host=${getApiHostForPlatform()}); firing onDidChangeMcpServerDefinitions`,
				);
				changeEmitter.fire();
			}
		}),
	);

	// `refreshDefinitions` is the imperative escape hatch the manual
	// refresh command and the dashboard's "Refresh" button both
	// rely on. The implicit signal is the same one the auth / config
	// listeners above fire, so the user-visible behaviour matches
	// what `minimax.onDidChangeApiKey` and `minimax.apiBaseUrl` edits
	// already trigger — VS Code simply re-asks for the definitions
	// and re-resolves them on the next MCP call.
	let disposed = false;
	const handle: MiniMaxMcpHandle = {
		refreshDefinitions(): void {
			if (disposed) return;
			logger.info(`${LOG_TAG} manual refreshDefinitions() invoked`);
			changeEmitter.fire();
		},
		isRegistered(): boolean {
			return !disposed;
		},
		dispose(): void {
			if (disposed) return;
			disposed = true;
			while (disposables.length > 0) {
				const d = disposables.pop();
				try {
					d?.dispose();
				} catch (error) {
					logger.warn(`${LOG_TAG} error while disposing provider`, error);
				}
			}
		},
	};
	return handle;
}