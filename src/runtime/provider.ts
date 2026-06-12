import * as vscode from 'vscode';
import { logger } from '../logger';
import { MiniMaxChatProvider } from '../provider';

export async function registerProvider(
	context: vscode.ExtensionContext,
): Promise<MiniMaxChatProvider> {
	const provider = new MiniMaxChatProvider(context);

	context.subscriptions.push(
		vscode.commands.registerCommand('minimax.setApiKey', () => provider.configureApiKey()),
		vscode.commands.registerCommand('minimax.clearApiKey', () => provider.clearApiKey()),
		vscode.lm.registerLanguageModelChatProvider('minimax', provider),
	);

	// Copilot Chat can serve cached model info without configurationSchema.
	// Activate it first so this refresh reaches a live listener.
	await activateCopilotChat();
	provider.refreshModelPicker();

	return provider;
}

async function activateCopilotChat(): Promise<void> {
	try {
		await vscode.extensions.getExtension('github.copilot-chat')?.activate();
	} catch (error) {
		logger.warn('Copilot Chat activation unavailable; model picker refresh may be delayed', error);
	}
}
