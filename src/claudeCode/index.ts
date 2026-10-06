import * as vscode from 'vscode';
import type { KeyManager } from '../keyManager';
import { ClaudeCodeBridge, pickHaikuModel, setRoutingEnabled, showClaudeCodeMenu } from './bridge';

/** Start Claude Code routing and register its commands. */
export function registerClaudeCodeBridge(context: vscode.ExtensionContext, keyManager: KeyManager): ClaudeCodeBridge {
	const bridge = new ClaudeCodeBridge(context, keyManager);
	context.subscriptions.push(
		bridge,
		vscode.commands.registerCommand('minimax.claudeCode.menu', () => showClaudeCodeMenu(bridge)),
		vscode.commands.registerCommand('minimax.claudeCode.enableRouting', () => setRoutingEnabled(true)),
		vscode.commands.registerCommand('minimax.claudeCode.disableRouting', () => setRoutingEnabled(false)),
		vscode.commands.registerCommand('minimax.claudeCode.selectHaikuModel', () => pickHaikuModel()),
	);
	void bridge.refresh();
	return bridge;
}
