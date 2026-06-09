/**
 * Shared types for the MiniMax Copilot extension.
 *
 * The extension talks to the MiniMax Anthropic-compatible endpoint
 * (`https://api.minimaxi.com/anthropic` or `https://api.minimax.io/anthropic`).
 * We deliberately mirror the Anthropic Messages API shape here so that
 * `request`/`stream` modules can be written against a stable contract without
 * leaking the SDK types into every consumer.
 */

// ---- Content blocks (Anthropic Messages API style) ----

export type MiniMaxTextBlock = {
	type: 'text';
	text: string;
};

export type MiniMaxImageBlock = {
	type: 'image';
	source:
		| { type: 'base64'; media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'; data: string }
		| { type: 'url'; url: string };
};

/**
 * Video block. M3 only (M2.x silently drops the part with a warning).
 * The `source` mirrors `MiniMaxImageBlock` plus a third form
 * (`mm_file`) for Files-API references, per the MiniMax docs:
 *   - `base64` for inline uploads ≤ 50 MB
 *   - `url` for hosted videos (must be ≤ 50 MB by default)
 *   - `mm_file` for files uploaded via the Files API (≤ 512 MB)
 *     — the request body stays small, the API streams the file by id.
 */
export type MiniMaxVideoBlock = {
	type: 'video';
	source:
		| { type: 'base64'; media_type: 'video/mp4' | 'video/avi' | 'video/quicktime' | 'video/x-matroska'; data: string }
		| { type: 'url'; url: string }
		| { type: 'mm_file'; file_id: string };
};

export type MiniMaxToolUseBlock = {
	type: 'tool_use';
	id: string;
	name: string;
	input: Record<string, unknown>;
};

export type MiniMaxToolResultBlock = {
	type: 'tool_result';
	tool_use_id: string;
	content: string | MiniMaxContentBlock[];
	is_error?: boolean;
};

export type MiniMaxThinkingBlock = {
	type: 'thinking';
	thinking: string;
	signature?: string;
};

export type MiniMaxContentBlock =
	| MiniMaxTextBlock
	| MiniMaxImageBlock
	| MiniMaxVideoBlock
	| MiniMaxToolUseBlock
	| MiniMaxToolResultBlock
	| MiniMaxThinkingBlock;

// ---- Messages ----

export interface MiniMaxUserMessage {
	role: 'user';
	content: string | MiniMaxContentBlock[];
}

export interface MiniMaxAssistantMessage {
	role: 'assistant';
	content: MiniMaxContentBlock[];
}

export type MiniMaxMessage = MiniMaxUserMessage | MiniMaxAssistantMessage;

/**
 * Result of `convertMessages`: an Anthropic-style `messages` array
 * plus the extracted `system` prompt. Lives in `types.ts` so
 * downstream callers (request layer, debug dumper) can import it
 * without dragging in the converter's `vscode` dependencies.
 */
export interface ConvertedConversation {
	messages: MiniMaxMessage[];
	systemPrompt?: string;
}

// ---- Tools ----

export interface MiniMaxTool {
	name: string;
	description?: string;
	input_schema: Record<string, unknown>;
}

// ---- Request params ----

export type MiniMaxRequest = {
	model: string;
	messages: MiniMaxMessage[];
	max_tokens: number;
	system?: string;
	stream: boolean;
	temperature?: number;
	top_p?: number;
	tools?: MiniMaxTool[];
	tool_choice?: { type: 'auto' | 'any' | 'tool'; name?: string };
	thinking?: {
		type: 'adaptive' | 'disabled';
	};
};

// ---- Usage ----

export interface MiniMaxUsage {
	input_tokens: number;
	output_tokens: number;
	cache_creation_input_tokens?: number;
	cache_read_input_tokens?: number;
}

// ---- Stream events (subset of Anthropic MessageStreamEvent we consume) ----

export type MiniMaxStreamEvent =
	| { type: 'message_start'; message?: { usage?: MiniMaxUsage; id?: string; model?: string } }
	| {
			type: 'content_block_start';
			index: number;
			content_block:
				| MiniMaxTextBlock
				| MiniMaxToolUseBlock
				| MiniMaxThinkingBlock;
	  }
	| {
			type: 'content_block_delta';
			index: number;
			delta:
				| { type: 'text_delta'; text: string }
				| { type: 'input_json_delta'; partial_json: string }
				| { type: 'thinking_delta'; thinking: string }
				| { type: 'signature_delta'; signature: string };
	  }
	| { type: 'content_block_stop'; index: number }
	| { type: 'message_delta'; delta: { stop_reason?: string; stop_sequence?: string }; usage?: { output_tokens?: number } }
	| { type: 'message_stop' }
	| { type: 'ping' };

// ---- Stream callbacks ----

export interface StreamCallbacks {
	onContent: (content: string) => void;
	onThinking: (text: string, signature?: string) => void;
	onToolCall: (toolCall: { id: string; name: string; inputJson: string }) => void;
	onError: (error: Error) => void;
	onDone: () => void;
	onUsage?: (usage: MiniMaxUsage) => void;
}

// ---- Model definitions ----

/**
 * Cost per million tokens, in the API account's billing currency.
 *
 * - `CNY` for `platform.minimaxi.com` (China) — scraped from
 *   https://platform.minimaxi.com/docs/guides/pricing-paygo
 * - `USD` for `platform.minimax.io` (global) — scraped from
 *   https://platform.minimax.io/docs/guides/pricing-paygo
 *
 * The UI picks the table based on the user's `minimax.apiBaseUrl` and
 * `vscode.env.language`; `null` means the price was not published in
 * the source we scraped and renders as "see official".
 */
export interface ModelPricing {
	input: number | null;
	output: number | null;
	cacheRead: number | null;
	cacheWrite: number | null;
	currency: 'CNY' | 'USD';
	note?: string;
}

export interface ModelDefinition {
	id: string;
	name: string;
	family: string;
	version: string;
	detail: string;
	/**
	 * Advertised context length. This is the only number MiniMax
	 * publishes on its model overview page; we don't try to split it
	 * into separate "input" / "output" caps because the docs don't
	 * publish those splits either.
	 */
	contextLength: number;
	/**
	 * Display hint for VS Code's model picker, copied from
	 * `contextLength`. Kept as a separate field because
	 * `vscode.LanguageModelChatInformation` requires both
	 * `maxInputTokens` and `maxOutputTokens` on the chat info object.
	 *
	 * We deliberately do NOT treat this as a provider-enforced cap.
	 * `provider/request.ts` passes the user-configured value (or 0 for
	 * "let the model decide") straight to the API, and any 400 from the
	 * upstream is surfaced as-is. The official Anthropic-compatible
	 * surface does not publish per-model `max_tokens` ceilings — we
	 * previously hardcoded 512K for M3 and 128K for M2.7, but those
	 * numbers came from us, not MiniMax, and ended up contradicting the
	 * docs.
	 */
	maxInputTokens: number;
	/** Display hint for VS Code's model picker. Same caveat as above. */
	maxOutputTokens: number;
	capabilities: {
		toolCalling: boolean | number;
		imageInput: boolean;
		videoInput?: boolean;
		thinking: boolean;
	};
	thinking: {
		supportsBudget: boolean;
		supportsAdaptive: boolean;
	};
	pricing: ModelPricing;
	/**
	 * Optional per-model sampling overrides. When set, the values are
	 * passed to the API as-is. The Anthropic `thinking: { type:
	 * "adaptive" }` constraint still wins over these: when thinking is
	 * on we force `temperature: 1` and drop `top_p` regardless of
	 * what's configured here.
	 */
	sampling?: {
		temperature?: number;
		topP?: number;
		topK?: number;
		frequencyPenalty?: number;
	};
	/**
	 * Escape hatch for MiniMax-specific or Anthropic-specific request
	 * body fields that don't have a first-class config knob. Keys are
	 * merged into the request body verbatim (after the standard fields).
	 * Known safe keys: `stop_sequences`, `service_tier`, `metadata`.
	 * Unknown keys are forwarded unchanged.
	 */
	extra?: Record<string, unknown>;
}
