import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { findFirstReplayMarker } from './replay';

export type SegmentResolveReason = 'markerFound' | 'markerMissing' | 'markerInvalid';

export interface ConversationSegment {
	segmentId: string;
	reason: SegmentResolveReason;
	markerMessageIndex?: number;
	markerPartIndex?: number;
	markerError?: string;
}

/**
 * Resolve the conversation segment ID for a request.
 *
 * Looks for a replay marker on the latest assistant message. When found and
 * valid, the marker carries a UUID that links the new request to a previous
 * conversation. When missing/invalid a new UUID is generated. The stable
 * segmentId is what makes cross-conversation reasoning replay possible —
 * the upstream prompt cache keys on it, so a returning user lands on a warm
 * cache instead of paying the cold-cache penalty on every turn.
 *
 * Vision attachments are intentionally **not** part of the segment contract:
 * images are forwarded natively to M3 or pre-resolved by the MCP
 * image-understanding tool, neither of which needs the segmentId to
 * replay.
 */
export function resolveConversationSegment(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
): ConversationSegment {
	for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
		const message = messages[messageIndex];
		if (message.role !== vscode.LanguageModelChatMessageRole.Assistant) {
			continue;
		}

		const foundMarker = findFirstReplayMarker(message);
		if (!foundMarker) {
			continue;
		}

		const { marker, partIndex } = foundMarker;
		if (marker.valid && marker.segmentId) {
			return {
				segmentId: marker.segmentId,
				reason: 'markerFound',
				markerMessageIndex: messageIndex,
				markerPartIndex: partIndex,
			};
		}

		if (!marker.valid) {
			return {
				segmentId: randomUUID(),
				reason: 'markerInvalid',
				markerMessageIndex: messageIndex,
				markerPartIndex: partIndex,
				markerError: marker.error ?? 'unknown-marker-error',
			};
		}
	}

	return {
		segmentId: randomUUID(),
		reason: 'markerMissing',
	};
}
