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
				if (path === '/setApiKey' || path.endsWith('/setApiKey')) {
					await vscode.commands.executeCommand('minimax.setApiKey');
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
