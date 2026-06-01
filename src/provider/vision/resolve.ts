import * as vscode from 'vscode';
import { toWellFormedString } from '../../json';
import { logger } from '../../logger';
import { parseFirstReplayMarker } from '../replay';
import {
	IMAGE_DESCRIPTION_PREFIX,
	IMAGE_DESCRIPTION_SUFFIX,
	IMAGE_DESCRIPTION_UNAVAILABLE,
} from './consts';
import { getVisionPrompt } from './model';
import type { VisionResolutionResult, VisionResolutionStats } from './types';

/**
 * Build an empty `VisionResolutionResult` that hands the original messages
 * back unchanged. Used when the target model supports image input natively
 * (e.g. MiniMax-M3) — there is no point in spinning up a vision proxy to
 * describe an image only to re-attach it as a base64 block a few lines
 * later, and worse, if the proxy is unavailable the image gets silently
 * replaced with `[Image Description unavailable]`.
 */
export function bypassVisionResolution(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
): VisionResolutionResult {
	return {
		messages,
		stats: {
			inputImageParts: 0,
			inputImageMessages: 0,
			currentImageMessages: 0,
			generatedImageMessages: 0,
			replayedImageMessages: 0,
			omittedImageMessages: 0,
			unavailableImageMessages: 0,
			failedImageMessages: 0,
			droppedImageParts: 0,
			markerVisionTextChars: 0,
			invalidMarkerVisionMetadata: 0,
		},
		replayMarkerMetadata: { thinkingBlocks: undefined },
	};
}

/**
 * Resolve image parts into text descriptions via a vision proxy.
 *
 * Only the "tail" user image message (most recent user message with images)
 * is sent to the vision proxy. Historical images that have already been
 * described in a prior turn are replayed from the marker on the previous
 * assistant message, so the conversation context is preserved without
 * re-sending every image.
 */
export async function resolveImageMessages(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	token: vscode.CancellationToken,
	getModel: () => Promise<vscode.LanguageModelChat | undefined>,
): Promise<VisionResolutionResult> {
	const stats = createVisionResolutionStats();
	collectInputImageStats(messages, stats);
	if (stats.inputImageParts === 0) {
		return { messages, stats, replayMarkerMetadata: {} };
	}

	const markerBindings = createVisionMarkerBindings(messages, stats);
	const currentImageMessageIndex = findCurrentImageMessageIndex(messages);
	const result: vscode.LanguageModelChatRequestMessage[] = [];
	let visionModel: vscode.LanguageModelChat | undefined;
	let visionModelRequested = false;
	let markerVisionText: string | undefined;

	for (const [messageIndex, message] of messages.entries()) {
		const imageParts = getImageParts(message);
		if (imageParts.length === 0) {
			result.push(message as vscode.LanguageModelChatRequestMessage);
			continue;
		}

		const nonImageParts = getNonImageParts(message);
		const replayText = markerBindings.get(messageIndex);
		if (replayText) {
			stats.replayedImageMessages += 1;
			stats.droppedImageParts += imageParts.length;
			result.push(
				createResolvedMessage(message, [
					...nonImageParts,
					new vscode.LanguageModelTextPart(replayText),
				]),
			);
			continue;
		}

		if (messageIndex === currentImageMessageIndex) {
			stats.currentImageMessages += 1;
			if (!visionModelRequested) {
				visionModelRequested = true;
				visionModel = await getModel();
			}
			const visionText = await resolveCurrentVisionText(
				imageParts,
				nonImageParts,
				visionModel,
				stats,
				token,
			);
			markerVisionText = visionText;
			stats.markerVisionTextChars = visionText.length;
			stats.droppedImageParts += imageParts.length;
			result.push(
				createResolvedMessage(message, [
					...nonImageParts,
					new vscode.LanguageModelTextPart(visionText),
				]),
			);
			continue;
		}

		stats.omittedImageMessages += 1;
		stats.droppedImageParts += imageParts.length;
		result.push(createResolvedMessage(message, nonImageParts));
	}

	return {
		messages: result,
		stats,
		replayMarkerMetadata: { thinkingBlocks: undefined },
		visionModelId: visionModel?.id,
	};
}

function createVisionResolutionStats(): VisionResolutionStats {
	return {
		inputImageParts: 0,
		inputImageMessages: 0,
		currentImageMessages: 0,
		generatedImageMessages: 0,
		replayedImageMessages: 0,
		omittedImageMessages: 0,
		unavailableImageMessages: 0,
		failedImageMessages: 0,
		droppedImageParts: 0,
		markerVisionTextChars: 0,
		invalidMarkerVisionMetadata: 0,
	};
}

function collectInputImageStats(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	stats: VisionResolutionStats,
): void {
	for (const message of messages) {
		const imageParts = getImageParts(message).length;
		if (imageParts === 0) {
			continue;
		}
		stats.inputImageMessages += 1;
		stats.inputImageParts += imageParts;
	}
}

function createVisionMarkerBindings(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	stats: VisionResolutionStats,
): Map<number, string> {
	const bindings = new Map<number, string>();
	const boundUserMessages = new Set<number>();

	for (const [messageIndex, message] of messages.entries()) {
		if (message.role !== vscode.LanguageModelChatMessageRole.Assistant) {
			continue;
		}

		const visionText = findAssistantVisionText(message, stats);
		if (!visionText) {
			continue;
		}

		for (let userIndex = messageIndex - 1; userIndex >= 0; userIndex -= 1) {
			if (boundUserMessages.has(userIndex)) {
				continue;
			}
			const candidate = messages[userIndex];
			if (candidate.role !== vscode.LanguageModelChatMessageRole.User) {
				continue;
			}
			if (getImageParts(candidate).length === 0) {
				continue;
			}

			bindings.set(userIndex, visionText);
			boundUserMessages.add(userIndex);
			break;
		}
	}

	return bindings;
}

function findAssistantVisionText(
	_message: vscode.LanguageModelChatRequestMessage,
	_stats: VisionResolutionStats,
): string | undefined {
	// Marker-based vision replay is not yet implemented for MiniMax.
	// Vision descriptions are only injected on the current-turn image,
	// not propagated to subsequent turns.
	return undefined;
}

function findCurrentImageMessageIndex(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
): number | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
			return undefined;
		}
		if (message.role !== vscode.LanguageModelChatMessageRole.User) {
			continue;
		}
		if (getImageParts(message).length > 0) {
			return index;
		}
	}
	return undefined;
}

async function resolveCurrentVisionText(
	imageParts: vscode.LanguageModelDataPart[],
	nonImageParts: readonly vscode.LanguageModelResponsePart[],
	visionModel: vscode.LanguageModelChat | undefined,
	stats: VisionResolutionStats,
	token: vscode.CancellationToken,
): Promise<string> {
	if (!visionModel) {
		stats.unavailableImageMessages += 1;
		return IMAGE_DESCRIPTION_UNAVAILABLE;
	}

	try {
		const response = await visionModel.sendRequest(
			[
				new vscode.LanguageModelTextPart(getVisionPrompt()),
				...nonImageParts,
				...imageParts,
			] as unknown as vscode.LanguageModelChatMessage[],
			{},
			token,
		);

		let text = '';
		for await (const part of response.stream) {
			if (part instanceof vscode.LanguageModelTextPart) {
				text += toWellFormedString(part.value);
			}
		}
		stats.generatedImageMessages += 1;
		return `${IMAGE_DESCRIPTION_PREFIX}${text.trim()}${IMAGE_DESCRIPTION_SUFFIX}`;
	} catch (error) {
		stats.failedImageMessages += 1;
		logger.warn('Vision proxy failed:', error);
		return IMAGE_DESCRIPTION_UNAVAILABLE;
	}
}

function getImageParts(message: vscode.LanguageModelChatRequestMessage): vscode.LanguageModelDataPart[] {
	const parts: vscode.LanguageModelDataPart[] = [];
	for (const part of message.content) {
		if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith('image/')) {
			parts.push(part);
		}
	}
	return parts;
}

function getNonImageParts(message: vscode.LanguageModelChatRequestMessage): vscode.LanguageModelResponsePart[] {
	const parts: vscode.LanguageModelResponsePart[] = [];
	for (const part of message.content) {
		if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith('image/')) {
			continue;
		}
		// Cast to ResponsePart because RequestMessagePart and ResponsePart are the
		// same runtime objects; only the static type differs.
		parts.push(part as unknown as vscode.LanguageModelResponsePart);
	}
	return parts;
}

function createResolvedMessage(
	message: vscode.LanguageModelChatRequestMessage,
	content: readonly vscode.LanguageModelResponsePart[],
): vscode.LanguageModelChatRequestMessage {
	return { ...message, content: content as unknown as vscode.LanguageModelChatRequestMessage['content'] };
}
