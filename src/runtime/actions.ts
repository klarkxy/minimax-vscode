import * as vscode from 'vscode';

/**
 * Register deep-link actions (e.g. minimax:///setApiKey, minimax:///showLogs).
 * Hosts such as the Copilot Chat welcome page or error notifications can
 * open these URIs to trigger extension commands without an explicit command
 * palette invocation.
 */
export function registerActionUrls(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.window.registerUriHandler({
			handleUri: async (uri: vscode.Uri) => {
				const path = uri.path;
				// `/setApiKey` is @deprecated. The historical URI is
				// embedded in error toasts ("Set API Key" buttons in
				// the 401/402 user-facing copy) that have already been
				// published, so we keep the handler dispatching — but
				// every new entry point should mint a `/addApiKey` URI
				// or, preferably, dispatch the command id directly
				// rather than going through `minimax:///`.
				if (path === '/setApiKey' || path.endsWith('/setApiKey')) {
					await vscode.commands.executeCommand('minimax.setApiKey');
					return;
				}
				if (path === '/addApiKey' || path.endsWith('/addApiKey')) {
					await vscode.commands.executeCommand('minimax.addApiKey');
					return;
				}
				if (path === '/showLogs' || path.endsWith('/showLogs')) {
					await vscode.commands.executeCommand('minimax.showLogs');
					return;
				}
				if (path === '/openRequestDumpsFolder' || path.endsWith('/openRequestDumpsFolder')) {
					await vscode.commands.executeCommand('minimax.openRequestDumpsFolder');
					return;
				}
			},
		}),
	);
}
