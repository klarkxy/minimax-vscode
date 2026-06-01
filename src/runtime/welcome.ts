import * as vscode from 'vscode';
import { WELCOME_SHOWN_KEY } from '../consts';
import { t } from '../i18n';
import { logger } from '../logger';
import type { MiniMaxChatProvider } from '../provider';

/**
 * Show a one-time welcome card the first time the provider registers.
 *
 * The card is rendered as an information message with an "Open walkthrough"
 * action. The walkthrough contribution in package.json drives the rest of
 * the onboarding.
 */
export async function showWelcomeIfNeeded(
	context: vscode.ExtensionContext,
	_provider: MiniMaxChatProvider,
): Promise<void> {
	const shown = context.globalState.get<boolean>(WELCOME_SHOWN_KEY);
	if (shown) {
		return;
	}

	const selection = await vscode.window.showInformationMessage(
		t('auth.notConfigured'),
		{ modal: false, detail: 'Walk through setApiKey, showModels, and advanced settings.' },
		'Open Walkthrough',
	);
	if (selection === 'Open Walkthrough') {
		void vscode.commands.executeCommand(
			'workbench.action.openWalkthroughs',
		);
	}

	await context.globalState.update(WELCOME_SHOWN_KEY, true);
	logger.info('Welcome flow shown');
}
