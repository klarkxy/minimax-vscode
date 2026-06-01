import * as vscode from 'vscode';
import { t } from '../i18n';
import type { ModelDefinition } from '../types';

/**
 * Thinking-capable models are advertised with a fixed
 * `thinking: { type: 'adaptive' }` hint on the Anthropic-compatible
 * endpoint; MiniMax does **not** expose a thinking-effort knob
 * (no `budget_tokens`, no `reasoning_effort` query parameter, no
 * `reasoning_split` field on the Anthropic surface — see the
 * OpenAPI spec at
 * https://platform.minimaxi.com/docs/api-reference/text/api/openapi-chat-anthropic.json).
 * The official `Mini-Agent` reference client likewise ships with
 * `extra_body={"reasoning_split": true}` hardcoded and no UI.
 *
 * So this extension deliberately has **no** `configurationSchema`
 * dropdown for thinking depth; M3 will always run in
 * `adaptive` mode, and M2.x will always run without a typed
 * `thinking` block (its reasoning still surfaces as
 * `<think>…</think>` inside the text content).
 */
export type ThinkingEffort = 'adaptive';

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
		statusIcon: hasApiKey ? undefined : new vscode.ThemeIcon('warning'),
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
	const fmt = (n: number | null) => (n === null ? t('pricing.unlisted') : `¥${n} /M`);
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

export function getConfiguredThinkingEffort(
	_options: ModelConfigurationOptions,
): ThinkingEffort {
	// MiniMax does not expose a thinking-effort toggle on the
	// Anthropic-compatible surface (see the file header), so this
	// always resolves to the single legal value. The function is
	// kept for call-site symmetry with the request layer.
	return 'adaptive';
}

function resolveDetailKey(m: ModelDefinition): string | undefined {
	const suffix = m.id.startsWith('MiniMax-') ? m.id.slice('MiniMax-'.length) : m.id;
	const key = `model.${suffix}.detail`;
	const translated = t(key);
	return translated !== key ? key : undefined;
}
