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
	request: MiniMaxRequest;
	isThinkingModel: boolean;
	thinkingEffort: 'none' | 'low' | 'high' | 'max';
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
		undefined, // temperature — let Anthropic default to 1 when thinking is on
		undefined, // top_p — let Anthropic default when thinking is on
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

function buildThinkingPayload(
	modelDef: ReturnType<typeof findModelById>,
	effort: 'none' | 'low' | 'high' | 'max',
): { type: 'enabled' | 'disabled'; budget_tokens?: number } | undefined {
	if (!modelDef?.capabilities.thinking) {
		return undefined;
	}
	if (effort === 'none') {
		return { type: 'disabled' };
	}
	// Anthropic thinking requires budget_tokens ≥ 1024.
	if (modelDef.thinking.supportsBudget) {
		const budget = effortToBudgetTokens(effort);
		return { type: 'enabled', budget_tokens: budget };
	}
	// M2.x: Anthropic-compatible endpoint does not have a native thinking
	// parameter; thinking still comes through as <think> tags in content.
	// We disable the explicit thinking field so the model uses its default
	// behaviour. (No `extra_body` analogue exists in the Anthropic API.)
	return undefined;
}

function effortToBudgetTokens(effort: 'low' | 'high' | 'max'): number {
	switch (effort) {
		case 'low':
			return 1024;
		case 'high':
			return 8192;
		case 'max':
			return 32_768;
	}
}

// `collectTrailingToolResultIds` is no longer used by the Anthropic transport
// but kept for callers that still want to know the count for diagnostics.
void collectTrailingToolResultIds;
