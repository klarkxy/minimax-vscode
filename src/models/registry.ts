import * as vscode from 'vscode';
import { MINIMAX_TOOLS_LIMIT } from '../consts';
import type { ModelDefinition, ModelPricing } from '../types';

/**
 * Per-million-token prices scraped from the official pricing pages.
 *
 * - CNY (¥) — https://platform.minimaxi.com/docs/guides/pricing-paygo
 * - USD ($) — https://platform.minimax.io/docs/guides/pricing-paygo
 *
 * `MODELS` references a key into these tables; the actual `pricing`
 * field attached to a `ModelDefinition` is resolved at runtime via
 * `localizeModelPricing()` based on the user's `minimax.apiBaseUrl` and
 * `vscode.env.language`.
 */
type PricingKey = 'm3' | 'm3Large' | 'm27' | 'm27Highspeed';

const PRICING_CNY: Record<PricingKey, ModelPricing> = {
	/** M3 in the standard ≤512K tier (限 7 天五折 → 原价). */
	m3: {
		input: 4.2,
		output: 16.8,
		cacheRead: 0.84,
		cacheWrite: null,
		currency: 'CNY',
		note: '7 天限时五折: 输入 ¥2.10 / 输出 ¥8.40 / 缓存读取 ¥0.42',
	},
	/** M3 in the >512K tier (限量供应, 需联系销售). */
	m3Large: {
		input: 8.4,
		output: 33.6,
		cacheRead: 1.68,
		cacheWrite: null,
		currency: 'CNY',
		note: '>512K 输入限量供应，需联系销售；预计数日后全量开放',
	},
	m27: {
		input: 2.1,
		output: 8.4,
		cacheRead: 0.42,
		cacheWrite: 2.625,
		currency: 'CNY',
	},
	m27Highspeed: {
		input: 4.2,
		output: 16.8,
		cacheRead: 0.42,
		cacheWrite: 2.625,
		currency: 'CNY',
	},
};

const PRICING_USD: Record<PricingKey, ModelPricing> = {
	m3: {
		input: 0.6,
		output: 2.4,
		cacheRead: 0.12,
		cacheWrite: null,
		currency: 'USD',
	},
	m3Large: {
		input: 1.2,
		output: 4.8,
		cacheRead: 0.24,
		cacheWrite: null,
		currency: 'USD',
		note: '>512K input tokens are limited-availability; contact sales. Public rollout expected within days.',
	},
	m27: {
		input: 0.3,
		output: 1.2,
		cacheRead: 0.06,
		cacheWrite: 0.375,
		currency: 'USD',
	},
	m27Highspeed: {
		input: 0.6,
		output: 2.4,
		cacheRead: 0.06,
		cacheWrite: 0.375,
		currency: 'USD',
	},
};

/** Whether the user's locale is Chinese (so we use CNY / ¥). */
export function isChineseLocale(language: string = vscode.env.language): boolean {
	const lower = language.toLowerCase();
	return lower === 'zh' || lower.startsWith('zh-') || lower.startsWith('zh_');
}

/** True if `baseUrl` points to the China platform. */
export function isChinaBaseUrl(baseUrl: string): boolean {
	return baseUrl.includes('minimaxi.com');
}

/** Pick the CNY vs USD price table for a given baseUrl + locale. */
export function pickPricingTable(baseUrl: string): Record<PricingKey, ModelPricing> {
	if (isChinaBaseUrl(baseUrl)) return PRICING_CNY;
	if (isChineseLocale()) return PRICING_CNY;
	return PRICING_USD;
}

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
type ModelTemplate = Omit<ModelDefinition, 'pricing'> & { pricingKey: PricingKey };

const MODEL_TEMPLATES: ModelTemplate[] = [
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
		pricingKey: 'm3',
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
		pricingKey: 'm27',
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
		pricingKey: 'm27Highspeed',
	},
];

/**
 * Read the configured `minimax.apiBaseUrl`, falling back to the global
 * `https://api.minimax.io/v1` (the default in `package.json`).
 */
function readConfiguredBaseUrl(): string {
	try {
		const config = vscode.workspace.getConfiguration('minimax');
		const raw = config.get<string>('apiBaseUrl');
		if (raw && typeof raw === 'string') return raw;
	} catch {
		// getConfiguration may throw if called before the extension is
		// fully initialised; fall through to the default.
	}
	return 'https://api.minimax.io/v1';
}

/**
 * Expand the localizable model templates into concrete `ModelDefinition`s
 * using the price table appropriate for the user's `baseUrl` and locale.
 * Callers should go through this rather than reading `MODELS` directly so
 * the rendered prices match the user's billing currency.
 */
export function getModels(baseUrl: string = readConfiguredBaseUrl()): ModelDefinition[] {
	const table = pickPricingTable(baseUrl);
	return MODEL_TEMPLATES.map((t) => {
		const { pricingKey, ...rest } = t;
		return { ...rest, pricing: table[pricingKey] };
	});
}

/** Models visible in the model picker (filtered by `minimax.visibleModels`). */
export function getVisibleModels(
	baseUrl: string = readConfiguredBaseUrl(),
): readonly ModelDefinition[] {
	const models = getModels(baseUrl);
	const config = vscode.workspace.getConfiguration('minimax');
	const raw = config.get<unknown>('visibleModels');
	if (!Array.isArray(raw)) {
		return models;
	}
	const configuredIds = new Set(
		raw.filter((value): value is string => typeof value === 'string'),
	);
	const visible = models.filter((m) => configuredIds.has(m.id));
	return visible.length > 0 ? visible : models;
}

export function findModelById(
	id: string,
	baseUrl: string = readConfiguredBaseUrl(),
): ModelDefinition | undefined {
	return getModels(baseUrl).find((m) => m.id === id);
}
