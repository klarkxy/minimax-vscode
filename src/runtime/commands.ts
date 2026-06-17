import * as vscode from 'vscode';
import { AuthManager } from '../auth';
import { t } from '../i18n';
import { logger } from '../logger';
import {
	getApiHostForPlatform,
	getClaudeCodeAllowedModels,
	getClaudeCodeLogPath,
	getCodexAllowedModels,
	getCodexLogPath,
	getCodexArchivedLogPath,
	getOpencodeAllowedModels,
	getOpencodeLogPath,
} from '../config';
import { toggleM31MContextEnabled } from '../provider/models';
import { createUsageStore, type UsageStore } from '../usage';
import { DashboardPanel } from '../dashboard/panel';
import { createPlanStatusBar, type PlanStatusBar } from '../dashboard/planStatusBar';
import { createPlanCache, type PlanCache } from '../dashboard/aggregator';
import { createMmxCliCache, type MmxCliCache } from '../dashboard/mmxCliCache';
import { copyMmxInstallPrompt } from '../dashboard/mmxCli';
import type { ChatTurnNotifier } from '../dashboard/chatTurnNotifier';
import {
	createClaudeCodeIngest,
	type ClaudeCodeIngestHandle,
} from '../dashboard/claudeCodeIngest';
import {
	createCodexIngest,
	type CodexIngestHandle,
} from '../dashboard/codexIngest';
import {
	createOpencodeIngest,
	type OpencodeIngestHandle,
} from '../dashboard/opencodeIngest';

let cachedContext: vscode.ExtensionContext | undefined;
let cachedAuth: AuthManager | undefined;
let cachedUsage: UsageStore | undefined;
let cachedPlanCache: PlanCache | undefined;
let cachedMmxCliCache: MmxCliCache | undefined;
let cachedPlanStatusBar: PlanStatusBar | undefined;
let cachedClaudeCodeIngest: ClaudeCodeIngestHandle | undefined;
let cachedCodexIngest: CodexIngestHandle | undefined;
let cachedOpencodeIngest: OpencodeIngestHandle | undefined;
let turnNotifierDisposable: vscode.Disposable | undefined;

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

export function setCommandContext(context: vscode.ExtensionContext): void {
	cachedContext = context;
	cachedAuth = new AuthManager(context);
	cachedUsage = createUsageStore(context.globalState);
	if (!cachedPlanStatusBar) {
		cachedPlanStatusBar = createPlanStatusBar({ cache: getPlanCache() });
		context.subscriptions.push(cachedPlanStatusBar);
		// Kick the initial key-state read so the placeholder shows the
		// right thing before the user has interacted with the extension.
		void refreshPlanKeyState();
		// Whenever the user sets / clears the API key, re-mirror the
		// state into the status bar and (re)warm the shared plan cache.
		context.subscriptions.push(cachedAuth.onDidChangeApiKey(() => {
			void refreshPlanKeyState();
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
	}
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

/** Return the cached Claude Code ingester handle, if one is running. */
export function getClaudeCodeIngest(): ClaudeCodeIngestHandle | undefined {
	return cachedClaudeCodeIngest;
}

/**
 * Start the background poller that ingests Codex JSONL rollouts into a
 * sibling Memento-backed store. Mirrors `setClaudeCodeIngest` — same
 * shape, same `onDidChangeConfiguration` tear-down contract, same
 * `UsageStore` lifetime.
 */
export function setCodexIngest(context: vscode.ExtensionContext): void {
	if (cachedCodexIngest) return;
	cachedCodexIngest = createCodexIngest({
		globalState: context.globalState,
		logPath: getCodexLogPath(),
		archivedLogPath: getCodexArchivedLogPath(),
		allowedModels: getCodexAllowedModels(),
	}).start();
	context.subscriptions.push({
		dispose: () => {
			cachedCodexIngest?.dispose();
			cachedCodexIngest = undefined;
		},
	});
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (
				e.affectsConfiguration('minimax.dashboard.includeCodex') ||
				e.affectsConfiguration('minimax.codex.logPath') ||
				e.affectsConfiguration('minimax.codex.archivedLogPath') ||
				e.affectsConfiguration('minimax.codex.pollIntervalMs') ||
				e.affectsConfiguration('minimax.codex.allowedModels')
			) {
				cachedCodexIngest?.dispose();
				cachedCodexIngest = undefined;
				setCodexIngest(context);
			}
		}),
	);
}

/** Return the cached Codex ingester handle, if one is running. */
export function getCodexIngest(): CodexIngestHandle | undefined {
	return cachedCodexIngest;
}

/**
 * Start the background poller that ingests OpenCode storage
 * (`storage/session/message/<session>/<msg>.json`) into a sibling
 * Memento-backed store. Mirrors the Claude Code / Codex ingesters.
 */
export function setOpencodeIngest(context: vscode.ExtensionContext): void {
	if (cachedOpencodeIngest) return;
	cachedOpencodeIngest = createOpencodeIngest({
		globalState: context.globalState,
		logPath: getOpencodeLogPath(),
		allowedModels: getOpencodeAllowedModels(),
	}).start();
	context.subscriptions.push({
		dispose: () => {
			cachedOpencodeIngest?.dispose();
			cachedOpencodeIngest = undefined;
		},
	});
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (
				e.affectsConfiguration('minimax.dashboard.includeOpencode') ||
				e.affectsConfiguration('minimax.opencode.logPath') ||
				e.affectsConfiguration('minimax.opencode.pollIntervalMs') ||
				e.affectsConfiguration('minimax.opencode.allowedModels')
			) {
				cachedOpencodeIngest?.dispose();
				cachedOpencodeIngest = undefined;
				setOpencodeIngest(context);
			}
		}),
	);
}

/** Return the cached OpenCode ingester handle, if one is running. */
export function getOpencodeIngest(): OpencodeIngestHandle | undefined {
	return cachedOpencodeIngest;
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

/** Fire-and-forget plan refresh — dedup'd by the 8s TTL. */
function pulsePlanCache(): void {
	void refreshPlanKeyState();
}

/** Last host we fed into the PlanCache. Used to decide whether the
 *  current pulse is a host change (in which case we MUST NOT
 *  auto-warm the cache with the previously-issued key — see the
 *  [high] finding from Codex's second adversarial review). */
let lastPulsedHost: 'china' | 'global' | null | undefined = undefined;

/** Mirror the current auth state into the plan status bar. */
async function refreshPlanKeyState(): Promise<void> {
	if (!cachedAuth || !cachedPlanStatusBar) return;
	const key = await cachedAuth.getApiKey();
	cachedPlanStatusBar.setKeyState(key ? 'set' : 'unset');
	if (key) {
		// Best-effort warm-up; the dashboard will reuse the same snapshot.
		// The host-classifier and PlanCache short-circuits already
		// guard the credential-leak paths for proxy users and malformed
		// URLs. The remaining concern is the cross-config-event race:
		// the user changes `minimax.apiBaseUrl` from a third-party
		// proxy to `api.minimaxi.com` (or vice versa); the apiBaseUrl
		// change fires before the user has had a chance to swap the
		// API key, so a `refresh({ apiKey: oldKey, host: newHost })`
		// would forward the old proxy key to the new official host.
		// We close that path by refusing to auto-warm when the host
		// has changed since the last pulse — the cache is invalidated
		// instead, and the next explicit user action (key change,
		// dashboard open, or the chat-turn-end notifier firing
		// against a stable host) is what kicks off the next fetch.
		const host = detectHost();
		if (host === null || host !== lastPulsedHost) {
			lastPulsedHost = host;
			getPlanCache().invalidate();
		} else {
			void getPlanCache().refresh({ apiKey: key, host });
		}
	} else {
		lastPulsedHost = undefined;
		getPlanCache().invalidate();
	}
}

export function registerCommands(context: vscode.ExtensionContext): void {
	setCommandContext(context);
	const auth = cachedAuth ?? new AuthManager(context);
	context.subscriptions.push(
		vscode.commands.registerCommand('minimax.switchToGlobal', () => switchBaseUrl('global')),
		vscode.commands.registerCommand('minimax.switchToChina', () => switchBaseUrl('china')),
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
			// about the 2× billing rate and the need for sales-granted
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
				codexIngest: cachedCodexIngest,
				opencodeIngest: cachedOpencodeIngest,
				// Pass the live resolver rather than a one-shot value
				// so the panel reflects the user's `minimax.apiBaseUrl`
				// changes on the next refresh — see `DashboardPanelDeps.
				// getHost` for the credential-leak rationale.
				getHost: detectHost,
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
			void cachedClaudeCodeIngest?.refresh();
		}),
		vscode.commands.registerCommand('minimax.openClaudeCodeLogFolder', () => {
			void openClaudeCodeLogFolder();
		}),
		vscode.commands.registerCommand('minimax.refreshCodexIngest', () => {
			void cachedCodexIngest?.refresh();
		}),
		vscode.commands.registerCommand('minimax.openCodexLogFolder', () => {
			void openCodexLogFolder();
		}),
		vscode.commands.registerCommand('minimax.refreshOpencodeIngest', () => {
			void cachedOpencodeIngest?.refresh();
		}),
		vscode.commands.registerCommand('minimax.openOpencodeLogFolder', () => {
			void openOpencodeLogFolder();
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
 * families to a model of the user's choice. Mirrors
 * `setVisionProxyModel` in `src/provider/vision/model.ts`.
 *
 * Stage 1 — pick a model. Lists every chat model the current VS Code
 * instance knows about (MiniMax, plus any other extension-registered
 * provider the user has installed). Sorts MiniMax first, then by
 * `vendor:id`. The current `chat.utilitySmallModel` value is marked.
 *
 * Stage 2 — pick which `chat.*` setting(s) to write the chosen model
 * into. Defaults to `chat.utilitySmallModel` (the ✨ button family);
 * `chat.utilityModel` is also offered (titles / summaries family).
 * Both go through the same `ILanguageModelsService` (see
 * https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/chat/browser/utilityModelContribution.ts)
 * so the `<vendor>:<id>` format is the right shape for both.
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

	const currentUtilitySmall =
		vscode.workspace
			.getConfiguration('chat')
			.get<string>('utilitySmallModel', '')
			.trim() || undefined;
	const currentUtility =
		vscode.workspace
			.getConfiguration('chat')
			.get<string>('utilityModel', '')
			.trim() || undefined;

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
			picked: false,
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
	// Defer to the configured `minimax.apiBaseUrl` so a fresh
	// international install lands on the global platform instead of
	// the previously-hard-coded `'china'` default. `getApiHostForPlatform`
	// shares the same resolution rules as the 401/402 action buttons
	// in `client/error.ts`, so the dashboard's "Token Plan" widget and
	// the error toasts both agree on which platform the user is on.
	//
	// Returns `null` when the configured URL is a third-party proxy
	// (e.g. a self-hosted Anthropic-compatible gateway). Callers that
	// need a non-null value (e.g. the mmx-cli install prompt) should
	// use `?? 'global'` at the call site; callers that care about
	// *not* sending the API key to MiniMax's official endpoints
	// (e.g. `refreshPlanKeyState`, the PlanCache) propagate `null`
	// all the way to `fetchPlanUsage` so the call short-circuits.
	try {
		const host = getApiHostForPlatform();
		if (host === null) return null;
		return host === 'api.minimaxi.com' ? 'china' : 'global';
	} catch {
		return null;
	}
}

async function switchBaseUrl(target: 'global' | 'china'): Promise<void> {
	const config = vscode.workspace.getConfiguration('minimax');
	// Anthropic-compatible base URLs. SDK appends /v1/messages automatically.
	const url =
		target === 'global'
			? 'https://api.minimax.io/anthropic'
			: 'https://api.minimaxi.com/anthropic';
	await config.update('apiBaseUrl', url, vscode.ConfigurationTarget.Global);
	const confirm =
		target === 'global'
			? 'MiniMax: Switched to Global Anthropic endpoint (minimax.io)'
			: 'MiniMax: Switched to China Anthropic endpoint (minimaxi.com)';
	vscode.window.showInformationMessage(confirm);
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

/** Reveal the configured Codex log directory (live sessions) in the
 *  OS file manager. Mirrors `openClaudeCodeLogFolder`. */
async function openCodexLogFolder(): Promise<void> {
	const dir = getCodexLogPath();
	await openDirectoryOrWarn(dir, t('codex.folderMissing', dir));
}

/** Reveal the configured OpenCode storage directory in the OS file
 *  manager. Mirrors `openClaudeCodeLogFolder`. */
async function openOpencodeLogFolder(): Promise<void> {
	const dir = getOpencodeLogPath();
	await openDirectoryOrWarn(dir, t('opencode.folderMissing', dir));
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
	void vscode.window.showWarningMessage(warning);
}

function contextGlobalStorage(): vscode.Uri {
	if (!cachedContext) {
		throw new Error('Extension context not initialised');
	}
	return cachedContext.globalStorageUri;
}
