import { createHash } from 'crypto';
import { appendFile, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import * as vscode from 'vscode';
import { getRequestDumpEnabled } from '../../config';
import { safeStringify } from '../../json';
import { logger } from '../../logger';
import type { MiniMaxRequest } from '../../types';
import { parseReplayMarkerData, REPLAY_MARKER_MIME } from '../replay';
import type { ConversationSegment } from '../segment';
import type { VisionResolutionStats } from '../vision/index';
import {
	classifyMiniMaxRequest,
	classifyProviderRequest,
	formatModelFields,
	formatRequestLogLine,
	type RequestKind,
} from './classifier';

let dumpCounter = 0;
let providerInputDumpCounter = 0;
let dumpWriteQueue: Promise<void> = Promise.resolve();

const REQUEST_OBSERVATIONS_FILE = '_request-observations.jsonl';
const HASH_WINDOW_CHARS = 2_048;

interface DumpContext {
	root: string;
	timestamp: string;
	basename: string;
	requestKind: RequestKind;
}

interface ProviderInputDumpPaths {
	directory: string;
	providerInput: string;
}

interface RequestDumpPaths {
	directory: string;
	input: string;
	resolved: string;
	request: string;
	msg0?: string;
}

export interface DumpMiniMaxRequestOptions {
	globalStorageUri: vscode.Uri;
	segment: ConversationSegment;
	requestKind?: RequestKind;
	vscodeModelId: string;
	isThinkingModel: boolean;
	thinkingEffort: string;
	maxTokens: number | undefined;
	inputMessages: readonly vscode.LanguageModelChatRequestMessage[];
	resolvedMessages: readonly vscode.LanguageModelChatRequestMessage[];
	requestOptions: vscode.ProvideLanguageModelChatResponseOptions;
	visionModelId?: string;
	visionStats?: VisionResolutionStats;
}

export interface DumpProviderInputOptions {
	globalStorageUri: vscode.Uri;
	segment: ConversationSegment;
	requestKind?: RequestKind;
	modelInfo: vscode.LanguageModelChatInformation;
	messages: readonly vscode.LanguageModelChatRequestMessage[];
	requestOptions: vscode.ProvideLanguageModelChatResponseOptions;
}

export function ensureRequestDumpRoot(globalStorageUri: vscode.Uri): string {
	return join(globalStorageUri.fsPath, 'request-dumps');
}

/**
 * Dump the raw LanguageModelChatProvider input before any request preparation.
 * This captures the first observable `options.tools` list, including any
 * `activate_*` virtual tools, even if the provider later short-circuits.
 */
export function dumpProviderInput(options: DumpProviderInputOptions): void {
	if (!getRequestDumpEnabled()) {
		return;
	}

	const requestKind =
		options.requestKind ??
		classifyProviderRequest({
			messages: options.messages,
			tools: options.requestOptions.tools,
		});
	const context = createDumpContext(
		options.globalStorageUri,
		options.segment,
		'minimax-provider-input',
		(providerInputDumpCounter += 1),
		requestKind,
	);
	const paths = createProviderInputDumpPaths(context);
	const toolSummary = summarizeTools(options.requestOptions.tools);

	enqueueDumpWrite(formatRequestLogLine(requestKind, 'providerInputDump'), async () => {
		await mkdir(context.root, { recursive: true });
		await writeJsonFile(paths.providerInput, createProviderInputSnapshot(options, context));

		await writeDumpObservation(
			options.globalStorageUri,
			createDumpObservation({
				event: 'provider-input',
				context,
				segment: options.segment,
				paths,
				model: { vscodeModelId: options.modelInfo.id },
				requestKind,
				requestOptions: options.requestOptions,
				messages: options.messages,
				toolSummary,
			}),
		);
		logProviderInputDump(options, paths, toolSummary, requestKind);
	});
}

/**
 * Dump the FULL MiniMax request payload (messages + tools) to disk verbatim
 * when debugMode is `verbose`. No truncation, no hashing - you get the
 * exact JSON that will be sent to the MiniMax API (minus the auth header).
 *
 * Files land under `<dump root>/<conversationSegmentId>/` so cache-lineage
 * changes are easy to inspect across provider calls.
 */
export function dumpMiniMaxRequest(
	request: MiniMaxRequest,
	options: DumpMiniMaxRequestOptions,
): void {
	if (!getRequestDumpEnabled()) {
		return;
	}

	const requestKind =
		options.requestKind ??
		classifyMiniMaxRequest({
			request,
			inputMessages: options.inputMessages,
		});
	const context = createDumpContext(
		options.globalStorageUri,
		options.segment,
		'minimax-request',
		(dumpCounter += 1),
		requestKind,
	);
	const msg0 = request.messages[0];
	const msg0Text = extractFirstMessageText(msg0);
	const paths: RequestDumpPaths = {
		directory: context.root,
		input: join(context.root, `${context.basename}.input.json`),
		resolved: join(context.root, `${context.basename}.resolved.json`),
		request: join(context.root, `${context.basename}.json`),
		msg0: msg0 ? join(context.root, `${context.basename}.msg0.txt`) : undefined,
	};

	enqueueDumpWrite(formatRequestLogLine(requestKind, 'requestDump'), async () => {
		await mkdir(context.root, { recursive: true });
		await writeJsonFile(paths.input, createInputSnapshot(options, context, msg0Text));
		await writeJsonFile(paths.resolved, createResolvedSnapshot(options, context));
		await writeJsonFile(paths.request, safeStringify(request));
		if (paths.msg0) {
			await writeFile(paths.msg0, msg0Text, 'utf8');
		}

		await writeDumpObservation(
			options.globalStorageUri,
			createDumpObservation({
				event: 'minimax-request',
				context,
				segment: options.segment,
				paths,
				model: {
					vscodeModelId: options.vscodeModelId,
					apiModelId: request.model,
				},
				requestKind,
				requestOptions: options.requestOptions,
				messages: options.inputMessages,
				toolSummary: summarizeTools(options.requestOptions.tools),
				vision: options.visionModelId
					? { modelId: options.visionModelId, stats: options.visionStats }
					: undefined,
			}),
		);
		logger.info(
			formatRequestLogLine(
				requestKind,
				`${formatModelFields(options.vscodeModelId, request.model)} ` +
					`thinking=${options.thinkingEffort} maxTokens=${options.maxTokens ?? 'default'} ` +
					`→ ${context.root}`,
			),
		);
	});
}

function createDumpContext(
	globalStorageUri: vscode.Uri,
	segment: ConversationSegment,
	tag: string,
	counter: number,
	requestKind: RequestKind,
): DumpContext {
	const root = join(ensureRequestDumpRoot(globalStorageUri), segment.segmentId);
	const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
	const basename = `${tag}-${timestamp}-${counter.toString().padStart(4, '0')}`;
	return { root, timestamp, basename, requestKind };
}

function createProviderInputDumpPaths(context: DumpContext): ProviderInputDumpPaths {
	return {
		directory: context.root,
		providerInput: join(context.root, `${context.basename}.provider-input.json`),
	};
}

interface ToolSummary {
	toolCount: number;
	toolNames: string[];
	activateToolCount: number;
	activateToolNames: string[];
}

interface DumpObservationInput {
	event: 'provider-input' | 'minimax-request';
	context: DumpContext;
	segment: ConversationSegment;
	paths: ProviderInputDumpPaths | RequestDumpPaths;
	model: { vscodeModelId: string; apiModelId?: string };
	requestKind: RequestKind;
	requestOptions: vscode.ProvideLanguageModelChatResponseOptions;
	messages: readonly vscode.LanguageModelChatRequestMessage[];
	toolSummary: ToolSummary;
	vision?: { modelId: string; stats?: VisionResolutionStats };
}

function createDumpObservation(input: DumpObservationInput): Record<string, unknown> {
	return {
		timestamp: new Date().toISOString(),
		event: input.event,
		requestKind: input.requestKind,
		segment: {
			id: input.segment.segmentId,
			reason: input.segment.reason,
			markerError: input.segment.markerError,
		},
		model: input.model,
		paths: input.paths,
		tools: input.toolSummary,
		vision: input.vision,
		messageCount: input.messages.length,
		firstMessageChars: getMessageText(input.messages[0]).length,
		latestUserChars: getLatestUserText(input.messages).length,
	};
}

function summarizeTools(
	tools: readonly vscode.LanguageModelChatTool[] | undefined,
): ToolSummary {
	if (!tools) {
		return { toolCount: 0, toolNames: [], activateToolCount: 0, activateToolNames: [] };
	}
	const activateNames: string[] = [];
	const otherNames: string[] = [];
	for (const tool of tools) {
		if (tool.name.startsWith('activate_')) {
			activateNames.push(tool.name);
		} else {
			otherNames.push(tool.name);
		}
	}
	return {
		toolCount: tools.length,
		toolNames: otherNames,
		activateToolCount: activateNames.length,
		activateToolNames: activateNames,
	};
}

function createProviderInputSnapshot(
	options: DumpProviderInputOptions,
	context: DumpContext,
): Record<string, unknown> {
	return {
		basename: context.basename,
		timestamp: context.timestamp,
		requestKind: context.requestKind,
		model: { vscodeModelId: options.modelInfo.id },
		tools: summarizeTools(options.requestOptions.tools),
		messages: options.messages.map((m) => ({
			role: m.role,
			parts: m.content.length,
			textHead: getMessageText(m).slice(0, HASH_WINDOW_CHARS),
			textHash: hashText(getMessageText(m)),
		})),
		requestOptions: {
			toolCount: options.requestOptions.tools?.length ?? 0,
			modelOptions: options.requestOptions.modelOptions,
		},
	};
}

function createInputSnapshot(
	options: DumpMiniMaxRequestOptions,
	context: DumpContext,
	msg0Text: string,
): Record<string, unknown> {
	return {
		basename: context.basename,
		timestamp: context.timestamp,
		requestKind: context.requestKind,
		model: {
			vscodeModelId: options.vscodeModelId,
			isThinkingModel: options.isThinkingModel,
			thinkingEffort: options.thinkingEffort,
			maxTokens: options.maxTokens,
		},
		tools: summarizeTools(options.requestOptions.tools),
		messages: options.inputMessages.map(summariseMessage),
		systemPromptHead: msg0Text.slice(0, HASH_WINDOW_CHARS),
		vision: options.visionStats,
	};
}

function extractFirstMessageText(message: { content: unknown } | undefined): string {
	if (!message) {
		return '';
	}
	const content = message.content;
	if (typeof content === 'string') {
		return content;
	}
	if (Array.isArray(content)) {
		let text = '';
		for (const block of content) {
			if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
				text += (block as { text?: string }).text ?? '';
			}
		}
		return text;
	}
	return '';
}

function createResolvedSnapshot(
	options: DumpMiniMaxRequestOptions,
	context: DumpContext,
): Record<string, unknown> {
	return {
		basename: context.basename,
		timestamp: context.timestamp,
		requestKind: context.requestKind,
		visionModelId: options.visionModelId,
		visionStats: options.visionStats,
		messages: options.resolvedMessages.map(summariseMessage),
	};
}

function summariseMessage(
	message: vscode.LanguageModelChatRequestMessage,
): Record<string, unknown> {
	const text = getMessageText(message);
	const imageDescriptionCount = countMarkerCarriedDescriptions(message);
	return {
		role: message.role,
		parts: message.content.length,
		textHead: text.slice(0, HASH_WINDOW_CHARS),
		textHash: hashText(text),
		imageDescriptionCount,
		hasReplayMarker: message.content.some(
			(part) => part instanceof vscode.LanguageModelDataPart && part.mimeType === REPLAY_MARKER_MIME,
		),
	};
}

function countMarkerCarriedDescriptions(message: vscode.LanguageModelChatRequestMessage): number {
	let count = 0;
	for (const part of message.content) {
		if (!(part instanceof vscode.LanguageModelDataPart)) {
			continue;
		}
		if (part.mimeType !== REPLAY_MARKER_MIME) {
			continue;
		}
		const parsed = parseReplayMarkerData(part.data);
		if (parsed.valid) {
			count += 1;
		}
	}
	return count;
}

function getMessageText(message: vscode.LanguageModelChatRequestMessage | undefined): string {
	if (!message) {
		return '';
	}
	let text = '';
	for (const part of message.content) {
		if (part instanceof vscode.LanguageModelTextPart) {
			text += part.value;
		}
	}
	return text;
}

function getLatestUserText(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role === vscode.LanguageModelChatMessageRole.User) {
			return getMessageText(message);
		}
	}
	return '';
}

function hashText(text: string): string {
	return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
	await writeFile(path, safeStringify(value), 'utf8');
}

function enqueueDumpWrite(label: string, action: () => Promise<void>): void {
	dumpWriteQueue = dumpWriteQueue
		.then(() => action())
		.catch((error) => {
			logger.warn(`${label} write failed:`, error);
		});
}

async function writeDumpObservation(
	globalStorageUri: vscode.Uri,
	observation: Record<string, unknown>,
): Promise<void> {
	const root = ensureRequestDumpRoot(globalStorageUri);
	await mkdir(root, { recursive: true });
	const file = join(root, REQUEST_OBSERVATIONS_FILE);
	await appendFile(file, `${safeStringify(observation)}\n`, 'utf8');
}

function logProviderInputDump(
	options: DumpProviderInputOptions,
	paths: ProviderInputDumpPaths,
	toolSummary: ToolSummary,
	requestKind: RequestKind,
): void {
	logger.info(
		formatRequestLogLine(
			requestKind,
			`${formatModelFields(options.modelInfo.id)} ` +
				`tools=${toolSummary.toolCount} activate=${toolSummary.activateToolCount} ` +
				`→ ${paths.providerInput}`,
		),
	);
}
