import * as vscode from 'vscode';
import { logger } from '../logger';
import { MiniMaxChatProvider } from '../provider';

export async function registerProvider(
	context: vscode.ExtensionContext,
): Promise<MiniMaxChatProvider> {
	const provider = new MiniMaxChatProvider(context);

	context.subscriptions.push(
		// `setApiKey` / `clearApiKey` are historical command ids kept
		// alive as runtime aliases of `addApiKey` / `deleteApiKey`.
		// `package.json#contributes.commands.aliases` makes the
		// command palette surface only the new ids, but `executeCommand`
		// calls (deep-link actions, keybindings, walkthrough completion
		// events, the `minimax:///` URI handler in `actions.ts`) still
		// dispatch by the old id. We register them as one-line
		// forwards so every call site keeps working without a separate
		// routing table.
		vscode.commands.registerCommand('minimax.setApiKey', () =>
			vscode.commands.executeCommand('minimax.addApiKey'),
		),
		vscode.commands.registerCommand('minimax.clearApiKey', () =>
			vscode.commands.executeCommand('minimax.deleteApiKey'),
		),
		vscode.lm.registerLanguageModelChatProvider('minimax', provider),
		// The provider holds the chat-turn notifier and the internal
		// `disposed` flag. Pushing it here lets VS Code call
		// `dispose()` on deactivation — without it the notifier's
		// listener sets would keep closures alive across restarts.
		provider,
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
