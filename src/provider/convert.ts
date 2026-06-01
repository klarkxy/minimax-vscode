import * as vscode from 'vscode';
import { safeStringify } from '../json';
import type {
	MiniMaxContentBlock,
	MiniMaxMessage,
	MiniMaxThinkingBlock,
	MiniMaxTool,
} from '../types';
import { findModelById } from '../models/registry';
import { parseFirstReplayMarker, type ReplayMarkerMetadata } from './replay';

const SUPPORTED_IMAGE_MIME_TYPES = new Set([
	'image/jpeg',
	'image/png',
	'image/gif',
	'image/webp',
]);

/**
 * VS Code's stable typings only expose `User` and `Assistant` roles. The
 * `System` role is part of the public `vscode.LanguageModelChatMessageRole`
 * enum but is not surfaced in @types/vscode; we identify it by its numeric
 * value, which has been stable since 1.84.
 */
const SYSTEM_ROLE_VALUE = 3 as const;

function isSystemRole(role: vscode.LanguageModelChatMessageRole): boolean {
	return (role as unknown as number) === SYSTEM_ROLE_VALUE;
}

export interface ConvertedConversation {
	messages: MiniMaxMessage[];
	systemPrompt?: string;
}

export interface ConvertMessagesOptions {
	/** Marker metadata carried over from a previous assistant turn. */
	replayMarkers?: ReplayMarkerMetadata;
}

/**
 * Convert VS Code chat messages to the MiniMax Anthropic-compatible format.
 *
 * Differences from the previous OpenAI-compatible version:
 *   - System messages are extracted and concatenated into the top-level
 *     `system` prompt field (Anthropic does not allow system messages inside
 *     the `messages` array).
 *   - Tool calls become Anthropic `tool_use` content blocks, with `input` as
 *     a structured object (not a pre-serialised string).
 *   - Tool results are emitted as `tool_result` content blocks attached to a
 *     synthetic user message that follows the assistant's `tool_use` block.
 *   - Image parts become Anthropic `image` blocks (base64 or url source).
 *   - Replay markers carry thinking blocks (with signatures) that are
 *     spliced into the assistant content so the model can see its own past
 *     reasoning across conversation turns.
 */
export function convertMessages(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	modelId: string,
	options: ConvertMessagesOptions = {},
): ConvertedConversation {
	const modelDef = findModelById(modelId);
	const supportsImages = modelDef?.capabilities.imageInput ?? false;
	const result: MiniMaxMessage[] = [];
	const systemParts: string[] = [];

	for (const message of messages) {
		// System messages live outside `messages` in the Anthropic API.
		if (isSystemRole(message.role)) {
			const text = concatTextParts(message.content);
			if (text) {
				systemParts.push(text);
			}
			continue;
		}

		if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
			const converted = convertAssistantMessage(message, supportsImages);
			if (converted) {
				result.push(converted);
			}
			continue;
		}

		// User role.
		const converted = convertUserMessage(message, supportsImages);
		if (converted) {
			result.push(converted);
		}
	}

	return {
		messages: result,
		systemPrompt: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
	};
}

function convertAssistantMessage(
	message: vscode.LanguageModelChatRequestMessage,
	supportsImages: boolean,
): MiniMaxMessage | undefined {
	const blocks: MiniMaxContentBlock[] = [];
	let textBuf = '';
	const toolResults: Array<{ callId: string; content: string }> = [];
	const inlineThinkingBlocks: MiniMaxThinkingBlock[] = [];

	for (const part of message.content) {
		if (part instanceof vscode.LanguageModelTextPart) {
			textBuf += part.value;
		} else if (isLanguageModelThinkingPart(part)) {
			const thinkingPart = part as unknown as {
				value: string | string[];
				id?: string;
				metadata?: Record<string, unknown>;
			};
			inlineThinkingBlocks.push({
				type: 'thinking',
				thinking: normalizeThinkingPartText(thinkingPart.value),
			});
		} else if (part instanceof vscode.LanguageModelToolCallPart) {
			let inputObject: Record<string, unknown> = {};
			try {
				inputObject =
					part.input && typeof part.input === 'object'
						? (part.input as Record<string, unknown>)
						: (JSON.parse(safeStringify(part.input)) as Record<string, unknown>);
			} catch {
				inputObject = {};
			}
			blocks.push({
				type: 'tool_use',
				id: part.callId,
				name: part.name,
				input: inputObject,
			});
		} else if (part instanceof vscode.LanguageModelToolResultPart) {
			let toolContent = '';
			for (const item of part.content) {
				if (item instanceof vscode.LanguageModelTextPart) {
					toolContent += item.value;
				} else if (item instanceof vscode.LanguageModelDataPart) {
					toolContent += safeStringify({ mime: item.mimeType, data: '[binary]' });
				}
			}
			toolResults.push({
				callId: part.callId,
				content: toolContent || safeStringify(part.content),
			});
		}
		// Image / data parts on assistant messages are ignored.
	}

	// Replay marker (cross-conversation thinking) takes precedence.
	const replayMarker = parseFirstReplayMarker(message);
	const markerThinking = replayMarker?.valid
		? (replayMarker.thinkingBlocks ?? [])
		: [];
	const thinkingBlocks = markerThinking.length > 0 ? markerThinking : inlineThinkingBlocks;

	if (textBuf) {
		blocks.push({ type: 'text', text: textBuf });
	}
	if (thinkingBlocks.length > 0) {
		blocks.push(...thinkingBlocks);
	}

	if (blocks.length === 0 && toolResults.length === 0) {
		return undefined;
	}

	// Tool results for an assistant turn are delivered as a *user* message
	// that follows the assistant's tool_use blocks, per Anthropic's protocol.
	const out: MiniMaxMessage[] = [{ role: 'assistant', content: blocks }];

	if (toolResults.length > 0) {
		const resultBlocks: MiniMaxContentBlock[] = toolResults.map((tr) => ({
			type: 'tool_result',
			tool_use_id: tr.callId,
			content: tr.content,
		}));
		out.push({ role: 'user', content: resultBlocks });
	}

	void supportsImages; // assistant messages never carry images here
	return out[0];
}

function convertUserMessage(
	message: vscode.LanguageModelChatRequestMessage,
	supportsImages: boolean,
): MiniMaxMessage | undefined {
	const blocks: MiniMaxContentBlock[] = [];
	let textBuf = '';
	let hasNonText = false;

	for (const part of message.content) {
		if (part instanceof vscode.LanguageModelTextPart) {
			textBuf += part.value;
		} else if (part instanceof vscode.LanguageModelDataPart) {
			const mime = part.mimeType;
			if (supportsImages && SUPPORTED_IMAGE_MIME_TYPES.has(mime)) {
				blocks.push(buildImageBlock(part));
				hasNonText = true;
			} else if (mime.startsWith('image/')) {
				// Non-multimodal model with an image attachment. We rely on
				// the vision pipeline (provider/vision) to have already
				// replaced it with a text description. Skip silently.
				continue;
			}
			// Non-image data parts are ignored.
		} else if (part instanceof vscode.LanguageModelToolResultPart) {
			// Tool result carried on a user message — synthesise a
			// tool_result content block. (The provider layer also breaks
			// these out into their own user message, but handle the case
			// for safety.)
			let toolContent = '';
			for (const item of part.content) {
				if (item instanceof vscode.LanguageModelTextPart) {
					toolContent += item.value;
				}
			}
			blocks.push({
				type: 'tool_result',
				tool_use_id: part.callId,
				content: toolContent || safeStringify(part.content),
			});
			hasNonText = true;
		}
	}

	if (textBuf) {
		// If we have a non-text block too, the text becomes its own block.
		// Otherwise, a single-string content is fine for Anthropic too but
		// we keep the block form for consistency.
		blocks.unshift({ type: 'text', text: textBuf });
	} else if (!hasNonText) {
		return undefined;
	}

	if (blocks.length === 0) {
		return undefined;
	}

	// Collapse a single text block into a plain string for cleanliness.
	if (blocks.length === 1 && blocks[0].type === 'text') {
		return { role: 'user', content: blocks[0].text };
	}
	return { role: 'user', content: blocks };
}

function buildImageBlock(part: vscode.LanguageModelDataPart): MiniMaxContentBlock {
	if (part.mimeType === 'image/jpeg' || part.mimeType === 'image/png' ||
		part.mimeType === 'image/gif' || part.mimeType === 'image/webp') {
		return {
			type: 'image',
			source: {
				type: 'base64',
				media_type: part.mimeType,
				data: Buffer.from(part.data).toString('base64'),
			},
		};
	}
	// Fall back to a URL-style source using a data URI. Anthropic accepts
	// data URIs in image source.url.
	return {
		type: 'image',
		source: {
			type: 'url',
			url: `data:${part.mimeType};base64,${Buffer.from(part.data).toString('base64')}`,
		},
	};
}

function concatTextParts(content: readonly unknown[]): string {
	let text = '';
	for (const part of content) {
		if (part instanceof vscode.LanguageModelTextPart) {
			text += part.value;
		}
	}
	return text;
}

function isLanguageModelThinkingPart(part: unknown): boolean {
	if (part === null || typeof part !== 'object') {
		return false;
	}
	if (
		part instanceof vscode.LanguageModelTextPart ||
		part instanceof vscode.LanguageModelToolCallPart ||
		part instanceof vscode.LanguageModelToolResultPart ||
		part instanceof vscode.LanguageModelDataPart
	) {
		return false;
	}
	const value = (part as { value?: unknown }).value;
	return typeof value === 'string' || Array.isArray(value);
}

function normalizeThinkingPartText(value: string | string[]): string {
	return Array.isArray(value) ? value.join('') : value;
}

/**
 * Convert VS Code tool definitions to the Anthropic format. Tool input
 * schemas use JSON Schema, identical to VS Code's `inputSchema`, so the
 * conversion is mostly structural.
 */
export function convertTools(
	tools: readonly vscode.LanguageModelChatTool[] | undefined,
): MiniMaxTool[] | undefined {
	if (!tools || tools.length === 0) {
		return undefined;
	}

	return tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		input_schema: (tool.inputSchema as Record<string, unknown>) ?? {
			type: 'object',
			properties: {},
		},
	}));
}

/**
 * Count total characters across all messages to calibrate chars-per-token.
 * Anthropic charges per token of text + image + tool input; we approximate
 * image and tool input by the byte length of their serialised form.
 */
export function countMessageChars(conversation: ConvertedConversation): number {
	let total = 0;
	for (const part of conversation.systemPrompt ?? []) {
		void part;
	}
	total += (conversation.systemPrompt ?? '').length;
	for (const message of conversation.messages) {
		if (typeof message.content === 'string') {
			total += message.content.length;
			continue;
		}
		for (const block of message.content) {
			switch (block.type) {
				case 'text':
					total += block.text.length;
					break;
				case 'image':
					if (block.source.type === 'base64') {
						total += block.source.data.length;
					} else {
						total += block.source.url.length;
					}
					break;
				case 'tool_use':
					total += block.id.length + block.name.length;
					total += safeStringify(block.input).length;
					break;
				case 'tool_result':
					total += block.tool_use_id.length;
					if (typeof block.content === 'string') {
						total += block.content.length;
					} else {
						for (const inner of block.content) {
							if (inner.type === 'text') {
								total += inner.text.length;
							}
						}
					}
					break;
				case 'thinking':
					total += block.thinking.length;
					break;
			}
		}
	}
	return total;
}
