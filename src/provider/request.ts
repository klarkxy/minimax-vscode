import * as vscode from 'vscode';
import { AuthManager } from '../auth';
import { MiniMaxClient } from '../client';
import { resolveApiModelId, getMaxTokens } from '../config';
import { CONFIG_SECTION } from '../consts';
import { t } from '../i18n';
import { findModelById } from '../models/registry';
import type { ConvertedConversation, MiniMaxRequest } from '../types';
import { convertMessages, countMessageChars } from './convert';
import {
	classifyMiniMaxRequest,
	createCacheDiagnosticsRecorder,
	dumpMiniMaxRequest,
	type CacheDiagnosticsRecorder,
	type CacheDiagnosticsRun,
	type RequestKind,
} from './debug';
import { getConfiguredThinkingEffort, type ModelConfigurationOptions } from './models';
import type { ReplayMarkerMetadata } from './replay';
import type { ConversationSegment } from './segment';
import { prepareRequestTools, collectTrailingToolResultIds } from './tools/request';
import { logger } from '../logger';
import { safeStringify } from '../json';
import { appendTerminalGuidanceToSystemPrompt, buildTerminalGuidance } from './terminalEnvironment';

export interface PreparedChatRequest {
	client: MiniMaxClient;
	apiKey: string;
	/**
	 * The Anthropic-compatible base URL resolved from the active key's
	 * `apiBaseUrl`. Falls back to the deprecated `minimax.apiBaseUrl`
	 * setting (then to the China default) when the pool has no active
	 * key. Stored on the prepared request so the stream layer does
	 * not have to re-resolve it and so request-dump diagnostics show
	 * the URL the request actually went to.
	 */
	baseUrl: string;
	request: MiniMaxRequest;
	modelDef: ReturnType<typeof findModelById> | undefined;
	isThinkingModel: boolean;
	/**
	 * The thinking effort the user has asked for. `adaptive` keeps
	 * thinking on; `disabled` (M3 only) turns it off. The
	 * `isThinkingModel` field reflects the model's capability, not
	 * the user's choice — they diverge when M3 is in disabled mode.
	 */
	thinkingEffort: 'adaptive' | 'disabled';
	totalRequestChars: number;
	trailingToolResultIds: string[];
	cacheDiagnostics: CacheDiagnosticsRun;
	requestKind: RequestKind;
	segment: ConversationSegment;
	replayMarkerMetadata: ReplayMarkerMetadata;
}

export interface PrepareChatRequestOptions {
	authManager: AuthManager;
	globalStorageUri: vscode.Uri;
	modelInfo: vscode.LanguageModelChatInformation;
	segment: ConversationSegment;
	messages: readonly vscode.LanguageModelChatRequestMessage[];
	options: vscode.ProvideLanguageModelChatResponseOptions;
	token: vscode.CancellationToken;
	cacheDiagnostics: CacheDiagnosticsRecorder;
}

export async function prepareChatRequest({
	authManager,
	globalStorageUri,
	modelInfo,
	segment,
	messages,
	options,
	token,
	cacheDiagnostics,
}: PrepareChatRequestOptions): Promise<PreparedChatRequest> {
	const apiKey = await authManager.getApiKey();
	if (!apiKey) {
		throw new Error(t('auth.notConfigured'));
	}

	// Resolve the host from the active key. The pool is the source of
	// truth; `getActiveApiBaseUrl()` itself falls back to the
	// deprecated `minimax.apiBaseUrl` setting when the pool is empty,
	// so legacy single-key users keep working without any change on
	// their part.
	const baseUrl = await authManager.keyManagerInstance.getActiveApiBaseUrl();

	const client = new MiniMaxClient();
	const modelDef = findModelById(modelInfo.id);
	const isThinkingModel = modelDef?.capabilities.thinking ?? false;
	// Merge user-configured `minimax.sampling` + `minimax.experimental.modelDefPresets`
	// on top of any modelDef defaults so callers can tweak temperature,
	// top_p, top_k, frequency_penalty per model without code changes.
	const userSampling = readUserSampling(modelInfo.id);
	const userExtra = readUserExtra(modelDef?.id ?? modelInfo.id);
	const enrichedModelDef = modelDef
		? {
				...modelDef,
				sampling: userSampling ?? modelDef.sampling,
				// Shallow-merge user presets on top of registry defaults
				// for the open escape-hatch fields, but restore any
				// registry-managed `extraReserved` keys afterwards so
				// the user can never silently strip them out. The
				// `?? {}` on `userExtra` is what allows a user who
				// hasn't configured anything to inherit the registry's
				// `extra` verbatim.
				extra: mergeExtraPreservingReserved(
					modelDef.extra,
					userExtra,
					modelDef.extraReserved,
				),
			}
		: undefined;
	// M3 supports a binary `thinking: { type: "disabled" }` switch via
	// the Copilot Chat picker dropdown. M2.x always stays `adaptive`
	// because the API ignores `disabled` for the M2 family. The
	// dropdown is the single source of truth — see
	// `provider/models.ts` for how the choice is read out of
	// `options.modelConfiguration[THINKING_ENABLED_KEY]`.
	const thinkingEffort = getConfiguredThinkingEffort(modelInfo.id, options as ModelConfigurationOptions);
	// `isThinkingModel` reflects whether the *model* is a thinking
	// model. `isThinkingEnabled` reflects whether the user has the
	// switch on (i.e. the dropdown returned `开启` / `adaptive`).
	// The two diverge for M3 only — when the user picks `关闭`,
	// we drop the temperature=1 / no-top_p
	// constraint and let the user's sampling overrides apply.
	const isThinkingEnabled = thinkingEffort === 'adaptive';
	const configuredMaxTokens = getMaxTokens();

	const converted = convertMessages(messages, modelInfo.id);
	const terminalGuidance = buildTerminalGuidance();
	const systemPrompt = appendTerminalGuidanceToSystemPrompt(converted.systemPrompt, terminalGuidance);
	const tools = prepareRequestTools(modelDef?.capabilities.toolCalling, options, terminalGuidance);

	const totalRequestChars = countMessageChars(converted);

	// Per the MiniMax Anthropic-API docs, the whole request body is
	// capped at 64 MB. Inline (base64/url) image+video data dominates
	// the count; we check the total bytes against the cap so we throw
	// a friendly error before the API returns 413.
	//
	// Resolve the API model ID first so a user who has set
	// `modelIdOverrides["MiniMax-M3-Priority"] = "MiniMax-M2.5"` (a
	// 32 MB historical model) gets the 32 MB cap applied pre-flight
	// instead of the 64 MB cap that would let the request through and
	// then 413 at the upstream.
	const resolvedApiModelId = resolveApiModelId(modelInfo.id, modelDef?.apiModelId);
	enforceRequestBodySizeLimit(converted, resolvedApiModelId);

	// Resolve the `max_tokens` value to send on the request.
	//
	// The MiniMax Anthropic-compatible surface does not publish per-model
	// `max_tokens` ceilings in its docs, so we deliberately do not clamp
	// to `modelDef.maxOutputTokens` here — doing so used to silently cap
	// requests at numbers we'd invented (512K for M3, 128K for M2.7) that
	// contradicted the docs. If the upstream rejects a too-large value
	// with HTTP 400, the error surfaces verbatim so the user can react.
	//
	// `0` here means "let the model decide": the `MiniMaxClient` will
	// translate it into "no explicit cap on the request body".
	const effectiveMaxTokens = configuredMaxTokens ?? 0;

	const request = client.buildRequest(
		// Use the API model id we already resolved for the size cap
		// (see the call site above) so the chain stays consistent
		// with the picker override. `resolveApiModelId` is documented
		// in `src/config.ts` — see the comment there for why a plain
		// `getApiModelId(...) || modelDef?.apiModelId || modelInfo.id`
		// chain does not work (the first term is always truthy).
		resolvedApiModelId,
		converted.messages,
		systemPrompt,
		effectiveMaxTokens,
		tools,
		buildThinkingPayload(modelDef, thinkingEffort),
		// Anthropic requires `temperature=1` whenever thinking is enabled
		// and forbids `top_p` in the same request. MiniMax inherits this
		// constraint for its `thinking: { type: "adaptive" }` mode.
		//
		// When the user picks `关闭` in the picker (M3 only — M2.x
		// always stays adaptive), we drop the forced temperature=1
		// so the user's per-model `temperature` override
		// (configured via `minimax.sampling`) finally takes effect.
		// `undefined` here is the signal for
		// `applyPerModelSampling` to forward the configured temperature.
		modelDef?.capabilities.thinking && isThinkingEnabled ? 1 : undefined,
		undefined,
		enrichedModelDef,
	);

	const requestKind = classifyMiniMaxRequest({ request, inputMessages: messages });
	dumpMiniMaxRequest(request, {
		globalStorageUri,
		segment,
		requestKind,
		vscodeModelId: modelInfo.id,
		isThinkingModel,
		thinkingEffort,
		maxTokens: effectiveMaxTokens,
		inputMessages: messages,
		resolvedMessages: messages,
		requestOptions: options,
	});

	const diagnosticsRun = cacheDiagnostics.beginRequest();

	// The trailing-tool-result count is used by cache diagnostics to
	// report how many `tool_result` blocks the most recent assistant
	// turn left dangling. The previous hand-rolled loop walked
	// EVERY message in EVERY direction and pushed every `tool_use_id`
	// it found, which inflated the count for long tool-calling
	// histories. Reuse the tail-walking helper from
	// `tools/request.ts` so the request layer and tool flow agree.
	const trailingToolResultIds = collectTrailingToolResultIds(converted.messages);

	return {
		client,
		apiKey,
		baseUrl,
		request,
		modelDef: enrichedModelDef,
		isThinkingModel,
		thinkingEffort,
		totalRequestChars,
		trailingToolResultIds,
		cacheDiagnostics: diagnosticsRun,
		requestKind,
		segment,
		replayMarkerMetadata: { thinkingBlocks: undefined },
	};
}

/**
 * Read `minimax.sampling[<modelId>]` from user config and validate
 * each field. Returns `undefined` when the user hasn't set anything
 * for this model so the caller can fall back to the registry default.
 */
function readUserSampling(
	modelId: string,
):
	| {
			temperature?: number;
			topP?: number;
			topK?: number;
			frequencyPenalty?: number;
	  }
	| undefined {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const raw = config.get<Record<string, unknown>>('sampling', {});
	const entry = raw?.[modelId];
	if (!isPlainObject(entry)) {
		return undefined;
	}
	const out: {
		temperature?: number;
		topP?: number;
		topK?: number;
		frequencyPenalty?: number;
	} = {};
	if (typeof entry.temperature === 'number' && entry.temperature >= 0 && entry.temperature <= 2) {
		out.temperature = entry.temperature;
	}
	if (typeof entry.topP === 'number' && entry.topP >= 0 && entry.topP <= 1) {
		out.topP = entry.topP;
	}
	if (typeof entry.topK === 'number' && Number.isInteger(entry.topK) && entry.topK >= 0) {
		out.topK = entry.topK;
	}
	if (
		typeof entry.frequencyPenalty === 'number' &&
		entry.frequencyPenalty >= -2 &&
		entry.frequencyPenalty <= 2
	) {
		out.frequencyPenalty = entry.frequencyPenalty;
	}
	return Object.keys(out).length === 0 ? undefined : out;
}

/**
 * Read `minimax.experimental.modelDefPresets[<modelId>]` from user
 * config. Returns the raw object so the core layer can pick out
 * specific fields and merge them into the request body.
 */
function readUserExtra(modelId: string): Record<string, unknown> | undefined {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const raw = config.get<Record<string, unknown>>('experimental.modelDefPresets', {});
	const entry = raw?.[modelId];
	return isPlainObject(entry) ? entry : undefined;
}

/**
 * Merge user `experimental.modelDefPresets` over the registry's
 * `modelDef.extra`, then restore the registry's value for any key
 * listed in `modelDef.extraReserved`. Reserved keys are the registry's
 * way of saying "this field belongs to the variant, not to the user
 * — they must not be able to override it via the preset escape
 * hatch". The M3-Priority variant uses this to pin `service_tier`
 * so a user who sets any preset entry (e.g. `stop_sequences`) doesn't
 * silently lose priority routing and end up billed at the standard
 * rate while thinking they have priority access.
 *
 * Exported for unit tests; production callers should rely on the
 * request-prep pipeline wiring it via `modelDef.extraReserved`.
 */
export function mergeExtraPreservingReserved(
	registryExtra: Record<string, unknown> | undefined,
	userExtra: Record<string, unknown> | undefined,
	reserved: readonly string[] | undefined,
): Record<string, unknown> {
	const merged: Record<string, unknown> = {
		...(registryExtra ?? {}),
		...(userExtra ?? {}),
	};
	if (!reserved || reserved.length === 0) {
		return merged;
	}
	for (const key of reserved) {
		if (registryExtra && Object.prototype.hasOwnProperty.call(registryExtra, key)) {
			merged[key] = registryExtra[key];
		} else {
			// Reserved list mentions a key the registry doesn't set —
			// strip any user value rather than leave a half-merged
			// residue. Defensive: today every reserved key is also
			// present in `registryExtra`, but the request layer should
			// not break if a future variant adds a reserved list
			// without populating the value yet.
			delete merged[key];
		}
	}
	return merged;
}

/**
 * Narrow `unknown` to a plain record without an explicit cast. The
 * previous `entry as Record<string, unknown>` was redundant because
 * the `typeof === 'object'` check already rules out primitives;
 * arrays slip through the same check, so we also rule those out
 * explicitly. Returning a typed record via a user-defined type
 * guard keeps the cast out of the call sites and lets TypeScript
 * carry the narrowing through.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Build the `thinking` block for a MiniMax Anthropic-compatible request.
 *
 * Per the official MiniMax OpenAPI spec
 * (https://platform.minimax.io/docs/api-reference/text/api/openapi-chat-anthropic.json),
 * the only legal values are `"disabled"` and `"adaptive"`. There is **no**
 * `enabled` value, no `budget_tokens` field, and no query-string knob —
 * sending any of those is what triggered the gateway's 404 page.
 *
 * Practical implications:
 *   - M3 (the only model with a native `thinking` content block) gets
 *     `adaptive` so the model itself picks the right reasoning depth.
 *   - M2.x does not declare a `thinking` content block at all, so we
 *     never emit the field; its reasoning arrives embedded as
 *     `<think>…</think>` inside the text content.
 */
function buildThinkingPayload(
	modelDef: ReturnType<typeof findModelById> | undefined,
	effort: 'adaptive' | 'disabled',
): { type: 'adaptive' } | { type: 'disabled' } | undefined {
	if (!modelDef?.capabilities.thinking) {
		return undefined;
	}
	// M3 honours both `adaptive` and `disabled` (the docs explicitly
	// say M3 thinking can be turned off). M2.x does not — even if we
	// send `disabled`, the gateway keeps thinking on; emitting
	// `disabled` would be a no-op so we still emit `adaptive` here for
	// the typed field to keep the body shape predictable.
	if (modelDef.thinking.supportsAdaptive) {
		return { type: effort };
	}
	// M2.x series: the gateway has no typed `thinking` field, so we
	// omit the block entirely. The reasoning text still arrives
	// embedded in the content (the prompt cache pipeline handles it).
	return undefined;
}

/**
 * Count the number of image data parts in the request so the bypass log
 * line can tell the user "I forwarded N images directly to the multimodal
 * model". Lightweight — runs only on the M3-native path.
 */
function countInputImages(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
): number {
	let count = 0;
	for (const message of messages) {
		for (const part of message.content) {
			if (
				part instanceof vscode.LanguageModelDataPart &&
				part.mimeType.startsWith('image/')
			) {
				count += 1;
			}
		}
	}
	return count;
}

/**
 * Count the number of video data parts. Mirrors `countInputImages` for
 * the M3-native video path.
 */
function countInputVideos(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
): number {
	let count = 0;
	for (const message of messages) {
		for (const part of message.content) {
			if (
				part instanceof vscode.LanguageModelDataPart &&
				part.mimeType.startsWith('video/')
			) {
				count += 1;
			}
		}
	}
	return count;
}

/**
 * Estimate the byte size of inline (base64/url) content blocks in a
 * converted conversation. `mm_file://` references contribute 0 bytes —
 * only the small `file_id` is sent, the actual file is fetched server-side.
 *
 * Base64 expands 3 bytes into 4 chars, so we divide by 4 × 3/4 = 3 to
 * get the original byte length. URL sources are passed through as-is
 * (the API will decode them).
 */
export function estimateRequestBodyBytes(
	converted: ConvertedConversation,
): number {
	let bytes = 0;
	const sys = converted.systemPrompt;
	if (typeof sys === 'string') {
		bytes += Buffer.byteLength(sys, 'utf8');
	}
	for (const message of converted.messages) {
		if (typeof message.content === 'string') {
			bytes += Buffer.byteLength(message.content, 'utf8');
			continue;
		}
		for (const block of message.content) {
			switch (block.type) {
				case 'text':
					bytes += Buffer.byteLength(block.text, 'utf8');
					break;
				case 'image':
					if (block.source.type === 'base64') {
						bytes += Math.floor((block.source.data.length * 3) / 4);
					} else {
						bytes += Buffer.byteLength(block.source.url, 'utf8');
					}
					break;
				case 'video':
					if (block.source.type === 'mm_file') break;
					if (block.source.type === 'base64') {
						bytes += Math.floor((block.source.data.length * 3) / 4);
					} else {
						bytes += Buffer.byteLength(block.source.url, 'utf8');
					}
					break;
				case 'tool_use':
					bytes += Buffer.byteLength(safeStringify({
						id: block.id,
						name: block.name,
						input: block.input,
					}), 'utf8');
					break;
				case 'tool_result':
					bytes += Buffer.byteLength(block.tool_use_id, 'utf8');
					if (typeof block.content === 'string') {
						bytes += Buffer.byteLength(block.content, 'utf8');
					} else {
						for (const inner of block.content) {
							if (inner.type === 'text') {
								bytes += Buffer.byteLength(inner.text, 'utf8');
							}
						}
					}
					break;
				case 'thinking':
					bytes += Buffer.byteLength(block.thinking, 'utf8');
					break;
			}
		}
	}
	return bytes;
}

/**
 * Throw a friendly i18n error when the inline content of a request would
 * blow the documented 64 MB cap. We only count the request *body* (no
 * URL/method/headers), so the real cap is a little higher; this is a
 * pre-flight check to surface oversized chats before the API bounces
 * them with HTTP 413.
 */
export function enforceRequestBodySizeLimit(
	converted: ConvertedConversation,
	modelId: string,
): void {
	// Per-attachment caps (10 MB image, 50 MB video) checked first so the
	// user gets a precise error pointing at the offending attachment
	// rather than a generic "your body is too large" message when only
	// one part is the culprit.
	enforceInlineAttachmentSizeLimits(converted);

	const bytes = estimateRequestBodyBytes(converted);
	if (bytes <= MAX_REQUEST_BODY_BYTES_FOR_MODEL(modelId)) {
		return;
	}
	const mb = (bytes / 1024 / 1024).toFixed(1);
	throw new Error(
		t(
			'request.bodyTooLarge',
			modelId,
			mb,
			Math.floor(MAX_REQUEST_BODY_BYTES_FOR_MODEL(modelId) / 1024 / 1024),
		),
	);
}

/**
 * Per-attachment caps from the MiniMax Anthropic-API docs:
 *   - inline image (base64/url): ≤ 10 MB
 *   - inline video (base64/url): ≤ 50 MB
 *   - `mm_file://` references:   exempt (up to 512 MB server-side)
 * Throw a localised error naming the offending block so the user knows
 * which attachment to shrink. We do NOT silently drop oversized
 * attachments — the host contract is "your attachment reached the
 * model", and dropping it would leave the model guessing.
 */
function enforceInlineAttachmentSizeLimits(converted: ConvertedConversation): void {
	for (const message of converted.messages) {
		if (typeof message.content === 'string') {
			continue;
		}
		for (const block of message.content) {
			if (block.type === 'image') {
				const bytes = block.source.type === 'base64'
					? Math.floor((block.source.data.length * 3) / 4)
					: Buffer.byteLength(block.source.url, 'utf8');
				if (bytes > MAX_INLINE_IMAGE_BYTES) {
					throw new Error(
						t(
							'request.imageTooLarge',
							(bytes / 1024 / 1024).toFixed(1),
							MAX_INLINE_IMAGE_BYTES / 1024 / 1024,
						),
					);
				}
			} else if (block.type === 'video') {
				if (block.source.type === 'mm_file') {
					continue;
				}
				const bytes = block.source.type === 'base64'
					? Math.floor((block.source.data.length * 3) / 4)
					: Buffer.byteLength(block.source.url, 'utf8');
				if (bytes > MAX_INLINE_VIDEO_BYTES) {
					throw new Error(
						t(
							'request.videoTooLarge',
							(bytes / 1024 / 1024).toFixed(1),
							MAX_INLINE_VIDEO_BYTES / 1024 / 1024,
						),
					);
				}
			}
		}
	}
}

/**
 * Per-model request-body caps from the MiniMax Anthropic-API docs. All
 * picker models (M3, M2.7, M2.7-highspeed) accept inline media and are
 * subject to the 64 MB ceiling. The 32 MB fallback exists for callers
 * that still point at historical models via `modelIdOverrides`.
 *
 * `modelId` is the *resolved* API model id (the value sent in the
 * request body), not the picker id — see the call site above. That
 * way a user who has rerouted `MiniMax-M3-Priority` to a 32 MB
 * historical model via `modelIdOverrides` gets the 32 MB cap applied
 * pre-flight instead of the 64 MB cap that would let the request
 * through and then 413 at the upstream.
 */
function MAX_REQUEST_BODY_BYTES_FOR_MODEL(modelId: string): number {
	// API model IDs of every model that accepts inline images / videos.
	// `MiniMax-M3-Priority` resolves to `MiniMax-M3` via the
	// registry's `apiModelId`, so it does not need a separate branch.
	if (
		modelId === 'MiniMax-M3' ||
		modelId === 'MiniMax-M2.7' ||
		modelId === 'MiniMax-M2.7-highspeed'
	) return 64 * 1024 * 1024;
	return 32 * 1024 * 1024;
}

/**
 * Per-attachment caps from the MiniMax Anthropic-API docs. All picker
 * models (M3, M2.7, M2.7-highspeed) accept inline media, so the
 * constants here are the single source of truth that the
 * `convert.ts` MIME table is sized against.
 */
const MAX_INLINE_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_INLINE_VIDEO_BYTES = 50 * 1024 * 1024;
