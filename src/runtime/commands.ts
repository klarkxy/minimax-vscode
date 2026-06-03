import * as vscode from 'vscode';
import { AuthManager } from '../auth';
import { t } from '../i18n';
import { logger } from '../logger';
import { getModels, getVisibleModels } from '../models/registry';
import { getBaseUrl } from '../config';
import { chooseCommitModel, generateCommitMessage } from '../git/commitMessage';
import { createUsageStore, type UsageStore } from '../usage';
import { DashboardPanel } from '../dashboard/panel';
import { createPlanStatusBar, type PlanStatusBar } from '../dashboard/planStatusBar';
import { createPlanCache, type PlanCache } from '../dashboard/aggregator';
import {
	installBundledMmxSkill,
	installMmxCli,
	installMmxSkill,
	loginMmxCli,
	readMmxCliStatus,
} from '../dashboard/mmxCli';
import type { ChatTurnNotifier } from '../dashboard/chatTurnNotifier';

let cachedContext: vscode.ExtensionContext | undefined;
let cachedAuth: AuthManager | undefined;
let cachedUsage: UsageStore | undefined;
let cachedPlanCache: PlanCache | undefined;
let cachedPlanStatusBar: PlanStatusBar | undefined;
let turnNotifierDisposable: vscode.Disposable | undefined;

function getPlanCache(): PlanCache {
	if (!cachedPlanCache) {
		cachedPlanCache = createPlanCache();
	}
	return cachedPlanCache;
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

/** Mirror the current auth state into the plan status bar. */
async function refreshPlanKeyState(): Promise<void> {
	if (!cachedAuth || !cachedPlanStatusBar) return;
	const key = await cachedAuth.getApiKey();
	cachedPlanStatusBar.setKeyState(key ? 'set' : 'unset');
	if (key) {
		// Best-effort warm-up; the dashboard will reuse the same snapshot.
		void getPlanCache().refresh({ apiKey: key, host: detectHost() });
	} else {
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
				host: detectHost(),
			});
			// Fire-and-forget: ensure the cache has a fresh snapshot for
			// both the dashboard render and the status bar to consume.
			void refreshPlanKeyState();
		}),
		vscode.commands.registerCommand('minimax.installMmxCli', () => {
			if (!cachedAuth || !cachedContext) {
				void vscode.window.showWarningMessage(t('usage.empty'));
				return;
			}
			void runMmxCliInstallWizard(cachedContext.extensionUri, cachedAuth);
		}),
	);
}

/**
 * The command-palette entry point for "Install mmx-cli".
 *
 * Walks the user through the three official steps in sequence:
 *   1. `npm install -g mmx-cli`                  (if missing)
 *   2. `mmx auth login --api-key <key>`          (if no mmx auth)
 *   3. `npx skills add MiniMax-AI/cli -y -g`     (if no skill)
 *
 * Each step is reported back as a VS Code notification. Failures stop
 * the chain — the user is told which step failed and what the captured
 * stderr was.
 */
async function runMmxCliInstallWizard(
	extensionUri: vscode.Uri,
	auth: AuthManager,
): Promise<void> {
	let status = await readMmxCliStatus();

	// Step 1 — install the binary.
	if (status.install !== 'installed') {
		const choice = await vscode.window.showInformationMessage(
			t('mmx.installProgress'),
			{ modal: true },
			t('mmx.installBtn'),
		);
		if (choice !== t('mmx.installBtn')) return;
		const result = await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: t('mmx.installProgress'),
				cancellable: false,
			},
			async (progress) => {
				progress.report({ message: 'npm install -g mmx-cli …' });
				const r = await installMmxCli({ log: (m) => logger.info(`[mmx-cli] ${m}`) });
				if (r.ok) {
					progress.report({ message: 'Installed.', increment: 100 });
				}
				return r;
			},
		);
		if (!result.ok) {
			// The most common failure is a stale PATH: VS Code was
			// launched before npm was on it. Offer to reload the
			// window so the new PATH takes effect.
			if (result.missing && /npm not found/.test(result.error ?? '')) {
				const choice = await vscode.window.showErrorMessage(
					t('mmx.installFailed', result.error ?? 'unknown'),
					t('mmx.reloadWindow'),
				);
				if (choice === t('mmx.reloadWindow')) {
					await vscode.commands.executeCommand('workbench.action.reloadWindow');
				}
				return;
			}
			vscode.window.showErrorMessage(t('mmx.installFailed', result.error ?? 'unknown'));
			return;
		}
		vscode.window.showInformationMessage(
			result.newVersion
				? t('mmx.installedWithVersion', result.newVersion)
				: t('mmx.installed'),
		);
		status = await readMmxCliStatus();
	}

	// Step 2 — login with the API key from SecretStorage.
	if (status.auth !== 'loggedIn') {
		const apiKey = await auth.getApiKey();
		if (!apiKey) {
			const choice = await vscode.window.showWarningMessage(
				t('mmx.loginRequiresKey'),
				t('mmx.setApiKey'),
			);
			if (choice === t('mmx.setApiKey')) {
				await vscode.commands.executeCommand('minimax.setApiKey');
			}
			return;
		}
		if (!status.binPath) {
			vscode.window.showWarningMessage(t('mmx.loginRequiresInstall'));
			return;
		}
		const result = await loginMmxCli(apiKey, status.binPath);
		if (!result.ok) {
			vscode.window.showErrorMessage(t('mmx.loginFailed', result.stderr || result.error || 'unknown'));
			return;
		}
		vscode.window.showInformationMessage(t('mmx.loginOk'));
	}

	// Step 3 — install the official SKILL so the agent can call mmx.
	status = await readMmxCliStatus();
	if (status.skill !== 'installed') {
		const skill = await installMmxSkill({ log: (m) => logger.info(`[mmx-skill] ${m}`), extensionUri });
		if (skill.ok) {
			vscode.window.showInformationMessage(
				skill.source === 'bundled'
					? t('mmx.skillInstalledBundled', skill.installedAt ?? '')
					: t('mmx.skillInstalled'),
			);
		} else {
			// Last-ditch fallback: try the bundled SKILL.md directly.
			const fallback = await installBundledMmxSkill(extensionUri);
			if (fallback.ok) {
				vscode.window.showInformationMessage(
					t('mmx.skillInstalledBundled', fallback.installedAt ?? ''),
				);
			} else {
				vscode.window.showErrorMessage(t('mmx.skillFailed', skill.error ?? 'unknown'));
			}
		}
	}

	// Reveal the dashboard so the user can see the new green ticks.
	if (cachedContext && cachedUsage && cachedAuth) {
		DashboardPanel.show({
			extensionUri: cachedContext.extensionUri,
			auth: cachedAuth,
			usageStore: cachedUsage,
			planCache: getPlanCache(),
			host: detectHost(),
		});
	}
}

function detectHost(): 'china' | 'global' {
	try {
		const baseUrl = getBaseUrl();
		return baseUrl.includes('minimaxi.com') ? 'china' : 'global';
	} catch {
		return 'china';
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
