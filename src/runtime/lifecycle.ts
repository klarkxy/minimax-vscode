import * as vscode from 'vscode';
import { t } from '../i18n';
import { logger } from '../logger';
import { MiniMaxChatProvider } from '../provider';
import { registerActionUrls } from './actions';
import {
	registerCommands,
	setCommandContext,
	setClaudeCodeIngest,
	setCodexIngest,
	setOpencodeIngest,
	bindChatTurnNotifier,
} from './commands';
import { autoSelectEndpointIfUnset } from './endpoint';
import { initializeDiagnostics } from './diagnostics';
import { registerProvider } from './provider';
import { showWelcomeIfNeeded } from './welcome';

let activeProvider: MiniMaxChatProvider | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	setCommandContext(context);
	await initializeDiagnostics(context);
	registerCommands(context);
	// Start the Claude Code JSONL log ingester. Independent of the
	// provider so the dashboard can show Claude Code data even if the
	// provider's API call layer never runs (e.g. user only uses
	// Claude Code CLI / Claude Code VSCode extension).
	setClaudeCodeIngest(context);
	// Same pattern for Codex (JSONL rollouts) and OpenCode (storage
	// directory). The three ingesters are fully independent — each
	// has its own Memento cursor, its own poll loop, its own
	// `onDidChangeConfiguration` tear-down.
	setCodexIngest(context);
	setOpencodeIngest(context);
	registerActionUrls(context);

	// First-run language-driven endpoint selection. The function is a no-op
	// once the user has explicitly chosen an endpoint (via settings or the
	// switchToGlobal / switchToChina commands).
	await autoSelectEndpointIfUnset();

	try {
		const provider = await registerProvider(context);
		activeProvider = provider;

		// Hook the provider's chat-turn boundary notifier into the
		// plan cache so the status-bar quota items pulse at most once
		// per Copilot user turn (not per internal API request).
		bindChatTurnNotifier(provider.chatTurnNotifier);

		void showWelcomeIfNeeded(context, provider).catch((error) => {
			logger.warn(t('extension.welcomeFailed'), error);
		});

		logger.info(`Extension activated version=${context.extension.packageJSON.version}`);
	} catch (error) {
		activeProvider = undefined;
		logger.error('Failed to activate MiniMax extension', error);
		void vscode.window.showErrorMessage(t('extension.activateFailed'));
		throw error;
	}
}

export async function deactivate(): Promise<void> {
	try {
		await activeProvider?.prepareForDeactivate();
	} catch (error) {
		logger.warn(t('extension.deactivateFailed'), error);
	} finally {
		activeProvider = undefined;
		logger.info('Extension deactivated');
		logger.dispose();
	}
}
