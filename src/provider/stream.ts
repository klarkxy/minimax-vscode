import * as vscode from 'vscode';
import { createUserFacingError, MiniMaxClient, MiniMaxRequestError } from '../client';
import { getBaseUrl } from '../config';
import { COPILOT_USAGE_DATA_PART_MIME } from '../consts';
import { logger } from '../logger';
import { t } from '../i18n';
import type {
	MiniMaxRequest,
	MiniMaxStreamEvent,
	MiniMaxThinkingBlock,
	MiniMaxUsage,
} from '../types';

/**
 * Single shared `TextEncoder` for the whole module. Constructing one
 * is cheap but not free, and `reportCopilotContextUsage` runs once
 * per API response — re-using one instance avoids the allocation
 * churn on a hot path.
 */
const textEncoder = new TextEncoder();
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
		{ apiKey, baseUrl: getBaseUrl(), modelDef: prepared.modelDef },
		token,
		prepared.request.system,
		prepared.request.max_tokens,
		tools,
		prepared.request.thinking,
		prepared.request.temperature,
		prepared.request.top_p,
		{
			onContent: (content: string) => {
				if (token.isCancellationRequested) return;
				reportInitialResponseNoticeOnce(progress, state, initialResponseNotice);
				progress.report(new vscode.LanguageModelTextPart(content));
			},

			onThinking: (text: string, signature?: string) => {
				if (token.isCancellationRequested) return;
				reportInitialResponseNoticeOnce(progress, state, initialResponseNotice);
				handleThinking(text, signature, state, progress);
			},

			onToolCall: (toolCall: { id: string; name: string; inputJson: string }) => {
				if (token.isCancellationRequested) return;
				reportInitialResponseNoticeOnce(progress, state, initialResponseNotice);
				handleToolCall(toolCall, state, progress);
			},

			onError: (error: Error) => {
				// Cancellation is delivered as a stream-level error in
				// the SDK adapter; treat it as a quiet abort instead of
				// routing through the user-facing error path (which
				// would surface a "request failed" toast for what is
				// really "the user already moved on").
				if (token.isCancellationRequested) return;
				// Copilot Chat treats upstream quota / rate-limit errors as its
				// own "quota exceeded" signal and pops a "reached the limit /
				// upgrade" modal. MiniMax balance (402) and rate limits (429)
				// are unrelated to Copilot quota, so surface them as plain
				// in-chat text instead of throwing an error the host misinterprets.
				if (
					error instanceof MiniMaxRequestError &&
					(error.status === 402 || error.status === 429)
				) {
					const userFacing = createUserFacingError(error);
					progress.report(new vscode.LanguageModelTextPart(userFacing.message));
					return;
				}
				throw createUserFacingError(error);
			},

			onDone: () => {
				if (token.isCancellationRequested) return;
				reportReplayMarkerOnce(prepared, state, progress);
				finalizeReplayDiagnostics(
					prepared.trailingToolResultIds,
					state,
					prepared.cacheDiagnostics,
				);
			},

			onUsage: (usage: MiniMaxUsage) => {
				if (token.isCancellationRequested) return;
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

		// Track this block so the signature_delta that follows can be
		// backfilled onto the right block. Without this push, the
		// signature always lands on `undefined` and is silently lost
		// (replay markers then omit thinking blocks entirely).
		state.pendingThinkingIndex = state.accumulatedThinkingBlocks.length;
		state.accumulatedThinkingBlocks.push({
			type: 'thinking',
			thinking: text,
		});

		// Emit a VS Code thinking part for in-progress reasoning. The
		// signature_delta that follows will be attached to the same block.
		emitThinkingPart(progress, text);
	} else if (signature && state.pendingThinkingIndex !== undefined) {
		// Backfill signature onto the thinking block it paired with.
		const target = state.accumulatedThinkingBlocks[state.pendingThinkingIndex];
		if (target) {
			target.signature = signature;
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

/**
 * Build the Copilot-Chat-compatible usage data part payload from an
 * Anthropic-shaped usage object.
 *
 * Anthropic charges for the full input prefix on cache-creation turns
 * (the prompt that *wrote* the cache entry, which is then re-used on
 * subsequent turns). Aggregating all three counters into `prompt_tokens`
 * matches both the oai-compatible-copilot upstream and what Copilot
 * Chat's status-bar widget actually expects to see.
 *
 * Note on `cached_tokens`: per Anthropic's API, this field counts
 * only the *read* portion of the cache (i.e. the cached prefix that
 * was actually re-used on this turn). We deliberately do NOT
 * include `cache_creation_input_tokens` here because the OAI-
 * compatible copilot widget interprets `cached_tokens` as "tokens
 * served from cache" — adding the write portion would double-count
 * it. The all-in `prompt_tokens` above is the right number for the
 * "tokens billed on this turn" view; `cached_tokens` is for the
 * cache-effectiveness sub-stat.
 *
 * Returns `null` on a zero-usage turn so the caller can skip
 * reporting it (avoids churning the status bar with empty updates).
 */
export function buildUsageDataPart(usage: MiniMaxUsage): {
	mime: typeof COPILOT_USAGE_DATA_PART_MIME;
	data: {
		prompt_tokens: number;
		completion_tokens: number;
		total_tokens: number;
		prompt_tokens_details: { cached_tokens: number };
	};
} | null {
	const inputTokens = usage.input_tokens ?? 0;
	const cacheCreateTokens = usage.cache_creation_input_tokens ?? 0;
	const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
	const outputTokens = usage.output_tokens ?? 0;
	const promptTokens = inputTokens + cacheCreateTokens + cacheReadTokens;
	if (promptTokens === 0 && outputTokens === 0) {
		return null;
	}
	return {
		mime: COPILOT_USAGE_DATA_PART_MIME,
		data: {
			prompt_tokens: promptTokens,
			completion_tokens: outputTokens,
			total_tokens: promptTokens + outputTokens,
			prompt_tokens_details: {
				cached_tokens: cacheReadTokens,
			},
		},
	};
}

/**
 * Update the chars-per-token ratio using an exponential moving
 * average (EMA) over the latest observed ratio. The 0.7/0.3 split
 * was tuned by the deepseek-v4-for-copilot authors; we keep the
 * same factors for parity. Returns the previous `charsPerToken`
 * unchanged when the inputs are degenerate (zero prompt tokens,
 * zero request chars) — the EMA is undefined there.
 */
export function updateCharsPerToken(
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
	const part = buildUsageDataPart(usage);
	if (!part) {
		return;
	}
	logger.debug('usage.report', {
		usage,
		emitted: part.data,
	});
	try {
		progress.report(
			new vscode.LanguageModelDataPart(
				textEncoder.encode(JSON.stringify(part.data)),
				part.mime,
			),
		);
	} catch (error) {
		logger.error('usage.report.error', {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

// Re-export the event type for downstream diagnostics.
export type { MiniMaxStreamEvent, MiniMaxRequest };
