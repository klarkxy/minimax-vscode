// Codex JSONL rollout ingestion.
//
// The MiniMax Copilot extension's `usageStore` only counts tokens that
// flow through the extension's own request layer (see
// `src/provider/index.ts:247-253`). When the user runs the OpenAI Codex
// CLI in parallel — pointed at a MiniMax-compatible provider via
// `~/.codex/config.toml` — those calls never enter our request path, so
// the dashboard silently misses them.
//
// The Codex CLI writes per-session JSONL rollouts to
// `~/.codex/sessions/<rollout-id>.jsonl` and moves finished sessions to
// `~/.codex/archived_sessions/`. Each line is a JSON object; the lines
// we care about are `event_msg` rows of subtype `token_count` (the
// CLI's compact summary of an assistant turn) or, on older builds,
// `response_item` rows containing a `message.usage` block.
//
// Token field shape follows the OpenAI Responses API:
//
//   { input_tokens, output_tokens,
//     cached_input_tokens, reasoning_output_tokens }
//
// The `cached_input_tokens` field maps to our `cacheReadTokens` (the
// upstream discount applies to reads), and `reasoning_output_tokens`
// folds into `outputTokens` (Anthropic's billing model bills reasoning
// as output).
//
// This module mirrors `src/dashboard/claudeCodeIngest.ts` 1:1 except
// for the parser and the dual-directory discovery — same cursor /
// LRU / poll / status / start / dispose lifecycle. The `FileSystemLike`
// shape is intentionally identical so the existing test patterns
// transfer over with no changes.

import * as vscode from 'vscode';
import { promises as fsp, createReadStream } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { logger } from '../logger';
import {
	CODEX_USAGE_STATS_KEY,
	CODEX_INGEST_CURSOR_KEY,
} from '../consts';
import { todayKey, type ModelUsage, type UsageStats, type UsageStore } from '../usage';
import {
	getIncludeCodex,
	getCodexLogPath,
	getCodexArchivedLogPath,
	getCodexPollIntervalMs,
	getCodexAllowedModels,
} from '../config';

// ---- Public types ----

/** Cursor schema version. Bump when the shape changes. */
export const CODEX_CURSOR_VERSION = 1;

export interface CodexFileCursor {
	/** Byte offset of the next byte to read. */
	offset: number;
	/** File mtime in ms — used to detect truncation / rotation. */
	mtimeMs: number;
	/** File size at last read — second truncation check. */
	size: number;
}

export interface CodexIngestCursor {
	version: 1;
	files: Record<string, CodexFileCursor>;
	lastSyncAt: number;
	lastErrorAt?: number;
	lastError?: string;
	parseErrors: number;
	/** Cumulative count of assistant lines dropped because the model
	 *  was not in the configured allowlist. Optional so cursors written
	 *  by older builds (no model filter) keep loading. */
	skippedModels?: number;
	/**
	 * 16-char SHA-256 of the sorted allowlist (joined by `\n`). The
	 * next read compares this against the current allowlist's
	 * fingerprint; a mismatch triggers a full re-read from offset 0
	 * so historical lines are re-evaluated against the new filter.
	 * Mirrors the `allowedModelsFingerprint` mechanism in
	 * `claudeCodeIngest.ts` — see that file for the full rationale.
	 */
	allowedModelsFingerprint?: string;
}

export type CodexIngestState =
	| 'ok'
	| 'empty'
	| 'disabled'
	| 'error'
	| 'loading';

export interface CodexIngestStatus {
	state: CodexIngestState;
	logPath: string;
	archivedLogPath: string;
	lastSyncAt: number | null;
	lastError: string | null;
	filesTracked: number;
	parseErrors: number;
	/** Number of assistant lines whose model ID was not in the
	 *  allowlist and were therefore skipped. */
	skippedModels: number;
	totalRequests: number;
	/** True on the very first poll cycle, until it completes. */
	isFirstPoll: boolean;
}

export interface CodexIngestHandle {
	store: UsageStore;
	status(): CodexIngestStatus;
	/** Start the periodic poll loop. Idempotent. */
	start(): CodexIngestHandle;
	/** Force a refresh now. */
	refresh(): Promise<void>;
	/** Subscribe to status / store changes. */
	subscribe(listener: () => void): vscode.Disposable;
	/** Stop the polling loop and flush the cursor. Idempotent. */
	dispose(): void;
}

export interface FileSystemLike {
	readFile(path: string, encoding: 'utf8'): Promise<string>;
	stat(path: string): Promise<{ size: number; mtimeMs: number }>;
	readdir(
		path: string,
		options: { withFileTypes: true },
	): Promise<
		Array<{ name: string; isFile(): boolean; isDirectory(): boolean }>
	>;
}

export interface CodexIngestOptions {
	globalState: vscode.Memento | undefined;
	/** Override the log paths (mostly for tests). */
	logPath?: string;
	archivedLogPath?: string;
	/** Polling interval in ms. Default 30 000. */
	pollIntervalMs?: number;
	/** Override `Date.now()` / `setInterval` for tests. */
	clock?: {
		now: () => number;
		setInterval: typeof setInterval;
		clearInterval: typeof clearInterval;
	};
	/** Override the file reader for tests. */
	fs?: FileSystemLike;
	/** Override the LRU size. Default 1000. */
	dedupLruSize?: number;
	/**
	 * Optional allowlist of model IDs the ingester counts. When
	 * omitted, the configured `minimax.codex.allowedModels` is
	 * consulted at construction time. Pass an explicit empty array
	 * to disable the filter (the tests rely on this).
	 */
	allowedModels?: readonly string[];
}

const DEFAULT_DEDUP_LRU_SIZE = 1000;

// ---- JSONL parser ----

interface RawUsage {
	input_tokens?: unknown;
	output_tokens?: unknown;
	cached_input_tokens?: unknown;
	reasoning_output_tokens?: unknown;
}

export interface ExtractedCodexUsage {
	modelId: string;
	usage: ModelUsage;
	dayKey: string;
	messageId: string;
}

/**
 * Parse a single JSONL line and extract token usage if it represents
 * an assistant turn with a usable usage block. Returns `null` for any
 * line that should be silently skipped.
 *
 * Two recognised line shapes (Codex CLI emits both across versions):
 *
 *   1. `event_msg` rows with `payload.type === "token_count"`. The
 *      `payload.info` block carries the usage fields plus `model`.
 *
 *   2. `response_item` rows wrapping a `message` whose `usage` is
 *      the standard Responses API block and `model` is the assistant
 *      model id.
 *
 * Both shapes are flattened into the same `ExtractedCodexUsage` so
 * the rest of the ingester only needs one code path.
 *
 * The `messageId` is used by the LRU dedup; falls back to the line's
 * own `id` / `uuid` when present, or `''` when absent (we still
 * accept the line, just can't dedup).
 */
export function extractCodexUsage(line: string): ExtractedCodexUsage | null {
	if (!line || line.trim().length === 0) return null;
	let obj: unknown;
	try {
		obj = JSON.parse(line);
	} catch {
		return null;
	}
	if (!obj || typeof obj !== 'object') return null;
	const o = obj as Record<string, unknown>;

	const type = o.type;
	if (type !== 'event_msg' && type !== 'response_item') return null;

	// Shape 1 — event_msg / token_count.
	if (type === 'event_msg') {
		const payload = (o.payload as Record<string, unknown> | undefined) ?? undefined;
		if (!payload || payload.type !== 'token_count') return null;
		const info = (payload.info as Record<string, unknown> | undefined) ?? undefined;
		if (!info || typeof info !== 'object') return null;

		const modelId = typeof info.model === 'string' ? info.model : null;
		if (!modelId) return null;
		const u = info as unknown as RawUsage;
		const usage: ModelUsage = {
			inputTokens: toInt(u.input_tokens),
			outputTokens: toInt(u.output_tokens) + toInt(u.reasoning_output_tokens),
			cacheReadTokens: toInt(u.cached_input_tokens),
			cacheWriteTokens: 0,
			requests: 1,
		};
		if (isAllZero(usage)) return null;
		const dayKey = parseDayKey(o.timestamp);
		const messageId =
			(typeof o.id === 'string' && o.id) ||
			(typeof o.uuid === 'string' && o.uuid) ||
			'';
		return { modelId, usage, dayKey, messageId };
	}

	// Shape 2 — response_item / message.
	const message = (o.message as Record<string, unknown> | undefined) ?? undefined;
	if (!message || typeof message !== 'object') return null;
	const modelId = typeof message.model === 'string' ? message.model : null;
	if (!modelId) return null;
	const u = message.usage as RawUsage | undefined;
	if (!u || typeof u !== 'object') return null;
	const usage: ModelUsage = {
		inputTokens: toInt(u.input_tokens),
		outputTokens: toInt(u.output_tokens) + toInt(u.reasoning_output_tokens),
		cacheReadTokens: toInt(u.cached_input_tokens),
		cacheWriteTokens: 0,
		requests: 1,
	};
	if (isAllZero(usage)) return null;
	const dayKey = parseDayKey(o.timestamp);
	const messageId =
		(typeof message.id === 'string' && message.id) ||
		(typeof o.id === 'string' && o.id) ||
		(typeof o.uuid === 'string' && o.uuid) ||
		'';
	return { modelId, usage, dayKey, messageId };
}

function toInt(v: unknown): number {
	if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
		return Math.floor(v);
	}
	return 0;
}

function isAllZero(usage: ModelUsage): boolean {
	return (
		usage.inputTokens === 0 &&
		usage.outputTokens === 0 &&
		usage.cacheReadTokens === 0 &&
		usage.cacheWriteTokens === 0
	);
}

function parseDayKey(ts: unknown): string {
	const s = typeof ts === 'string' ? ts : '';
	const parsed = Date.parse(s);
	if (Number.isFinite(parsed)) return todayKey(new Date(parsed));
	return todayKey();
}

// ---- Tiny LRU for dedup ----

class LruSet {
	private readonly max: number;
	private readonly map = new Map<string, true>();
	constructor(max: number) {
		this.max = max;
	}
	has(key: string): boolean {
		return this.map.has(key);
	}
	add(key: string): void {
		if (this.map.has(key)) {
			this.map.delete(key);
			this.map.set(key, true);
			return;
		}
		this.map.set(key, true);
		if (this.map.size > this.max) {
			const oldest = this.map.keys().next().value;
			if (oldest !== undefined) this.map.delete(oldest);
		}
	}
	clear(): void {
		this.map.clear();
	}
}

// ---- Cursor helpers ----

function allowedModelsFingerprint(
	allowedModels: ReadonlySet<string> | null,
): string {
	if (allowedModels === null) return '*';
	const sorted = [...allowedModels].sort();
	return createHash('sha256').update(sorted.join('\n')).digest('hex').slice(0, 16);
}

function emptyCursor(now: number, fingerprint?: string): CodexIngestCursor {
	return {
		version: CODEX_CURSOR_VERSION,
		files: {},
		lastSyncAt: 0,
		parseErrors: 0,
		allowedModelsFingerprint: fingerprint,
	};
}

function readCursor(
	state: vscode.Memento | undefined,
	currentFingerprint: string,
): CodexIngestCursor {
	if (!state) return emptyCursor(0, currentFingerprint);
	const raw = state.get<CodexIngestCursor | undefined>(CODEX_INGEST_CURSOR_KEY);
	if (!raw || raw.version !== CODEX_CURSOR_VERSION) {
		return emptyCursor(0, currentFingerprint);
	}
	if (raw.allowedModelsFingerprint !== currentFingerprint) {
		return emptyCursor(0, currentFingerprint);
	}
	return {
		version: CODEX_CURSOR_VERSION,
		files: { ...(raw.files ?? {}) },
		lastSyncAt: raw.lastSyncAt ?? 0,
		lastErrorAt: raw.lastErrorAt,
		lastError: raw.lastError,
		parseErrors: raw.parseErrors ?? 0,
		skippedModels: raw.skippedModels ?? 0,
		allowedModelsFingerprint: currentFingerprint,
	};
}

async function writeCursor(
	state: vscode.Memento | undefined,
	cursor: CodexIngestCursor,
): Promise<void> {
	if (!state) return;
	await state.update(CODEX_INGEST_CURSOR_KEY, cursor);
}

// ---- File enumeration ----

async function discoverJsonlFiles(
	roots: string[],
	fs: FileSystemLike,
): Promise<string[]> {
	const out: string[] = [];
	async function walk(dir: string): Promise<void> {
		let entries: Array<{ name: string; isFile(): boolean; isDirectory(): boolean }>;
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const full = path.join(dir, e.name);
			if (e.isDirectory()) {
				await walk(full);
			} else if (e.isFile() && e.name.endsWith('.jsonl')) {
				out.push(full);
			}
		}
	}
	for (const root of roots) {
		if (!root) continue;
		try {
			await walk(root);
		} catch {
			// Root missing or unreadable — same as no files.
		}
	}
	return out;
}

// ---- Per-file streaming read ----

async function readNewPortion(
	filePath: string,
	start: number,
): Promise<{ text: string; eof: boolean }> {
	return new Promise((resolve, reject) => {
		const stream = createReadStream(filePath, {
			start,
			encoding: 'utf8',
		});
		const chunks: string[] = [];
		stream.on('data', (chunk: string | Buffer) => {
			chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
		});
		stream.on('end', () => {
			resolve({ text: chunks.join(''), eof: true });
		});
		stream.on('error', (err) => reject(err));
	});
}

// ---- Main factory ----

export function createCodexIngest(opts: CodexIngestOptions): CodexIngestHandle {
	const clock = opts.clock ?? {
		now: () => Date.now(),
		setInterval: (cb: () => void, ms: number) => setInterval(cb, ms),
		clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
	};
	const fs: FileSystemLike = opts.fs ?? {
		readFile: (p, e) => fsp.readFile(p, e),
		stat: async (p) => {
			const s = await fsp.stat(p);
			return { size: s.size, mtimeMs: s.mtimeMs };
		},
		readdir: (p, o) => fsp.readdir(p, o),
	};
	const pollIntervalMs = opts.pollIntervalMs ?? getCodexPollIntervalMs();
	const dedupLruSize = opts.dedupLruSize ?? DEFAULT_DEDUP_LRU_SIZE;

	const allowedModels: ReadonlySet<string> | null = opts.allowedModels
		? (opts.allowedModels.length > 0 ? new Set(opts.allowedModels) : null)
		: new Set(getCodexAllowedModels());

	const lru = new LruSet(dedupLruSize);
	const partials = new Map<string, string>();
	const listeners = new Set<(stats: UsageStats) => void>();

	const currentFingerprint = allowedModelsFingerprint(allowedModels);
	let cursor: CodexIngestCursor = readCursor(opts.globalState, currentFingerprint);
	let isFirstPoll = false;
	let started = false;
	let inFlight: Promise<void> | undefined;
	let disposed = false;
	let timer: ReturnType<typeof setInterval> | undefined;

	function computeStatus(): CodexIngestStatus {
		const logPath = opts.logPath ?? getCodexLogPath();
		const archivedLogPath = opts.archivedLogPath ?? getCodexArchivedLogPath();
		const enabled = getIncludeCodex();
		const state: CodexIngestState = !enabled
			? 'disabled'
			: isFirstPoll
				? 'loading'
				: cursor.lastError
					? 'error'
					: Object.keys(cursor.files).length === 0
						? 'empty'
						: 'ok';
		const stats: UsageStats = readStatsFromState(opts.globalState);
		return {
			state,
			logPath,
			archivedLogPath,
			lastSyncAt: cursor.lastSyncAt || null,
			lastError: cursor.lastError ?? null,
			filesTracked: Object.keys(cursor.files).length,
			parseErrors: cursor.parseErrors,
			skippedModels: cursor.skippedModels ?? 0,
			totalRequests: stats.total.requests,
			isFirstPoll,
		};
	}

	function notify(): void {
		const _status = computeStatus();
		for (const listener of listeners) {
			try {
				listener(statsCache);
			} catch {
				// Listener errors must not break the ingester.
			}
		}
		void _status;
	}

	const statsCache: UsageStats = readStatsFromState(opts.globalState);

	function accept(record: ExtractedCodexUsage): void {
		statsCache.total.inputTokens += record.usage.inputTokens;
		statsCache.total.outputTokens += record.usage.outputTokens;
		statsCache.total.cacheReadTokens += record.usage.cacheReadTokens;
		statsCache.total.cacheWriteTokens += record.usage.cacheWriteTokens;
		statsCache.total.requests += 1;
		const modelBucket = (statsCache.byModel[record.modelId] ??= {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			requests: 0,
		});
		modelBucket.inputTokens += record.usage.inputTokens;
		modelBucket.outputTokens += record.usage.outputTokens;
		modelBucket.cacheReadTokens += record.usage.cacheReadTokens;
		modelBucket.cacheWriteTokens += record.usage.cacheWriteTokens;
		modelBucket.requests += 1;
		const dayBucket = (statsCache.daily[record.dayKey] ??= {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			requests: 0,
		});
		dayBucket.inputTokens += record.usage.inputTokens;
		dayBucket.outputTokens += record.usage.outputTokens;
		dayBucket.cacheReadTokens += record.usage.cacheReadTokens;
		dayBucket.cacheWriteTokens += record.usage.cacheWriteTokens;
		dayBucket.requests += 1;
		statsCache.updatedAt = new Date(clock.now()).toISOString();
		void opts.globalState?.update(CODEX_USAGE_STATS_KEY, statsCache);
	}

	async function ingestFile(
		filePath: string,
		cur: CodexFileCursor | undefined,
	): Promise<CodexFileCursor> {
		const stat = await fs.stat(filePath);
		let next: CodexFileCursor;
		if (!cur) {
			next = { offset: 0, mtimeMs: stat.mtimeMs, size: stat.size };
		} else if (stat.size < cur.size) {
			partials.delete(filePath);
			next = { offset: 0, mtimeMs: stat.mtimeMs, size: stat.size };
		} else if (cur.offset > stat.size) {
			partials.delete(filePath);
			next = { offset: 0, mtimeMs: stat.mtimeMs, size: stat.size };
		} else {
			next = {
				offset: cur.offset,
				mtimeMs: cur.mtimeMs,
				size: stat.size,
			};
		}

		if (next.offset >= stat.size) {
			return next;
		}

		const { text, eof } = await readNewPortion(filePath, next.offset);
		if (!eof) {
			return cur ?? next;
		}

		let buffer = (partials.get(filePath) ?? '') + text;
		let bytesConsumed = next.offset;
		let lineIdx = buffer.indexOf('\n');
		while (lineIdx >= 0) {
			const line = buffer.slice(0, lineIdx);
			buffer = buffer.slice(lineIdx + 1);
			bytesConsumed += Buffer.byteLength(line, 'utf8') + 1;
			if (line.trim().length > 0) {
				const parsed = extractCodexUsage(line);
				if (parsed) {
					if (allowedModels !== null && !allowedModels.has(parsed.modelId)) {
						cursor.skippedModels = (cursor.skippedModels ?? 0) + 1;
					} else if (parsed.messageId) {
						if (lru.has(parsed.messageId)) {
							// Already counted in a prior poll.
						} else {
							lru.add(parsed.messageId);
							accept(parsed);
						}
					} else {
						accept(parsed);
					}
				} else {
					cursor.parseErrors += 1;
				}
			}
			lineIdx = buffer.indexOf('\n');
		}

		if (buffer.length > 0) {
			partials.set(filePath, buffer);
			return {
				offset: next.offset + Buffer.byteLength(text, 'utf8'),
				mtimeMs: stat.mtimeMs,
				size: stat.size,
			};
		}
		partials.delete(filePath);

		return {
			offset: bytesConsumed,
			mtimeMs: stat.mtimeMs,
			size: stat.size,
		};
	}

	async function pollOnce(): Promise<void> {
		if (!getIncludeCodex()) {
			isFirstPoll = false;
			notify();
			return;
		}
		const logPath = opts.logPath ?? getCodexLogPath();
		const archivedLogPath = opts.archivedLogPath ?? getCodexArchivedLogPath();
		try {
			const files = await discoverJsonlFiles(
				archivedLogPath ? [logPath, archivedLogPath] : [logPath],
				fs,
			);
			const seen = new Set<string>();
			for (const file of files) {
				seen.add(file);
				const cur = cursor.files[file];
				try {
					cursor.files[file] = await ingestFile(file, cur);
				} catch (error) {
					cursor.parseErrors += 1;
					logger.warn(`codexIngest: failed to read ${file}`, error);
				}
			}
			for (const tracked of Object.keys(cursor.files)) {
				if (!seen.has(tracked)) {
					delete cursor.files[tracked];
					partials.delete(tracked);
				}
			}
			cursor.lastSyncAt = clock.now();
			cursor.lastError = undefined;
			cursor.lastErrorAt = undefined;
		} catch (error) {
			cursor.lastError = error instanceof Error ? error.message : String(error);
			cursor.lastErrorAt = clock.now();
			logger.warn('codexIngest: poll failed', error);
		} finally {
			isFirstPoll = false;
			await writeCursor(opts.globalState, cursor);
			notify();
		}
	}

	function scheduleNext(): void {
		if (disposed) return;
		timer = clock.setInterval(() => {
			void handle.refresh();
		}, pollIntervalMs);
	}

	const store: UsageStore = {
		record: async () => {
			/* no-op — the ingester mutates the cache directly. */
		},
		read: () => readStatsFromState(opts.globalState),
		readToday: () => {
			const all = readStatsFromState(opts.globalState);
			const bucket = all.daily[todayKey(new Date(clock.now()))];
			return bucket ? { ...bucket } : emptyUsage();
		},
		readRange: (days: number) =>
			sumRangeFromState(opts.globalState, days, clock.now()),
		readDailySeries: (days: number) =>
			buildSeriesFromState(opts.globalState, days, clock.now()),
		reset: async () => {
			const fresh = defaultStats(clock.now());
			statsCache.startedAt = fresh.startedAt;
			statsCache.updatedAt = fresh.updatedAt;
			statsCache.total = fresh.total;
			statsCache.byModel = fresh.byModel;
			statsCache.daily = fresh.daily;
			await opts.globalState?.update(CODEX_USAGE_STATS_KEY, statsCache);
			lru.clear();
			cursor.files = {};
			cursor.skippedModels = 0;
			cursor.parseErrors = 0;
			cursor.lastError = undefined;
			cursor.lastErrorAt = undefined;
			cursor.lastSyncAt = clock.now();
			await writeCursor(opts.globalState, cursor);
			notify();
		},
		subscribe(listener) {
			const wrapped = (_stats: UsageStats): void => {
				(listener as unknown as () => void)();
			};
			listeners.add(wrapped);
			return new vscode.Disposable(() => {
				listeners.delete(wrapped);
			});
		},
	};

	const handle: CodexIngestHandle = {
		store,
		status: computeStatus,
		async refresh(): Promise<void> {
			if (disposed) return;
			if (inFlight) return inFlight;
			inFlight = pollOnce().finally(() => {
				inFlight = undefined;
			});
			return inFlight;
		},
		start(): CodexIngestHandle {
			if (disposed) return handle;
			if (started) return handle;
			started = true;
			isFirstPoll = true;
			queueMicrotask(() => {
				void handle.refresh().finally(scheduleNext);
			});
			return handle;
		},
		subscribe(listener) {
			const wrapped = (_stats: UsageStats): void => listener();
			listeners.add(wrapped);
			return new vscode.Disposable(() => {
				listeners.delete(wrapped);
			});
		},
		dispose(): void {
			if (disposed) return;
			disposed = true;
			if (timer !== undefined) {
				clock.clearInterval(timer);
				timer = undefined;
			}
			// Wait for the in-flight poll to settle (if any) so the
			// final cursor write below reflects the last completed
			// cycle. Errors are swallowed — dispose() is a void
			// contract and the in-flight poll's own `try/finally`
			// already calls `writeCursor` on the way out.
			const pending = inFlight;
			void Promise.resolve(pending)
				.catch(() => undefined)
				.finally(() => {
					void writeCursor(opts.globalState, cursor);
				});
		},
	};

	return handle;
}

// ---- Stats helpers (mirror src/usage.ts but bypass the wrapper) ----

function emptyUsage(): ModelUsage {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		requests: 0,
	};
}

function defaultStats(nowMs: number): UsageStats {
	const now = new Date(nowMs).toISOString();
	return {
		startedAt: now,
		updatedAt: now,
		total: emptyUsage(),
		byModel: {},
		daily: {},
	};
}

function readStatsFromState(
	state: vscode.Memento | undefined,
): UsageStats {
	if (!state) return defaultStats(Date.now());
	const raw = state.get<UsageStats | undefined>(CODEX_USAGE_STATS_KEY);
	if (!raw) return defaultStats(Date.now());
	return {
		startedAt: raw.startedAt,
		updatedAt: raw.updatedAt,
		total: { ...emptyUsage(), ...raw.total },
		byModel: Object.fromEntries(
			Object.entries(raw.byModel ?? {}).map(([id, usage]) => [
				id,
				{ ...emptyUsage(), ...usage },
			]),
		),
		daily: Object.fromEntries(
			Object.entries(raw.daily ?? {}).map(([date, usage]) => [
				date,
				{ ...emptyUsage(), ...usage },
			]),
		),
	};
}

function shiftDays(base: Date, delta: number): Date {
	const d = new Date(base);
	d.setDate(d.getDate() + delta);
	return d;
}

function sumRangeFromState(
	state: vscode.Memento | undefined,
	days: number,
	nowMs: number,
): ModelUsage {
	const total = emptyUsage();
	if (days <= 0) return total;
	const stats = readStatsFromState(state);
	const today = new Date(nowMs);
	for (let i = 0; i < days; i++) {
		const key = todayKey(shiftDays(today, -i));
		const bucket = stats.daily[key];
		if (!bucket) continue;
		total.inputTokens += bucket.inputTokens;
		total.outputTokens += bucket.outputTokens;
		total.cacheReadTokens += bucket.cacheReadTokens;
		total.cacheWriteTokens += bucket.cacheWriteTokens;
		total.requests += bucket.requests;
	}
	return total;
}

function buildSeriesFromState(
	state: vscode.Memento | undefined,
	days: number,
	nowMs: number,
): Array<{ date: string; usage: ModelUsage }> {
	if (days <= 0) return [];
	const stats = readStatsFromState(state);
	const today = new Date(nowMs);
	const series: Array<{ date: string; usage: ModelUsage }> = [];
	for (let i = days - 1; i >= 0; i--) {
		const key = todayKey(shiftDays(today, -i));
		const usage = stats.daily[key];
		series.push({
			date: key,
			usage: usage ? { ...usage } : emptyUsage(),
		});
	}
	return series;
}
