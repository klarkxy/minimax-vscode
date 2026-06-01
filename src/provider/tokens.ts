import * as vscode from 'vscode';
import { REPLAY_MARKER_MIME } from './replay';

const IMAGE_PART_ESTIMATED_CHARS = 1020;
const DEFAULT_CHARS_PER_TOKEN = 4.0;
const MAX_PARTS_BYTES = 10_000;

/**
 * Recursively estimate the character count for a single content part.
 * Returns character count, which the caller divides by charsPerToken to get
 * the token estimate. The provider maintains a calibrated charsPerToken
 * value updated by `updateCharsPerToken` based on real API usage.
 */
function estimatePartChars(part: unknown): number {
	// 1. LanguageModelTextPart — the most common case
	if (part instanceof vscode.LanguageModelTextPart) {
		return part.value.length;
	}

	// 2. LanguageModelToolCallPart — count callId + name + JSON-serialized input
	if (part instanceof vscode.LanguageModelToolCallPart) {
		let chars = part.callId.length + part.name.length;
		try {
			chars += JSON.stringify(part.input).length;
		} catch {
			chars += 2;
		}
		return chars;
	}

	// 3. LanguageModelToolResultPart — recursively count nested content parts
	if (part instanceof vscode.LanguageModelToolResultPart) {
		let chars = part.callId.length;
		if (Array.isArray(part.content)) {
			for (const item of part.content) {
				chars += estimatePartChars(item);
			}
		}
		return chars;
	}

	// 4. LanguageModelDataPart — use a capped heuristic. Images go through
	//    the vision pipeline before reaching the API, so we use a stable
	//    fallback estimate instead of raw image bytes.
	if (part instanceof vscode.LanguageModelDataPart) {
		const mime = part.mimeType;
		if (mime === REPLAY_MARKER_MIME) {
			// Marker metadata is not sent as assistant content.
			return 0;
		}
		if (mime.startsWith('image/')) {
			return IMAGE_PART_ESTIMATED_CHARS;
		}
		// PDFs and other documents: use byteLength as a rough proxy but cap it
		// to prevent a single large attachment from dominating the budget.
		return Math.min(part.data?.byteLength ?? 0, MAX_PARTS_BYTES);
	}

	// 5. LanguageModelThinkingPart (proposed API) — handle string | string[]
	if (looksLikeThinkingPart(part)) {
		const value = (part as { value?: unknown }).value;
		if (typeof value === 'string') {
			return value.length;
		}
		if (Array.isArray(value)) {
			let chars = 0;
			for (const s of value) {
				if (typeof s === 'string') {
					chars += s.length;
				}
			}
			return chars;
		}
		return 0;
	}

	// 6. Fallback: try to stringify unknown part types
	if (part && typeof part === 'object') {
		try {
			return JSON.stringify(part).length;
		} catch {
			return 0;
		}
	}

	return 0;
}

/**
 * Duck-typed check for LanguageModelThinkingPart (proposed API, may not be available
 * at runtime). The part has a `value` of string | string[] and is not any of the
 * well-known part classes.
 */
function looksLikeThinkingPart(part: unknown): boolean {
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

export function estimateTokenCount(
	text: string | vscode.LanguageModelChatRequestMessage,
	charsPerToken: number,
): number {
	if (typeof text === 'string') {
		return Math.max(1, Math.ceil(text.length / charsPerToken));
	}

	if (!text?.content || !Array.isArray(text.content)) {
		return 1;
	}

	let totalChars = 0;
	for (const part of text.content) {
		totalChars += estimatePartChars(part);
	}
	return Math.max(1, Math.ceil(totalChars / charsPerToken));
}

export { DEFAULT_CHARS_PER_TOKEN };
