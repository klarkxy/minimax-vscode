import type { MiniMaxThinkingBlock } from '../../types';

export interface ReplayMarkerParseResult {
	valid: boolean;
	segmentId?: string;
	thinkingBlocks?: MiniMaxThinkingBlock[];
	legacySegmentOnly?: boolean;
	payloadFormat?: ReplayMarkerPayloadFormat;
	error?: string;
}

export interface LocatedReplayMarker {
	partIndex: number;
	marker: ReplayMarkerParseResult;
}

export type ReplayMarkerPayloadFormat = 'json-base64url' | 'raw-json' | 'raw-uuid';

export interface ReplayMarkerMetadata {
	thinkingBlocks?: MiniMaxThinkingBlock[];
}
