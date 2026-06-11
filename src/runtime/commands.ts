import * as vscode from 'vscode';
import { AuthManager } from '../auth';
import { t } from '../i18n';
import { logger } from '../logger';
import { getModels, getVisibleModels } from '../models/registry';
import { getApiHostForPlatform, getBaseUrl, getClaudeCodeAllowedModels, getClaudeCodeLogPath } from '../config';
import { chooseCommitModel, generateCommitMessage } from '../git/commitMessage';
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

let cachedContext: vscode.ExtensionContext | undefined;
let cachedAuth: AuthManager | undefined;
let cachedUsage: UsageStore | undefined;
let cachedPlanCache: PlanCache | undefined;
let cachedMmxCliCache: MmxCliCache | undefined;
let cachedPlanStatusBar: PlanStatusBar | undefined;
let cachedClaudeCodeIngest: ClaudeCodeIngestHandle | undefined;
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
		vscode.commands.registerCommand('minimax.showPricing', () => {
			void showPricing();
		}),
		vscode.commands.registerCommand('minimax.generateCommitMessage', (...args: unknown[]) => {
			logger.debug('minimax.generateCommitMessage called', { args });
			if (!cachedAuth) {
				cachedAuth = new AuthManager(context);
			}
			void generateCommitMessage(cachedAuth, args[0]);
		}),
		vscode.commands.registerCommand('minimax.chooseCommitModel', () => {
			void chooseCommitModel();
		}),
		vscode.commands.registerCommand('minimax.toggleM31MContext', () => {
			// Lifts the M3 picker entry from the safe 512K default to
			// the official 1M cap. The command pops a modal warning
			// about the 2× billing rate and the need for sales-granted
			// >512K access before flipping on; off is unconditional.
			void toggleM31MContextEnabled();
		}),
		vscode.commands.registerCommand('minimax.showUsage', () => {
			void showUsage();
		}),
		vscode.commands.registerCommand('minimax.resetUsage', () => {
			void resetUsage();
		}),
		vscode.commands.registerCommand('minimax.showProviderStatus', () => {
			void showProviderStatus(auth);
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
	const root = vscode.Uri.joinPath(contextGlobalStorage(), 'request-dumps');
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
	void vscode.window.showWarningMessage(
		t('claudeCode.folderMissing', dir),
	);
}

async function showPricing(): Promise<void> {
	const baseUrl = getBaseUrl();
	const isChina = baseUrl.includes('minimaxi.com');
	const flag = isChina ? '🇨🇳' : '🌐';
	const headerRow = `| ${t('pricing.header.model')} | ${t('pricing.header.input')} | ${t('pricing.header.output')} | ${t('pricing.header.cacheRead')} | ${t('pricing.header.cacheWrite')} |`;
	const sep = `| --- | ---: | ---: | ---: | ---: |`;

	const models = getModels(baseUrl);
	const rows = models.map((m) => {
		const { input, output, cacheRead, cacheWrite, currency } = m.pricing;
		const symbol = currency === 'USD' ? '$' : '¥';
		const fmt = (n: number | null) => (n === null ? t('pricing.unlisted') : `${symbol}${n.toFixed(2)}`);
		return `| ${m.id} | ${fmt(input)} | ${fmt(output)} | ${fmt(cacheRead)} | ${fmt(cacheWrite)} |`;
	});

	const notes = models.filter((m) => m.pricing.note).map(
		(m) => `- **${m.id}**: ${m.pricing.note}`,
	);

	const lines: string[] = [
		`# ${flag} ${t('pricing.title')}`,
		'',
		t('pricing.providers', 'Anthropic Messages', baseUrl),
		'',
		headerRow,
		sep,
		...rows,
	];

	if (notes.length > 0) {
		lines.push('', '## Notes', '', ...notes);
	}

	lines.push('', `> ${t('pricing.note')}`);

	const doc = await vscode.workspace.openTextDocument({
		content: lines.join('\n'),
		language: 'markdown',
	});
	await vscode.window.showTextDocument(doc, { preview: true });
}

function contextGlobalStorage(): vscode.Uri {
	if (!cachedContext) {
		throw new Error('Extension context not initialised');
	}
	return cachedContext.globalStorageUri;
}

function formatNumber(n: number): string {
	return n.toLocaleString('en-US');
}

async function showUsage(): Promise<void> {
	const store = cachedUsage;
	if (!store) {
		void vscode.window.showWarningMessage(t('usage.empty'));
		return;
	}
	const stats = store.read();
	const total = stats.total;
	const lines: string[] = [];
	lines.push(`# ${t('usage.title')}`);
	lines.push('');
	if (total.requests === 0) {
		lines.push(t('usage.empty'));
	} else {
		lines.push(
			t(
				'usage.line.total',
				formatNumber(total.inputTokens),
				formatNumber(total.outputTokens),
				formatNumber(total.requests),
			),
		);
		if (total.cacheReadTokens > 0 || total.cacheWriteTokens > 0) {
			lines.push(
				t(
					'usage.line.cache',
					formatNumber(total.cacheReadTokens),
					formatNumber(total.cacheWriteTokens),
				),
			);
		}
		const perModel = Object.entries(stats.byModel);
		if (perModel.length > 0) {
			lines.push('');
			lines.push('## Models');
			for (const [id, usage] of perModel) {
				lines.push(
					t(
						'usage.line.model',
						id,
						formatNumber(usage.inputTokens),
						formatNumber(usage.outputTokens),
						formatNumber(usage.requests),
					),
				);
			}
		} else {
			lines.push('', t('usage.modelEmpty'));
		}
	}
	lines.push('');
	lines.push(t('usage.line.startedAt', stats.startedAt));
	lines.push(t('usage.line.updatedAt', stats.updatedAt));

	// Append a clearly-labelled Claude Code section so the markdown
	// report covers both the extension's own usage and the Claude
	// Code JSONL-derived usage. Independent data source — kept in its
	// own block so a reader can tell them apart at a glance.
	const cc = cachedClaudeCodeIngest;
	if (cc) {
		const ccStats = cc.store.read();
		lines.push('');
		lines.push('## Claude Code (separate source)');
		const ccTotal = ccStats.total;
		if (ccTotal.requests === 0) {
			lines.push(t('claudeCode.showUsageEmpty'));
		} else {
			lines.push(
				t(
					'usage.line.total',
					formatNumber(ccTotal.inputTokens),
					formatNumber(ccTotal.outputTokens),
					formatNumber(ccTotal.requests),
				),
			);
			if (ccTotal.cacheReadTokens > 0 || ccTotal.cacheWriteTokens > 0) {
				lines.push(
					t(
						'usage.line.cache',
						formatNumber(ccTotal.cacheReadTokens),
						formatNumber(ccTotal.cacheWriteTokens),
					),
				);
			}
			const ccPerModel = Object.entries(ccStats.byModel);
			if (ccPerModel.length > 0) {
				lines.push('');
				for (const [id, usage] of ccPerModel) {
					lines.push(
						t(
							'usage.line.model',
							id,
							formatNumber(usage.inputTokens),
							formatNumber(usage.outputTokens),
							formatNumber(usage.requests),
						),
					);
				}
			}
		}
		const ccStatus = cc.status();
		lines.push('');
		lines.push(`- Log path: \`${ccStatus.logPath}\``);
		lines.push(`- Files tracked: ${ccStatus.filesTracked}`);
		if (ccStatus.parseErrors > 0) {
			lines.push(`- Parse errors: ${ccStatus.parseErrors}`);
		}
	}

	const doc = await vscode.workspace.openTextDocument({
		content: lines.join('\n'),
		language: 'markdown',
	});
	await vscode.window.showTextDocument(doc, { preview: true });
}

async function resetUsage(): Promise<void> {
	const store = cachedUsage;
	if (!store) {
		return;
	}
	await store.reset();
	vscode.window.showInformationMessage(t('usage.resetDone'));
}

async function showProviderStatus(auth: AuthManager): Promise<void> {
	const ext = vscode.extensions.getExtension('klarkxy.minimax-vscode-copilot');
	const hasKey = await auth.hasApiKey();
	const visible = getVisibleModels();
	const stats = cachedUsage?.read();
	const lastModel = stats
		? Object.entries(stats.byModel).sort(
				(a, b) => (b[1].requests ?? 0) - (a[1].requests ?? 0),
			)[0]
		: undefined;
	const total = stats?.total;
	const lines: string[] = [];
	lines.push(`# ${t('status.title')}`);
	lines.push('');
	if (ext) {
		const pkg = ext.packageJSON as { version?: string; displayName?: string } | undefined;
		const version = pkg?.version ?? '?';
		const name = pkg?.displayName ?? 'MiniMax Copilot';
		lines.push(t('status.active', name, version));
	} else {
		lines.push(t('status.inactive'));
	}
	lines.push('');
	lines.push(hasKey ? t('status.apiKeySet') : t('status.apiKeyMissing'));
	lines.push(t('status.visibleModels', formatNumber(visible.length)));
	if (total && total.requests > 0) {
		lines.push(
			t('status.lastUsage', formatNumber(total.inputTokens), formatNumber(total.outputTokens)),
		);
		if (lastModel) {
			lines.push(t('usage.line.model', lastModel[0], formatNumber(lastModel[1].inputTokens), formatNumber(lastModel[1].outputTokens), formatNumber(lastModel[1].requests)));
		}
	} else {
		lines.push(t('status.usageEmpty'));
	}
	lines.push('');
	lines.push(t('usage.line.startedAt', stats?.startedAt ?? new Date().toISOString()));

	const doc = await vscode.workspace.openTextDocument({
		content: lines.join('\n'),
		language: 'markdown',
	});
	await vscode.window.showTextDocument(doc, { preview: true });
}
