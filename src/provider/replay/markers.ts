import * as vscode from 'vscode';
import { safeStringify } from '../../json';
import type { MiniMaxThinkingBlock } from '../../types';
import {
	BASE64URL_PATTERN,
	ENCODED_JSON_MARKER_PREFIX,
	LEGACY_SEGMENT_ID_PATTERN,
	REPLAY_MARKER_MIME,
	REPLAY_MARKER_PREFIXES,
	REPLAY_MARKER_WRITER_ID,
} from './consts';
import type {
	LocatedReplayMarker,
	ReplayMarkerMetadata,
	ReplayMarkerParseResult,
	ReplayMarkerPayloadFormat,
} from './types';

export function findFirstReplayMarker(
	message: vscode.LanguageModelChatRequestMessage,
): LocatedReplayMarker | undefined {
	for (const [partIndex, part] of message.content.entries()) {
		const marker = parseReplayMarkerPart(part);
		if (marker) {
			return { partIndex, marker };
		}
	}
	return undefined;
}

export function parseFirstReplayMarker(
	message: vscode.LanguageModelChatRequestMessage,
): ReplayMarkerParseResult | undefined {
	return findFirstReplayMarker(message)?.marker;
}

function parseReplayMarkerPart(part: unknown): ReplayMarkerParseResult | undefined {
	if (!(part instanceof vscode.LanguageModelDataPart)) {
		return undefined;
	}
	if (part.mimeType !== REPLAY_MARKER_MIME) {
		return undefined;
	}
	const result = parseReplayMarkerData(part.data);
	// Return `undefined` for invalid payloads so `findFirstReplayMarker`
	// can skip past them. The previous code returned the `{ valid:
	// false }` object itself, which was truthy, causing
	// `findFirstReplayMarker` to short-circuit on the first
	// non-marker DataPart that happened to share the replay
	// marker MIME (e.g. a future feature that emits its own
	// `minimax_marker` payloads).
	return result.valid ? result : undefined;
}

export function hasReplayMarkerMetadata(metadata: ReplayMarkerMetadata): boolean {
	return Boolean(metadata.thinkingBlocks && metadata.thinkingBlocks.length > 0);
}

export function createReplayMarkerPart(
	metadata: ReplayMarkerMetadata,
): vscode.LanguageModelDataPart {
	const payload = encodeReplayMarkerJson({
		...(metadata.thinkingBlocks && metadata.thinkingBlocks.length > 0
			? { thinking: { blocks: metadata.thinkingBlocks } }
			: {}),
	});
	return new vscode.LanguageModelDataPart(
		new TextEncoder().encode(`${REPLAY_MARKER_WRITER_ID}\\${payload}`),
		REPLAY_MARKER_MIME,
	);
}

export function parseReplayMarkerData(data: Uint8Array): ReplayMarkerParseResult {
	const decoded = new TextDecoder().decode(data);
	const separatorIndex = decoded.indexOf('\\');
	if (separatorIndex < 0) {
		return { valid: false, error: 'marker-prefix-missing' };
	}

	const markerPrefix = decoded.slice(0, separatorIndex);
	if (!REPLAY_MARKER_PREFIXES.has(markerPrefix)) {
		return { valid: false, error: 'marker-prefix-mismatch' };
	}

	const markerPayload = decoded.slice(separatorIndex + 1);
	const decodedPayload = decodeReplayMarkerPayload(markerPayload);
	if (!decodedPayload.valid) {
		return { valid: false, error: decodedPayload.error };
	}
	const payload = decodedPayload.value;

	if (isValidLegacySegmentId(payload)) {
		return {
			valid: true,
			segmentId: payload.toLowerCase(),
			legacySegmentOnly: true,
			payloadFormat: decodedPayload.format,
		};
	}

	try {
		const value = JSON.parse(payload) as unknown;
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			return { valid: false, error: 'marker-payload-not-object' };
		}

		const segmentId = parseOptionalSegmentId(value);
		if (segmentId.error) {
			return { valid: false, error: segmentId.error };
		}

		const thinking = parseThinkingMarkerMetadata(value);
		return {
			valid: true,
			segmentId: segmentId.value,
			...thinking,
			legacySegmentOnly: Boolean(segmentId.value && !thinking.thinkingBlocks),
			payloadFormat: decodedPayload.format,
		};
	} catch {
		return { valid: false, error: 'marker-json-invalid' };
	}
}

function parseOptionalSegmentId(value: object): {
	value?: string;
	error?: 'segment-id-not-string' | 'segment-id-not-uuid';
} {
	const segmentId = (value as { segmentId?: unknown }).segmentId;
	if (segmentId === undefined) {
		return {};
	}
	if (typeof segmentId !== 'string') {
		return { error: 'segment-id-not-string' };
	}
	if (!isValidLegacySegmentId(segmentId)) {
		return { error: 'segment-id-not-uuid' };
	}
	return { value: segmentId.toLowerCase() };
}

function parseThinkingMarkerMetadata(value: object): {
	thinkingBlocks?: MiniMaxThinkingBlock[];
} {
	const thinking = (value as { thinking?: unknown }).thinking;
	if (thinking === undefined) {
		return {};
	}
	if (!thinking || typeof thinking !== 'object' || Array.isArray(thinking)) {
		return {};
	}

	const blocks = (thinking as { blocks?: unknown }).blocks;
	if (!Array.isArray(blocks)) {
		return {};
	}

	const parsed: MiniMaxThinkingBlock[] = [];
	for (const entry of blocks) {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
			continue;
		}
		const text = (entry as { thinking?: unknown }).thinking;
		if (typeof text !== 'string' || text.length === 0) {
			continue;
		}
		const signature = (entry as { signature?: unknown }).signature;
		const block: MiniMaxThinkingBlock = {
			type: 'thinking',
			thinking: text,
		};
		if (typeof signature === 'string' && signature.length > 0) {
			block.signature = signature;
		}
		parsed.push(block);
	}

	return parsed.length > 0 ? { thinkingBlocks: parsed } : {};
}

function encodeReplayMarkerJson(value: object): string {
	const json = safeStringify(value);
	return `${ENCODED_JSON_MARKER_PREFIX}${Buffer.from(json, 'utf8').toString('base64url')}`;
}

function decodeReplayMarkerPayload(
	markerPayload: string,
):
	| { valid: true; value: string; format: ReplayMarkerPayloadFormat }
	| { valid: false; error: string } {
	if (markerPayload.startsWith(ENCODED_JSON_MARKER_PREFIX)) {
		const encoded = markerPayload.slice(ENCODED_JSON_MARKER_PREFIX.length);
		if (!encoded || !BASE64URL_PATTERN.test(encoded)) {
			return { valid: false, error: 'marker-payload-not-base64url' };
		}
		const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
		return { valid: true, value: decoded, format: 'json-base64url' };
	}
	if (markerPayload.startsWith('{') || markerPayload.startsWith('[')) {
		return { valid: true, value: markerPayload, format: 'raw-json' };
	}
	if (isValidLegacySegmentId(markerPayload)) {
		return { valid: true, value: markerPayload.toLowerCase(), format: 'raw-uuid' };
	}
	return { valid: false, error: 'marker-payload-not-json' };
}

function isValidLegacySegmentId(value: string): boolean {
	return LEGACY_SEGMENT_ID_PATTERN.test(value);
}
