import * as vscode from 'vscode';
import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../logger';
import type {
	MiniMaxMessage,
	MiniMaxRequest,
	MiniMaxStreamEvent,
	MiniMaxTool,
	MiniMaxUsage,
	StreamCallbacks,
} from '../types';
import { createHttpError, normalizeRequestError } from './error';

export { MiniMaxRequestError } from './error';

export interface ChatOptions {
	apiKey?: string;
	baseUrl?: string;
	/** Optional Anthropic beta header. */
	betas?: string[];
	/**
	 * Optional per-model overrides that should be merged into the
	 * request body. Currently used for `sampling` (temperature,
	 * top_p, top_k, frequency_penalty) and `extra` (escape hatch for
	 * any future Anthropic / MiniMax field).
	 */
	modelDef?: MiniMaxModelSamplingSource;
}

/**
 * Append non-empty query parameters to a base URL while preserving any
 * existing query string. Used as a hook for future MiniMax-specific
 * toggles; the current thinking-effort signal is sent in the request
 * body via the typed `thinking` field, not the URL.
 */
export function appendQueryParams(
	baseUrl: string,
	params: Record<string, string | number | boolean | undefined> | undefined,
): string {
	if (!params) {
		return baseUrl;
	}
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value === undefined || value === null) {
			continue;
		}
		search.append(key, String(value));
	}
	const suffix = search.toString();
	if (!suffix) {
		return baseUrl;
	}
	return baseUrl.includes('?') ? `${baseUrl}&${suffix}` : `${baseUrl}?${suffix}`;
}


/**
 * Anthropic accepts at most 4 `cache_control` breakpoints per request. The
 * VS Code Copilot host can already emit several breakpoints inside
 * `messages`; combined with the two we add (system + last tool) the total
 * can exceed 4 and the API returns 400. This function counts every
 * breakpoint currently set on `system`, `tools`, and each message content
 * block, and if the total exceeds 4, strips breakpoints in a stable
 * priority order:
 *   1. In-message breakpoints, earliest first (least valuable — covers the
 *      shortest prefix).
 *   2. The tools breakpoint, if still over budget after step 1.
 *   3. The system breakpoint(s), last (most valuable — covers the longest
 *      stable prefix).
 *
 * Mirrors the oai-compatible-copilot `enforceCacheControlBudget` so the
 * two extensions behave identically under the same host input.
 */
const CACHE_CONTROL_BUDGET = 4;

export function enforceCacheControlBudget(
	params: Record<string, unknown>,
): void {
	let total = 0;
	const systemBlocksWithCC: Array<{ cache_control?: unknown }> = [];
	const toolsWithCC: Array<{ name?: unknown; cache_control?: unknown }> = [];
	const msgBlocksWithCC: Array<{ cache_control?: unknown }> = [];

	const system = params.system;
	if (Array.isArray(system)) {
		for (const block of system) {
			if (block && typeof block === 'object' && (block as { cache_control?: unknown }).cache_control) {
				systemBlocksWithCC.push(block as { cache_control?: unknown });
				total++;
			}
		}
	}
	const tools = params.tools;
	if (Array.isArray(tools)) {
		for (const tool of tools) {
			if (tool && typeof tool === 'object' && (tool as { cache_control?: unknown }).cache_control) {
				toolsWithCC.push(tool as { name?: unknown; cache_control?: unknown });
				total++;
			}
		}
	}
	const messages = params.messages;
	if (Array.isArray(messages)) {
		for (const msg of messages) {
			if (!msg || typeof msg !== 'object') {
				continue;
			}
			const content = (msg as { content?: unknown }).content;
			if (Array.isArray(content)) {
				for (const block of content) {
					if (
						block &&
						typeof block === 'object' &&
						(block as { cache_control?: unknown }).cache_control
					) {
						msgBlocksWithCC.push(block as { cache_control?: unknown });
						total++;
					}
				}
			}
		}
	}

	if (total <= CACHE_CONTROL_BUDGET) {
		return;
	}

	let toRemove = total - CACHE_CONTROL_BUDGET;
	const removalLog: string[] = [];

	for (const block of msgBlocksWithCC) {
		if (toRemove === 0) {
			break;
		}
		delete block.cache_control;
		toRemove--;
		removalLog.push('message');
	}
	for (const tool of toolsWithCC) {
		if (toRemove === 0) {
			break;
		}
		delete tool.cache_control;
		toRemove--;
		removalLog.push('tool');
	}
	for (const block of systemBlocksWithCC) {
		if (toRemove === 0) {
			break;
		}
		delete block.cache_control;
		toRemove--;
		removalLog.push('system');
	}

	logger.debug('anthropic.cache_control.trim', {
		originalCount: total,
		finalCount: CACHE_CONTROL_BUDGET,
		dropped: removalLog,
	});
}

/**
 * Wire the per-model `sampling` block into the request body, but only
 * when thinking is off (the Anthropic `thinking` constraint overrides
 * `temperature` and `top_p` when it's on). Always respects
 * `topK` and `frequencyPenalty` — those are not constrained by thinking.
 */
function applyPerModelSampling(
	params: Record<string, unknown>,
	modelDef: MiniMaxModelSamplingSource | undefined,
	thinking: { type: 'adaptive' | 'disabled' } | undefined,
): void {
	const sampling = modelDef?.sampling;
	if (!sampling) {
		return;
	}
	if (thinking) {
		// Thinking on: Anthropic's constraint wins, so we only forward
		// the fields that aren't constrained (topK, frequencyPenalty).
		if (typeof sampling.topK === 'number') {
			params.top_k = sampling.topK;
		}
		if (typeof sampling.frequencyPenalty === 'number') {
			params.frequency_penalty = sampling.frequencyPenalty;
		}
		return;
	}
	if (typeof sampling.temperature === 'number') {
		params.temperature = sampling.temperature;
	}
	if (typeof sampling.topP === 'number') {
		params.top_p = sampling.topP;
	}
	if (typeof sampling.topK === 'number') {
		params.top_k = sampling.topK;
	}
	if (typeof sampling.frequencyPenalty === 'number') {
		params.frequency_penalty = sampling.frequencyPenalty;
	}
}

/**
 * Shape we read from the optional modelDef argument on the request
 * builders. Declared inline to avoid a circular import (core.ts is
 * the lowest layer in the request path).
 */
interface MiniMaxModelSamplingSource {
	sampling?: {
		temperature?: number;
		topP?: number;
		topK?: number;
		frequencyPenalty?: number;
	};
	extra?: Record<string, unknown>;
}

/**
 * Merge the per-model `extra` escape hatch into the request body.
 * Any key the user (or the registry) put on `modelDef.extra` ends up
 * as a top-level field on the Anthropic request. Used for fields like
 * `stop_sequences`, `service_tier`, `metadata`, or whatever MiniMax
 * ships next that we don't have a first-class config for yet.
 */
function applyExtraParams(
	params: Record<string, unknown>,
	modelDef: MiniMaxModelSamplingSource | undefined,
): void {
	const extra = modelDef?.extra;
	if (!extra || typeof extra !== 'object') {
		return;
	}
	for (const [key, value] of Object.entries(extra)) {
		if (value === undefined) {
			continue;
		}
		// Don't let `extra` clobber the Anthropic-required / constrained
		// fields we always set ourselves.
		if (
			key === 'model' ||
			key === 'messages' ||
			key === 'stream' ||
			key === 'max_tokens' ||
			key === 'system' ||
			key === 'thinking' ||
			key === 'tools' ||
			key === 'temperature' ||
			key === 'top_p' ||
			key === 'top_k' ||
			key === 'frequency_penalty'
		) {
			continue;
		}
		// `tools` from extra is concatenated with our tools list rather
		// than replacing it (matches upstream behaviour).
		if (key === 'tools' && Array.isArray(value)) {
			const existing = Array.isArray(params.tools) ? params.tools : [];
			params.tools = [...existing, ...(value as unknown[])];
			continue;
		}
		params[key] = value;
	}
}

/**
 * Attach Anthropic-style `cache_control: { type: "ephemeral" }`
 * breakpoints to the system prompt and the last tool, then run
 * `enforceCacheControlBudget` to make sure the total stays under the
 * 4-breakpoint cap.
 */
function attachCacheControlBreakpoints(params: Record<string, unknown>): void {
	const system = params.system;
	if (typeof system === 'string' && system.length > 0) {
		// Upgrade the string to a structured text block so we can carry
		// a cache_control breakpoint. The Anthropic SDK accepts either
		// form; the structured form is the only one that supports
		// `cache_control`.
		params.system = [
			{ type: 'text', text: system, cache_control: { type: 'ephemeral' } },
		];
	} else if (Array.isArray(system) && system.length > 0) {
		// Append the breakpoint to the last system block so we don't
		// create a new chunked prefix.
		const last = system[system.length - 1] as { cache_control?: unknown };
		if (last && typeof last === 'object' && !last.cache_control) {
			last.cache_control = { type: 'ephemeral' };
		}
	}

	const tools = params.tools;
	if (Array.isArray(tools) && tools.length > 0) {
		const last = tools[tools.length - 1] as { cache_control?: unknown };
		if (last && typeof last === 'object' && !last.cache_control) {
			last.cache_control = { type: 'ephemeral' };
		}
	}

	enforceCacheControlBudget(params);
}

/**
 * Thin wrapper around the Anthropic SDK tuned for the MiniMax Anthropic-
 * compatible endpoint. The SDK does most of the work (SSE framing, auth,
 * retries); we add:
 *  - abort handling driven by the VS Code cancellation token
 *  - HTTP / network error normalisation through `client/error.ts`
 *  - stream-event translation into the `StreamCallbacks` shape used by the
 *    provider layer (so the rest of the codebase is SDK-agnostic)
 *  - Anthropic-message-shape construction (system as top-level field, content
 *    blocks, etc.)
 */
export class MiniMaxClient {
	private readonly defaultBaseUrl = 'https://api.minimaxi.com/anthropic';

	/**
	 * Stream a chat completion from the MiniMax Anthropic-compatible API.
	 *
	 * Errors are reported through `callbacks.onError` so the provider layer
	 * can wrap them in user-facing messages. We never re-throw — the host
	 * would otherwise see an unhandled promise rejection.
	 */
	async streamChat(
		model: string,
		messages: MiniMaxMessage[],
		options: ChatOptions | undefined,
		cancellationToken: vscode.CancellationToken | undefined,
		systemPrompt: string | undefined,
		maxTokens: number,
		tools: MiniMaxTool[] | undefined,
		thinking: { type: 'adaptive' | 'disabled' } | undefined,
		temperature: number | undefined,
		topP: number | undefined,
		callbacks: StreamCallbacks,
		extraQueryParams?: Record<string, string | number | boolean | undefined>,
	): Promise<void> {
		// `options.modelDef` carries per-model `sampling` and `extra`
		// fields. It's the only way to plumb the modelDef down to the
		// helper functions without a circular import.
		// (declared once on the method below via the apply* helpers)
		const apiKey = options?.apiKey?.trim();
		if (!apiKey) {
			callbacks.onError(new Error('API key is required'));
			return;
		}

		const baseUrl = options?.baseUrl?.trim() || this.defaultBaseUrl;
		const effectiveBaseUrl = appendQueryParams(baseUrl, extraQueryParams);
		const client = new Anthropic({ apiKey, baseURL: effectiveBaseUrl });

		// Build the Anthropic request body. System prompt is a top-level field.
		// Thinking requires the dedicated beta header on the Anthropic API; on
		// the MiniMax Anthropic-compatible surface it is a first-class field.
		const params: Record<string, unknown> = {
			model,
			max_tokens: maxTokens,
			messages: messages as unknown as Array<Record<string, unknown>>,
			stream: true,
		};
		if (systemPrompt && systemPrompt.length > 0) {
			params.system = systemPrompt;
		}
		if (tools && tools.length > 0) {
			params.tools = tools as unknown as Array<Record<string, unknown>>;
		}
		// Attach Anthropic-style cache_control breakpoints to the system
		// prompt and last tool, then run enforceCacheControlBudget to
		// trim in-message breakpoints if the host's own caching strategy
		// would otherwise push us past Anthropic's 4-breakpoint cap.
		attachCacheControlBreakpoints(params);
		if (thinking) {
			// Note: Anthropic's thinking constraint is that temperature must be 1
			// (the default) and top_p must be unset. We respect that here.
			params.thinking = thinking;
		} else {
			if (typeof temperature === 'number') {
				params.temperature = temperature;
			}
			if (typeof topP === 'number' && topP > 0 && topP <= 1) {
				params.top_p = topP;
			}
		}
		applyPerModelSampling(params, options?.modelDef, thinking);
		applyExtraParams(params, options?.modelDef);

		const abortController = new AbortController();
		const cancellationDisposable = cancellationToken?.onCancellationRequested(() => {
			abortController.abort();
		});

		try {
			const stream = client.messages.stream(
				params as unknown as Parameters<typeof client.messages.stream>[0],
				{ signal: abortController.signal },
			);

			await consumeAnthropicStream(
				stream as unknown as AsyncIterable<MiniMaxStreamEvent>,
				callbacks,
				abortController,
			);
		} catch (error) {
			if (isAbortError(error) && cancellationToken?.isCancellationRequested) {
				return;
			}
			const normalized = await normalizeTransportError(error, baseUrl);
			logger.error(
				'MiniMax request failed:',
				'diagnosticMessage' in normalized
					? (normalized as Error & { diagnosticMessage?: string }).diagnosticMessage
					: normalized.message,
				error,
			);
			callbacks.onError(normalized);
		} finally {
			cancellationDisposable?.dispose();
		}
	}

	/**
	 * Send a non-streaming chat completion and return the assembled
	 * text plus final usage block. Used by utilities that only need
	 * the final answer (e.g. commit-message generation) and do not
	 * want the ceremony of stream callbacks.
	 *
	 * Returns `{ text: '' }` on cancellation / hard error so callers
	 * can handle the empty-result case with a localised message.
	 */
	async completeChat(
		apiKey: string,
		baseUrl: string | undefined,
		request: MiniMaxRequest,
		cancellationToken: vscode.CancellationToken | undefined,
		extraQueryParams?: Record<string, string | number | boolean | undefined>,
	): Promise<{ text: string; usage?: MiniMaxUsage }> {
		const trimmedKey = apiKey?.trim();
		if (!trimmedKey) {
			throw new Error('API key is required');
		}
		const url = appendQueryParams(baseUrl?.trim() || this.defaultBaseUrl, extraQueryParams);
		const client = new Anthropic({ apiKey: trimmedKey, baseURL: url });

		// completeChat always sends a non-streaming request; the type
		// assertion strips the "stream: true" marker that buildRequest
		// includes for stream-based consumers.
		const body = { ...request, stream: false } as unknown as Parameters<typeof client.messages.create>[0];

		const abortController = new AbortController();
		const cancellationDisposable = cancellationToken?.onCancellationRequested(() => {
			abortController.abort();
		});

		try {
			const response = await client.messages.create(body, {
				signal: abortController.signal,
			});
			const text = extractAssistantText(response);
			const usage = (response as { usage?: MiniMaxUsage }).usage;
			return { text, usage };
		} catch (error) {
			if (isAbortError(error) && cancellationToken?.isCancellationRequested) {
				return { text: '' };
			}
			const normalized = await normalizeTransportError(error, url);
			logger.error(
				'MiniMax non-streaming request failed:',
				'diagnosticMessage' in normalized
					? (normalized as Error & { diagnosticMessage?: string }).diagnosticMessage
					: normalized.message,
				error,
			);
			throw normalized;
		} finally {
			cancellationDisposable?.dispose();
		}
	}

	/** Build a request payload without sending it. Used by request dumpers. */
	buildRequest(
		model: string,
		messages: MiniMaxMessage[],
		systemPrompt: string | undefined,
		maxTokens: number,
		tools: MiniMaxTool[] | undefined,
		thinking: { type: 'adaptive' | 'disabled' } | undefined,
		temperature: number | undefined,
		topP: number | undefined,
		modelDef?: MiniMaxModelSamplingSource,
	): MiniMaxRequest {
		const request: MiniMaxRequest = {
			model,
			messages,
			stream: true,
			max_tokens: maxTokens,
		};
		if (systemPrompt) {
			request.system = systemPrompt;
		}
		if (tools && tools.length > 0) {
			request.tools = tools;
		}
		// Same Anthropic cache_control placement as the live stream path
		// so request dumps (verbose mode) reflect the real wire payload.
		attachCacheControlBreakpoints(request as unknown as Record<string, unknown>);
		if (thinking) {
			request.thinking = thinking;
		}
		if (!thinking) {
			if (typeof temperature === 'number') {
				request.temperature = temperature;
			}
			if (typeof topP === 'number' && topP > 0 && topP <= 1) {
				request.top_p = topP;
			}
		}
		applyPerModelSampling(request as unknown as Record<string, unknown>, modelDef, thinking);
		applyExtraParams(request as unknown as Record<string, unknown>, modelDef);
		return request;
	}
}

async function normalizeTransportError(error: unknown, baseUrl: string): Promise<Error> {
	// Anthropic SDK throws `Anthropic.APIError` with `status`, `headers`, and
	// a JSON `error` body. When we have the raw response we can route through
	// the same createHttpError path that the legacy transport used; otherwise
	// we fall back to generic normalisation.
	if (isAnthropicApiError(error)) {
		const status = error.status;
		if (status !== undefined) {
			const responseText = extractAnthropicErrorBody(error);
			const response = new Response(responseText, {
				status,
				statusText: (error as { statusText?: string }).statusText ?? '',
			});
			return await createHttpError(response, baseUrl);
		}
	}
	return normalizeRequestError(error);
}

function isAnthropicApiError(
	error: unknown,
): error is InstanceType<typeof Anthropic.APIError> {
	return (
		!!error &&
		typeof error === 'object' &&
		typeof (error as { status?: unknown }).status === 'number' &&
		(error as { name?: string }).name === 'APIError'
	);
}

function extractAnthropicErrorBody(error: InstanceType<typeof Anthropic.APIError>): string {
	try {
		const inner = error.error as { type?: string } | undefined;
		return JSON.stringify({
			type: 'error',
			error: { type: inner?.type ?? 'api_error', message: error.message },
		});
	} catch {
		return error.message;
	}
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === 'AbortError';
}

function extractAssistantText(response: unknown): string {
	const content = (response as { content?: unknown }).content;
	if (!Array.isArray(content)) {
		return '';
	}
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== 'object') {
			continue;
		}
		const type = (block as { type?: unknown }).type;
		const text = (block as { text?: unknown }).text;
		if (type === 'text' && typeof text === 'string') {
			parts.push(text);
		}
	}
	return parts.join('');
}

/**
 * Drive the Anthropic SDK's async-iterable event stream and dispatch
 * `StreamCallbacks`. We also collect the final usage block from
 * `message_delta` so the provider can calibrate token counting.
 */
async function consumeAnthropicStream(
	stream: AsyncIterable<MiniMaxStreamEvent>,
	callbacks: StreamCallbacks,
	abortController: AbortController,
): Promise<void> {
	// Per-block accumulators for tool calls (input_json_delta fragments).
	const toolInputBuffers = new Map<number, { id: string; name: string }>();
	const toolArgsBuffers = new Map<number, string>();

	let pendingUsage: MiniMaxUsage | undefined;

	for await (const event of stream) {
		switch (event.type) {
			case 'message_start': {
				pendingUsage = event.message?.usage;
				break;
			}
			case 'content_block_start': {
				const block = event.content_block;
				if (block.type === 'tool_use') {
					toolInputBuffers.set(event.index, { id: block.id, name: block.name });
					toolArgsBuffers.set(event.index, '');
				}
				break;
			}
			case 'content_block_delta': {
				const delta = event.delta;
				if (delta.type === 'text_delta') {
					callbacks.onContent(delta.text);
				} else if (delta.type === 'thinking_delta') {
					callbacks.onThinking(delta.thinking);
				} else if (delta.type === 'input_json_delta') {
					const existing = toolArgsBuffers.get(event.index) ?? '';
					toolArgsBuffers.set(event.index, existing + delta.partial_json);
				} else if (delta.type === 'signature_delta') {
					// Signature is paired with the immediately preceding thinking
					// delta. We forward it via a no-content thinking callback so
					// the caller can capture it for cross-turn replay.
					callbacks.onThinking('', delta.signature);
				}
				break;
			}
			case 'content_block_stop': {
				const meta = toolInputBuffers.get(event.index);
				const args = toolArgsBuffers.get(event.index);
				if (meta && args !== undefined) {
					callbacks.onToolCall({ id: meta.id, name: meta.name, inputJson: args });
					toolInputBuffers.delete(event.index);
					toolArgsBuffers.delete(event.index);
				}
				break;
			}
			case 'message_delta': {
				if (event.usage) {
					pendingUsage = {
						...(pendingUsage ?? {
							input_tokens: 0,
							output_tokens: 0,
						}),
						output_tokens: event.usage.output_tokens ?? pendingUsage?.output_tokens ?? 0,
					};
				}
				break;
			}
			case 'message_stop': {
				if (pendingUsage && callbacks.onUsage) {
					callbacks.onUsage(pendingUsage);
				}
				callbacks.onDone();
				return;
			}
			case 'ping':
			default:
				break;
		}
	}

	abortController.abort();
	if (pendingUsage && callbacks.onUsage) {
		callbacks.onUsage(pendingUsage);
	}
	callbacks.onDone();
}
