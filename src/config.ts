import * as vscode from 'vscode';
import { CONFIG_SECTION, DEFAULT_BASE_URL_GLOBAL } from './consts';

export type DebugMode = 'minimal' | 'metadata' | 'verbose';

/**
 * Get the MiniMax Anthropic-compatible API base URL. The Anthropic SDK
 * appends `/v1/messages` automatically, so the configured URL is the host
 * prefix (e.g. `https://api.minimaxi.com/anthropic`).
 *
 * Defaults to the international endpoint when not configured.
 */
export function getBaseUrl(): string {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const url = config.get<string>('apiBaseUrl');
	if (typeof url === 'string' && url.trim().length > 0) {
		return url.trim();
	}
	return DEFAULT_BASE_URL_GLOBAL;
}

/**
 * Resolve the API model ID to send to the endpoint.
 *
 * Users can override model IDs via the `modelIdOverrides` setting object
 * (e.g. for third-party API proxies). Falls back to the VS Code model ID
 * when no override is configured.
 */
export function getApiModelId(vscodeModelId: string): string {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const overrides = config.get<Record<string, string>>('modelIdOverrides');
	const override = overrides?.[vscodeModelId]?.trim();
	return override || vscodeModelId;
}

/**
 * Diagnostic mode. `verbose` also enables metadata logs.
 */
export function getDebugMode(): DebugMode {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	return normalizeDebugMode(config.get<unknown>('debugMode')) ?? 'minimal';
}

/**
 * Whether to log privacy-preserving diagnostic debug information.
 */
export function getDebugLoggingEnabled(): boolean {
	return getDebugMode() !== 'minimal';
}

/**
 * Whether to write full MiniMax request payloads to disk.
 */
export function getRequestDumpEnabled(): boolean {
	return getDebugMode() === 'verbose';
}

/**
 * Resolve the configured max output tokens limit.
 * Returns `undefined` when set to 0 (API default — no limit).
 */
export function getMaxTokens(): number | undefined {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const value = config.get<number>('maxTokens', 0);
	return value > 0 ? value : undefined;
}

export function getStabilizeToolListEnabled(): boolean {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	return config.get<boolean>('experimental.stabilizeToolList', false);
}

function normalizeDebugMode(value: unknown): DebugMode | undefined {
	if (value === 'minimal' || value === 'metadata' || value === 'verbose') {
		return value;
	}
	return undefined;
}
