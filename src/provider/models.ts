import * as vscode from 'vscode';
import { t } from '../i18n';
import type { ModelDefinition } from '../types';

/**
 * Thinking effort levels exposed in the model picker dropdown.
 *
 * Mapping to MiniMax API:
 *   - `none`  → M3: thinking disabled, no reasoning_split on M2.x
 *   - `low`   → M3: thinking enabled with small budget; M2.x: reasoning_split=true
 *   - `high`  → M3: thinking enabled with standard budget; M2.x: reasoning_split=true (default)
 *   - `max`   → M3: thinking enabled with deep budget; M2.x: reasoning_split=true
 *
 * Non-public API surface: `configurationSchema` on chat info and
 * `modelConfiguration` on response options are not part of the stable
 * `vscode.LanguageModelChat*` typings yet.
 */

export type ThinkingEffort = 'none' | 'low' | 'high' | 'max';

export type ModelConfigurationOptions = vscode.ProvideLanguageModelChatResponseOptions & {
	readonly modelConfiguration?: Record<string, unknown>;
	readonly configuration?: Record<string, unknown>;
};

type ThinkingEffortConfigurationSchema = ReturnType<typeof buildThinkingEffortSchema>;

export type ModelPickerChatInformation = vscode.LanguageModelChatInformation & {
	readonly isUserSelectable: boolean;
	readonly statusIcon?: vscode.ThemeIcon;
	readonly configurationSchema?: ThinkingEffortConfigurationSchema;
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
		...(m.capabilities.thinking ? { configurationSchema: buildThinkingEffortSchema() } : {}),
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
	options: ModelConfigurationOptions,
): ThinkingEffort {
	const configuredEffort =
		options.modelConfiguration?.reasoningEffort ?? options.configuration?.reasoningEffort;

	if (
		configuredEffort === 'none' ||
		configuredEffort === 'low' ||
		configuredEffort === 'high' ||
		configuredEffort === 'max'
	) {
		return configuredEffort;
	}

	return 'high';
}

function buildThinkingEffortSchema() {
	return {
		properties: {
			reasoningEffort: {
				type: 'string',
				title: t('status.thinking'),
				enum: ['none', 'low', 'high', 'max'],
				enumItemLabels: [
					t('thinking.none'),
					t('thinking.low'),
					t('thinking.high'),
					t('thinking.max'),
				],
				enumDescriptions: [
					t('thinking.none.desc'),
					t('thinking.low.desc'),
					t('thinking.high.desc'),
					t('thinking.max.desc'),
				],
				default: 'high',
				group: 'navigation',
			},
		},
	} as const;
}

function resolveDetailKey(m: ModelDefinition): string | undefined {
	const suffix = m.id.startsWith('MiniMax-') ? m.id.slice('MiniMax-'.length) : m.id;
	const key = `model.${suffix}.detail`;
	const translated = t(key);
	return translated !== key ? key : undefined;
}
