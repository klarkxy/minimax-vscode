import * as vscode from 'vscode';
import { AuthManager } from '../auth';
import { t } from '../i18n';
import { logger } from '../logger';
import { MODELS, getVisibleModels } from '../models/registry';
import { getBaseUrl } from '../config';
import { chooseCommitModel, generateCommitMessage } from '../git/commitMessage';
import { createUsageStore, type UsageStore } from '../usage';
import { DashboardPanel } from '../dashboard/panel';
import { createUsageStatusBar, type UsageStatusBar } from '../dashboard/statusBar';

let cachedContext: vscode.ExtensionContext | undefined;
let cachedAuth: AuthManager | undefined;
let cachedUsage: UsageStore | undefined;
let cachedStatusBar: UsageStatusBar | undefined;

export function setCommandContext(context: vscode.ExtensionContext): void {
	cachedContext = context;
	cachedAuth = new AuthManager(context);
	cachedUsage = createUsageStore(context.globalState);
	if (!cachedStatusBar) {
		cachedStatusBar = createUsageStatusBar({
			store: cachedUsage,
			auth: cachedAuth,
			command: 'minimax.openDashboard',
		});
		context.subscriptions.push(cachedStatusBar);
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
				host: detectHost(),
			});
		}),
	);
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

	const rows = MODELS.map((m) => {
		const { input, output, cacheRead, cacheWrite, note } = m.pricing;
		const fmt = (n: number | null) => (n === null ? t('pricing.unlisted') : `¥${n.toFixed(2)}`);
		return `| ${m.id} | ${fmt(input)} | ${fmt(output)} | ${fmt(cacheRead)} | ${fmt(cacheWrite)} |`;
	});

	const notes = MODELS.filter((m) => m.pricing.note).map(
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
	const ext = vscode.extensions.getExtension('klarkxy.minimax-copilot');
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
