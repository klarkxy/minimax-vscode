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
