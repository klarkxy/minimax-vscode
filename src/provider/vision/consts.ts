/** Default model ID used for the vision proxy when auto-detection is enabled. */
export const DEFAULT_VISION_MODEL_ID = 'gpt-4o';

/**
 * Prompt sent to the vision proxy model when describing image attachments
 * before forwarding them to text-only MiniMax models.
 */
export const IMAGE_DESCRIPTION_PROMPT =
	'Describe all image attachments in this message.\n\n' +
	'If there is one image, describe it directly.\n' +
	'If there are multiple images:\n' +
	'1. Describe each image separately, preserving their order.\n' +
	'2. Then provide a combined description explaining the overall context and relationships across the images.\n\n' +
	'Return one concise factual description suitable for inserting into a text-only chat prompt. Include visible text, objects, UI elements, people, and relevant context. Do not invent details.';

/** Fallback when the vision proxy is unavailable. */
export const IMAGE_DESCRIPTION_UNAVAILABLE = '[Image Description unavailable]';

/** Wrappers around vision model descriptions. Kept stable so prompt shape does not vary by locale. */
export const IMAGE_DESCRIPTION_PREFIX = '[Image Description: ';
export const IMAGE_DESCRIPTION_SUFFIX = ']';
