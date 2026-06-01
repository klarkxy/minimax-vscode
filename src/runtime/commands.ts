import * as vscode from 'vscode';
import { AuthManager } from '../auth';
import { t } from '../i18n';
import { logger } from '../logger';
import { MODELS } from '../models/registry';
import { getBaseUrl } from '../config';
import { generateCommitMessage } from '../git/commitMessage';

let cachedContext: vscode.ExtensionContext | undefined;
let cachedAuth: AuthManager | undefined;

export function setCommandContext(context: vscode.ExtensionContext): void {
	cachedContext = context;
	cachedAuth = new AuthManager(context);
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
		vscode.commands.registerCommand('minimax.generateCommitMessage', () => {
			if (!cachedAuth) {
				cachedAuth = new AuthManager(context);
			}
			void generateCommitMessage(cachedAuth);
		}),
	);
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
