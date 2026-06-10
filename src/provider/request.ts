import * as vscode from 'vscode';
import { AuthManager } from '../auth';
import { MiniMaxClient } from '../client';
import { getApiModelId, getMaxTokens } from '../config';
import { CONFIG_SECTION } from '../consts';
import { t } from '../i18n';
import { findModelById } from '../models/registry';
import type { ConvertedConversation, MiniMaxRequest, MiniMaxTool } from '../types';
import { convertMessages, convertTools, countMessageChars } from './convert';
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
import { prepareRequestTools } from './tools/request';
import { logger } from '../logger';
import { safeStringify } from '../json';
import { bypassVisionResolution, resolveImageMessages } from './vision/index';

export interface PreparedChatRequest {
	client: MiniMaxClient;
	apiKey: string;
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
	visionMarkerTextChars?: number;
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
	getVisionModel: () => Promise<vscode.LanguageModelChat | undefined>;
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
	getVisionModel,
}: PrepareChatRequestOptions): Promise<PreparedChatRequest> {
	const apiKey = await authManager.getApiKey();
	if (!apiKey) {
		throw new Error(t('auth.notConfigured'));
	}

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
				extra: userExtra ?? modelDef.extra,
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

	// If the target model accepts image input natively (e.g. MiniMax-M3,
	// `imageInput: true`), skip the vision proxy entirely. The proxy
	// only exists to convert images into text descriptions for the
	// text-only M2.x family; running it before a multimodal model
	// would (a) waste a round-trip and (b) silently destroy the image
	// whenever the proxy is unavailable, replacing it with
	// `[Image Description unavailable]`.
	const supportsImages = modelDef?.capabilities.imageInput ?? false;
	const supportsVideos = modelDef?.capabilities.videoInput ?? false;
	const visionResolution = supportsImages
		? bypassVisionResolution(messages)
		: await resolveImageMessages(messages, token, getVisionModel);
	if (supportsImages) {
		logger.info(
			`[MiniMax] Vision proxy bypassed — ${modelInfo.id} supports image input natively; ` +
				`${countInputImages(messages)} image part(s) will be sent as base64 directly.`,
		);
	}
	if (supportsVideos) {
		const videoCount = countInputVideos(messages);
		if (videoCount > 0) {
			logger.info(
				`[MiniMax] ${modelInfo.id} supports video input natively; ` +
					`${videoCount} video part(s) will be sent as base64 directly.`,
			);
		}
	}
	const resolvedMessages = visionResolution.messages;
	const converted = convertMessages(resolvedMessages, modelInfo.id);
	const tools = prepareRequestTools(modelDef?.capabilities.toolCalling, options);

	const totalRequestChars = countMessageChars(converted);

	// Per the MiniMax Anthropic-API docs, the whole request body is
	// capped at 64 MB. Inline (base64/url) image+video data dominates
	// the count; we check the total bytes against the cap so we throw
	// a friendly error before the API returns 413.
	enforceRequestBodySizeLimit(converted, modelInfo.id);

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
		getApiModelId(modelInfo.id),
		converted.messages,
		converted.systemPrompt,
		effectiveMaxTokens,
		tools as MiniMaxTool[] | undefined,
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
		resolvedMessages,
		requestOptions: options,
		visionModelId: visionResolution.visionModelId,
		visionStats: visionResolution.stats,
	});

	const diagnosticsRun = cacheDiagnostics.beginRequest();

	const trailingToolResultIds: string[] = [];
	for (const message of converted.messages) {
		if (typeof message.content === 'string') {
			continue;
		}
		for (const block of message.content) {
			if (block.type === 'tool_result' && block.tool_use_id) {
				trailingToolResultIds.push(block.tool_use_id);
			}
		}
	}
	trailingToolResultIds.reverse();

	return {
		client,
		apiKey,
		request,
		modelDef: enrichedModelDef,
		isThinkingModel,
		thinkingEffort,
		totalRequestChars,
		trailingToolResultIds,
		cacheDiagnostics: diagnosticsRun,
		requestKind,
		segment,
		replayMarkerMetadata: visionResolution.replayMarkerMetadata,
		visionMarkerTextChars: visionResolution.stats.markerVisionTextChars || undefined,
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
	if (!entry || typeof entry !== 'object') {
		return undefined;
	}
	const src = entry as Record<string, unknown>;
	const out: {
		temperature?: number;
		topP?: number;
		topK?: number;
		frequencyPenalty?: number;
	} = {};
	if (typeof src.temperature === 'number' && src.temperature >= 0 && src.temperature <= 2) {
		out.temperature = src.temperature;
	}
	if (typeof src.topP === 'number' && src.topP >= 0 && src.topP <= 1) {
		out.topP = src.topP;
	}
	if (typeof src.topK === 'number' && Number.isInteger(src.topK) && src.topK >= 0) {
		out.topK = src.topK;
	}
	if (
		typeof src.frequencyPenalty === 'number' &&
		src.frequencyPenalty >= -2 &&
		src.frequencyPenalty <= 2
	) {
		out.frequencyPenalty = src.frequencyPenalty;
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
	if (!entry || typeof entry !== 'object') {
		return undefined;
	}
	return entry as Record<string, unknown>;
}

/**
 * Build the `thinking` block for a MiniMax Anthropic-compatible request.
 *
 * Per the official MiniMax OpenAPI spec
 * (https://platform.minimaxi.com/docs/api-reference/text/api/openapi-chat-anthropic.json),
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
 * line can tell the user "I skipped the vision proxy and forwarded N
 * images directly". Lightweight — runs only on the bypass path.
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
function estimateRequestBodyBytes(
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
function enforceRequestBodySizeLimit(
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
 * Per-model request-body caps from the MiniMax Anthropic-API docs. M3 is
 * the only model in the picker that accepts inline media at all, so we
 * only need a 64 MB entry; the M2.x branch is here for callers that
 * still point at historical models via `modelIdOverrides`.
 */
function MAX_REQUEST_BODY_BYTES_FOR_MODEL(modelId: string): number {
	if (modelId === 'MiniMax-M3') return 64 * 1024 * 1024;
	return 32 * 1024 * 1024;
}

/**
 * Per-attachment caps from the MiniMax Anthropic-API docs. M3 is the
 * only picker model that accepts inline media, but the constants live
 * here as a single source of truth that the `convert.ts` MIME table
 * is sized against.
 */
const MAX_INLINE_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_INLINE_VIDEO_BYTES = 50 * 1024 * 1024;
