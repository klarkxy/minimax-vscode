import * as vscode from 'vscode';
import { t } from '../i18n';
import { logger } from '../logger';
import { MiniMaxChatProvider } from '../provider';
import { setCommitModelStore } from '../git/commitMessage';
import { registerActionUrls } from './actions';
import { registerCommands, setCommandContext } from './commands';
import { autoSelectEndpointIfUnset } from './endpoint';
import { initializeDiagnostics } from './diagnostics';
import { registerProvider } from './provider';
import { showWelcomeIfNeeded } from './welcome';

let activeProvider: MiniMaxChatProvider | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	setCommandContext(context);
	setCommitModelStore(context.globalState);
	await initializeDiagnostics(context);
	registerCommands(context);
	registerActionUrls(context);

	// First-run language-driven endpoint selection. The function is a no-op
	// once the user has explicitly chosen an endpoint (via settings or the
	// switchToGlobal / switchToChina commands).
	await autoSelectEndpointIfUnset();

	try {
		const provider = await registerProvider(context);
		activeProvider = provider;

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
