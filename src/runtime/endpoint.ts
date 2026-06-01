import * as vscode from 'vscode';
import { CONFIG_SECTION, DEFAULT_BASE_URL_CHINA, DEFAULT_BASE_URL_GLOBAL } from '../consts';
import { logger } from '../logger';

/**
 * Pick the default Anthropic-compatible base URL based on the VS Code
 * display language. The heuristic is intentionally simple — it is a
 * best-effort default that the user can always override through the
 * `minimax.switchToGlobal` / `minimax.switchToChina` commands or the
 * `minimax.apiBaseUrl` setting.
 *
 *   - `zh*` (Simplified / Traditional Chinese, Hong Kong, Singapore, etc.)
 *     → China endpoint (lower latency, paid in CNY).
 *   - everything else
 *     → Global endpoint.
 */
export function pickDefaultBaseUrlForDisplayLanguage(
	language: string,
): { url: string; isChina: boolean } {
	const normalised = language.toLowerCase();
	if (normalised.startsWith('zh')) {
		return { url: DEFAULT_BASE_URL_CHINA, isChina: true };
	}
	return { url: DEFAULT_BASE_URL_GLOBAL, isChina: false };
}

/**
 * Auto-set `minimax.apiBaseUrl` from the VS Code display language, but
 * only when the user has never configured it. This keeps the call a
 * no-op for users who have already picked an endpoint explicitly.
 *
 * Returns the URL that ended up in effect (either the newly set one or
 * the existing user choice).
 */
export async function autoSelectEndpointIfUnset(
	inspect: () => vscode.WorkspaceConfiguration = () => vscode.workspace.getConfiguration(CONFIG_SECTION),
): Promise<{ url: string; source: 'auto' | 'user' | 'default' }> {
	const config = inspect();
	const inspection = config.inspect<string>('apiBaseUrl');

	const userValue = pickUserConfiguredValue(inspection);
	if (userValue !== undefined) {
		return { url: userValue, source: 'user' };
	}

	const { url, isChina } = pickDefaultBaseUrlForDisplayLanguage(vscode.env.language);
	const currentlyInEffect = config.get<string>('apiBaseUrl') ?? '';
	if (currentlyInEffect === url) {
		return { url, source: 'default' };
	}

	try {
		await config.update('apiBaseUrl', url, vscode.ConfigurationTarget.Global);
		logger.info(
			`Auto-selected ${isChina ? 'China' : 'Global'} Anthropic endpoint based on display language "${vscode.env.language}" → ${url}`,
		);
		return { url, source: 'auto' };
	} catch (error) {
		logger.warn('Failed to auto-select Anthropic endpoint', error);
		return { url: currentlyInEffect, source: 'default' };
	}
}

/**
 * Read the inspect() result and return the first non-empty user-set
 * value (workspace scope beats global scope). `undefined` means the
 * user has never configured it.
 */
function pickUserConfiguredValue(
	inspection: ReturnType<vscode.WorkspaceConfiguration['inspect']> | undefined,
): string | undefined {
	if (!inspection) {
		return undefined;
	}
	const candidates = [
		inspection.workspaceFolderValue,
		inspection.workspaceValue,
		inspection.globalValue,
	];
	for (const candidate of candidates) {
		if (typeof candidate === 'string' && candidate.trim().length > 0) {
			return candidate.trim();
		}
	}
	return undefined;
}
