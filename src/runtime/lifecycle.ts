import * as vscode from 'vscode';
import { t } from '../i18n';
import { logger } from '../logger';
import { MiniMaxChatProvider } from '../provider';
import { registerActionUrls } from './actions';
import {
	registerCommands,
	setCommandContext,
	setClaudeCodeIngest,
	bindChatTurnNotifier,
} from './commands';
import { autoSelectEndpointIfUnset } from './endpoint';
import { initializeDiagnostics } from './diagnostics';
import { registerProvider } from './provider';
import { getAuthManager, setMcpProvider, getMcpProvider } from './commands';
import { registerMiniMaxMcpProvider } from './mcp';
import { showWelcomeIfNeeded } from './welcome';

let activeProvider: MiniMaxChatProvider | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	setCommandContext(context);
	// One-time cleanup of memento keys left behind by the removed
	// Codex / OpenCode ingesters. The modules and their constants are
	// gone, but users who previously enabled those sources still carry
	// orphaned cursor / stats blobs in globalState. Purge them once so
	// the storage does not grow indefinitely and cannot collide with
	// future features that might reuse these key names.
	const legacyKeys = [
		'minimax-vscode.codexUsageStats',
		'minimax-vscode.codexIngestCursor',
		'minimax-vscode.opencodeUsageStats',
		'minimax-vscode.opencodeIngestSeen',
	];
	for (const key of legacyKeys) {
		try {
			await context.globalState.update(key, undefined);
		} catch {
			// Best-effort cleanup; do not block activation.
		}
	}
	await initializeDiagnostics(context);
	registerCommands(context);
	// Start the Claude Code JSONL log ingester. Independent of the
	// provider so the dashboard can show Claude Code data even if the
	// provider's API call layer never runs (e.g. user only uses
	// Claude Code CLI / Claude Code VSCode extension).
	setClaudeCodeIngest(context);
	registerActionUrls(context);

	// Register the MiniMax Web Search MCP server definition provider
	// so VS Code's MCP runtime discovers it (see src/runtime/mcp.ts).
	// This intentionally happens BEFORE the chat model provider below
	// so the dashboard's first paint can already reflect an active
	// MCP server when the user has an API key + known host. The
	// provider is a no-op when the user is on an unrecognised host
	// or has no key — the dashboard surfaces the reason separately.
	const auth = getAuthManager();
	if (auth) {
		const mcpHandle = registerMiniMaxMcpProvider(context, auth);
		context.subscriptions.push(mcpHandle);
		// Share the handle with `commands.ts` so the
		// `minimax.refreshMcp` command (and the dashboard's Refresh
		// button, which dispatches the same command) can fire
		// `onDidChangeMcpServerDefinitions` and prompt VS Code to
		// re-resolve on the next MCP call. The handle's
		// `refreshDefinitions()` is a no-op after the push'd
		// subscription above is disposed.
		setMcpProvider(mcpHandle);
	}

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
