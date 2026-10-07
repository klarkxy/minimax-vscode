import * as vscode from 'vscode';
import { AuthManager } from '../auth';
import { t } from '../i18n';
import { logger } from '../logger';
import {
	getClaudeCodeAllowedModels,
	getClaudeCodeLogPath,
} from '../config';
import { toggleM31MContextEnabled } from '../provider/models';
import { provideMiniMaxMcpServers, type MiniMaxMcpHandle } from './mcp';
import { getBaseUrl } from '../config';
import { resolvePlatformHost } from '../consts';
import { createUsageStore, type UsageStore } from '../usage';
import { DashboardPanel } from '../dashboard/panel';
import { createPlanStatusBar, type PlanStatusBar } from '../dashboard/planStatusBar';
import { createPlanCache, type PlanCache } from '../dashboard/aggregator';
import { createMmxCliCache, type MmxCliCache } from '../dashboard/mmxCliCache';
import { copyMmxInstallPrompt } from '../dashboard/mmxCli';
import type { ChatTurnNotifier } from '../dashboard/chatTurnNotifier';
import { createClaudeCodeIngest, type ClaudeCodeIngestHandle } from '../dashboard/claudeCodeIngest';
import { createTokenPlanPoller, type TokenPlanPollerHandle } from '../dashboard/tokenPlanPoller';
import { API_KEY_SECRET_PREFIX } from '../consts';
import { KeyManager } from '../keyManager';
import {
	addApiKeyCommand,
	deleteApiKeyCommand,
	manageApiKeysCommand,
	renameApiKeyCommand,
	switchApiKeyCommand,
} from './keyCommands';

let cachedContext: vscode.ExtensionContext | undefined;
let cachedKeyManager: KeyManager | undefined;
let cachedAuth: AuthManager | undefined;
let cachedUsage: UsageStore | undefined;
let cachedPlanCache: PlanCache | undefined;
let cachedMmxCliCache: MmxCliCache | undefined;
let cachedPlanStatusBar: PlanStatusBar | undefined;
let cachedClaudeCodeIngest: ClaudeCodeIngestHandle | undefined;
let cachedMcpProvider: MiniMaxMcpHandle | undefined;
let cachedTokenPlanPoller: TokenPlanPollerHandle | undefined;
let turnNotifierDisposable: vscode.Disposable | undefined;

/** Read the shared `KeyManager` instance. Created lazily on first
 *  call (or on `setCommandContext` if the context is already known)
 *  so modules that need a snapshot before activation still get one
 *  via the fallback `KeyManager(context)` constructor. */
export function getKeyManager(): KeyManager {
	if (!cachedKeyManager) {
		if (!cachedContext) {
			throw new Error('KeyManager accessed before setCommandContext');
		}
		cachedKeyManager = new KeyManager(cachedContext);
	}
	return cachedKeyManager;
}

function getPlanCache(): PlanCache {
	if (!cachedPlanCache) {
		cachedPlanCache = createPlanCache();
	}
	return cachedPlanCache;
}

function getMmxCliCache(): MmxCliCache {
	if (!cachedMmxCliCache) {
		cachedMmxCliCache = createMmxCliCache({
			globalState: cachedContext?.globalState,
		});
	}
	return cachedMmxCliCache;
}

/**
 * Read the shared `AuthManager` instance used by every other runtime
 * module. Returns `undefined` only if `setCommandContext` has not yet
 * run (i.e. very early activation). Exported so `lifecycle.ts` can
 * hand it to the MCP provider and any other module that needs to
 * resolve secrets without instantiating a second SecretStorage client.
 */
export function getAuthManager(): AuthManager | undefined {
	return cachedAuth;
}

/**
 * Read the cached MCP provider handle so the dashboard can ask
 * whether the provider is currently registered with VS Code.
 * Returns `undefined` only if `setMcpProvider` has not run yet
 * (i.e. very early activation or the `getAuthManager()` short
 * circuit fired). Mirrors `getAuthManager()`.
 */
export function getMcpProvider(): MiniMaxMcpHandle | undefined {
	return cachedMcpProvider;
}

export function setCommandContext(context: vscode.ExtensionContext): void {
	cachedContext = context;
	cachedKeyManager = new KeyManager(context);
	cachedAuth = new AuthManager(context, cachedKeyManager);
	cachedUsage = createUsageStore(context.globalState, { keyManager: cachedKeyManager });
	if (!cachedPlanStatusBar) {
		cachedPlanStatusBar = createPlanStatusBar({
			cache: getPlanCache(),
			getActiveKeyLabel: () => {
				try {
					const km = getKeyManager();
					const snap = km.snapshot();
					if (!snap.activeKeyId) return undefined;
					return snap.keys.find((k) => k.id === snap.activeKeyId)?.name;
				} catch {
					return undefined;
				}
			},
			getKeyPool: () => {
				try {
					const km = getKeyManager();
					const snap = km.snapshot();
					return snap.keys.map((k) => ({
						id: k.id,
						name: k.name,
						region: k.region,
						fingerprint: k.fingerprint,
						isActive: k.id === snap.activeKeyId,
					}));
				} catch {
					return undefined;
				}
			},
		});
		context.subscriptions.push(cachedPlanStatusBar);
		// Re-render the active-key label and pool summary whenever
		// the key pool changes (add / rename / switch / delete).
		context.subscriptions.push(getKeyManager().onDidChange(() => {
			cachedPlanStatusBar?.refreshKeyLabel();
		}));
		// Kick the initial key-state read so the placeholder shows the
		// right thing before the user has interacted with the extension.
		void refreshPlanKeyState().catch((error) => {
			logger.warn('Initial plan key-state refresh failed', error);
		});
		// Whenever the user sets / clears the API key, re-mirror the
		// state into the status bar and (re)warm the shared plan cache.
		context.subscriptions.push(cachedAuth.onDidChangeApiKey(() => {
			void refreshPlanKeyState().catch((error) => {
				logger.warn('Plan key-state refresh after API-key change failed', error);
			});
		}));
		// The user can also flip apiBaseUrl at runtime via the
		// switchToGlobal / switchToChina commands; those update the
		// config but not the auth state, so subscribe to config changes
		// to detect host switches and re-pulse the cache.
		context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('minimax.apiBaseUrl')) {
				void pulsePlanCache();
			}
		}));
		// Config changes to apiBaseUrl can affect every key's host
		// resolution; trigger a non-force refresh so the poller picks
		// up the new host on the next cycle.
		context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('minimax.apiBaseUrl')) {
				void cachedTokenPlanPoller?.refresh();
			}
		}));
	}
	// Start (or re-start) the background Token Plan poller. This
	// runs OUTSIDE the status-bar guard so that each call to
	// `setCommandContext` (e.g. from a second test or a multi-window
	// scenario) disposes the previous poller and creates a fresh one.
	// Without this, the first test's poller timer would keep the Node
	// event loop alive after the test runner tears down, causing a
	// 30-second hang at file-level cleanup.
	cachedTokenPlanPoller?.dispose();
	cachedTokenPlanPoller = createTokenPlanPoller({
		planCache: getPlanCache(),
		keyManager: cachedKeyManager,
		fetchSecret: (keyId) =>
			Promise.resolve(
				context.secrets.get(`${API_KEY_SECRET_PREFIX}${keyId}`),
			).catch(() => undefined),
	});
	context.subscriptions.push({
		dispose: () => {
			cachedTokenPlanPoller?.dispose();
			cachedTokenPlanPoller = undefined;
		},
	});
}

/**
 * Start the background poller that ingests Claude Code JSONL session
 * logs into a sibling Memento-backed store. Idempotent — re-calling
 * has no effect. The handle is cached so command handlers and the
 * dashboard panel can subscribe to it.
 *
 * A configuration change to any of the three Claude Code settings
 * tears down the handle and rebuilds it on the next call so the new
 * path / interval / on-off state takes effect.
 */
export function setClaudeCodeIngest(context: vscode.ExtensionContext): void {
	if (cachedClaudeCodeIngest) return;
	cachedClaudeCodeIngest = createClaudeCodeIngest({
		globalState: context.globalState,
		logPath: getClaudeCodeLogPath(),
		allowedModels: getClaudeCodeAllowedModels(),
	}).start();
	context.subscriptions.push({
		dispose: () => {
			cachedClaudeCodeIngest?.dispose();
			cachedClaudeCodeIngest = undefined;
		},
	});
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (
				e.affectsConfiguration('minimax.dashboard.includeClaudeCode') ||
				e.affectsConfiguration('minimax.claudeCode.logPath') ||
				e.affectsConfiguration('minimax.claudeCode.pollIntervalMs') ||
				e.affectsConfiguration('minimax.claudeCode.allowedModels')
			) {
				cachedClaudeCodeIngest?.dispose();
				cachedClaudeCodeIngest = undefined;
				setClaudeCodeIngest(context);
			}
		}),
	);
}

/** Return the cached MCP provider handle, if one is running. */
export function getClaudeCodeIngest(): ClaudeCodeIngestHandle | undefined {
	return cachedClaudeCodeIngest;
}

/**
 * Read the shared TokenPlanPoller handle. Created lazily on the first
 * call to `setCommandContext` so that callers (dashboard panel,
 * `pulsePlanCache`) can force a multi-key refresh even before the
 * periodic timer fires. Returns `undefined` only if
 * `setCommandContext` has not yet run.
 */
export function getTokenPlanPoller(): TokenPlanPollerHandle | undefined {
	return cachedTokenPlanPoller;
}

/**
 * Dispose the cached Token Plan poller and clear the module-level
 * reference. Exported so test teardown can kill the `setInterval`
 * timer that would otherwise keep the Node event loop alive after
 * the test runner tears down. Idempotent — safe to call when no
 * poller exists.
 */
export function disposeTokenPlanPoller(): void {
	cachedTokenPlanPoller?.dispose();
	cachedTokenPlanPoller = undefined;
}

/**
 * Cache the MCP provider handle returned by
 * `registerMiniMaxMcpProvider` so the `MiniMax: Refresh MiniMax Web
 * Search MCP` command (and the dashboard's "Refresh" button, which
 * executes the same command) can fire
 * `onDidChangeMcpServerDefinitions` and prompt VS Code to re-resolve
 * on the next MCP call.
 *
 * Lifecycle is owned by `lifecycle.ts`: the handle is created on
 * `activate()` and pushed into `context.subscriptions`, so the
 * cache here is a read-only alias — disposing the handle disposes
 * the underlying provider and `refreshDefinitions()` becomes a
 * safe no-op (see the `disposed` guard in
 * `registerMiniMaxMcpProvider`).
 */
export function setMcpProvider(handle: MiniMaxMcpHandle): void {
	cachedMcpProvider = handle;
}

/**
 * Wire the provider's turn-boundary notifier to the plan cache. Called
 * by lifecycle.ts once `registerProvider()` returns. We intentionally
 * don't listen to `UsageStore.subscribe` here — a single Copilot turn
 * fans out to many internal API requests, so per-request events would
 * pulse the plan cache 10+ times per turn. Turn-end is the canonical
 * "we just spent tokens" signal; the notifier itself throttles to
 * one broadcast per `minIntervalMs` window.
 */
export function bindChatTurnNotifier(notifier: ChatTurnNotifier): void {
	turnNotifierDisposable?.dispose();
	turnNotifierDisposable = notifier.onTurnEnd(() => {
		void pulsePlanCache();
	});
}

/**
 * Fire-and-forget plan refresh. With the multi-key poller in
 * place this now refreshes EVERY named key (TTL-respecting)
 * rather than just the active key. The single-key
 * `refreshPlanKeyState` still exists for the dashboard's
 * active-key rendering path.
 */
function pulsePlanCache(): void {
	void cachedTokenPlanPoller?.refresh().catch((error) => {
		logger.warn('Plan cache pulse failed', error);
	});
}

/** Last host we fed into the PlanCache. Used to decide whether the
 *  current pulse is a host change (in which case we MUST NOT
 *  auto-warm the cache with the previously-issued key — see the
 *  [high] finding from Codex's second adversarial review). */
let lastPulsedHost: 'china' | 'global' | null | undefined = undefined;

/**
 * Mirror the current auth state into the plan status bar. Still
 * needed for the status bar's key-state indicator (`set`/`unset`).
 * The actual quota fetch is now driven by the Token Plan poller
 * (`pulsePlanCache`), so this function only invalidates the cache
 * on host changes (credential-leak guard) and does NOT issue a
 * fresh fetch — the poller handles that.
 */
async function refreshPlanKeyState(): Promise<void> {
	if (!cachedAuth || !cachedPlanStatusBar) return;
	const key = await cachedAuth.getApiKey();
	cachedPlanStatusBar.setKeyState(key ? 'set' : 'unset');
	if (!key) {
		lastPulsedHost = undefined;
		getPlanCache().invalidate();
		return;
	}
	const host = detectHost();
	// Host-change guard: when the user switches apiBaseUrl from a
	// proxy to an official host (or vice versa), invalidate the
	// cache so the old identity's snapshot is not served under the
	// new host. The poller's next cycle will fetch fresh data for
	// all keys.
	if (host === null || host !== lastPulsedHost) {
		lastPulsedHost = host;
		getPlanCache().invalidate();
	}
	// No direct fetch here — the poller's 5-minute cycle handles
	// warm-up. For the dashboard's force-refresh case, the panel
	// calls `poller.refresh({ force })` directly.
}

export function registerCommands(context: vscode.ExtensionContext): void {
	setCommandContext(context);
	const auth = cachedAuth ?? new AuthManager(context, getKeyManager());
	context.subscriptions.push(
		vscode.commands.registerCommand('minimax.addApiKey', () => addApiKeyCommand()),
		vscode.commands.registerCommand('minimax.deleteApiKey', () => deleteApiKeyCommand()),
		vscode.commands.registerCommand('minimax.switchApiKey', () => switchApiKeyCommand()),
		vscode.commands.registerCommand('minimax.renameApiKey', () => renameApiKeyCommand()),
		vscode.commands.registerCommand('minimax.manageApiKeys', () => manageApiKeysCommand()),
		vscode.commands.registerCommand('minimax.reprobeApiKey', () => reprobeApiKeyCommand()),
		vscode.commands.registerCommand('minimax.showLogs', () => {
			logger.show();
		}),
		vscode.commands.registerCommand('minimax.openRequestDumpsFolder', () => {
			void openRequestDumpsFolder();
		}),
		vscode.commands.registerCommand('minimax.useForCopilotCommitMessages', () => {
			void useForCopilotCommitMessages();
		}),
		vscode.commands.registerCommand('minimax.toggleM31MContext', () => {
			// Lifts the M3 picker entry from the safe 512K default to
			// the official 1M cap. The command pops a modal warning
			// about the 1.5× billing rate and the need for sales-granted
			// >512K access before flipping on; off is unconditional.
			void toggleM31MContextEnabled();
		}),
		vscode.commands.registerCommand('minimax.openDashboard', () => {
			if (!cachedAuth || !cachedUsage || !cachedContext) {
				void vscode.window.showWarningMessage(t('usage.empty'));
				return;
			}
			DashboardPanel.show({
				extensionUri: cachedContext.extensionUri,
				auth: cachedAuth,
				usageStore: cachedUsage,
				planCache: getPlanCache(),
				mmxCliCache: getMmxCliCache(),
				claudeCodeIngest: cachedClaudeCodeIngest,
				tokenPlanPoller: cachedTokenPlanPoller,
				// Pass the live resolver rather than a one-shot value
				// so the panel reflects the user's `minimax.apiBaseUrl`
				// changes on the next refresh — see `DashboardPanelDeps.
				// getHost` for the credential-leak rationale.
				getHost: detectHost,
				// Same pattern for the MCP provider's registration
				// state. Resolved against the cached handle so the
				// panel can show "registered" only when VS Code
				// actually accepted the provider.
				getMcpProviderRegistered: () => getMcpProvider()?.isRegistered() ?? false,
			});
			// Fire-and-forget: ensure the cache has a fresh snapshot for
			// both the dashboard render and the status bar to consume.
			void refreshPlanKeyState();
		}),
		vscode.commands.registerCommand('minimax.installMmxCli', () => {
			// Detection only — we never install, never log in, never
			// install the SKILL. The only thing this command does
			// is copy the official three-step prompt from the docs
			// to the clipboard, in the language that matches the
			// configured endpoint. The user decides what to do
			// next (paste it into a chat, run the commands in a
			// terminal, etc.).
			void copyMmxInstallPromptForCommand();
		}),
		vscode.commands.registerCommand('minimax.refreshClaudeCodeIngest', () => {
			void cachedClaudeCodeIngest?.refresh().catch((error) => {
				logger.warn('Claude Code ingest refresh failed', error);
			});
		}),
		vscode.commands.registerCommand('minimax.openClaudeCodeLogFolder', () => {
			void openClaudeCodeLogFolder();
		}),
		vscode.commands.registerCommand('minimax.refreshMcp', () => {
			// The MCP provider exposes a manual "refresh now" button
			// in the dashboard. The actual work is firing
			// `onDidChangeMcpServerDefinitions` on the cached handle
			// so VS Code re-asks for the definitions and re-resolves
			// them on the next MCP call — that's what the README
			// and CHANGELOG promise the user this command does.
			//
			// We still do a `provideMiniMaxMcpServers()` pass FIRST
			// to fail fast: if the key is missing or the host is
			// unrecognised, the user gets an immediate warning
			// instead of a generic "refreshed" toast followed by
			// a no-op re-resolve in VS Code.
			void (async () => {
				try {
					if (!cachedMcpProvider) {
						void vscode.window.showWarningMessage(t('mcp.providerNotRegistered'));
						logger.warn(
							'[MiniMax MCP] refreshMcp invoked but the provider is not registered (lifecycle error?)',
						);
						return;
					}
					// Prefer the active key's `apiBaseUrl` so the MCP server definition
				// matches the chat request path. Falls back to the
				// deprecated `minimax.apiBaseUrl` setting when the pool
				// is empty (legacy migration in flight).
				const km = getKeyManager();
				const active = km?.snapshot();
				const activeEntry = active?.keys.find((k) => k.id === active.activeKeyId);
				const baseUrl = activeEntry?.apiBaseUrl?.trim() || getBaseUrl();
					const { ready, reason, definition } = await provideMiniMaxMcpServers(
						cachedAuth ?? auth,
						baseUrl,
					);
					if (!ready) {
						void vscode.window.showWarningMessage(reason);
						return;
					}
					cachedMcpProvider.refreshDefinitions();
					void vscode.window.showInformationMessage(t('mcp.refreshed'));
					logger.info(
						`[MiniMax MCP] manual refresh: host=${definition?.host ?? '?'} command=${definition?.command ?? 'uvx'}`,
					);
				} catch (error) {
					logger.warn('[MiniMax MCP] refreshMcp failed', error);
					void vscode.window.showWarningMessage(t('mcp.refreshFailed'));
				}
			})();
		}),
	);
}

/**
 * Command-palette entry for `MiniMax: Install mmx-cli`. Just copies
 * the official three-step prompt from the docs to the clipboard, in
 * the language matching the configured endpoint (`china` → 简体中文,
 * otherwise → English). The user is fully in control of what to do
 * with the prompt next.
 */
async function copyMmxInstallPromptForCommand(): Promise<void> {
	// Third-party-proxy users get the international prompt by default;
	// the install-prompt language is not security-sensitive, so we
	// simply pick the most common case when `detectHost()` returns
	// `null`.
	const result = await copyMmxInstallPrompt(detectHost() ?? 'global');
	if (!result.copied) {
		vscode.window.showErrorMessage(t('mmx.copyFailed'));
		return;
	}
	vscode.window.showInformationMessage(t('mmx.promptCopied'));
}

/**
 * Two-stage picker for routing Copilot Chat's "utility" / "small utility"
 * families to a model of the user's choice.
 *
 * Stage 1 — pick a model. Lists every chat model the current VS Code
 * instance knows about (MiniMax, plus any other extension-registered
 * provider the user has installed). Sorts MiniMax first, then by
 * `vendor/id`. The current `chat.utilitySmallModel` value is marked.
 *
 * Stage 2 — pick which `chat.*` setting(s) to write the chosen model
 * into. Both `chat.utilitySmallModel` (Agent helpers / ✨ button) and
 * `chat.utilityModel` (titles / summaries) are selected by default so
 * VS Code 1.128+ BYOK Agent mode has both utility families available.
 * Both go through the same `ILanguageModelsService` (see
 * https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/chat/browser/utilityModelContribution.ts)
 * so the `<vendor>/<id>` format is the right shape for both.
 *
 * The per-task `github.copilot.chat.*.model` overrides
 * (`askAgent.model`, `conversationCompaction.model`,
 * `instantApply.shortContextModelName`) are NOT exposed here — those
 * take a bare Copilot-family model id, not `<vendor>:<id>`, so mixing
 * them in this flow would mislead users. They are listed in the README
 * under "Per-task model overrides" for users who want to set them
 * manually.
 *
 * Reload / restart Copilot Chat for the changes to take effect — the
 * settings are read at extension activation, not on every commit.
 */
async function useForCopilotCommitMessages(): Promise<void> {
	let allModels: vscode.LanguageModelChat[];
	try {
		allModels = await vscode.lm.selectChatModels();
	} catch (error) {
		logger.warn('useForCopilotCommitMessages: selectChatModels failed', error);
		void vscode.window.showErrorMessage(t('commit.modelListFailed'));
		return;
	}
	if (allModels.length === 0) {
		void vscode.window.showInformationMessage(t('commit.noModels'));
		return;
	}

	const rawUtilitySmall = vscode.workspace.getConfiguration('chat').get<unknown>('utilitySmallModel');
	const currentUtilitySmall =
		typeof rawUtilitySmall === 'string' ? rawUtilitySmall.trim() || undefined : undefined;
	const rawUtility = vscode.workspace.getConfiguration('chat').get<unknown>('utilityModel');
	const currentUtility =
		typeof rawUtility === 'string' ? rawUtility.trim() || undefined : undefined;

	const items: vscode.QuickPickItem[] = allModels.map((m) => {
		const fullId = `${m.vendor}/${m.id}`;
		const isCurrent = fullId === currentUtilitySmall || fullId === currentUtility;
		return {
			label: m.name || m.id,
			description: fullId,
			detail: isCurrent ? t('commit.currentlySelected') : undefined,
		};
	});
	// MiniMax models first, then the rest alphabetically by vendor then id.
	items.sort((a, b) => {
		const aIsMiniMax = a.description?.startsWith('minimax/') ? 0 : 1;
		const bIsMiniMax = b.description?.startsWith('minimax/') ? 0 : 1;
		if (aIsMiniMax !== bIsMiniMax) return aIsMiniMax - bIsMiniMax;
		return (a.description ?? '').localeCompare(b.description ?? '');
	});

	const pick = await vscode.window.showQuickPick(items, {
		title: t('commit.pickModelTitle'),
		placeHolder: t('commit.pickModelPlaceholder'),
		ignoreFocusOut: true,
		matchOnDescription: true,
	});
	if (!pick || !pick.description) return;

	const targetItems: (vscode.QuickPickItem & { picked?: boolean })[] = [
		{
			label: t('commit.targetUtilitySmall'),
			description: 'chat.utilitySmallModel',
			detail: t('commit.targetUtilitySmallDetail'),
			picked: true,
		},
		{
			label: t('commit.targetUtility'),
			description: 'chat.utilityModel',
			detail: t('commit.targetUtilityDetail'),
			picked: true,
		},
	];
	// Multi-select: use `createQuickPick` rather than `showQuickPick`
	// because the type pinned by our `vscode.proposed.*.d.ts` shims does
	// not include `canSelectMany` in `QuickPickOptions`. `createQuickPick`
	// has stable typings for `canSelectMany` + `onDidAccept` regardless
	// of engine version.
	//
	// ⚠️ dispose() is called OUTSIDE the callback chain to avoid a
	// synchronously-triggered onDidHide racing the promise resolution:
	// onDidHide fires when dispose() is called, and if disposed before
	// the promise is resolved, the user sees a silent no-op.
	const targetQp = vscode.window.createQuickPick<vscode.QuickPickItem & { picked?: boolean }>();
	targetQp.title = t('commit.pickTargetTitle');
	targetQp.placeholder = t('commit.pickTargetPlaceholder');
	targetQp.canSelectMany = true;
	targetQp.ignoreFocusOut = true;
	targetQp.items = targetItems;
	targetQp.selectedItems = targetItems.filter((i) => i.picked);
	const accepted = await new Promise<readonly (vscode.QuickPickItem & { picked?: boolean })[] | undefined>(
		(resolve) => {
			targetQp.onDidAccept(() => resolve(targetQp.selectedItems));
			targetQp.onDidHide(() => resolve(undefined));
			targetQp.show();
		},
	);
	targetQp.dispose();
	if (!accepted || accepted.length === 0) return;

	const chatConfig = vscode.workspace.getConfiguration('chat');
	// `config.update` returns a `Thenable<void>` (per our type shims);
	// `Promise.all` insists on `Promise<void>`, so resolve each first.
	const writes: Promise<void>[] = [];
	for (const item of accepted) {
		if (item.description === 'chat.utilitySmallModel') {
			writes.push(
				Promise.resolve(
					chatConfig.update('utilitySmallModel', pick.description, vscode.ConfigurationTarget.Global),
				),
			);
		} else if (item.description === 'chat.utilityModel') {
			writes.push(
				Promise.resolve(
					chatConfig.update('utilityModel', pick.description, vscode.ConfigurationTarget.Global),
				),
			);
		}
	}
	await Promise.all(writes);
	void vscode.window.showInformationMessage(
		t('commit.setupComplete', pick.description, accepted.length),
	);
}

function detectHost(): 'china' | 'global' | null {
	// Prefer the active key's `apiBaseUrl` — the pool is the source of
	// truth. Falls back to the deprecated `minimax.apiBaseUrl` setting
	// when the pool has no active entry (legacy migration in flight).
	// Synchronous because the dashboard panel calls this from render
	// paths; the active key's URL is always available from the
	// `snapshot()` cache without an async fetch.
	//
	// Returns `null` when the resolved URL is a third-party proxy
	// (e.g. a self-hosted Anthropic-compatible gateway). Callers that
	// need a non-null value (e.g. the mmx-cli install prompt) should
	// use `?? 'global'` at the call site; callers that care about
	// *not* sending the API key to MiniMax's official endpoints
	// (e.g. `refreshPlanKeyState`, the PlanCache) propagate `null`
	// all the way to `fetchPlanUsage` so the call short-circuits.
	try {
		const km = getKeyManager();
		const snap = km?.snapshot();
		const activeEntry = snap?.keys.find((k) => k.id === snap.activeKeyId);
		const url = activeEntry?.apiBaseUrl?.trim() || getBaseUrl();
		const host = resolvePlatformHost(url);
		if (host === null) return null;
		return host === 'api.minimaxi.com' ? 'china' : 'global';
	} catch {
		return null;
	}
}

async function reprobeApiKeyCommand(): Promise<void> {
	const manager = getKeyManager();
	if (!manager) {
		void vscode.window.showWarningMessage(t('keys.managerUnavailable'));
		return;
	}
	const snapshot = manager.snapshot();
	if (!snapshot.activeKeyId) {
		void vscode.window.showInformationMessage(t('keys.reprobeNoActive'));
		return;
	}
	const activeBefore = snapshot.keys.find((k) => k.id === snapshot.activeKeyId);
	const updated = await manager.reprobeActiveKey();
	if (!updated) {
		// Active entry exists but has no usable secret. (The reprobe
		// fast-path also returns the entry unchanged when the region
		// is already known; in that case we don't toast and skip the
		// cache invalidation.)
		if (activeBefore) {
			void vscode.window.showWarningMessage(t('keys.reprobeMissingSecret'));
		}
		return;
	}
	// Only invalidate + toast when something actually changed. The
	// fast-path returns the same entry, so a no-op probe is silent.
	const regionChanged = activeBefore?.region !== updated.region;
	const urlChanged = activeBefore?.apiBaseUrl !== updated.apiBaseUrl;
	if (regionChanged || urlChanged) {
		getPlanCache().invalidate();
		void vscode.window.showInformationMessage(
			t('keys.reprobed', updated.name, updated.region, updated.apiBaseUrl),
		);
	}
}

async function openRequestDumpsFolder(): Promise<void> {
	// Use `Uri.file(root.fsPath)` rather than `Uri.joinPath(...)` so the
	// resulting URI carries the `file://` scheme. `vscode.env.openExternal`
	// shells out to the OS, which only knows how to handle standard
	// schemes (`http://`, `mailto:`, `file://`, …); a
	// `vscode-userdata://` URI from `joinPath` is rejected silently on
	// Windows (Shell asks "open with what app?"; the user dismisses it;
	// the catch block fires but the error toast often gets lost behind
	// the Copilot Chat panel). `Uri.file()` produces a `file://` URI the
	// Shell knows to open in the file manager.
	const fsPath = vscode.Uri.joinPath(contextGlobalStorage(), 'request-dumps').fsPath;
	return openRequestDumpsFolderAt(fsPath);
}

/**
 * @internal — exported for the regression test in
 * `test/openRequestDumpsFolder.test.ts` so the test can drive the
 * command without paying for the full `registerCommands` →
 * `setCommandContext` → `createPlanStatusBar` cascade (which pulls in
 * `StatusBarAlignment`, `FileType`, `lm.selectChatModels`, and other
 * vscode surface the test mock doesn't need to model). Production
 * callers should use the unparameterised `openRequestDumpsFolder`,
 * which reads the globalStorageUri from the cached extension context.
 */
export async function openRequestDumpsFolderAt(globalStorageFsPath: string): Promise<void> {
	const root = vscode.Uri.file(globalStorageFsPath);
	try {
		await vscode.workspace.fs.createDirectory(root);
		await vscode.env.openExternal(root);
	} catch (error) {
		logger.warn(t('extension.openRequestDumpsFolderFailed'), error);
		vscode.window.showErrorMessage(t('extension.openRequestDumpsFolderFailed'));
	}
}

/**
 * Reveal the configured Claude Code log directory in the OS file
 * manager. Shows a warning if the directory doesn't exist (which is
 * normal for users who haven't installed Claude Code yet).
 */
async function openClaudeCodeLogFolder(): Promise<void> {
	const dir = getClaudeCodeLogPath();
	await openDirectoryOrWarn(dir, t('claudeCode.folderMissing', dir));
}

/** Shared helper: stat `dir`, open it in the OS file manager when it
 *  exists and is a directory, otherwise show `warning` so the user
 *  knows where we looked. The three log-folder commands all funnel
 *  through this to keep the error-toast copy consistent. */
async function openDirectoryOrWarn(dir: string, warning: string): Promise<void> {
	try {
		const stat = await vscode.workspace.fs.stat(vscode.Uri.file(dir));
		if (stat.type & vscode.FileType.Directory) {
			await vscode.env.openExternal(vscode.Uri.file(dir));
			return;
		}
	} catch {
		// Directory doesn't exist or is unreadable — fall through to
		// the warning.
	}
	void Promise.resolve(vscode.window.showWarningMessage(warning)).catch(() => {
		// Toast dismissed or API failure — no recovery needed.
	});
}

function contextGlobalStorage(): vscode.Uri {
	if (!cachedContext) {
		throw new Error('Extension context not initialised');
	}
	return cachedContext.globalStorageUri;
}
