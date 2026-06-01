import * as vscode from 'vscode';
import { MINIMAX_TOOLS_LIMIT } from '../consts';
import type { ModelDefinition, ModelPricing } from '../types';

const CURRENCY = 'CNY' as const;

/** Per-million-token prices scraped from platform.minimaxi.com. */
const PRICING = {
	/** M3 in the standard ≤512K tier (限 7 天五折 → 原价). */
	m3: {
		input: 4.2,
		output: 16.8,
		cacheRead: 0.84,
		cacheWrite: null,
		currency: CURRENCY,
		note: '7 天限时五折: 输入 ¥2.10 / 输出 ¥8.40 / 缓存读取 ¥0.42',
	} satisfies ModelPricing,
	/** M3 in the >512K tier (限量供应, 需联系销售). */
	m3Large: {
		input: 8.4,
		output: 33.6,
		cacheRead: 1.68,
		cacheWrite: null,
		currency: CURRENCY,
		note: '>512K 输入限量供应，需联系销售；预计数日后全量开放',
	} satisfies ModelPricing,
	m27: {
		input: 2.1,
		output: 8.4,
		cacheRead: 0.42,
		cacheWrite: 2.625,
		currency: CURRENCY,
	} satisfies ModelPricing,
	m27Highspeed: {
		input: 4.2,
		output: 16.8,
		cacheRead: 0.42,
		cacheWrite: 2.625,
		currency: CURRENCY,
	} satisfies ModelPricing,
};

/**
 * Model registry.
 *
 * MiniMax officially recommends M3 and M2.7 for new Token Plan users.
 * M2.5 / M2.1 / M2 are historical models and are not exposed by the
 * picker; users on those models can still drive the extension by adding
 * the corresponding ID to `minimax.modelIdOverrides` and
 * `minimax.visibleModels` once the registration is reinstated upstream.
 *
 * Note on M3: the official spec is 1M context, but the >512K input tier
 * is currently 限时限量供应 and the API rejects requests with
 * `max_tokens > 512_000`. We therefore advertise 1M as the headline
 * figure (so VS Code shows the model's true ambition) but cap effective
 * input and output at 512K until the rollout completes.
 */
export const MODELS: ModelDefinition[] = [
	{
		id: 'MiniMax-M3',
		name: 'MiniMax M3',
		family: 'minimax',
		version: '3',
		detail: 'Native multimodal frontier coding model (1M context, 512K effective)',
		contextLength: 1_000_000,
		maxInputTokens: 512_000,
		maxOutputTokens: 512_000,
		capabilities: {
			toolCalling: MINIMAX_TOOLS_LIMIT,
			imageInput: true,
			videoInput: true,
			thinking: true,
		},
		thinking: {
			supportsBudget: false,
			supportsAdaptive: true,
		},
		pricing: PRICING.m3,
	},
	{
		id: 'MiniMax-M2.7',
		name: 'MiniMax M2.7',
		family: 'minimax',
		version: '2.7',
		detail: 'Self-iterating coding model (~60 TPS)',
		contextLength: 204_800,
		maxInputTokens: 196_608,
		maxOutputTokens: 131_072,
		capabilities: {
			toolCalling: MINIMAX_TOOLS_LIMIT,
			imageInput: false,
			thinking: true,
		},
		thinking: {
			supportsBudget: false,
			supportsAdaptive: false,
		},
		pricing: PRICING.m27,
	},
	{
		id: 'MiniMax-M2.7-highspeed',
		name: 'MiniMax M2.7 (High-Speed)',
		family: 'minimax',
		version: '2.7-highspeed',
		detail: 'M2.7 high-speed: same quality, faster (~100 TPS)',
		contextLength: 204_800,
		maxInputTokens: 196_608,
		maxOutputTokens: 131_072,
		capabilities: {
			toolCalling: MINIMAX_TOOLS_LIMIT,
			imageInput: false,
			thinking: true,
		},
		thinking: {
			supportsBudget: false,
			supportsAdaptive: false,
		},
		pricing: PRICING.m27Highspeed,
	},
];

/** Models visible in the model picker (filtered by `minimax.visibleModels`). */
export function getVisibleModels(): readonly ModelDefinition[] {
	const config = vscode.workspace.getConfiguration('minimax');
	const raw = config.get<unknown>('visibleModels');
	if (!Array.isArray(raw)) {
		return MODELS;
	}
	const configuredIds = new Set(
		raw.filter((value): value is string => typeof value === 'string'),
	);
	const visible = MODELS.filter((m) => configuredIds.has(m.id));
	return visible.length > 0 ? visible : MODELS;
}

export function findModelById(id: string): ModelDefinition | undefined {
	return MODELS.find((m) => m.id === id);
}
