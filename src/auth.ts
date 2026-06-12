import * as vscode from 'vscode';
import { API_KEY_SECRET, displayPlatformUrl } from './consts';
import { t } from './i18n';

/**
 * Manages the MiniMax API key via VS Code SecretStorage (secure) with
 * fallback to extension settings (less secure, for CI/automation).
 */
export class AuthManager {
	private readonly _onDidChangeApiKey = new vscode.EventEmitter<void>();
	/** Fires whenever the API key is written, cleared, or replaced. */
	readonly onDidChangeApiKey: vscode.Event<void> = this._onDidChangeApiKey.event;

	constructor(private readonly context: vscode.ExtensionContext) {}

	/**
	 * Get API key. Tries SecretStorage first, then falls back to settings.
	 */
	async getApiKey(): Promise<string | undefined> {
		const secretKey = await this.context.secrets.get(API_KEY_SECRET);
		if (secretKey) {
			return secretKey;
		}

		const config = vscode.workspace.getConfiguration('minimax');
		const settingsKey = config.get<string>('apiKey');
		if (settingsKey?.trim()) {
			return settingsKey.trim();
		}

		return undefined;
	}

	/**
	 * Store API key in SecretStorage.
	 */
	async setApiKey(apiKey: string): Promise<void> {
		await this.context.secrets.store(API_KEY_SECRET, apiKey.trim());
		this._onDidChangeApiKey.fire();
	}

	/**
	 * Delete stored API key.
	 */
	async deleteApiKey(): Promise<void> {
		await this.context.secrets.delete(API_KEY_SECRET);
		this._onDidChangeApiKey.fire();
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
