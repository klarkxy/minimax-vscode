import * as vscode from 'vscode';
import { createUserFacingError, MiniMaxClient } from '../client';
import { getBaseUrl } from '../config';
import { logger } from '../logger';
import { t } from '../i18n';
import type {
	MiniMaxRequest,
	MiniMaxStreamEvent,
	MiniMaxThinkingBlock,
	MiniMaxUsage,
} from '../types';
import {
	createReplayMarkerPart,
	hasReplayMarkerMetadata,
	type ReplayMarkerMetadata,
} from './replay';
import type { PreparedChatRequest } from './request';

interface ResponseStreamState {
	accumulatedThinkingText: string;
	accumulatedThinkingBlocks: MiniMaxThinkingBlock[];
	emittedToolCallCount: number;
	initialResponseNoticeReported: boolean;
	replayMarkerReported: boolean;
	// Track the index → block-kind so we can attach a signature to the
	// correct thinking block (signatures arrive via signature_delta paired
	// with the most recent thinking block on the same index).
	pendingThinkingIndex: number | undefined;
}

const COPILOT_USAGE_DATA_PART_MIME = 'usage';

export interface StreamChatCompletionOptions {
	prepared: PreparedChatRequest;
	progress: vscode.Progress<vscode.LanguageModelResponsePart>;
	token: vscode.CancellationToken;
	initialResponseNotice?: string;
	getCharsPerToken: () => number;
	setCharsPerToken: (charsPerToken: number) => void;
	onUsage?: (usage: MiniMaxUsage) => void;
}

/**
 * Stream a chat completion from the prepared MiniMax request and dispatch
 * stream events as VS Code language model response parts.
 *
 * The Anthropic SDK is used through `MiniMaxClient`; this module is
 * transport-agnostic and only consumes the `StreamCallbacks` interface.
 */
export async function streamChatCompletion({
	prepared,
	progress,
	token,
	initialResponseNotice,
	getCharsPerToken,
	setCharsPerToken,
	onUsage: onUsageExternal,
}: StreamChatCompletionOptions): Promise<void> {
	const state: ResponseStreamState = {
		accumulatedThinkingText: '',
		accumulatedThinkingBlocks: [],
		emittedToolCallCount: 0,
		initialResponseNoticeReported: false,
		replayMarkerReported: false,
		pendingThinkingIndex: undefined,
	};

	// `prepared.apiKey` is the API key resolved by `prepareChatRequest`
	// (SecretStorage first, then `minimax.apiKey` setting fallback). It
	// must already be non-empty here — `prepareChatRequest` throws
	// `auth.notConfigured` otherwise.
	const apiKey = prepared.apiKey;
	if (!apiKey) {
		throw new Error(t('auth.notConfigured'));
	}

	const tools = prepared.request.tools;
	await prepared.client.streamChat(
		prepared.request.model,
		prepared.request.messages,
		{ apiKey, baseUrl: getBaseUrl() },
		token,
		prepared.request.system,
		prepared.request.max_tokens,
		tools,
		prepared.request.thinking,
		prepared.request.temperature,
		prepared.request.top_p,
		{
			onContent: (content: string) => {
				reportInitialResponseNoticeOnce(progress, state, initialResponseNotice);
				progress.report(new vscode.LanguageModelTextPart(content));
			},

			onThinking: (text: string, signature?: string) => {
				reportInitialResponseNoticeOnce(progress, state, initialResponseNotice);
				handleThinking(text, signature, state, progress);
			},

			onToolCall: (toolCall) => {
				reportInitialResponseNoticeOnce(progress, state, initialResponseNotice);
				handleToolCall(toolCall, state, progress);
			},

			onError: (error: Error) => {
				throw createUserFacingError(error);
			},

			onDone: () => {
				reportReplayMarkerOnce(prepared, state, progress);
				finalizeReplayDiagnostics(
					prepared.trailingToolResultIds,
					state,
					prepared.cacheDiagnostics,
				);
			},

			onUsage: (usage: MiniMaxUsage) => {
				const charsPerToken = updateCharsPerToken(
					prepared.totalRequestChars,
					usage,
					getCharsPerToken(),
				);
				setCharsPerToken(charsPerToken);
				prepared.cacheDiagnostics.onUsage(usage, charsPerToken);
				reportCopilotContextUsage(progress, usage);
				onUsageExternal?.(usage);
			},
		},
	);
}

function reportInitialResponseNoticeOnce(
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	state: ResponseStreamState,
	initialResponseNotice: string | undefined,
): void {
	if (!initialResponseNotice || state.initialResponseNoticeReported) {
		return;
	}
	state.initialResponseNoticeReported = true;
	progress.report(new vscode.LanguageModelTextPart(initialResponseNotice));
}

function reportReplayMarkerOnce(
	prepared: PreparedChatRequest,
	state: ResponseStreamState,
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
): void {
	if (state.replayMarkerReported) {
		return;
	}
	state.replayMarkerReported = true;
	reportReplayMarker(prepared, state, progress);
}

function reportReplayMarker(
	prepared: PreparedChatRequest,
	state: ResponseStreamState,
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
): void {
	const metadata = getReplayMarkerMetadata(prepared, state);
	if (!hasReplayMarkerMetadata(metadata)) {
		return;
	}

	try {
		const markerPart = createReplayMarkerPart(metadata);
		progress.report(markerPart);
	} catch (error) {
		logger.warn('Failed to report replay marker', error);
	}
}

function getReplayMarkerMetadata(
	prepared: PreparedChatRequest,
	state: ResponseStreamState,
): ReplayMarkerMetadata {
	return {
		...prepared.replayMarkerMetadata,
		thinkingBlocks:
			state.accumulatedThinkingBlocks.length > 0
				? state.accumulatedThinkingBlocks
				: undefined,
	};
}

function handleThinking(
	text: string,
	signature: string | undefined,
	state: ResponseStreamState,
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
): void {
	if (text.length > 0) {
		state.accumulatedThinkingText += text;

		// Emit a VS Code thinking part for in-progress reasoning. The
		// signature_delta that follows will be attached to the same block.
		emitThinkingPart(progress, text, signature);
	} else if (signature) {
		// Backfill signature onto the last thinking block.
		const last = state.accumulatedThinkingBlocks[state.accumulatedThinkingBlocks.length - 1];
		if (last) {
			last.signature = signature;
		}
	}
}

/**
 * The proposed `LanguageModelThinkingPart` constructor accepts a value and
 * optional metadata. We expose the thinking text through that part; signature
 * is preserved in the replay marker instead (we keep the in-memory cache but
 * do not re-emit the thinking part with the signature).
 */
function emitThinkingPart(
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	text: string,
	_signature: string | undefined,
): void {
	const ThinkingCtor = (vscode as unknown as { LanguageModelThinkingPart?: unknown })
		.LanguageModelThinkingPart;
	if (typeof ThinkingCtor === 'function') {
		const Ctor = ThinkingCtor as new (
			value: string | string[],
			id?: string,
			metadata?: Record<string, unknown>,
		) => unknown;
		const part = new Ctor(text);
		progress.report(part as unknown as vscode.LanguageModelResponsePart);
		void _signature;
		return;
	}
	// Fallback for hosts that don't expose the proposed API.
	progress.report(new vscode.LanguageModelTextPart(`<think>${text}</think>`));
}

function handleToolCall(
	toolCall: { id: string; name: string; inputJson: string },
	state: ResponseStreamState,
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
): void {
	state.emittedToolCallCount += 1;

	let parsedInput: Record<string, unknown> = {};
	try {
		parsedInput = JSON.parse(toolCall.inputJson) as Record<string, unknown>;
	} catch {
		parsedInput = {};
	}
	progress.report(
		new vscode.LanguageModelToolCallPart(toolCall.id, toolCall.name, parsedInput),
	);
}

function finalizeReplayDiagnostics(
	trailingToolResultIds: readonly string[],
	state: ResponseStreamState,
	cacheDiagnostics: {
		onDone: (info: {
			reasoningTextChars: number;
			emittedToolCalls: number;
			trailingToolResults: number;
		}) => void;
	},
): void {
	cacheDiagnostics.onDone({
		reasoningTextChars: state.accumulatedThinkingText.length,
		emittedToolCalls: state.emittedToolCallCount,
		trailingToolResults: trailingToolResultIds.length,
	});
}

function updateCharsPerToken(
	totalRequestChars: number,
	usage: MiniMaxUsage,
	charsPerToken: number,
): number {
	const promptTokens = usage.input_tokens ?? 0;
	if (totalRequestChars > 0 && promptTokens > 0) {
		const observedRatio = totalRequestChars / promptTokens;
		return charsPerToken * 0.7 + observedRatio * 0.3;
	}
	return charsPerToken;
}

function reportCopilotContextUsage(
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	usage: MiniMaxUsage,
): void {
	const data = {
		prompt_tokens: usage.input_tokens ?? 0,
		completion_tokens: usage.output_tokens ?? 0,
		total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
		prompt_tokens_details: {
			cached_tokens: usage.cache_read_input_tokens ?? 0,
		},
	};

	progress.report(
		new vscode.LanguageModelDataPart(
			new TextEncoder().encode(JSON.stringify(data)),
			COPILOT_USAGE_DATA_PART_MIME,
		),
	);
}

// Re-export the event type for downstream diagnostics.
export type { MiniMaxStreamEvent, MiniMaxRequest };
