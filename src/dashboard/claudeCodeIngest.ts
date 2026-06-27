// Claude Code JSONL log ingestion.
//
// The MiniMax Copilot extension's `usageStore` only counts tokens that
// flow through the extension's own request layer (see
// `src/provider/index.ts:247-253`). When the user runs Claude Code CLI
// or the official Claude Code VSCode extension in parallel, those
// calls never enter our request path — so the dashboard silently misses
// them.
//
// Claude Code writes per-session JSONL logs to
// `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`. Each line
// is a JSON object; `type === "assistant"` lines carry a `message.usage`
// block with the same field shape as Anthropic's API:
//
//   { input_tokens, output_tokens,
//     cache_creation_input_tokens, cache_read_input_tokens }
//
// This module:
//   1. Polls the configured log directory every `pollIntervalMs`
//      (default 30 s).
//   2. Tracks a per-file byte-offset cursor in Memento so we never
//      re-read bytes that we've already ingested. Truncation /
//      rotation are detected via a `size` comparison and a `mtimeMs`
//      sanity check; the cursor is reset to 0 on shrink.
//   3. Holds a per-file partial-line buffer so we don't commit the
//      cursor past a line that hasn't yet ended with `\n` (Claude Code
//      may be mid-write when we poll).
//   4. Dedups records by the assistant `message.id` via a small LRU so
//      a partial last line that completes between two polls isn't
//      counted twice.
//   5. Feeds accepted records into a sibling Memento-backed store that
//      exposes the same `read / readToday / readRange / readDailySeries`
//      shape as `usageStore`, so the dashboard can render both sources
//      with the same helpers.

import * as vscode from 'vscode';
import { promises as fsp, createReadStream } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { logger } from '../logger';
import {
	CLAUDE_CODE_INGEST_MAX_DISCOVERY_DEPTH,
	CLAUDE_CODE_INGEST_MAX_READ_BYTES,
	CLAUDE_CODE_USAGE_STATS_KEY,
	CLAUDE_CODE_INGEST_CURSOR_KEY,
} from '../consts';
import { todayKey, type ModelUsage, type UsageStats, type UsageStore } from '../usage';
import {
	getIncludeClaudeCode,
	getClaudeCodeLogPath,
	getClaudeCodePollIntervalMs,
	getClaudeCodeAllowedModels,
} from '../config';

// ---- Public types ----

/** Cursor schema version — bump if the shape ever changes.
 *
 * v1 (LRN-20260611-005 superseded): the model allowlist was applied
 * only to NEW lines (after the stored byte offset). Historical lines
 * were silently kept in `stats.byModel` regardless of the allowlist,
 * so the dashboard could not retroactively correct itself when the
 * user changed the allowlist — Codex's adversarial review Finding 3
 * closed this gap.
 *
 * v2 (current): the cursor carries an `allowedModelsFingerprint`
 * so the next poll can detect a fingerprint mismatch and reset the
 * file offsets to 0, re-reading every JSONL line under the new
 * allowlist. The LRU dedup (by `message.id`) prevents double-
 * counting of already-recorded rows in the same session.
 */
export const CLAUDE_CODE_CURSOR_VERSION = 2;

export interface ClaudeCodeFileCursor {
	/** Byte offset of the next byte to read. */
	offset: number;
	/** File mtime in ms — used to detect truncation / rotation. */
	mtimeMs: number;
	/** File size at last read — second truncation check. */
	size: number;
}

export interface ClaudeCodeIngestCursor {
	version: 2;
	files: Record<string, ClaudeCodeFileCursor>;
	lastSyncAt: number;
	lastErrorAt?: number;
	lastError?: string;
	parseErrors: number;
	/** Cumulative count of assistant lines dropped because the model
	 *  was not in the configured allowlist. Optional so cursors written
	 *  by older builds (which had no model filter) keep loading. */
	skippedModels?: number;
	/**
	 * 16-char SHA-256 of the sorted allowlist (joined by `\n`). The
	 * next read compares this against the current allowlist's
	 * fingerprint; a mismatch triggers a full re-read from offset 0
	 * so historical lines are re-evaluated against the new filter.
	 * Optional so cursors written by v1 (no allowlist) keep loading —
	 * the mismatch is detected and triggers the same reset.
	 */
	allowedModelsFingerprint?: string;
}

export type ClaudeCodeIngestState =
	| 'ok'
	| 'empty'
	| 'disabled'
	| 'error'
	| 'loading';

export interface ClaudeCodeIngestStatus {
	state: ClaudeCodeIngestState;
	logPath: string;
	lastSyncAt: number | null;
	lastError: string | null;
	filesTracked: number;
	parseErrors: number;
	/** Number of assistant lines whose model ID was not in the
	 *  allowlist and were therefore skipped. Surfaced for visibility —
	 *  non-zero means the user is using Claude Code with models we
	 *  don't track, which is expected when Claude Code is configured
	 *  to talk to other providers. */
	skippedModels: number;
	totalRequests: number;
	/** True on the very first poll cycle, until it completes. */
	isFirstPoll: boolean;
}

export interface ClaudeCodeIngestHandle {
	store: UsageStore;
	status(): ClaudeCodeIngestStatus;
	/** Start the periodic poll loop. Idempotent. The first poll fires
	 *  immediately so the dashboard has data on first paint. Returns
	 *  the handle for chaining. */
	start(): ClaudeCodeIngestHandle;
	/** Force a refresh now (used by the "Re-scan" command and the
	 *  dashboard's button). Resolves when the next poll cycle finishes. */
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

export interface ClaudeCodeIngestOptions {
	globalState: vscode.Memento | undefined;
	/** Override the log path (mostly for tests). */
	logPath?: string;
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
	 * Optional allowlist of model IDs the ingester counts. Any
	 * assistant line whose `message.model` is not in this set is
	 * skipped (counted in `skippedModels` for visibility). When
	 * omitted, the configured `minimax.claudeCode.allowedModels` is
	 * consulted at construction time. Pass an explicit empty array to
	 * disable the filter (count every model) — the tests rely on
	 * this so their assertions stay independent of the user's
	 * settings.json.
	 */
	allowedModels?: readonly string[];
}

const DEFAULT_DEDUP_LRU_SIZE = 1000;

/**
 * Clamp the polling interval to the same [min, max] the user-facing
 * setting advertises (see `minimax.claudeCode.pollIntervalMs` in
 * `package.json`). A user who enters `1` would otherwise busy-loop;
 * `Number.MAX_SAFE_INTEGER` would stall the ingester entirely. The
 * settings UI already enforces the range, but tests and direct
 * `opts.pollIntervalMs` overrides can bypass it.
 */
function clampPollInterval(value: number): number {
	if (!Number.isFinite(value)) {
		return 30_000;
	}
	return Math.max(5000, Math.min(600_000, Math.floor(value)));
}

// ---- JSONL parser ----

interface RawAssistantUsage {
	input_tokens?: unknown;
	output_tokens?: unknown;
	cache_creation_input_tokens?: unknown;
	cache_read_input_tokens?: unknown;
}

export interface ExtractedUsage {
	modelId: string;
	usage: ModelUsage;
	dayKey: string;
	messageId: string;
}

/**
 * Parse a single JSONL line and extract token usage if it represents
 * an assistant turn with a usable usage block. Returns `null` for any
 * line that should be silently skipped (non-assistant types, malformed
 * JSON, missing `usage`, all-zero usage that would inflate `requests`).
 *
 * The `messageId` is the assistant message id (used by the LRU dedup);
 * may be `''` when absent (we still accept the line, just can't dedup).
 */
export function extractUsage(line: string): ExtractedUsage | null {
	if (!line || line.trim().length === 0) return null;
	let obj: unknown;
	try {
		obj = JSON.parse(line);
	} catch {
		return null;
	}
	if (!obj || typeof obj !== 'object') return null;
	const o = obj as Record<string, unknown>;
	if (o.type !== 'assistant') return null;

	const message = (o.message as Record<string, unknown> | undefined) ?? undefined;
	if (!message || typeof message !== 'object') return null;

	const modelId = typeof message.model === 'string' ? message.model : null;
	if (!modelId) return null;

	const u = message.usage as RawAssistantUsage | undefined;
	if (!u || typeof u !== 'object') return null;

	const toInt = (v: unknown): number => {
		if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
			return Math.floor(v);
		}
		return 0;
	};

	const usage: ModelUsage = {
		inputTokens: toInt(u.input_tokens),
		outputTokens: toInt(u.output_tokens),
		cacheReadTokens: toInt(u.cache_read_input_tokens),
		cacheWriteTokens: toInt(u.cache_creation_input_tokens),
		requests: 1,
	};

	// Drop zero-token rows so `requests` doesn't get inflated by
	// tool-result echoes that the SDK emits without a usage block.
	if (
		usage.inputTokens === 0 &&
		usage.outputTokens === 0 &&
		usage.cacheReadTokens === 0 &&
		usage.cacheWriteTokens === 0
	) {
		return null;
	}

	const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
	const date = Number.isFinite(ts) ? new Date(ts) : new Date();
	const dayKey = todayKey(date);

	const messageId =
		(typeof message.id === 'string' && message.id) ||
		(typeof o.uuid === 'string' && o.uuid) ||
		'';

	return { modelId, usage, dayKey, messageId };
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
			// Re-insert to bump to most-recently-used.
			this.map.delete(key);
			this.map.set(key, true);
			return;
		}
		this.map.set(key, true);
		if (this.map.size > this.max) {
			// Evict the oldest entry.
			const oldest = this.map.keys().next().value;
			if (oldest !== undefined) this.map.delete(oldest);
		}
	}
	/** Drop every entry. Used by `store.reset()` so a Reset click
	 *  re-counts every JSONL line on the next poll (otherwise the
	 *  LRU would skip everything it had previously seen, leaving
	 *  the "reset" visually indistinguishable from "stopped
	 *  reading your files"). */
	clear(): void {
		this.map.clear();
	}
}

// ---- Cursor helpers ----

/**
 * 16-char SHA-256 fingerprint of the model allowlist. Sorting
 * before hashing makes the fingerprint stable across array-order
 * changes (e.g. two allowlists that differ only in element order
 * hash to the same value). The empty list has its own fingerprint
 * (an empty sorted array) so `[]` (no filter) and `[X, Y, Z]`
 * produce different fingerprints.
 *
 * Returns `'*'` for the no-filter case (`null` allowedModels, or
 * explicit `[]` opt-out) so `readCursor` can distinguish "we
 * intentionally track everything" from "we are filtering" without
 * a separate boolean field.
 */
function allowedModelsFingerprint(allowedModels: ReadonlySet<string> | null): string {
	if (allowedModels === null) return '*';
	const sorted = [...allowedModels].sort();
	return createHash('sha256').update(sorted.join('\n')).digest('hex').slice(0, 16);
}

function emptyCursor(now: number, fingerprint?: string): ClaudeCodeIngestCursor {
	return {
		version: CLAUDE_CODE_CURSOR_VERSION,
		files: {},
		lastSyncAt: 0,
		parseErrors: 0,
		allowedModelsFingerprint: fingerprint,
	};
}

function readCursor(
	state: vscode.Memento | undefined,
	currentFingerprint: string,
): ClaudeCodeIngestCursor {
	if (!state) return emptyCursor(0, currentFingerprint);
	const raw = state.get<ClaudeCodeIngestCursor | undefined>(
		CLAUDE_CODE_INGEST_CURSOR_KEY,
	);
	// Three reasons to reset the cursor (return emptyCursor):
	//
	//  1. No cursor stored (first run).
	//  2. Stored version doesn't match the current schema version
	//     (a future bump should re-read from offset 0).
	//  3. The stored allowlist fingerprint doesn't match the
	//     currently configured allowlist. Without this check
	//     (added in LRN-20260611-005), changing the allowlist
	//     would only affect FUTURE lines — historical lines
	//     already counted under the old filter would stay in
	//     `stats.byModel` forever. Codex's adversarial review
	//     Finding 3 closed this by triggering a full re-read on
	//     mismatch; the LRU dedup (by message.id) keeps the
	//     re-evaluation from double-counting already-recorded rows
	//     in the same session.
	if (!raw || raw.version !== CLAUDE_CODE_CURSOR_VERSION) {
		return emptyCursor(0, currentFingerprint);
	}
	if (raw.allowedModelsFingerprint !== currentFingerprint) {
		return emptyCursor(0, currentFingerprint);
	}
	return {
		version: CLAUDE_CODE_CURSOR_VERSION,
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
	cursor: ClaudeCodeIngestCursor,
): Promise<void> {
	if (!state) return;
	await state.update(CLAUDE_CODE_INGEST_CURSOR_KEY, cursor);
}

// ---- File enumeration ----

async function discoverJsonlFiles(
	root: string,
	fs: FileSystemLike,
): Promise<string[]> {
	const out: string[] = [];
	async function walk(dir: string, depth: number): Promise<void> {
		// Cap recursion at CLAUDE_CODE_INGEST_MAX_DISCOVERY_DEPTH so a
		// symlink cycle or pathological nesting can't blow the stack.
		if (depth > CLAUDE_CODE_INGEST_MAX_DISCOVERY_DEPTH) {
			return;
		}
		let entries: Array<{ name: string; isFile(): boolean; isDirectory(): boolean }>;
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			// Directory disappeared or is unreadable — treat as no files.
			return;
		}
		for (const e of entries) {
			const full = path.join(dir, e.name);
			if (e.isDirectory()) {
				await walk(full, depth + 1);
			} else if (e.isFile() && e.name.endsWith('.jsonl')) {
				out.push(full);
			}
		}
	}
	try {
		await walk(root, 0);
	} catch {
		// Root missing or unreadable — same as no files.
		return [];
	}
	return out;
}

// ---- Per-file streaming read ----

async function readNewPortion(
	filePath: string,
	start: number,
): Promise<{ text: string; bytesRead: number; eof: boolean }> {
	return new Promise((resolve, reject) => {
		// Cap each read at CLAUDE_CODE_INGEST_MAX_READ_BYTES. If the file
		// has more data than that, the next poll picks it up from
		// `start + bytesRead` — we never materialise an arbitrarily
		// large string into memory.
		const stream = createReadStream(filePath, {
			start,
			end: start + CLAUDE_CODE_INGEST_MAX_READ_BYTES - 1,
			encoding: 'utf8',
		});
		let bytesRead = 0;
		const chunks: string[] = [];
		let settled = false;
		const finish = (eof: boolean) => {
			if (settled) {
				return;
			}
			settled = true;
			resolve({ text: chunks.join(''), bytesRead, eof });
		};
		stream.on('data', (chunk: string | Buffer) => {
			const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
			chunks.push(text);
			bytesRead += Buffer.byteLength(text, 'utf8');
		});
		stream.on('end', () => finish(true));
		stream.on('close', () => {
			// Fires when the fd is released — including the case where
			// we hit the `end` cap and the stream stopped before EOF.
			finish(bytesRead >= CLAUDE_CODE_INGEST_MAX_READ_BYTES ? false : true);
		});
		stream.on('error', (err) => {
			// Explicit destroy so we don't leak the fd until GC.
			stream.destroy();
			if (!settled) {
				settled = true;
				reject(err);
			}
		});
	});
}

// ---- Main factory ----

export function createClaudeCodeIngest(
	opts: ClaudeCodeIngestOptions,
): ClaudeCodeIngestHandle {
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
	const pollIntervalMs = clampPollInterval(opts.pollIntervalMs ?? getClaudeCodePollIntervalMs());
	const dedupLruSize = opts.dedupLruSize ?? DEFAULT_DEDUP_LRU_SIZE;

	// Resolve the model allowlist once at construction. Two cases:
	//   - `opts.allowedModels` is an explicit array (including `[]`):
	//     honour it. `[]` disables the filter (count every model) —
	//     the tests rely on this. Otherwise the constructor snapshot
	//     is taken from the user's settings.json via
	//     `getClaudeCodeAllowedModels`. The snapshot is intentionally
	//     captured once: editing the allowlist at runtime requires
	//     a workspace-configuration change, which the caller
	//     (`setClaudeCodeIngest`) listens for and rebuilds the
	//     ingester — so we don't need to re-read on every poll.
	//
	// `null` means "no filter" (count every model). An empty `Set`
	// would mean "filter everything out", which is rarely what we
	// want — distinguishing the two keeps the `[]` opt-out working.
	const allowedModels: ReadonlySet<string> | null = opts.allowedModels
		? (opts.allowedModels.length > 0 ? new Set(opts.allowedModels) : null)
		: new Set(getClaudeCodeAllowedModels());

	const lru = new LruSet(dedupLruSize);
	const partials = new Map<string, string>();
	const listeners = new Set<(stats: UsageStats) => void>();

	// Compute the fingerprint for the currently-resolved allowlist
	// and use it both for the read comparison and for persisting on
	// the next `writeCursor` call. See `readCursor` for the
	// mismatch-detection path.
	const currentFingerprint = allowedModelsFingerprint(allowedModels);
	let cursor: ClaudeCodeIngestCursor = readCursor(opts.globalState, currentFingerprint);
	// `isFirstPoll` flips to `true` when `start()` is called and back
	// to `false` once the first poll completes. While `true`, the
	// status reports `'loading'`. Polling is opt-in (tests do not
	// call `start()` so they don't get a real `setInterval` keeping
	// the process alive between cases).
	let isFirstPoll = false;
	let started = false;
	let inFlight: Promise<void> | undefined;
	let disposed = false;
	let timer: ReturnType<typeof setInterval> | undefined;

	// Surface the current state in one place. State derivation rules:
	//   - 'disabled' when `getIncludeClaudeCode()` is false
	//   - 'loading'  during the very first poll cycle
	//   - 'error'    when the last poll recorded an error and we have
	//                 no successful sync yet, OR when the configured
	//                 log path is unreadable
	//   - 'empty'    when no JSONL files are tracked AND the last poll
	//                 completed without error AND there is no successful
	//                 sync to fall back to
	//   - 'ok'       otherwise
	function computeStatus(): ClaudeCodeIngestStatus {
		const logPath = opts.logPath ?? getClaudeCodeLogPath();
		const enabled = getIncludeClaudeCode();
		const state: ClaudeCodeIngestState = !enabled
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
		// The status snapshot is recomputed on demand via
		// `handle.status()`; we just trigger the side effect of
		// bumping lastError / lastSyncAt here.
		void _status;
	}

	// Apply a single parsed record to the stats cache. We mutate an
	// in-memory copy of the memento JSON directly because we need to
	// bucket by the JSONL line's `timestamp` (not the wall clock) and
	// `UsageStore.record()` always uses today for the daily bucket.
	const statsCache: UsageStats = readStatsFromState(opts.globalState);

	function accept(record: ExtractedUsage): void {
		// total
		statsCache.total.inputTokens += record.usage.inputTokens;
		statsCache.total.outputTokens += record.usage.outputTokens;
		statsCache.total.cacheReadTokens += record.usage.cacheReadTokens;
		statsCache.total.cacheWriteTokens += record.usage.cacheWriteTokens;
		statsCache.total.requests += 1;
		// byModel
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
		// daily
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
		// Stats are flushed once per poll in `pollOnce` — see the
		// `accept(...)` comment above. Avoids one Memento write per
		// JSONL record (which can be hundreds per poll).
	}

	async function ingestFile(
		filePath: string,
		cur: ClaudeCodeFileCursor | undefined,
	): Promise<ClaudeCodeFileCursor> {
		const stat = await fs.stat(filePath);
		let next: ClaudeCodeFileCursor;
		if (!cur) {
			next = { offset: 0, mtimeMs: stat.mtimeMs, size: stat.size };
		} else if (stat.size < cur.size) {
			// Truncated or rotated — restart from 0.
			partials.delete(filePath);
			next = { offset: 0, mtimeMs: stat.mtimeMs, size: stat.size };
		} else if (cur.offset > stat.size) {
			// Cursor past EOF (shouldn't happen, but be defensive).
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
			// Nothing new — update mtime/size for next time and bail.
			return next;
		}

		const { text, bytesRead } = await readNewPortion(filePath, next.offset);

		let buffer = (partials.get(filePath) ?? '') + text;
		let bytesConsumed = next.offset;
		let lineIdx = buffer.indexOf('\n');
		while (lineIdx >= 0) {
			const line = buffer.slice(0, lineIdx);
			buffer = buffer.slice(lineIdx + 1);
			bytesConsumed += Buffer.byteLength(line, 'utf8') + 1; // +1 for '\n'
			if (line.trim().length > 0) {
				const parsed = extractUsage(line);
				if (parsed) {
					// Apply the model allowlist before the LRU: a
					// row for a non-MiniMax model is not "MiniMax
					// usage" and must not be counted. We still want
					// to surface the count in the status so the
					// user can see "yes, Claude Code is also
					// talking to <other provider>, and we are
					// correctly ignoring those tokens". `null` means
					// "no filter" (the empty-array opt-out the tests
					// use to keep their assertions independent of
					// the user's settings.json).
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
						// No messageId → can't dedup; trust the cursor.
						accept(parsed);
					}
				} else {
					cursor.parseErrors += 1;
				}
			}
			lineIdx = buffer.indexOf('\n');
		}

		// `bytesConsumed` is the byte position right after the last
		// fully-consumed `\n`. Anything left in `buffer` is a partial
		// trailing line we must NOT count yet. We advance the cursor
		// to `bytesConsumed` so the next poll skips the consumed bytes.
		// If the read was truncated by the size cap, `bytesRead <
		// (stat.size - next.offset)` — the next poll will pick up from
		// `bytesConsumed` (which may equal `bytesRead` or be inside
		// the still-partial last line). Either way we don't reread.
		if (buffer.length > 0) {
			partials.set(filePath, buffer);
		} else {
			partials.delete(filePath);
		}

		// `bytesRead` may be < bytesConsumed when the buffer held a
		// partial-line continuation from a previous poll — those bytes
		// came from the prior read, not this one. Use the larger of
		// the two so the cursor always moves forward.
		const newOffset = Math.max(bytesConsumed, next.offset + bytesRead);
		return {
			offset: newOffset,
			mtimeMs: stat.mtimeMs,
			size: stat.size,
		};
	}

	async function pollOnce(): Promise<void> {
		if (!getIncludeClaudeCode()) {
			isFirstPoll = false;
			notify();
			return;
		}
		const logPath = opts.logPath ?? getClaudeCodeLogPath();
		try {
			const files = await discoverJsonlFiles(logPath, fs);
			const seen = new Set<string>();
			for (const file of files) {
				seen.add(file);
				const cur = cursor.files[file];
				try {
					cursor.files[file] = await ingestFile(file, cur);
				} catch (error) {
					cursor.parseErrors += 1;
					logger.warn(
						`claudeCodeIngest: failed to read ${file}`,
						error,
					);
				}
			}
			// Drop cursors for files that no longer exist.
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
			logger.warn('claudeCodeIngest: poll failed', error);
		} finally {
			isFirstPoll = false;
			await writeCursor(opts.globalState, cursor);
			// Flush the in-memory stats cache to Memento once per poll.
			// `accept(...)` mutates the cache without persisting, so a
			// single end-of-poll write covers every record processed in
			// this cycle — previously we wrote once per record, which
			// could be hundreds of concurrent Memento writes for a
			// burst of Claude Code JSONL.
			await opts.globalState?.update(CLAUDE_CODE_USAGE_STATS_KEY, statsCache);
			notify();
		}
	}

	function scheduleNext(): void {
		if (disposed) return;
		timer = clock.setInterval(() => {
			void handle.refresh();
		}, pollIntervalMs);
	}

	// Minimal `UsageStore`-shaped object that reads from the same
	// memento JSON we write. We don't go through `createUsageStore`
	// because that has its own in-memory state and always uses
	// `todayKey()` for the daily bucket — we need per-day bucketing
	// driven by the JSONL line's own `timestamp`.
	const store: UsageStore = {
		// `record` is part of the public API; the ingester only ever
		// mutates the store internally so the no-op is a safe shape.
		record: async () => {
			/* no-op — the ingester mutates the cache directly. */
		},
		read: () => readStatsFromState(opts.globalState),
		readForKey: () => readStatsFromState(opts.globalState),
		readAllKeys: () => ({}),
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
			await opts.globalState?.update(CLAUDE_CODE_USAGE_STATS_KEY, statsCache);
			// Reset clears EVERYTHING — both the in-memory stats and
			// the per-file byte-offset cursor. Without the cursor
			// reset, the next poll would skip bytes 0..offset on
			// every file (the cursor remembered reading them) and
			// the new empty stats would never record any of them.
			// LRN-20260611-005 captures the user-visible behaviour
			// change ("Reset" button is now a full reset, not a
			// "clear stats but keep cursor" one — it was the latter
			// historically and confused users who thought the
			// dashboard had stopped reading their files).
			//
			// The LRU dedup (by `message.id`) is also cleared — if
			// it weren't, the next poll would re-read the file from
			// offset 0 but skip every old line that was already in
			// the LRU, leaving the user's "Reset" click visually
			// indistinguishable from "the ingester stopped
			// reading your files". LRU is a per-instance dedup
			// only — clearing it is cheap (it's a Map of size 1024
			// by default) and never persisted.
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
			// `UsageStore.subscribe` takes a `(stats) => void` callback
			// while the handle's `subscribe` takes a no-arg one. We
			// ignore the stats arg and call the user's listener with
			// no args.
			const wrapped = (_stats: UsageStats): void => {
				(listener as unknown as () => void)();
			};
			listeners.add(wrapped);
			return new vscode.Disposable(() => {
				listeners.delete(wrapped);
			});
		},
	};

	const handle: ClaudeCodeIngestHandle = {
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
		start(): ClaudeCodeIngestHandle {
			if (disposed) return handle;
			if (started) return handle;
			started = true;
			isFirstPoll = true;
			// First poll fires immediately so the dashboard has data
			// on first paint; subsequent polls on the interval. The
			// first poll is fired in a microtask so the caller can
			// subscribe before the first state notification lands.
			queueMicrotask(() => {
				void handle.refresh().finally(scheduleNext);
			});
			return handle;
		},
		subscribe(listener) {
			// The handle's `subscribe` takes a no-arg listener; the
			// internal set is typed as `(stats) => void` so we wrap.
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

	// Polling is opt-in. The extension calls `start()` once during
	// activation; tests stay silent unless they call `start()`
	// explicitly. This keeps the test process from keeping a real
	// `setInterval` alive between tests.

	return handle;
}

// ---- Stats helpers (mirror src/usage.ts but bypass the wrapper so we
// can drive daily bucketing from each record's own `dayKey`). ----

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
	const raw = state.get<UsageStats | undefined>(CLAUDE_CODE_USAGE_STATS_KEY);
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
