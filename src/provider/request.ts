import * as vscode from 'vscode';
import { AuthManager } from '../auth';
import { MiniMaxClient } from '../client';
import { getApiModelId, getBaseUrl, getMaxTokens } from '../config';
import { t } from '../i18n';
import { findModelById } from '../models/registry';
import type { MiniMaxRequest, MiniMaxTool } from '../types';
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
import { collectTrailingToolResultIds, prepareRequestTools } from './tools/request';
import { resolveImageMessages } from './vision/index';

export interface PreparedChatRequest {
	client: MiniMaxClient;
	apiKey: string;
	request: MiniMaxRequest;
	isThinkingModel: boolean;
	thinkingEffort: 'adaptive';
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
	// MiniMax does not expose a thinking-effort knob on the
	// Anthropic-compatible endpoint; see `provider/models.ts` for
	// the full rationale and a link to the upstream OpenAPI spec.
	const thinkingEffort = getConfiguredThinkingEffort(options as ModelConfigurationOptions);
	const configuredMaxTokens = getMaxTokens();

	const visionResolution = await resolveImageMessages(messages, token, getVisionModel);
	const resolvedMessages = visionResolution.messages;
	const converted = convertMessages(resolvedMessages, modelInfo.id);
	const tools = prepareRequestTools(modelDef?.capabilities.toolCalling, options);

	const totalRequestChars = countMessageChars(converted);

	// Clamp user-configured maxTokens to the model's hard cap so we never
	// send a value the API rejects with HTTP 400 (e.g. M3 caps at 512_000,
	// not 524_288). User-set 0 means "let the model decide".
	const effectiveMaxTokens =
		configuredMaxTokens !== undefined && modelDef
			? Math.min(configuredMaxTokens, modelDef.maxOutputTokens)
			: (configuredMaxTokens ?? modelDef?.maxOutputTokens ?? 16_384);

	const request = client.buildRequest(
		getApiModelId(modelInfo.id),
		converted.messages,
		converted.systemPrompt,
		effectiveMaxTokens,
		tools as MiniMaxTool[] | undefined,
		buildThinkingPayload(modelDef, thinkingEffort),
		// Anthropic requires `temperature=1` whenever thinking is enabled
		// and forbids `top_p` in the same request. MiniMax inherits this
		// constraint for its `thinking: { type: "adaptive" }` mode, so
		// we force temperature=1 for any thinking-capable model and
		// drop top_p (the SDK never sends it from the call above).
		modelDef?.capabilities.thinking ? 1 : undefined,
		undefined,
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
	void getBaseUrl(); // kept for future per-request override

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
	_effort: 'adaptive',
): { type: 'adaptive' } | undefined {
	if (!modelDef?.capabilities.thinking) {
		return undefined;
	}
	if (modelDef.thinking.supportsAdaptive) {
		return { type: 'adaptive' };
	}
	// M2.x series: the gateway has no typed `thinking` field, so we
	// omit the block entirely. The reasoning text still arrives
	// embedded in the content (the prompt cache pipeline handles it).
	return undefined;
}

// `collectTrailingToolResultIds` is no longer used by the Anthropic transport
// but kept for callers that still want to know the count for diagnostics.
void collectTrailingToolResultIds;
