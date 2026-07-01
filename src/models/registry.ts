import * as vscode from 'vscode';
import { getBaseUrl, getM3ContextWindow } from '../config';
import {
	isChineseLocale as isChineseLocaleShared,
	MINIMAX_TOOLS_LIMIT,
	PLATFORM_HOST_CHINA,
	resolvePlatformHost,
} from '../consts';
import type { ModelDefinition, ModelPricing } from '../types';

/** Re-export the shared `isChineseLocale` so existing call sites
 *  (`import { isChineseLocale } from '../models/registry'`) keep
 *  working — the canonical definition lives in `consts.ts`. */
export const isChineseLocale = isChineseLocaleShared;

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
type PricingKey = 'm3' | 'm3Large' | 'm3Priority' | 'm3LargePriority' | 'm27' | 'm27Highspeed';

const PRICING_CNY: Record<PricingKey, ModelPricing> = {
	/** M3 in the standard ≤512K tier (永久五折后). */
	m3: {
		input: 2.1,
		output: 8.4,
		cacheRead: 0.42,
		cacheWrite: null,
		currency: 'CNY',
	},
	// M3 standard >512K — 1.5× the standard ≤512K rate. Kept in the
	// table for the **per-token** (>512K input portion) rate that the
	// API applies at request time, but NOT used to label the picker
	// entry: the picker entry shows the ≤512K base rate (¥2.1 input),
	// and the >512K portion is billed at 1.5× at the API. A future
	// "show me the >512K rate in the picker" feature would surface
	// this row in the tooltip — see the >512K hint appended by
	// `formatPricingTooltip` when `maxInputTokens > 512_000`.
	m3Large: {
		input: 4.2,
		output: 16.8,
		cacheRead: 0.84,
		cacheWrite: null,
		currency: 'CNY',
		note: '>512K 输入限量供应，需联系销售；预计数日后全量开放',
	},
	/** M3 priority ≤512K tier — 1.5× the standard per-token rate. */
	m3Priority: {
		input: 3.15,
		output: 12.6,
		cacheRead: 0.63,
		cacheWrite: null,
		currency: 'CNY',
		note: '优先服务按标准价格的 1.5 倍计费，请求获得优先准入（service_tier: "priority"）',
	},
	// M3 priority >512K — 1.5× the >512K standard rate (3× of the
	// standard ≤512K rate). Same status as `m3Large`: defined for
	// reference, the picker entry uses `m3Priority` as the base rate.
	m3LargePriority: {
		input: 6.3,
		output: 25.2,
		cacheRead: 1.26,
		cacheWrite: null,
		currency: 'CNY',
		note: '>512K 输入限量供应，需联系销售；优先服务按对应标准档位价格的 1.5 倍计费',
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
		input: 0.3,
		output: 1.2,
		cacheRead: 0.06,
		cacheWrite: null,
		currency: 'USD',
	},
	// Per-token rate for the >512K input portion of standard M3 —
	// see the CNY table for the full rationale.
	m3Large: {
		input: 0.6,
		output: 2.4,
		cacheRead: 0.12,
		cacheWrite: null,
		currency: 'USD',
		note: '>512K input tokens are limited-availability; contact sales. Public rollout expected within days.',
	},
	/** M3 priority ≤512K — 1.5× standard pricing. */
	m3Priority: {
		input: 0.45,
		output: 1.8,
		cacheRead: 0.09,
		cacheWrite: null,
		currency: 'USD',
		note: 'Priority requests get faster response and lower failure rate via service_tier: "priority", billed at 1.5× the standard per-token rate.',
	},
	// Per-token rate for the >512K input portion of M3-Priority.
	// See the CNY table for the rationale.
	m3LargePriority: {
		input: 0.9,
		output: 3.6,
		cacheRead: 0.18,
		cacheWrite: null,
		currency: 'USD',
		note: '>512K input tokens are limited-availability; contact sales. Priority requests billed at 1.5× the corresponding standard-tier rate.',
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

/** Whether the user's locale is Chinese (so we use CNY / ¥).
 *  Re-exported from `consts.ts` so existing call sites that already
 *  import it from here keep working — see `consts.ts` for the
 *  authoritative definition. */

/**
 * True if `baseUrl` points to the China Anthropic-compatible API host.
 *
 * Uses `resolvePlatformHost` for strict hostname equality (NOT raw-URL
 * `String.includes`) so spoofing vectors like
 * `https://api.minimax.io@my-proxy.example.com/v1` (userinfo),
 * `https://api.minimax.io.evil.example/v1` (suffix), and
 * `https://proxy.example.com/api.minimax.io/v1` (path) all return
 * `false`. The previous `baseUrl.includes('minimaxi.com')` was
 * substring-matching the raw URL, which is the LRN-20260611-005
 * credential-leak class of bug.
 */
export function isChinaBaseUrl(baseUrl: string): boolean {
	return resolvePlatformHost(baseUrl) === PLATFORM_HOST_CHINA;
}

/** Pick the CNY vs USD price table for a given baseUrl + locale. */
export function pickPricingTable(baseUrl: string): Record<PricingKey, ModelPricing> {
	if (isChinaBaseUrl(baseUrl)) return PRICING_CNY;
	if (isChineseLocale(vscode.env.language)) return PRICING_CNY;
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
 * is still in limited rollout per the [pricing page][pp] footnote. We
 * therefore report 512K as the *effective* cap in the model picker (see
 * the M3 entry below) so VS Code's "上下文窗口" indicator shows the
 * number a normal user can actually push to. Users who have been granted
 * access to the >512K tier can lift it via the
 * `minimax.enableM31MContext` setting — the only way to flip that
 * setting is the **MiniMax: Toggle M3 1M Context** command, which pops
 * a modal warning about the 1.5× billing rate before changing it. Going
 * through the command (rather than editing `settings.json` directly)
 * is what makes the warning visible to the user.
 *
 * Note on M3 Priority: the `MiniMax-M3-Priority` variant shares the
 * same upstream model (`apiModelId: 'MiniMax-M3'`) but sends
 * `service_tier: "priority"` on every request for faster response and
 * lower failure rate, billed at 1.5× the standard per-token price.
 *
 * [pp]: https://platform.minimax.io/docs/guides/pricing-paygo
 *
 * Note on M2.7: the official spec is 204,800 context. We do not split
 * it into input vs. output caps because the docs do not publish such a
 * split either. Earlier versions hardcoded `maxInputTokens: 196_608`
 * and `maxOutputTokens: 131_072`; those numbers came from us, not
 * MiniMax, and have been removed.
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
		// VS Code renders the model's `maxInputTokens` as the denominator
		// in its "上下文窗口: N / M" indicator inside the chat UI. The
		// official M3 spec is 1M, but the >512K input tier is still in
		// limited rollout and most users will get a 400 if they try to
		// push past 512K. Reporting `1_000_000` here would make the UI
		// say "1M" while in practice requests above 512K fail — that's
		// the kind of mismatch we want to avoid.
		//
		// We therefore report 512K as the effective cap. Users who have
		// been granted access to the >512K tier can lift this via the
		// `minimax.maxContextTokens` setting; the chat info emitter
		// rebuilds the picker entry when that setting changes, so the
		// UI updates live without an editor reload.
		maxInputTokens: 512_000,
		// VS Code's "Manage Language Models" panel renders the picker
		// context-size column by SUMMING `maxInputTokens + maxOutputTokens`
		// and passing the total through `formatTokenCount()`
		// (microsoft/vscode/src/vs/workbench/contrib/chat/browser/chatManagement/chatModelsWidget.ts,
		// `TokenLimitsColumnRenderer.renderModelElement`). Setting both
		// fields to `512_000` would make that column render as `1M`
		// (1_024_000 round-trips to `1M`) even when `enableM31MContext`
		// is off — a misleading "1M" label that disagrees with the actual
		// 512K input cap the user is paying for. We set `maxOutputTokens`
		// to `0` here so the column shows `formatTokenCount(maxInputTokens)`
		// = `"512K"` when the 1M toggle is off and `"1M"` when it is on.
		// The actual `max_tokens` request parameter is **not** read from
		// this field — `request.ts` deliberately uses the user's
		// `minimax.maxOutputTokens` setting instead, so this is a
		// display-only knob. See CLAUDE.md → "Picket context-size column"
		// for the upstream rendering rule and the deepseek-v4-for-copilot
		// precedent (PR Vizards/deepseek-v4-for-copilot#71).
		maxOutputTokens: 0,
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
		priceCategory: 'medium',
	},
	{
		id: 'MiniMax-M3-Priority',
		name: 'MiniMax M3 (Priority)',
		apiModelId: 'MiniMax-M3',
		family: 'minimax',
		version: '3',
		detail: 'M3 with priority access — faster response, lower failure rate',
		contextLength: 1_000_000,
		maxInputTokens: 512_000,
		// See the M3 entry above for why `maxOutputTokens` is `0` —
		// VS Code sums the two fields when rendering the "Manage
		// Language Models" context-size column, so this is display-only.
		maxOutputTokens: 0,
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
		pricingKey: 'm3Priority',
		priceCategory: 'high',
		extra: { service_tier: 'priority' },
		// `service_tier: "priority"` is what actually routes the
		// request to the priority tier. The user-facing preset escape
		// hatch (`minimax.experimental.modelDefPresets`) is shallow-
		// merged on top of this template, so without the reserved list
		// a user who set any preset entry for this picker ID would
		// silently drop `service_tier` and get standard-tier billing
		// while believing they had priority access.
		extraReserved: ['service_tier'],
	},
	{
		id: 'MiniMax-M2.7',
		name: 'MiniMax M2.7',
		family: 'minimax',
		version: '2.7',
		detail: 'Self-iterating coding model (~60 TPS)',
		contextLength: 204_800,
		// The official "上下文窗口" column lists 204,800 — on the
		// Anthropic-compatible surface this is the **input** capacity.
		// Earlier builds split the 204,800 pool into 131_072 input +
		// 73_728 output, but the MiniMax docs never published such a
		// split; the data sheet calls the whole number the "context
		// window", which in Anthropic convention means `max_input_tokens`.
		maxInputTokens: 204_800,
		maxOutputTokens: 0,
		capabilities: {
			toolCalling: MINIMAX_TOOLS_LIMIT,
			// M2.x only supports text and tool-call blocks on MiniMax's Anthropic API.
			thinking: true,
		},
		thinking: {
			supportsBudget: false,
			supportsAdaptive: false,
		},
		pricingKey: 'm27',
		priceCategory: 'low',
	},
	{
		id: 'MiniMax-M2.7-highspeed',
		name: 'MiniMax M2.7 (High-Speed)',
		family: 'minimax',
		version: '2.7-highspeed',
		detail: 'M2.7 high-speed: same quality, faster (~100 TPS)',
		contextLength: 204_800,
		maxInputTokens: 204_800,
		maxOutputTokens: 0,
		capabilities: {
			toolCalling: MINIMAX_TOOLS_LIMIT,
			// M2.x only supports text and tool-call blocks on MiniMax's Anthropic API.
			thinking: true,
		},
		thinking: {
			supportsBudget: false,
			supportsAdaptive: false,
		},
		pricingKey: 'm27Highspeed',
		priceCategory: 'low',
	},
];

/**
 * Read the configured `minimax.apiBaseUrl`, falling back to the
 * shared `getBaseUrl()` default. The earlier implementation
 * had a private hard-coded `'https://api.minimax.io/v1'` fallback
 * that disagreed with the China default in `package.json`; routing
 * through `getBaseUrl()` keeps the picker pricing and the chat
 * request on the same source of truth.
 */
function readConfiguredBaseUrl(): string {
	try {
		return getBaseUrl();
	} catch {
		// `getBaseUrl` may throw if `vscode.workspace.getConfiguration`
		// is called before the extension is fully initialised; the
		// module-level default inside `getBaseUrl` covers that, but
		// be defensive in case a future change makes the call unsafe.
		return 'https://api.minimaxi.com/anthropic';
	}
}

/**
 * Expand the localizable model templates into concrete `ModelDefinition`s
 * using the price table appropriate for the user's `baseUrl` and locale.
 * Callers should go through this rather than reading `MODELS` directly so
 * the rendered prices match the user's billing currency.
 */
export function getModels(baseUrl: string = readConfiguredBaseUrl()): ModelDefinition[] {
	const table = pickPricingTable(baseUrl);
	// M3's effective cap is either the safe 512K default or the official
	// 1M cap, depending on `minimax.enableM31MContext`. The boolean is
	// flipped via the `minimax.toggleM31MContext` command (which pops
	// a modal warning about the 1.5× billing rate and the need for
	// sales-granted >512K access). When the toggle is on we lift M3's
	// `maxInputTokens` / `maxOutputTokens` to 1M so the VS Code
	// "上下文窗口" indicator reflects what the user is opting into.
	// The same logic applies to the priority variant (`MiniMax-M3-Priority`)
	// so both entries stay in sync when the user lifts the context cap.
	const m3Window = getM3ContextWindow();
	return MODEL_TEMPLATES.map((t) => {
		const { pricingKey, ...rest } = t;
		// Spread `extra` and `extraReserved` into fresh containers so
		// callers cannot mutate the module-level `MODEL_TEMPLATES`
		// literal by writing through the returned `ModelDefinition`.
		// `extra` may hold nested objects (e.g. `metadata: { team }`)
		// in future variants; deep-cloning it is the caller's
		// responsibility — the registry only shallow-copies.
		const base: ModelDefinition = (rest.extra || rest.extraReserved)
			? {
				...rest,
				extra: rest.extra ? { ...rest.extra } : undefined,
				extraReserved: rest.extraReserved ? [...rest.extraReserved] : undefined,
				pricing: table[pricingKey],
			}
			: { ...rest, pricing: table[pricingKey] };
		const isM3Family =
			t.id === 'MiniMax-M3' || t.id === 'MiniMax-M3-Priority';
		// Lifting the picker cap to 1M only changes `maxInputTokens`.
		// The picker **price column** still shows the ≤512K base rate
		// (¥2.1 for standard M3, ¥3.15 for priority). The >512K
		// portion of an actual request is billed per-token at the
		// `m3Large` / `m3LargePriority` rate by the upstream API — see
		// the hint appended in `formatPricingTooltip` when the picker
		// advertises >512K, which is where those numbers surface.
		//
		// The previous implementation switched the entire `pricing`
		// row to `m3Large` / `m3LargePriority` when the 1M toggle was
		// on, which made every token in the picker look 1.5×–3× more
		// expensive than the ≤512K base rate the user is actually
		// billed for on most requests.
		if (!isM3Family || m3Window === t.maxInputTokens) {
			return base;
		}
		// Lifting the cap to 1M only changes `maxInputTokens`. We
		// deliberately leave `maxOutputTokens` at the template's value
		// (0 for M3 family — see the comment at the M3 template above
		// for why) so that `formatTokenCount(maxInputTokens + maxOutputTokens)`
		// in VS Code's picker column renders the desired boundary label
		// ("512K" off, "1M" on). If `maxOutputTokens` were also lifted,
		// the sum would cross the 1M threshold (`1M + 1M = 2M → "2M"`)
		// and the picker would show a misleading "2M" label that
		// disagrees with the actual 1M input cap.
		return {
			...base,
			maxInputTokens: m3Window,
		};
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
