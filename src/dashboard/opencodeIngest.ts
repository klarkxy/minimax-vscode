// OpenCode storage directory ingestion.
//
// The MiniMax Copilot extension's `usageStore` only counts tokens that
// flow through the extension's own request layer (see
// `src/provider/index.ts:247-253`). When the user runs the OpenCode CLI
// (https://opencode.ai) in parallel — pointed at a MiniMax-compatible
// provider — those calls never enter our request path, so the dashboard
// silently misses them.
//
// OpenCode's on-disk layout (from `packages/opencode/src/storage/storage.ts`)
// is a tree of one-object-per-file under `$XDG_DATA_HOME/opencode/storage`,
// NOT a single append-only JSONL log:
//
//   storage/session/<projectID>/<sessionID>.json    — session metadata
//   storage/session/message/<sessionID>/<msgID>.json — per-message JSON
//   storage/session/part/<sessionID>/<msgID>/<partID>.json — parts
//
// Because each message lives in its own file, a byte-offset cursor is
// impossible — the file is rewritten as a whole on update. We instead:
//
//   1. Walk `storage/session/message/<sessionID>/` recursively.
//   2. Persist a "seen message IDs" set in Memento (capped at 5000
//      entries; once it overflows we clear and start over).
//   3. Use the file's mtime as a secondary filter — even an unseen ID
//      whose mtime is older than the last poll's high-water mark is
//      skipped (it's a message we previously read but whose ID
//      dropped out of the LRU; mtime prevents re-counting on the
//      next poll while the LRU catches up).
//
// Token fields live on the message object's `tokens` block. We try
// the canonical nested shape first (`tokens.input`, `tokens.output`,
// `tokens.cache.read`, `tokens.cache.write`) and fall back to the
// flat Responses-style block (`input_tokens`, `output_tokens`, etc.)
// for older OpenCode versions. Missing fields default to 0; an
// all-zero record is dropped so the `requests` counter does not
// inflate on tool-result echoes.

import * as vscode from 'vscode';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { logger } from '../logger';
import {
	OPENCODE_USAGE_STATS_KEY,
	OPENCODE_INGEST_SEEN_KEY,
} from '../consts';
import { todayKey, type ModelUsage, type UsageStats, type UsageStore } from '../usage';
import {
	getIncludeOpencode,
	getOpencodeLogPath,
	getOpencodePollIntervalMs,
	getOpencodeAllowedModels,
} from '../config';

// ---- Public types ----

/** Cursor schema version. Bump when the shape changes. */
export const OPENCODE_SEEN_VERSION = 1;

/** Soft cap on the persisted "seen message IDs" set. When the set
 *  grows past this size we clear it on the next read and rely on
 *  the mtime high-water mark to prevent double-counting. 5000 is
 *  generous — a heavy user generates < 1000 messages per day. */
export const OPENCODE_SEEN_CAP = 5000;

export interface OpencodeSeenCursor {
	version: 1;
	/** Sorted array of message IDs we've already counted. */
	seen: string[];
	/** Highest mtime (ms) seen on the previous poll — used as a
	 *  secondary filter for IDs that have aged out of `seen`. */
	lastSyncAt: number;
	lastErrorAt?: number;
	lastError?: string;
	parseErrors: number;
	skippedModels?: number;
	/** Fingerprint of the resolved model allowlist. A mismatch at
	 *  read time forces a full re-walk so historical messages are
	 *  re-evaluated under the new filter. See
	 *  `claudeCodeIngest.ts` for the full rationale. */
	allowedModelsFingerprint?: string;
}

export type OpencodeIngestState =
	| 'ok'
	| 'empty'
	| 'disabled'
	| 'error'
	| 'loading';

export interface OpencodeIngestStatus {
	state: OpencodeIngestState;
	logPath: string;
	lastSyncAt: number | null;
	lastError: string | null;
	filesTracked: number;
	parseErrors: number;
	skippedModels: number;
	totalRequests: number;
	isFirstPoll: boolean;
}

export interface OpencodeIngestHandle {
	store: UsageStore;
	status(): OpencodeIngestStatus;
	start(): OpencodeIngestHandle;
	refresh(): Promise<void>;
	subscribe(listener: () => void): vscode.Disposable;
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

export interface OpencodeIngestOptions {
	globalState: vscode.Memento | undefined;
	/** Override the storage root (mostly for tests). */
	logPath?: string;
	/** Polling interval in ms. Default 30 000. */
	pollIntervalMs?: number;
	clock?: {
		now: () => number;
		setInterval: typeof setInterval;
		clearInterval: typeof clearInterval;
	};
	fs?: FileSystemLike;
	/** Override the seen-set cap. Default 5000. */
	seenCap?: number;
	/**
	 * Optional allowlist of model IDs the ingester counts. When
	 * omitted, the configured `minimax.opencode.allowedModels` is
	 * consulted at construction time. Pass an explicit empty array
	 * to disable the filter (the tests rely on this).
	 */
	allowedModels?: readonly string[];
}

// ---- JSON parser ----

export interface ExtractedOpencodeUsage {
	modelId: string;
	usage: ModelUsage;
	dayKey: string;
	messageId: string;
}

/**
 * Parse a single OpenCode message JSON and extract token usage.
 * Returns `null` for any message that should be silently skipped.
 *
 * The message object is expected to look like:
 *   {
 *     id: "msg_…",
 *     sessionID: "ses_…",
 *     role: "assistant",
 *     modelID: "MiniMax-M3",
 *     providerID: "anthropic",
 *     time: { created: 1718… },
 *     tokens: {
 *       input: 100, output: 50,
 *       cache: { read: 10, write: 5 },
 *       reasoning: 7,
 *     },
 *   }
 *
 * We also accept the older flat shape (`input_tokens` / `output_tokens` /
 * `cached_input_tokens` at the top level) so the ingester works across
 * OpenCode versions without a parser bump.
 */
export function extractOpencodeUsage(
	text: string,
): ExtractedOpencodeUsage | null {
	if (!text || text.trim().length === 0) return null;
	let obj: unknown;
	try {
		obj = JSON.parse(text);
	} catch {
		return null;
	}
	if (!obj || typeof obj !== 'object') return null;
	const o = obj as Record<string, unknown>;

	// role filter: only assistant turns carry billable tokens.
	const role = typeof o.role === 'string' ? o.role : '';
	if (role !== 'assistant') return null;

	const messageId = typeof o.id === 'string' ? o.id : '';
	const modelId = typeof o.modelID === 'string' ? o.modelID : '';
	if (!messageId || !modelId) return null;

	const usage = readUsage(o);
	if (isAllZero(usage)) return null;

	const ts = extractTimestamp(o);
	const dayKey = Number.isFinite(ts) ? todayKey(new Date(ts)) : todayKey();
	return { modelId, usage, dayKey, messageId };
}

function readUsage(o: Record<string, unknown>): ModelUsage {
	// New shape: tokens: { input, output, cache: { read, write }, reasoning }.
	const tokens = (o.tokens as Record<string, unknown> | undefined) ?? undefined;
	if (tokens && typeof tokens === 'object') {
		const cache = (tokens.cache as Record<string, unknown> | undefined) ?? {};
		const input = toInt(tokens.input ?? tokens.input_tokens);
		const output = toInt(tokens.output ?? tokens.output_tokens) +
			toInt(tokens.reasoning ?? tokens.reasoning_output_tokens);
		const cacheRead = toInt(cache.read ?? cache.read_tokens ?? tokens.cached_input_tokens);
		const cacheWrite = toInt(cache.write ?? cache.write_tokens ?? tokens.cache_creation_input_tokens);
		return {
			inputTokens: input,
			outputTokens: output,
			cacheReadTokens: cacheRead,
			cacheWriteTokens: cacheWrite,
			requests: 1,
		};
	}
	// Old flat shape: { input_tokens, output_tokens, cached_input_tokens, … }.
	const input = toInt(o.input_tokens);
	const output = toInt(o.output_tokens) + toInt(o.reasoning_output_tokens);
	const cacheRead = toInt(o.cached_input_tokens);
	const cacheWrite = toInt(o.cache_creation_input_tokens);
	return {
		inputTokens: input,
		outputTokens: output,
		cacheReadTokens: cacheRead,
		cacheWriteTokens: cacheWrite,
		requests: 1,
	};
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

function extractTimestamp(o: Record<string, unknown>): number {
	const time = (o.time as Record<string, unknown> | undefined) ?? undefined;
	const raw = time ? (time.created ?? time.completed) : undefined;
	if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
	if (typeof raw === 'string') {
		const parsed = Date.parse(raw);
		if (Number.isFinite(parsed)) return parsed;
	}
	return NaN;
}

// ---- Cursor helpers ----

function allowedModelsFingerprint(
	allowedModels: ReadonlySet<string> | null,
): string {
	if (allowedModels === null) return '*';
	const sorted = [...allowedModels].sort();
	return createHash('sha256').update(sorted.join('\n')).digest('hex').slice(0, 16);
}

function emptySeen(now: number, fingerprint?: string): OpencodeSeenCursor {
	return {
		version: OPENCODE_SEEN_VERSION,
		seen: [],
		lastSyncAt: now,
		parseErrors: 0,
		allowedModelsFingerprint: fingerprint,
	};
}

function readSeen(
	state: vscode.Memento | undefined,
	currentFingerprint: string,
): OpencodeSeenCursor {
	if (!state) return emptySeen(0, currentFingerprint);
	const raw = state.get<OpencodeSeenCursor | undefined>(OPENCODE_INGEST_SEEN_KEY);
	if (!raw || raw.version !== OPENCODE_SEEN_VERSION) {
		return emptySeen(0, currentFingerprint);
	}
	if (raw.allowedModelsFingerprint !== currentFingerprint) {
		// Allowlist changed — start fresh so historical messages are
		// re-evaluated under the new filter. Mirrors the same
		// mechanism in claudeCodeIngest / codexIngest.
		return emptySeen(raw.lastSyncAt, currentFingerprint);
	}
	return {
		version: OPENCODE_SEEN_VERSION,
		seen: Array.isArray(raw.seen) ? [...raw.seen] : [],
		lastSyncAt: raw.lastSyncAt ?? 0,
		lastErrorAt: raw.lastErrorAt,
		lastError: raw.lastError,
		parseErrors: raw.parseErrors ?? 0,
		skippedModels: raw.skippedModels ?? 0,
		allowedModelsFingerprint: currentFingerprint,
	};
}

async function writeSeen(
	state: vscode.Memento | undefined,
	seen: OpencodeSeenCursor,
): Promise<void> {
	if (!state) return;
	await state.update(OPENCODE_INGEST_SEEN_KEY, seen);
}

// ---- File enumeration ----

interface DiscoveredFile {
	path: string;
	mtimeMs: number;
}

/** Recursively walk `storage/session/message/<sessionID>/*.json` and
 *  return every file with its mtime. The `<sessionID>` intermediate
 *  directory is opaque to us — we just need every JSON file under
 *  any `message/` subtree. */
async function discoverMessageFiles(
	root: string,
	fs: FileSystemLike,
): Promise<DiscoveredFile[]> {
	const out: DiscoveredFile[] = [];
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
			} else if (e.isFile() && e.name.endsWith('.json')) {
				try {
					const st = await fs.stat(full);
					out.push({ path: full, mtimeMs: st.mtimeMs });
				} catch {
					// File disappeared between readdir and stat —
					// skip it; the next poll will pick it up if it
					// comes back.
				}
			}
		}
	}
	try {
		// OpenCode nests message files two levels deep
		// (`<root>/session/message/<sessionID>/<messageID>.json`).
		// We recurse from the root, so any *.json under
		// `<root>/**/message/**/*.json` is matched. We deliberately
		// do NOT start at `<root>/session/message/` directly — the
		// exact intermediate directory name (currently `session`)
		// could change across OpenCode versions, while a
		// `**/message/**/*.json` walk is forward-compatible.
		await walk(root);
	} catch {
		// Root missing — same as no files.
	}
	return out.filter((f) => f.path.includes(`${path.sep}message${path.sep}`));
}

// ---- Main factory ----

export function createOpencodeIngest(
	opts: OpencodeIngestOptions,
): OpencodeIngestHandle {
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
	const pollIntervalMs = opts.pollIntervalMs ?? getOpencodePollIntervalMs();
	const seenCap = opts.seenCap ?? OPENCODE_SEEN_CAP;

	const allowedModels: ReadonlySet<string> | null = opts.allowedModels
		? (opts.allowedModels.length > 0 ? new Set(opts.allowedModels) : null)
		: new Set(getOpencodeAllowedModels());

	const listeners = new Set<(stats: UsageStats) => void>();
	const seenSet = new Set<string>();
	const statsCache: UsageStats = readStatsFromState(opts.globalState);

	const currentFingerprint = allowedModelsFingerprint(allowedModels);
	let cursor: OpencodeSeenCursor = readSeen(opts.globalState, currentFingerprint);
	// Hydrate the in-memory `seen` set from the persisted cursor.
	for (const id of cursor.seen) seenSet.add(id);

	let isFirstPoll = false;
	let started = false;
	let inFlight: Promise<void> | undefined;
	let disposed = false;
	let timer: ReturnType<typeof setInterval> | undefined;

	function computeStatus(): OpencodeIngestStatus {
		const logPath = opts.logPath ?? getOpencodeLogPath();
		const enabled = getIncludeOpencode();
		const state: OpencodeIngestState = !enabled
			? 'disabled'
			: isFirstPoll
				? 'loading'
				: cursor.lastError
					? 'error'
					: seenSet.size === 0
						? 'empty'
						: 'ok';
		const stats: UsageStats = readStatsFromState(opts.globalState);
		return {
			state,
			logPath,
			lastSyncAt: cursor.lastSyncAt || null,
			lastError: cursor.lastError ?? null,
			filesTracked: seenSet.size,
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

	function accept(record: ExtractedOpencodeUsage): void {
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
		void opts.globalState?.update(OPENCODE_USAGE_STATS_KEY, statsCache);
	}

	async function processFile(
		file: DiscoveredFile,
	): Promise<'ok' | 'skipped' | 'parseError'> {
		// The seen set is the source of truth — mtime filtering was
		// tried first but the `cursor.lastSyncAt` high-water mark is
		// updated AFTER each poll completes, so on a re-creation
		// `lastSyncAt` is already >= every historical file's mtime,
		// which would skip legitimate files. The seen-set LRU (capped
		// at `seenCap` and reset on overflow) is sufficient to
		// bound re-reads; the mtime order below ensures messages
		// are processed in chronological order.
		let text: string;
		try {
			text = await fs.readFile(file.path, 'utf8');
		} catch {
			return 'parseError';
		}
		const parsed = extractOpencodeUsage(text);
		if (!parsed) {
			return 'parseError';
		}
		// Check the seen set FIRST so a re-encountered message is
		// not double-counted into either `stats.total.requests` or
		// `skippedModels` on a re-creation. The `skippedModels`
		// counter is the cumulative count of "we saw this model in
		// the wild but didn't add it" — once we've already seen a
		// particular message id, neither accept nor re-increment.
		if (seenSet.has(parsed.messageId)) {
			return 'skipped';
		}
		seenSet.add(parsed.messageId);
		if (allowedModels !== null && !allowedModels.has(parsed.modelId)) {
			cursor.skippedModels = (cursor.skippedModels ?? 0) + 1;
			return 'ok';
		}
		accept(parsed);
		return 'ok';
	}

	async function pollOnce(): Promise<void> {
		if (!getIncludeOpencode()) {
			isFirstPoll = false;
			notify();
			return;
		}
		const logPath = opts.logPath ?? getOpencodeLogPath();
		try {
			const files = await discoverMessageFiles(logPath, fs);
			// Process in mtime order so the seenSet advances
			// deterministically — a message that arrives between two
			// polls and is older than the just-recorded lastSyncAt
			// will still be processed (the seen set, not mtime, is
			// the source of truth for "have we seen this id").
			files.sort((a, b) => a.mtimeMs - b.mtimeMs);
			for (const file of files) {
				const result = await processFile(file);
				if (result === 'parseError') {
					cursor.parseErrors += 1;
				}
			}
			cursor.lastSyncAt = clock.now();
			cursor.lastError = undefined;
			cursor.lastErrorAt = undefined;
		} catch (error) {
			cursor.lastError = error instanceof Error ? error.message : String(error);
			cursor.lastErrorAt = clock.now();
			logger.warn('opencodeIngest: poll failed', error);
		} finally {
			// Cap the persisted set. We could keep the in-memory
			// `seenSet` unbounded (Map handles it) but the persisted
			// form is serialised on every write and the dashboard's
			// `seenModels`-style counter relies on a stable snapshot.
			if (seenSet.size > seenCap) {
				seenSet.clear();
				cursor.skippedModels = 0;
			}
			cursor.seen = [...seenSet];
			isFirstPoll = false;
			await writeSeen(opts.globalState, cursor);
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
			await opts.globalState?.update(OPENCODE_USAGE_STATS_KEY, statsCache);
			seenSet.clear();
			cursor.seen = [];
			cursor.skippedModels = 0;
			cursor.parseErrors = 0;
			cursor.lastError = undefined;
			cursor.lastErrorAt = undefined;
			cursor.lastSyncAt = clock.now();
			await writeSeen(opts.globalState, cursor);
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

	const handle: OpencodeIngestHandle = {
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
		start(): OpencodeIngestHandle {
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
			// already calls `writeSeen` on the way out.
			const pending = inFlight;
			void Promise.resolve(pending)
				.catch(() => undefined)
				.finally(() => {
					void writeSeen(opts.globalState, cursor);
				});
		},
	};

	return handle;
}

// ---- Stats helpers ----

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
	const raw = state.get<UsageStats | undefined>(OPENCODE_USAGE_STATS_KEY);
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
