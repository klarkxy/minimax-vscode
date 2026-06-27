import { createHash } from 'crypto';
import { appendFile, mkdir, readdir, rename, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import * as vscode from 'vscode';
import {
	REQUEST_DUMP_MAX_CONCURRENT_WRITES,
	REQUEST_DUMP_MAX_SEGMENT_DIRS,
	REQUEST_DUMP_OBSERVATIONS_MAX_BYTES,
} from '../../consts';
import { getRequestDumpEnabled } from '../../config';
import { safeStringify } from '../../json';
import { logger } from '../../logger';
import type { MiniMaxRequest } from '../../types';
import { parseReplayMarkerData, REPLAY_MARKER_MIME } from '../replay';
import type { ConversationSegment } from '../segment';
import {
	classifyMiniMaxRequest,
	classifyProviderRequest,
	formatModelFields,
	formatRequestLogLine,
	type RequestKind,
} from './classifier';

let dumpCounter = 0;
let providerInputDumpCounter = 0;

/**
 * Bounded concurrency dump queue. The previous implementation chained
 * every write into a single Promise (`dumpWriteQueue = dumpWriteQueue.then(...)`),
 * which is functionally a serial pipeline with an ever-growing tail of
 * closures held in memory. Under verbose-mode bursts this can OOM. We
 * now keep at most `REQUEST_DUMP_MAX_CONCURRENT_WRITES` in-flight tasks
 * and queue the rest; new writes that would exceed the cap are dropped
 * with a warning so the writer path never blocks a chat response.
 */
let activeDumpWrites = 0;
const pendingDumpWrites: Array<() => void> = [];
let lastDropWarnAt = 0;
// Resolvers waiting for the queue to drain. Resolved when both
// `activeDumpWrites` and `pendingDumpWrites` reach zero — i.e. every
// write enqueued up to the call site has finished. Used by tests
// (`flushPendingDumpWrites`) to wait deterministically for the
// fire-and-forget queue instead of `setTimeout(...)`.
let dumpFlushResolvers: Array<() => void> = [];

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
		await pruneOldDumpSegments(options.globalStorageUri);
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
		// `request` is the literal MiniMax request object — pass it
		// to `writeJsonFile` so the file is JSON, not a JSON-encoded
		// string. The previous `safeStringify(request)` here double-
		// encoded the payload (file contained a quoted string).
		await writeJsonFile(paths.request, request);
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
		await pruneOldDumpSegments(options.globalStorageUri);
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
	if (pendingDumpWrites.length > 0) {
		// Backpressure: drop oldest queued write rather than letting the
		// queue grow without bound. The label goes through `logger.debug`
		// (one per burst, throttled) so we don't spam the output channel.
		const now = Date.now();
		if (now - lastDropWarnAt > 10_000) {
			logger.warn(`${label} dropped: dump writer backpressure (queue=${pendingDumpWrites.length})`);
			lastDropWarnAt = now;
		}
		// Intentionally skip enqueueing this write.
		return;
	}

	const run = () => {
		activeDumpWrites += 1;
		const done = action()
			.catch((error) => {
				logger.warn(`${label} write failed:`, error);
			})
			.finally(() => {
				activeDumpWrites -= 1;
				const next = pendingDumpWrites.shift();
				if (next) {
					next();
				}
				maybeResolveFlushWaiters();
			});
		// `done` is intentionally not awaited here — the call site is
		// fire-and-forget. We only attach it to `activeDumpPromises` so
		// `flushPendingDumpWrites()` can wait for it to settle.
		void done;
	};

	if (activeDumpWrites < REQUEST_DUMP_MAX_CONCURRENT_WRITES) {
		run();
	} else {
		pendingDumpWrites.push(run);
	}
}

function maybeResolveFlushWaiters(): void {
	if (activeDumpWrites === 0 && pendingDumpWrites.length === 0 && dumpFlushResolvers.length > 0) {
		const resolvers = dumpFlushResolvers;
		dumpFlushResolvers = [];
		for (const resolve of resolvers) {
			resolve();
		}
	}
}

/**
 * Resolves once every dump write enqueued up to this call has settled.
 * Test-only escape hatch: the dump queue is fire-and-forget by design
 * (so chat responses are never blocked by I/O), which means tests cannot
 * assert on the on-disk shape with a fixed `setTimeout`. Call this
 * after `dumpProviderInput` / `dumpMiniMaxRequest` to make the queue
 * observable. No-op in production.
 */
export function flushPendingDumpWrites(): Promise<void> {
	if (activeDumpWrites === 0 && pendingDumpWrites.length === 0) {
		return Promise.resolve();
	}
	return new Promise<void>((resolve) => {
		dumpFlushResolvers.push(resolve);
	});
}

async function writeDumpObservation(
	globalStorageUri: vscode.Uri,
	observation: Record<string, unknown>,
): Promise<void> {
	const root = ensureRequestDumpRoot(globalStorageUri);
	await mkdir(root, { recursive: true });
	const file = join(root, REQUEST_OBSERVATIONS_FILE);
	await rotateObservationsIfNeeded(globalStorageUri, file);
	await appendFile(file, `${safeStringify(observation)}\n`, 'utf8');
}

/**
 * Roll the observations file over when it crosses the configured cap.
 * Keeps the newest entries under a `.1` sibling and starts a fresh file.
 * No-op on platforms where stat() throws (e.g. permission denied) — the
 * append will still succeed; we just lose the rotation guarantee for
 * that single write.
 */
async function rotateObservationsIfNeeded(
	globalStorageUri: vscode.Uri,
	file: string,
): Promise<void> {
	let info;
	try {
		info = await stat(file);
	} catch {
		return; // file does not exist yet
	}
	if (info.size < REQUEST_DUMP_OBSERVATIONS_MAX_BYTES) {
		return;
	}
	const rotated = `${file}.1`;
	try {
		await rm(rotated, { force: true });
		await rename(file, rotated);
	} catch (error) {
		logger.warn('observations rotation failed:', error);
	}
}

/**
 * Trim the dump root so it never accumulates more than
 * `REQUEST_DUMP_MAX_SEGMENT_DIRS` segment directories. Each segment is
 * a directory of related dumps; we sort by mtime ascending and remove
 * the oldest until we're under the cap. Errors are swallowed (best-
 * effort: never let a cleanup failure block the next dump).
 */
async function pruneOldDumpSegments(globalStorageUri: vscode.Uri): Promise<void> {
	const root = ensureRequestDumpRoot(globalStorageUri);
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		return;
	}
	const dirs = entries.filter((entry) => entry.isDirectory());
	if (dirs.length <= REQUEST_DUMP_MAX_SEGMENT_DIRS) {
		return;
	}
	const withMtime = await Promise.all(
		dirs.map(async (entry) => {
			const full = join(root, entry.name);
			try {
				const info = await stat(full);
				return { full, mtimeMs: info.mtimeMs };
			} catch {
				return { full, mtimeMs: Number.POSITIVE_INFINITY };
			}
		}),
	);
	withMtime.sort((a, b) => a.mtimeMs - b.mtimeMs);
	const toRemove = withMtime.slice(0, withMtime.length - REQUEST_DUMP_MAX_SEGMENT_DIRS);
	for (const entry of toRemove) {
		try {
			await rm(entry.full, { recursive: true, force: true });
		} catch (error) {
			logger.warn('pruneOldDumpSegments: failed to remove', entry.full, error);
		}
	}
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
