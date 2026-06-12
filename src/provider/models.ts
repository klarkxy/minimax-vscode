import * as vscode from 'vscode';
import { CONFIG_SECTION } from '../consts';
import { t } from '../i18n';
import type { ModelDefinition, PriceCategory } from '../types';

/**
 * Thinking-capable models advertise a binary `thinking` switch on the
 * Anthropic-compatible endpoint (see the docs at
 * https://platform.minimax.io/docs/api-reference/text-anthropic-api):
 *   - `adaptive` — keep the default reasoning trace
 *   - `disabled` — turn the typed `thinking` block off (M3 only;
 *     M2.x will keep thinking on regardless, per the docs)
 *
 * MiniMax does **not** expose a thinking-effort knob (no
 * `budget_tokens`, no `reasoning_effort`, no `reasoning_split` field
 * on the Anthropic surface). The `Mini-Agent` reference client
 * hardcodes `extra_body={"reasoning_split": true}` and ships no UI.
 *
 * The on/off switch is surfaced in Copilot Chat's model picker as a
 * per-model `configurationSchema` dropdown — the same path
 * `deepseek-v4-for-copilot` uses for its `reasoningEffort` selector.
 * The user's choice rides on the next chat request inside
 * `options.modelConfiguration[THINKING_ENABLED_KEY]`; the request
 * layer (`getConfiguredThinkingEffort`) is the single reader. The
 * dropdown is the only UI — there is no separate command or
 * setting, matching the deepseek pattern.
 */
export type ThinkingEffort = 'adaptive' | 'disabled';

/**
 * Schema key for the thinking on/off dropdown. Copilot Chat reads
 * `options.modelConfiguration[KEY]` on every `provideLanguageModelChatResponse`
 * call to learn the user's selection; we keep the name in lock-step
 * with the schema property below so the picker UI and the request
 * layer agree on the field name.
 */
export const THINKING_ENABLED_KEY = 'thinkingEnabled';

export type ModelConfigurationOptions = vscode.ProvideLanguageModelChatResponseOptions & {
	readonly modelConfiguration?: Record<string, unknown>;
	readonly configuration?: Record<string, unknown>;
};

/**
 * Cost metadata fields read by Copilot Chat's model picker to render
 * the price column. Mirror of deepseek-v4-for-copilot's ModelCostInformation.
 *
 * - inputCost  ← pricing.input (non-cached input per million tokens)
 * - outputCost ← pricing.output
 * - cacheCost  ← pricing.cacheRead (cached input per million tokens)
 * - priceCategory emitted only with concrete pricing; omitted when
 *   any component is missing or null so the picker shows nothing
 *   rather than misleading partial data.
 */
export interface ModelCostInformation {
	readonly inputCost?: string;
	readonly outputCost?: string;
	readonly cacheCost?: string;
	readonly priceCategory?: PriceCategory;
}

export type ModelPickerChatInformation = vscode.LanguageModelChatInformation &
	ModelCostInformation & {
		readonly isUserSelectable: boolean;
		readonly statusIcon?: vscode.ThemeIcon;
		readonly configurationSchema?: vscode.LanguageModelConfigurationSchema;
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
		statusIcon: !hasApiKey ? new vscode.ThemeIcon('warning') : undefined,
		maxInputTokens: m.maxInputTokens,
		maxOutputTokens: m.maxOutputTokens,
		isUserSelectable: true,
		capabilities: {
			toolCalling: m.capabilities.toolCalling,
			imageInput: m.capabilities.imageInput,
		},
		// The on/off switch is a per-model dropdown rendered by Copilot
		// Chat from this schema. It writes the user's choice into
		// `options.modelConfiguration[THINKING_ENABLED_KEY]` on the
		// next request, which `getConfiguredThinkingEffort` reads back.
		// Mirrors the `deepseek-v4-for-copilot` reasoningEffort dropdown
		// — the dropdown is the single source of truth, no fallback
		// setting or command is required.
		// We only attach the schema to models whose `thinking.supportsAdaptive`
		// flag is true — M2.x is also a "thinking" model by capability
		// but the API silently ignores `disabled` for the M2 family, so
		// showing a toggle on M2.x would be a misleading no-op.
		...(m.thinking.supportsAdaptive
			? { configurationSchema: buildThinkingEnabledSchema() }
			: {}),
		...toModelCostInfo(m),
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

/**
 * Build the cost metadata that Copilot Chat renders in the model picker's
 * price column. Populated from the resolved per-million-token prices so
 * the picker shows a live cost summary, matching the deepseek pattern.
 */
function toModelCostInfo(m: ModelDefinition): ModelCostInformation {
	const { pricing, priceCategory } = m;
	if (pricing.input === null || pricing.output === null) {
		return {};
	}
	const symbol = pricing.currency === 'USD' ? '$' : '¥';
	return {
		...(priceCategory ? { priceCategory } : {}),
		inputCost: `${symbol}${pricing.input}`,
		outputCost: `${symbol}${pricing.output}`,
		cacheCost: pricing.cacheRead !== null ? `${symbol}${pricing.cacheRead}` : undefined,
	};
}

function formatNumber(n: number): string {
	return n.toLocaleString('en-US');
}

/**
 * Build the per-model thinking on/off dropdown schema. Copilot Chat
 * renders it as a row beneath the model name in the picker. The
 * user's selection is delivered on the next chat request as
 * `options.modelConfiguration[THINKING_ENABLED_KEY]`.
 *
 * MiniMax's Anthropic surface only exposes two values for
 * `thinking.type` — `adaptive` (default) and `disabled` — so the
 * dropdown is a simple boolean rather than the four-level effort
 * scale that DeepSeek V4 exposes.
 */
function buildThinkingEnabledSchema(): vscode.LanguageModelConfigurationSchema {
	return {
		properties: {
			[THINKING_ENABLED_KEY]: {
				type: 'string',
				title: t('status.thinking'),
				enum: ['true', 'false'],
				enumItemLabels: [t('thinking.on'), t('thinking.off')],
				enumDescriptions: [t('thinking.on.desc'), t('thinking.off.desc')],
				default: 'true',
				group: 'navigation',
			},
		},
	} as vscode.LanguageModelConfigurationSchema;
}

/**
 * Resolve the per-model thinking switch. The decision is made in
 * two steps:
 *
 *   1. If the model is M2.x, return `'adaptive'`. The docs say
 *      M2.x thinking cannot be turned off — sending `disabled` is
 *      a no-op — so we ignore the user's selection for that family.
 *   2. Otherwise read the per-call `modelConfiguration[thinkingEnabled]`
 *      the Copilot Chat picker supplies. The dropdown is the single
 *      source of truth; absent the field (e.g. a misbehaving host
 *      that skipped the schema write-back) we default to `'adaptive'`.
 */
export function getConfiguredThinkingEffort(
	modelId: string,
	options?: ModelConfigurationOptions,
): ThinkingEffort {
	if (modelId !== 'MiniMax-M3') {
		return 'adaptive';
	}
	const configured = options?.modelConfiguration?.[THINKING_ENABLED_KEY]
		?? options?.configuration?.[THINKING_ENABLED_KEY];
	if (typeof configured === 'string') {
		if (configured === 'false') return 'disabled';
		if (configured === 'true') return 'adaptive';
	}
	if (typeof configured === 'boolean') {
		return configured ? 'adaptive' : 'disabled';
	}
	return 'adaptive';
}

/**
 * Flip the `minimax.enableM31MContext` setting. The boolean controls
 * whether the **MiniMax-M3** entry in the model picker advertises the
 * safe 512K default (`false`) or the official 1M cap (`true`).
 *
 * Going on is **destructive** in three ways:
 *
 * 1. The picker immediately advertises 1M, so VS Code's
 *    "上下文窗口" indicator shows `N / 1M` instead of `N / 512K`.
 * 2. Requests above 512K will be billed at **2× the per-token rate**
 *    (see the [pricing page][pp]).
 * 3. The >512K input tier is in limited rollout — accounts without
 *    explicit sales-granted access will get HTTP 400 from the API.
 *
 * The user must explicitly opt in via the `minimax.toggleM31MContext`
 * command (this function). The command pops a modal warning before
 * flipping the setting; going through the command (rather than
 * editing `settings.json` directly) is what makes the warning visible.
 * Toggling off is unconditional — once off, the picker immediately
 * returns to the safe 512K default.
 *
 * [pp]: https://platform.minimax.io/docs/guides/pricing-paygo
 *
 * Returns the new boolean value.
 */
export async function toggleM31MContextEnabled(): Promise<boolean | undefined> {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const current = config.get<boolean>('enableM31MContext', false);
	const next = !current;
	if (next) {
		// Pop a modal warning before flipping on. The user has to click
		// "I understand" for the setting to change; cancel returns
		// `undefined` and leaves the setting untouched. The `title` is
		// baked into the body string because `showWarningMessage`'s
		// `MessageOptions` only supports `detail` and `modal`, not a
		// custom `title`.
		const confirmed = await vscode.window.showWarningMessage(
			`${t('m31m.warning.title')}\n\n${t('m31m.warning.body')}`,
			{ modal: true },
			t('m31m.warning.confirm'),
		);
		if (confirmed !== t('m31m.warning.confirm')) {
			return undefined;
		}
	}
	await config.update('enableM31MContext', next, vscode.ConfigurationTarget.Global);
	vscode.window.showInformationMessage(
		next ? t('m31m.toggledOn') : t('m31m.toggledOff'),
	);
	return next;
}

function resolveDetailKey(m: ModelDefinition): string | undefined {
	const suffix = m.id.startsWith('MiniMax-') ? m.id.slice('MiniMax-'.length) : m.id;
	const key = `model.${suffix}.detail`;
	const translated = t(key);
	return translated !== key ? key : undefined;
}
