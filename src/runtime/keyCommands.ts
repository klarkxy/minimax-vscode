// Command handlers for the named API key pool. Each handler is a
// thin wrapper around the shared `KeyManager` instance; the heavy
// lifting (SecretStorage, memento, region probe, endpoint sync) is
// inside the manager. The handlers exist so `commands.ts` can
// register them as `minimax.*` command IDs without bloating the
// `registerCommands` switch.

import * as vscode from 'vscode';
import { getKeyManager } from './commands';
import { getBaseUrl } from '../config';
import { t } from '../i18n';
import { logger } from '../logger';

export type KeyCommandResult = 'created' | 'switched' | 'renamed' | 'deleted' | 'cancelled' | 'failed';

/** Prompt the user for a name; returns `undefined` if they cancel or
 *  the name is already in use. The empty-string check mirrors the
 *  validation inside `KeyManager.addApiKey` so we don't bother the
 *  manager with bad input. */
async function promptForName(currentNames: ReadonlySet<string>, initial = ''): Promise<string | undefined> {
	const name = await vscode.window.showInputBox({
		prompt: t('keys.promptName'),
		placeHolder: t('keys.placeholderName'),
		value: initial,
		ignoreFocusOut: true,
		validateInput: (value: string) => {
			const trimmed = value?.trim() ?? '';
			if (!trimmed) return t('keys.emptyName');
			if (currentNames.has(trimmed)) return t('keys.duplicateName');
			return undefined;
		},
	});
	return name?.trim() || undefined;
}

/** Prompt the user for the secret. Empty values are rejected by
 *  validation so we never persist a whitespace-only key. */
async function promptForSecret(): Promise<string | undefined> {
	const secret = await vscode.window.showInputBox({
		prompt: t('keys.promptSecret'),
		placeHolder: t('keys.placeholderSecret'),
		password: true,
		ignoreFocusOut: true,
		validateInput: (value: string) => (!value?.trim() ? t('keys.emptySecret') : undefined),
	});
	return secret?.trim() || undefined;
}

/** Build a QuickPick item for each key in the pool, labelling the
 *  active entry and showing the region + fingerprint as secondary
 *  text. */
function toPickItem(key: { id: string; name: string; region: string; fingerprint: string; isLegacy: boolean; apiBaseUrl: string }, active: boolean) {
	return {
		label: key.name + (active ? `  $(check) ${t('keys.activeSuffix')}` : ''),
		description: `${key.region} • ${key.fingerprint}`,
		detail: key.isLegacy ? t('keys.legacyDetail', key.apiBaseUrl) : key.apiBaseUrl,
		keyId: key.id,
	};
}

/** `minimax.addApiKey`: ask for a name + secret, let KeyManager
 *  probe the official China/Global hosts, and persist the new
 *  entry. The new key is always set active; the previous key is
 *  remembered so the user can switch back via `Switch API Key`. */
export async function addApiKeyCommand(): Promise<KeyCommandResult> {
	const manager = getKeyManager();
	if (!manager) {
		void vscode.window.showWarningMessage(t('keys.managerUnavailable'));
		return 'failed';
	}
	const snapshot = manager.snapshot();
	const names = new Set(snapshot.keys.map((k) => k.name));
	const name = await promptForName(names);
	if (!name) return 'cancelled';
	const secret = await promptForSecret();
	if (!secret) return 'cancelled';

	try {
		const entry = await manager.addApiKey({ name, apiKey: secret, probe: true });
		await manager.updateApiBaseUrl(entry.apiBaseUrl);
		void vscode.window.showInformationMessage(
			t('keys.added', entry.name, entry.region),
		);
		return 'created';
	} catch (error) {
		logger.warn('[MiniMax keys] addApiKey failed', error);
		void vscode.window.showErrorMessage(t('keys.addFailed', (error as Error).message));
		return 'failed';
	}
}

/** `minimax.switchApiKey`: QuickPick of all named keys; selecting
 *  one makes it active AND mirrors its endpoint into
 *  `minimax.apiBaseUrl`. */
export async function switchApiKeyCommand(): Promise<KeyCommandResult> {
	const manager = getKeyManager();
	if (!manager) {
		void vscode.window.showWarningMessage(t('keys.managerUnavailable'));
		return 'failed';
	}
	const snapshot = manager.snapshot();
	if (snapshot.keys.length === 0) {
		void vscode.window.showInformationMessage(t('keys.emptyPool'));
		return 'cancelled';
	}
	const items = snapshot.keys.map((k) => toPickItem(k, k.id === snapshot.activeKeyId));
	const picked = await vscode.window.showQuickPick(items, {
		title: t('keys.switchTitle'),
		placeHolder: t('keys.switchPlaceholder'),
		ignoreFocusOut: true,
	});
	if (!picked) return 'cancelled';
	try {
		await manager.setActiveKey(picked.keyId);
		void vscode.window.showInformationMessage(t('keys.switched', picked.label));
		return 'switched';
	} catch (error) {
		logger.warn('[MiniMax keys] switchApiKey failed', error);
		void vscode.window.showErrorMessage(t('keys.switchFailed', (error as Error).message));
		return 'failed';
	}
}

/** `minimax.renameApiKey`: pick a key, then prompt for a new name.
 *  Two-step flow keeps the QuickPick short and avoids accidentally
 *  clobbering names. */
export async function renameApiKeyCommand(): Promise<KeyCommandResult> {
	const manager = getKeyManager();
	if (!manager) {
		void vscode.window.showWarningMessage(t('keys.managerUnavailable'));
		return 'failed';
	}
	const snapshot = manager.snapshot();
	if (snapshot.keys.length === 0) {
		void vscode.window.showInformationMessage(t('keys.emptyPool'));
		return 'cancelled';
	}
	const items = snapshot.keys.map((k) => toPickItem(k, k.id === snapshot.activeKeyId));
	const picked = await vscode.window.showQuickPick(items, {
		title: t('keys.renameTitle'),
		placeHolder: t('keys.renamePlaceholder'),
		ignoreFocusOut: true,
	});
	if (!picked) return 'cancelled';
	const taken = new Set(snapshot.keys.filter((k) => k.id !== picked.keyId).map((k) => k.name));
	const newName = await promptForName(taken, picked.label);
	if (!newName || newName === picked.label) return 'cancelled';
	try {
		await manager.renameApiKey(picked.keyId, newName);
		void vscode.window.showInformationMessage(t('keys.renamed', newName));
		return 'renamed';
	} catch (error) {
		logger.warn('[MiniMax keys] renameApiKey failed', error);
		void vscode.window.showErrorMessage(t('keys.renameFailed', (error as Error).message));
		return 'failed';
	}
}

/** `minimax.deleteApiKey`: pick a key, confirm, then remove both
 *  the secret and the metadata. The active key auto-falls through
 *  to the next entry inside the manager. */
export async function deleteApiKeyCommand(): Promise<KeyCommandResult> {
	const manager = getKeyManager();
	if (!manager) {
		void vscode.window.showWarningMessage(t('keys.managerUnavailable'));
		return 'failed';
	}
	const snapshot = manager.snapshot();
	if (snapshot.keys.length === 0) {
		void vscode.window.showInformationMessage(t('keys.emptyPool'));
		return 'cancelled';
	}
	const items = snapshot.keys.map((k) => toPickItem(k, k.id === snapshot.activeKeyId));
	const picked = await vscode.window.showQuickPick(items, {
		title: t('keys.deleteTitle'),
		placeHolder: t('keys.deletePlaceholder'),
		ignoreFocusOut: true,
	});
	if (!picked) return 'cancelled';
	const confirm = await vscode.window.showWarningMessage(
		t('keys.deleteConfirm', picked.label),
		{ modal: true },
		t('keys.deleteConfirmYes'),
	);
	if (confirm !== t('keys.deleteConfirmYes')) return 'cancelled';
	try {
		await manager.deleteApiKey(picked.keyId);
		void vscode.window.showInformationMessage(t('keys.deleted', picked.label));
		return 'deleted';
	} catch (error) {
		logger.warn('[MiniMax keys] deleteApiKey failed', error);
		void vscode.window.showErrorMessage(t('keys.deleteFailed', (error as Error).message));
		return 'failed';
	}
}

/** `minimax.manageApiKeys`: convenience entry point that opens
 *  the dashboard focused on the API Keys section. Currently the
 *  dashboard's webview doesn't yet render that section, so we
 *  just show an information message that links to the existing
 *  sub-commands. Once the API Keys section lands in the webview
 *  this becomes a `DashboardPanel.reveal('apiKeys')` call. */
export async function manageApiKeysCommand(): Promise<void> {
	const manager = getKeyManager();
	if (!manager) {
		void vscode.window.showWarningMessage(t('keys.managerUnavailable'));
		return;
	}
	const items: Array<vscode.QuickPickItem & { command: string }> = [
		{ label: t('keys.actionAdd'), description: t('keys.actionAddDesc'), command: 'minimax.addApiKey' },
		{ label: t('keys.actionSwitch'), description: t('keys.actionSwitchDesc'), command: 'minimax.switchApiKey' },
		{ label: t('keys.actionRename'), description: t('keys.actionRenameDesc'), command: 'minimax.renameApiKey' },
		{ label: t('keys.actionDelete'), description: t('keys.actionDeleteDesc'), command: 'minimax.deleteApiKey' },
	];
	const picked = await vscode.window.showQuickPick(items, {
		title: t('keys.manageTitle'),
		placeHolder: t('keys.managePlaceholder'),
		ignoreFocusOut: true,
	});
	if (!picked) return;
	void vscode.commands.executeCommand(picked.command);
}

/** Diagnostic helper used by the dashboard panel; returns the
 *  live snapshot of the key pool so the webview can render
 *  it. Kept here (instead of inline in `panel.ts`) so tests can
 *  import the same path the runtime uses. */
export function getKeyManagerSnapshot() {
	return getKeyManager()?.snapshot();
}

/** `getBaseUrl` is re-exported from `config` so the dashboard can
 *  render the *current* endpoint alongside the active key, even
 *  when the active key is not the one driving the URL. */
export { getBaseUrl };
