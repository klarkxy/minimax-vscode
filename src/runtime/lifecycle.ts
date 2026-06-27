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
	getKeyManager,
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

	// One-time upgrade of the legacy single-key slot (`minimax-vscode.apiKey`)
	// into the named pool. Idempotent across windows — if another window
	// already migrated, this is a no-op. After migration we fire-and-forget
	// a region probe so the user does not have to re-enter their key or
	// manually pick a host. The probe is intentionally non-blocking: the
	// request path falls back to the configured `minimax.apiBaseUrl` while
	// the probe is in flight, so the very first request still works.
	try {
		const km = getKeyManager();
		const migration = await km.migrateLegacySecret();
		if (migration.result === 'migrated') {
			logger.info(
				`[MiniMax] Migrated legacy single-key slot into named pool (${migration.id}); running async region probe.`,
			);
			void km.reprobeActiveKey().catch((error) => {
				logger.warn('[MiniMax] Async probe after legacy migration failed', error);
			});
		}
	} catch (error) {
		logger.warn('[MiniMax] Legacy key migration failed', error);
	}

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
	//
	// The MCP provider receives the active-key URL resolver so the
	// server definition it injects matches the chat request host on
	// every `provide` / `resolve` call — otherwise switching the
	// active key would split-brain the chat request host from the
	// MCP spawn env (the manual `minimax.refreshMcp` command path
	// already does this; we close the auto-resolve path here).
	const auth = getAuthManager();
	if (auth) {
		const mcpHandle = registerMiniMaxMcpProvider(context, auth, {
			getApiBaseUrl: () => getKeyManager().getActiveApiBaseUrl(),
		});
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
	// once the user has explicitly chosen an endpoint (via the setting). It
	// primes `minimax.apiBaseUrl` only on a clean install so the request
	// path's setting fallback works until `reprobeActiveKey()` finishes.
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
