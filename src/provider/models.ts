import * as vscode from 'vscode';
import { CONFIG_SECTION } from '../consts';
import { t } from '../i18n';
import type { ModelDefinition } from '../types';

/**
 * Thinking-capable models advertise a binary `thinking` switch on the
 * Anthropic-compatible endpoint (see the docs at
 * https://platform.minimaxi.com/docs/api-reference/text-anthropic-api):
 *   - `adaptive` — keep the default reasoning trace
 *   - `disabled` — turn the typed `thinking` block off (M3 only;
 *     M2.x will keep thinking on regardless, per the docs)
 *
 * MiniMax does **not** expose a thinking-effort knob (no
 * `budget_tokens`, no `reasoning_effort`, no `reasoning_split` field
 * on the Anthropic surface). The `Mini-Agent` reference client
 * hardcodes `extra_body={"reasoning_split": true}` and ships no UI.
 *
 * The on/off switch is exposed via the `minimax.thinking.enabled`
 * setting (see `package.json`); a dedicated `minimax.toggleThinking`
 * command flips it in one click. An earlier draft attempted to put
 * the switch in Copilot Chat's per-model `configurationSchema`
 * dropdown, but the host treats the dropdown's `default` field as
 * canonical on every re-render — the user's first click was
 * silently overridden. The settings + command pair is reliable.
 */
export type ThinkingEffort = 'adaptive' | 'disabled';

export type ModelConfigurationOptions = vscode.ProvideLanguageModelChatResponseOptions & {
	readonly modelConfiguration?: Record<string, unknown>;
	readonly configuration?: Record<string, unknown>;
};

export type ModelPickerChatInformation = vscode.LanguageModelChatInformation & {
	readonly isUserSelectable: boolean;
	readonly statusIcon?: vscode.ThemeIcon;
};

export function toChatInfo(
	m: ModelDefinition,
	hasApiKey: boolean,
): ModelPickerChatInformation {
	const detailKey = resolveDetailKey(m);
	const modelDetail = detailKey ? t(detailKey) : m.detail;
	// The thinking on/off dropdown was attempted via Copilot Chat's
	// per-model `configurationSchema` (see the file header) but the
	// host re-applies the schema `default` on every render, which
	// silently overrode the user's first click. We removed the
	// dropdown entirely; the on/off switch is now driven by the
	// `minimax.thinking.enabled` setting + the `minimax.toggleThinking`
	// command, both of which behave predictably.
	return {
		id: m.id,
		name: m.name,
		family: m.family,
		version: m.version,
		// The model picker "cost" column is rendered by Copilot Chat from a
		// fixed `detail` regex (e.g. `Position: 100 / Output: 500 / Cache: 10`).
		// Our per-million-token prices don't fit that schema, so we keep
		// `detail` to a short human description and surface pricing in the
		// tooltip + via the **MiniMax: Show Pricing** command.
			detail: hasApiKey ? modelDetail : t('auth.apiKeyRequiredDetail'),
		tooltip: hasApiKey
			? `${modelDetail}\n\n${formatPricingTooltip(m)}`
			: t('auth.apiKeyRequiredDetail'),
		statusIcon: !hasApiKey ? new vscode.ThemeIcon('warning') : undefined,
		maxInputTokens: m.maxInputTokens,
		maxOutputTokens: m.maxOutputTokens,
		isUserSelectable: true,
		capabilities: {
			toolCalling: m.capabilities.toolCalling,
			imageInput: m.capabilities.imageInput,
		},
	};
}

function formatPricingTooltip(m: ModelDefinition): string {
	const { pricing, contextLength, maxInputTokens, maxOutputTokens } = m;
	const symbol = pricing.currency === 'USD' ? '$' : '¥';
	const fmt = (n: number | null) => (n === null ? t('pricing.unlisted') : `${symbol}${n} /M`);
	const lines = [
		`Context: ${formatNumber(contextLength)} (effective: ${formatNumber(maxInputTokens)})`,
		`Output cap: ${formatNumber(maxOutputTokens)}`,
		`Input: ${fmt(pricing.input)}`,
		`Output: ${fmt(pricing.output)}`,
		`Cache read: ${fmt(pricing.cacheRead)}`,
		`Cache write: ${fmt(pricing.cacheWrite)}`,
	];
	if (pricing.note) {
		lines.push('', pricing.note);
	}
	return lines.join('\n');
}

function formatNumber(n: number): string {
	return n.toLocaleString('en-US');
}

/**
 * Build a per-model configuration schema for the binary thinking
 * on/off switch. Copilot Chat renders this as a dropdown inside the
 * model picker when you click an M3 row. The user's selection appears
 * in `options.modelConfiguration.reasoningMode` on the next
 * `provideLanguageModelChatResponse` call.
 *
 * MiniMax's Anthropic surface only exposes two values:
 *   - `adaptive` (default) — emit typed `thinking` block
 *   - `disabled` — suppress the typed block (M3 only; M2.x ignores it)
 *
 * There is no intensity knob (`budget_tokens`, `reasoning_effort`),
 * so we keep the dropdown to a simple on/off choice. See
 * `buildThinkingSchema()` below for the actual schema definition.
 */

/**
 * Resolve the per-model thinking switch. The decision is made in two
 * steps:
 *   1. M2.x always returns `'adaptive'` (the docs say M2.x thinking
 *      cannot be turned off — sending `disabled` is a no-op).
 *   2. For M3 we read the `minimax.thinking.enabled` setting, which
 *      the user can flip from the Settings UI or via the
 *      `minimax.toggleThinking` command. The setting is the single
 *      source of truth.
 *
 * An earlier draft tried to use Copilot Chat's per-model
 * `configurationSchema` dropdown (matching the DeepSeek-for-Copilot
 * pattern). In practice the host re-applies the schema `default`
 * on every re-render, so the user's first click was silently
 * overridden and the second click flipped back to On. The setting
 * is the reliable path.
 */
export function getConfiguredThinkingEffort(
	modelId: string,
	_options?: ModelConfigurationOptions,
): ThinkingEffort {
	if (modelId !== 'MiniMax-M3') {
		return 'adaptive';
	}
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const enabled = config.get<boolean>('thinking.enabled', true);
	return enabled ? 'adaptive' : 'disabled';
}

/**
 * Flip the `minimax.thinking.enabled` setting and surface a
 * localised toast so the user gets a visible confirmation. Returns
 * the new value.
 *
 * Exposed as a `minimax.toggleThinking` command so the user can pin
 * a keybinding to it. The setting is the single source of truth for
 * thinking on M3; M2.x always stays adaptive and the toggle is a
 * no-op for it.
 */
export async function toggleThinkingEnabled(): Promise<boolean> {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const current = config.get<boolean>('thinking.enabled', true);
	const next = !current;
	await config.update('thinking.enabled', next, vscode.ConfigurationTarget.Global);
	vscode.window.showInformationMessage(
		next ? t('thinking.toggledOn') : t('thinking.toggledOff'),
	);
	return next;
}

function resolveDetailKey(m: ModelDefinition): string | undefined {
	const suffix = m.id.startsWith('MiniMax-') ? m.id.slice('MiniMax-'.length) : m.id;
	const key = `model.${suffix}.detail`;
	const translated = t(key);
	return translated !== key ? key : undefined;
}
