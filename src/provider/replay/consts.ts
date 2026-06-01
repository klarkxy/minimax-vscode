import { REPLAY_MARKER_MIME } from '../../consts';
import { MODELS } from '../../models/registry';

export { REPLAY_MARKER_MIME };

export const REPLAY_MARKER_WRITER_ID = 'minimax-vscode';

export const REPLAY_MARKER_PREFIXES = new Set<string>([
	REPLAY_MARKER_WRITER_ID,
	...MODELS.map((model) => model.id),
]);

export const ENCODED_JSON_MARKER_PREFIX = 'json:';
export const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
export const LEGACY_SEGMENT_ID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
