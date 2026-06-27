import * as vscode from 'vscode';
import { setErrorActionUrl } from '../client';

/**
 * Wire the error-action URLs used by the client error mapper to the extension
 * commands registered in commands.ts. This lets HTTP/network errors embed
 * working "Set API Key" / "Show Logs" links in their markdown summaries.
 *
 * The `configureApiKey` URI (`/setApiKey`) is @deprecated: it dispatches the
 * legacy `minimax.setApiKey` command, which is itself a runtime alias of
 * `minimax.addApiKey`. New error copy should prefer the same alias path so
 * the embedded link stays working without binding future code to a retired
 * command id — at the cost of one extra hop through the URI handler.
 */
export function initializeDiagnostics(context: vscode.ExtensionContext): void {
	const extensionUri = context.extensionUri;

	setErrorActionUrl('configureApiKey', `${extensionUri.scheme}://${extensionUri.authority}/setApiKey`);
	setErrorActionUrl('showLogs', `${extensionUri.scheme}://${extensionUri.authority}/showLogs`);
}
