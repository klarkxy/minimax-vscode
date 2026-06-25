import * as vscode from 'vscode';
import { displayPlatformUrl } from './consts';
import { t } from './i18n';
import type { KeyManager } from './keyManager';

/**
 * Manages the MiniMax API key. Thin facade over `KeyManager` that
 * keeps the historical single-key API used across the extension
 * (`getApiKey`, `setApiKey`, `deleteApiKey`, `hasApiKey`,
 * `promptForApiKey`). New code should use `KeyManager` directly so
 * the named key pool is visible to it.
 */
export class AuthManager {
	private readonly _onDidChangeApiKey = new vscode.EventEmitter<void>();
	/** Fires whenever the API key is written, cleared, or replaced. */
	readonly onDidChangeApiKey: vscode.Event<void> = this._onDidChangeApiKey.event;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly keyManager: KeyManager,
	) {
		// Re-fire as a plain `void` event so legacy consumers don't
		// have to learn about the snapshot type.
		this.keyManager.onDidChange(() => this._onDidChangeApiKey.fire());
	}

	/**
	 * Get API key. Delegates to the active entry in `KeyManager`; if
	 * no named key is configured yet, falls back to the legacy
	 * single-key slot + `minimax.apiKey` setting.
	 */
	async getApiKey(): Promise<string | undefined> {
		return this.keyManager.getActiveApiKey();
	}

	/**
	 * Store API key. New code should call `KeyManager.addApiKey`
	 * instead so the key lands in the named pool with a name and a
	 * probed region. Kept for the `minimax.setApiKey` command and
	 * any test fixture that only knows about the legacy flow.
	 */
	async setApiKey(apiKey: string): Promise<void> {
		const trimmed = apiKey.trim();
		if (!trimmed) {
			throw new Error('API key is required');
		}
		// The legacy slot is read-only in the new model; mirror
		// historical behaviour by storing into SecretStorage and
		// letting `getApiKey` fall back to it. The pool itself is
		// untouched so we never lose the user's prior state.
		await this.context.secrets.store(
			'minimax-vscode.apiKey',
			trimmed,
		);
		this._onDidChangeApiKey.fire();
	}

	/**
	 * Delete stored API key. Mirrors the historical behaviour: only
	 * the legacy single-key slot is cleared. The named pool is
	 * preserved so the user can still use the keys they added.
	 */
	async deleteApiKey(): Promise<void> {
		await this.context.secrets.delete('minimax-vscode.apiKey');
	}

	/**
	 * Check if an API key is configured.
	 */
	async hasApiKey(): Promise<boolean> {
		const key = await this.getApiKey();
		return key !== undefined && key.length > 0;
	}

	/**
	 * Prompt user to enter API key via input box.
	 *
	 * `baseUrl` is the user's configured `minimax.apiBaseUrl` (NOT
	 * necessarily a known MiniMax host — third-party proxies are
	 * allowed). It's only used to pick the platform URL that goes
	 * into the input box prompt text. Pass the configured value
	 * verbatim; `displayPlatformUrl()` will map known hosts to
	 * `platform.minimax.io` (international) or
		 * `platform.minimaxi.com` (China) and fall back
	 * to the raw URL for unrecognised hosts.
	 */
	async promptForApiKey(baseUrl: string): Promise<boolean> {
		const apiKey = await vscode.window.showInputBox({
			prompt: t('auth.prompt', displayPlatformUrl(baseUrl)),
			placeHolder: t('auth.placeholder'),
			password: true,
			ignoreFocusOut: true,
			validateInput: (value: string) => {
				if (!value?.trim()) {
					return t('auth.emptyValidation');
				}
				return undefined;
			},
		});

		if (apiKey) {
			await this.setApiKey(apiKey);
			vscode.window.showInformationMessage(t('auth.saved'));
			return true;
		}

		return false;
	}
}
