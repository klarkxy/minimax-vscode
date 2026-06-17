// Unit tests for the Codex JSONL rollout ingester.
//
// Strategy: use the injectable `fs` and `clock` options so we never
// touch the real filesystem. Mirrors `test/claudeCodeIngest.test.ts`
// pattern 1:1 — same `FakeMemento`, same `realFs` adapter that
// delegates to `node:fs` so `fs.createReadStream` can open a real
// path, same `mkTmpDir` helper, same case ordering.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
	extractCodexUsage,
	createCodexIngest,
	type FileSystemLike,
} from '../src/dashboard/codexIngest.js';
import {
	CODEX_USAGE_STATS_KEY,
	CODEX_INGEST_CURSOR_KEY,
} from '../src/consts.js';

class FakeMemento {
	private store = new Map<string, unknown>();
	get<T>(key: string): T | undefined {
		return this.store.get(key) as T | undefined;
	}
	update(key: string, value: unknown): Thenable<void> {
		this.store.set(key, value);
		return Promise.resolve();
	}
}

function realFs(_rootDir: string): FileSystemLike {
	return {
		readFile: (p, e) => fsp.readFile(p, e),
		stat: async (p) => {
			const s = await fsp.stat(p);
			return { size: s.size, mtimeMs: s.mtimeMs };
		},
		readdir: (p, o) => fsp.readdir(p, o),
	};
}

async function mkTmpDir(): Promise<string> {
	return await fsp.mkdtemp(path.join(os.tmpdir(), 'codexIngest-test-'));
}

function writeFile(p: string, content: string): Promise<void> {
	return fsp.writeFile(p, content, 'utf8');
}

function appendFile(p: string, content: string): Promise<void> {
	return fsp.appendFile(p, content, 'utf8');
}

/** Build a `event_msg` / `token_count` Codex rollout line. */
function tokenCountLine(opts: {
	model: string;
	ts: string;
	input: number;
	output: number;
	cacheRead?: number;
	reasoning?: number;
	messageId?: string;
	id?: string;
}): string {
	return JSON.stringify({
		type: 'event_msg',
		id: opts.id ?? 'evt_' + Math.random().toString(36).slice(2),
		uuid: 'uuid-' + Math.random().toString(36).slice(2),
		sessionId: 'sess-1',
		timestamp: opts.ts,
		payload: {
			type: 'token_count',
			info: {
				model: opts.model,
				input_tokens: opts.input,
				output_tokens: opts.output,
				cached_input_tokens: opts.cacheRead ?? 0,
				reasoning_output_tokens: opts.reasoning ?? 0,
			},
		},
	});
}

/** Build a `response_item` Codex rollout line. */
function responseItemLine(opts: {
	model: string;
	ts: string;
	input: number;
	output: number;
	cacheRead?: number;
	reasoning?: number;
	messageId?: string;
}): string {
	return JSON.stringify({
		type: 'response_item',
		timestamp: opts.ts,
		message: {
			id: opts.messageId ?? 'msg_' + Math.random().toString(36).slice(2),
			model: opts.model,
			role: 'assistant',
			usage: {
				input_tokens: opts.input,
				output_tokens: opts.output,
				cached_input_tokens: opts.cacheRead ?? 0,
				reasoning_output_tokens: opts.reasoning ?? 0,
			},
		},
	});
}

function otherLine(text: string): string {
	return JSON.stringify({ type: 'user_message', content: text });
}

// ---- Parser tests ----

test('extractCodexUsage: empty / whitespace line returns null', () => {
	assert.equal(extractCodexUsage(''), null);
	assert.equal(extractCodexUsage('   '), null);
});

test('extractCodexUsage: valid event_msg token_count returns usage + dayKey + messageId', () => {
	const line = tokenCountLine({
		model: 'MiniMax-M3',
		ts: '2026-06-10T10:00:00.000Z',
		input: 100,
		output: 50,
		cacheRead: 10,
		reasoning: 7,
		id: 'evt_abc',
	});
	const out = extractCodexUsage(line);
	assert.ok(out);
	assert.equal(out.modelId, 'MiniMax-M3');
	assert.equal(out.usage.inputTokens, 100);
	assert.equal(out.usage.outputTokens, 57);
	assert.equal(out.usage.cacheReadTokens, 10);
	assert.equal(out.usage.cacheWriteTokens, 0);
	assert.equal(out.dayKey, '2026-06-10');
	assert.equal(out.messageId, 'evt_abc');
});

test('extractCodexUsage: valid response_item returns usage', () => {
	const line = responseItemLine({
		model: 'MiniMax-M3',
		ts: '2026-06-10T10:00:00Z',
		input: 8,
		output: 16,
		messageId: 'msg_xyz',
	});
	const out = extractCodexUsage(line);
	assert.ok(out);
	assert.equal(out.usage.inputTokens, 8);
	assert.equal(out.usage.outputTokens, 16);
	assert.equal(out.messageId, 'msg_xyz');
});

test('extractCodexUsage: user_message / event_msg non-token_count return null', () => {
	assert.equal(extractCodexUsage(otherLine('hi')), null);
	assert.equal(
		extractCodexUsage(
			JSON.stringify({
				type: 'event_msg',
				payload: { type: 'something_else' },
			}),
		),
		null,
	);
});

test('extractCodexUsage: assistant without a usage block returns null', () => {
	assert.equal(
		extractCodexUsage(
			JSON.stringify({
				type: 'event_msg',
				payload: {
					type: 'token_count',
					info: { model: 'MiniMax-M3' },
				},
			}),
		),
		null,
	);
});

test('extractCodexUsage: all-zero usage returns null', () => {
	const line = tokenCountLine({ model: 'm', ts: '2026-06-10T10:00:00Z', input: 0, output: 0 });
	assert.equal(extractCodexUsage(line), null);
});

test('extractCodexUsage: malformed JSON returns null', () => {
	assert.equal(extractCodexUsage('{not json'), null);
});

test('extractCodexUsage: negative numbers clamp to 0', () => {
	const line = tokenCountLine({
		model: 'm',
		ts: '2026-06-10T10:00:00Z',
		input: -10,
		output: 5,
		cacheRead: -1,
	});
	const out = extractCodexUsage(line);
	assert.ok(out);
	assert.equal(out.usage.inputTokens, 0);
	assert.equal(out.usage.outputTokens, 5);
	assert.equal(out.usage.cacheReadTokens, 0);
});

test('extractCodexUsage: missing model field returns null', () => {
	assert.equal(
		extractCodexUsage(
			JSON.stringify({
				type: 'response_item',
				timestamp: '2026-06-10T10:00:00Z',
				message: {
					id: 'm1',
					role: 'assistant',
					usage: { input_tokens: 5, output_tokens: 5 },
				},
			}),
		),
		null,
	);
});

// ---- Ingester integration tests ----

test('ingester: first poll reads all files in the temp dir', async () => {
	const dir = await mkTmpDir();
	try {
		const f1 = path.join(dir, 'rollout1.jsonl');
		await writeFile(
			f1,
			tokenCountLine({ model: 'm1', ts: '2026-06-09T10:00:00Z', input: 10, output: 20, messageId: 'a' }) + '\n' +
			tokenCountLine({ model: 'm2', ts: '2026-06-09T10:01:00Z', input: 5, output: 7, messageId: 'b' }) + '\n',
		);
		const handle = createCodexIngest({
			globalState: new FakeMemento(),
			logPath: dir,
			archivedLogPath: '',
			pollIntervalMs: 60_000,
			allowedModels: [],
			fs: realFs(dir),
		});
		await handle.refresh();
		const stats = handle.store.read();
		assert.equal(stats.total.requests, 2);
		assert.equal(stats.total.inputTokens, 15);
		assert.equal(stats.total.outputTokens, 27);
		assert.equal(stats.byModel['m1'].requests, 1);
		assert.equal(stats.byModel['m2'].requests, 1);
		handle.dispose();
	} finally {
		await fsp.rm(dir, { recursive: true, force: true });
	}
});

test('ingester: archived directory is scanned in addition to the live one', async () => {
	const root = await mkTmpDir();
	const live = path.join(root, 'sessions');
	const archived = path.join(root, 'archived_sessions');
	await fsp.mkdir(live);
	await fsp.mkdir(archived);
	try {
		await writeFile(
			path.join(live, 'a.jsonl'),
			tokenCountLine({ model: 'm1', ts: '2026-06-09T10:00:00Z', input: 1, output: 2, messageId: 'a' }) + '\n',
		);
		await writeFile(
			path.join(archived, 'b.jsonl'),
			tokenCountLine({ model: 'm2', ts: '2026-06-09T10:00:00Z', input: 3, output: 4, messageId: 'b' }) + '\n',
		);
		const handle = createCodexIngest({
			globalState: new FakeMemento(),
			logPath: live,
			archivedLogPath: archived,
			pollIntervalMs: 60_000,
			allowedModels: [],
			fs: realFs(root),
		});
		await handle.refresh();
		assert.equal(handle.status().filesTracked, 2);
		assert.equal(handle.store.read().total.requests, 2);
		handle.dispose();
	} finally {
		await fsp.rm(root, { recursive: true, force: true });
	}
});

test('ingester: second poll with no file changes reads zero new lines', async () => {
	const dir = await mkTmpDir();
	try {
		const f1 = path.join(dir, 's.jsonl');
		await writeFile(
			f1,
			tokenCountLine({ model: 'm', ts: '2026-06-09T10:00:00Z', input: 10, output: 20, messageId: 'a' }) + '\n',
		);
		const handle = createCodexIngest({
			globalState: new FakeMemento(),
			logPath: dir,
			archivedLogPath: '',
			pollIntervalMs: 60_000,
			allowedModels: [],
			fs: realFs(dir),
		});
		await handle.refresh();
		assert.equal(handle.store.read().total.requests, 1);
		await handle.refresh();
		assert.equal(handle.store.read().total.requests, 1);
		handle.dispose();
	} finally {
		await fsp.rm(dir, { recursive: true, force: true });
	}
});

test('ingester: appending to a file is picked up on the next poll', async () => {
	const dir = await mkTmpDir();
	try {
		const f1 = path.join(dir, 's.jsonl');
		await writeFile(
			f1,
			tokenCountLine({ model: 'm', ts: '2026-06-09T10:00:00Z', input: 10, output: 20, messageId: 'a' }) + '\n',
		);
		const handle = createCodexIngest({
			globalState: new FakeMemento(),
			logPath: dir,
			archivedLogPath: '',
			pollIntervalMs: 60_000,
			allowedModels: [],
			fs: realFs(dir),
		});
		await handle.refresh();
		await new Promise((r) => setTimeout(r, 10));
		await appendFile(
			f1,
			tokenCountLine({ model: 'm', ts: '2026-06-09T10:01:00Z', input: 3, output: 4, messageId: 'b' }) + '\n',
		);
		await handle.refresh();
		assert.equal(handle.store.read().total.requests, 2);
		assert.equal(handle.store.read().total.inputTokens, 13);
		handle.dispose();
	} finally {
		await fsp.rm(dir, { recursive: true, force: true });
	}
});

test('ingester: file truncation (size shrinks) resets cursor to 0', async () => {
	const dir = await mkTmpDir();
	try {
		const f1 = path.join(dir, 's.jsonl');
		const fullContent =
			tokenCountLine({ model: 'm', ts: '2026-06-09T10:00:00Z', input: 10, output: 20, messageId: 'a' }) + '\n' +
			tokenCountLine({ model: 'm', ts: '2026-06-09T10:01:00Z', input: 5, output: 7, messageId: 'b' }) + '\n';
		await writeFile(f1, fullContent);
		const handle = createCodexIngest({
			globalState: new FakeMemento(),
			logPath: dir,
			archivedLogPath: '',
			pollIntervalMs: 60_000,
			allowedModels: [],
			fs: realFs(dir),
		});
		await handle.refresh();
		assert.equal(handle.store.read().total.requests, 2);
		await writeFile(
			f1,
			tokenCountLine({ model: 'm', ts: '2026-06-09T11:00:00Z', input: 100, output: 200, messageId: 'c' }) + '\n',
		);
		await new Promise((r) => setTimeout(r, 10));
		await handle.refresh();
		assert.equal(handle.store.read().total.requests, 3);
		handle.dispose();
	} finally {
		await fsp.rm(dir, { recursive: true, force: true });
	}
});

test('ingester: file deletion drops the cursor entry', async () => {
	const dir = await mkTmpDir();
	try {
		const f1 = path.join(dir, 's.jsonl');
		await writeFile(
			f1,
			tokenCountLine({ model: 'm', ts: '2026-06-09T10:00:00Z', input: 10, output: 20, messageId: 'a' }) + '\n',
		);
		const handle = createCodexIngest({
			globalState: new FakeMemento(),
			logPath: dir,
			archivedLogPath: '',
			pollIntervalMs: 60_000,
			allowedModels: [],
			fs: realFs(dir),
		});
		await handle.refresh();
		assert.equal(handle.status().filesTracked, 1);
		await fsp.unlink(f1);
		await handle.refresh();
		assert.equal(handle.status().filesTracked, 0);
		handle.dispose();
	} finally {
		await fsp.rm(dir, { recursive: true, force: true });
	}
});

test('ingester: malformed lines increment parseErrors but do not break the file', async () => {
	const dir = await mkTmpDir();
	try {
		const f1 = path.join(dir, 's.jsonl');
		await writeFile(
			f1,
			'{not json\n' +
			tokenCountLine({ model: 'm', ts: '2026-06-09T10:00:00Z', input: 10, output: 20, messageId: 'a' }) + '\n',
		);
		const handle = createCodexIngest({
			globalState: new FakeMemento(),
			logPath: dir,
			archivedLogPath: '',
			pollIntervalMs: 60_000,
			allowedModels: [],
			fs: realFs(dir),
		});
		await handle.refresh();
		assert.equal(handle.status().parseErrors, 1);
		assert.equal(handle.store.read().total.requests, 1);
		handle.dispose();
	} finally {
		await fsp.rm(dir, { recursive: true, force: true });
	}
});

test('ingester: cursor blob is persisted to memento after each poll', async () => {
	const dir = await mkTmpDir();
	try {
		const f1 = path.join(dir, 's.jsonl');
		await writeFile(
			f1,
			tokenCountLine({ model: 'm', ts: '2026-06-09T10:00:00Z', input: 10, output: 20, messageId: 'a' }) + '\n',
		);
		const memento = new FakeMemento();
		const handle = createCodexIngest({
			globalState: memento,
			logPath: dir,
			archivedLogPath: '',
			pollIntervalMs: 60_000,
			allowedModels: [],
			fs: realFs(dir),
		});
		await handle.refresh();
		const cursor = memento.get<{ version: number; files: Record<string, unknown> }>(
			CODEX_INGEST_CURSOR_KEY,
		);
		assert.ok(cursor);
		assert.equal(cursor.version, 1);
		assert.equal(Object.keys(cursor.files).length, 1);
		assert.equal(
			typeof (cursor as { allowedModelsFingerprint?: unknown })
				.allowedModelsFingerprint,
			'string',
		);
		handle.dispose();
	} finally {
		await fsp.rm(dir, { recursive: true, force: true });
	}
});

test('ingester: re-creating with the same memento resumes from the persisted cursor', async () => {
	const dir = await mkTmpDir();
	try {
		const f1 = path.join(dir, 's.jsonl');
		await writeFile(
			f1,
			tokenCountLine({ model: 'm', ts: '2026-06-09T10:00:00Z', input: 10, output: 20, messageId: 'a' }) + '\n',
		);
		const memento = new FakeMemento();
		const h1 = createCodexIngest({
			globalState: memento,
			logPath: dir,
			archivedLogPath: '',
			pollIntervalMs: 60_000,
			allowedModels: [],
			fs: realFs(dir),
		});
		await h1.refresh();
		const before = memento.get<{ files: Record<string, { offset: number }> }>(
			CODEX_INGEST_CURSOR_KEY,
		)!;
		const offsetBefore = before.files[f1].offset;
		h1.dispose();
		const h2 = createCodexIngest({
			globalState: memento,
			logPath: dir,
			archivedLogPath: '',
			pollIntervalMs: 60_000,
			allowedModels: [],
			fs: realFs(dir),
		});
		await h2.refresh();
		assert.equal(h2.store.read().total.requests, 1);
		const after = memento.get<{ files: Record<string, { offset: number }> }>(
			CODEX_INGEST_CURSOR_KEY,
		)!;
		assert.equal(after.files[f1].offset, offsetBefore);
		h2.dispose();
	} finally {
		await fsp.rm(dir, { recursive: true, force: true });
	}
});

test('ingester: uuid LRU dedup skips re-read lines', async () => {
	const dir = await mkTmpDir();
	try {
		const f1 = path.join(dir, 's.jsonl');
		const line = tokenCountLine({
			model: 'm',
			ts: '2026-06-09T10:00:00Z',
			input: 10,
			output: 20,
			messageId: 'msg_dup',
		});
		await writeFile(f1, line);
		const handle = createCodexIngest({
			globalState: new FakeMemento(),
			logPath: dir,
			archivedLogPath: '',
			pollIntervalMs: 60_000,
			allowedModels: [],
			fs: realFs(dir),
		});
		await handle.refresh();
		await new Promise((r) => setTimeout(r, 10));
		await appendFile(f1, '\n');
		await handle.refresh();
		assert.equal(handle.store.read().total.requests, 1);
		handle.dispose();
	} finally {
		await fsp.rm(dir, { recursive: true, force: true });
	}
});

test('ingester: subscribe fires on every poll that lands data', async () => {
	const dir = await mkTmpDir();
	try {
		const f1 = path.join(dir, 's.jsonl');
		await writeFile(
			f1,
			tokenCountLine({ model: 'm', ts: '2026-06-09T10:00:00Z', input: 10, output: 20, messageId: 'a' }) + '\n',
		);
		const handle = createCodexIngest({
			globalState: new FakeMemento(),
			logPath: dir,
			archivedLogPath: '',
			pollIntervalMs: 60_000,
			allowedModels: [],
			fs: realFs(dir),
		});
		let count = 0;
		const sub = handle.subscribe(() => {
			count += 1;
		});
		await handle.refresh();
		await handle.refresh();
		sub.dispose();
		assert.ok(count >= 2, `expected at least 2 notifications, got ${count}`);
		handle.dispose();
	} finally {
		await fsp.rm(dir, { recursive: true, force: true });
	}
});

test('ingester: status reports ok after a successful first poll', async () => {
	const dir = await mkTmpDir();
	try {
		const f1 = path.join(dir, 's.jsonl');
		await writeFile(
			f1,
			tokenCountLine({ model: 'm', ts: '2026-06-09T10:00:00Z', input: 10, output: 20, messageId: 'a' }) + '\n',
		);
		const handle = createCodexIngest({
			globalState: new FakeMemento(),
			logPath: dir,
			archivedLogPath: '',
			pollIntervalMs: 60_000,
			allowedModels: [],
			fs: realFs(dir),
		});
		assert.equal(handle.status().state, 'empty');
		await handle.refresh();
		assert.equal(handle.status().state, 'ok');
		handle.dispose();
	} finally {
		await fsp.rm(dir, { recursive: true, force: true });
	}
});

test('ingester: status reports empty when no JSONL files exist', async () => {
	const dir = await mkTmpDir();
	try {
		const handle = createCodexIngest({
			globalState: new FakeMemento(),
			logPath: dir,
			archivedLogPath: '',
			pollIntervalMs: 60_000,
			allowedModels: [],
			fs: realFs(dir),
		});
		await handle.refresh();
		assert.equal(handle.status().state, 'empty');
		assert.equal(handle.status().filesTracked, 0);
		handle.dispose();
	} finally {
		await fsp.rm(dir, { recursive: true, force: true });
	}
});

test('ingester: per-day buckets use the line timestamp, not the wall clock', async () => {
	const dir = await mkTmpDir();
	try {
		const f1 = path.join(dir, 's.jsonl');
		// Three records on three different days, all at midnight UTC.
		// The 5-day window returned by `readDailySeries(5)` is
		// anchored on today's local date, so we don't assert which
		// specific dates are in the series — only that the three
		// records landed in `stats.daily` and the cumulative
		// `requests` total matches the input. The wall-clock-anchored
		// series would zero them out; the line-timestamp-anchored
		// series would not. That's the property we care about.
		await writeFile(
			f1,
			tokenCountLine({ model: 'm', ts: '2026-06-07T00:00:00Z', input: 1, output: 1, id: 'd1' }) + '\n' +
			tokenCountLine({ model: 'm', ts: '2026-06-08T00:00:00Z', input: 2, output: 2, id: 'd2' }) + '\n' +
			tokenCountLine({ model: 'm', ts: '2026-06-09T00:00:00Z', input: 3, output: 3, id: 'd3' }) + '\n',
		);
		const handle = createCodexIngest({
			globalState: new FakeMemento(),
			logPath: dir,
			archivedLogPath: '',
			pollIntervalMs: 60_000,
			allowedModels: [],
			fs: realFs(dir),
		});
		await handle.refresh();
		const stats = handle.store.read();
		assert.equal(stats.total.requests, 3, 'all three records must be counted');
		// Each unique day key should have exactly one request, and
		// the three keys should be the three fixture days.
		const dailyKeys = Object.keys(stats.daily).sort();
		assert.deepEqual(
			dailyKeys,
			['2026-06-07', '2026-06-08', '2026-06-09'],
			'daily buckets should use the line timestamp, not the wall clock',
		);
		handle.dispose();
	} finally {
		await fsp.rm(dir, { recursive: true, force: true });
	}
});

test('ingester: store.reset() clears all in-memory stats', async () => {
	const dir = await mkTmpDir();
	try {
		const f1 = path.join(dir, 's.jsonl');
		await writeFile(
			f1,
			tokenCountLine({ model: 'm', ts: '2026-06-09T10:00:00Z', input: 10, output: 20, messageId: 'a' }) + '\n',
		);
		const handle = createCodexIngest({
			globalState: new FakeMemento(),
			logPath: dir,
			archivedLogPath: '',
			pollIntervalMs: 60_000,
			allowedModels: [],
			fs: realFs(dir),
		});
		await handle.refresh();
		assert.equal(handle.store.read().total.requests, 1);
		await handle.store.reset();
		assert.equal(handle.store.read().total.requests, 0);
		handle.dispose();
	} finally {
		await fsp.rm(dir, { recursive: true, force: true });
	}
});

test('ingester: dispose() is idempotent', async () => {
	const dir = await mkTmpDir();
	try {
		const handle = createCodexIngest({
			globalState: new FakeMemento(),
			logPath: dir,
			archivedLogPath: '',
			pollIntervalMs: 60_000,
			allowedModels: [],
			fs: realFs(dir),
		});
		handle.dispose();
		handle.dispose();
		await handle.refresh();
	} finally {
		await fsp.rm(dir, { recursive: true, force: true });
	}
});

test('ingester: missing log directory is treated as empty (no error)', async () => {
	const dir = await mkTmpDir();
	const missing = path.join(dir, 'does-not-exist');
	try {
		const handle = createCodexIngest({
			globalState: new FakeMemento(),
			logPath: missing,
			archivedLogPath: '',
			pollIntervalMs: 60_000,
			allowedModels: [],
			fs: realFs(missing),
		});
		await handle.refresh();
		assert.equal(handle.status().state, 'empty');
		handle.dispose();
	} finally {
		await fsp.rm(dir, { recursive: true, force: true });
	}
});

test('ingester: the on-disk UsageStats key matches the constant', async () => {
	const dir = await mkTmpDir();
	try {
		const f1 = path.join(dir, 's.jsonl');
		await writeFile(
			f1,
			tokenCountLine({ model: 'm', ts: '2026-06-09T10:00:00Z', input: 10, output: 20, messageId: 'a' }) + '\n',
		);
		const memento = new FakeMemento();
		const handle = createCodexIngest({
			globalState: memento,
			logPath: dir,
			archivedLogPath: '',
			pollIntervalMs: 60_000,
			allowedModels: [],
			fs: realFs(dir),
		});
		await handle.refresh();
		const stats = memento.get(CODEX_USAGE_STATS_KEY);
		assert.ok(stats);
		handle.dispose();
	} finally {
		await fsp.rm(dir, { recursive: true, force: true });
	}
});

// ---- Model allowlist ----

test('ingester: model allowlist counts only matching models and tracks skipped count', async () => {
	const dir = await mkTmpDir();
	try {
		const f1 = path.join(dir, 's.jsonl');
		await writeFile(
			f1,
			tokenCountLine({ model: 'MiniMax-M3', ts: '2026-06-09T10:00:00Z', input: 100, output: 50, messageId: 'a' }) + '\n' +
			tokenCountLine({ model: 'gpt-5', ts: '2026-06-09T10:01:00Z', input: 200, output: 80, messageId: 'b' }) + '\n' +
			tokenCountLine({ model: 'gpt-5-mini', ts: '2026-06-09T10:02:00Z', input: 300, output: 90, messageId: 'c' }) + '\n',
		);
		const handle = createCodexIngest({
			globalState: new FakeMemento(),
			logPath: dir,
			archivedLogPath: '',
			pollIntervalMs: 60_000,
			fs: realFs(dir),
			allowedModels: ['MiniMax-M3'],
		});
		await handle.refresh();
		const stats = handle.store.read();
		assert.equal(stats.total.requests, 1);
		assert.equal(stats.total.inputTokens, 100);
		assert.equal(stats.total.outputTokens, 50);
		assert.equal(stats.byModel['MiniMax-M3'].requests, 1);
		assert.equal(stats.byModel['gpt-5'], undefined);
		assert.equal(stats.byModel['gpt-5-mini'], undefined);
		assert.equal(handle.status().skippedModels, 2);
		handle.dispose();
	} finally {
		await fsp.rm(dir, { recursive: true, force: true });
	}
});

test('ingester: empty allowedModels disables the filter (count every model)', async () => {
	const dir = await mkTmpDir();
	try {
		const f1 = path.join(dir, 's.jsonl');
		await writeFile(
			f1,
			tokenCountLine({ model: 'MiniMax-M3', ts: '2026-06-09T10:00:00Z', input: 10, output: 20, messageId: 'a' }) + '\n' +
			tokenCountLine({ model: 'something-else', ts: '2026-06-09T10:01:00Z', input: 5, output: 7, messageId: 'b' }) + '\n',
		);
		const handle = createCodexIngest({
			globalState: new FakeMemento(),
			logPath: dir,
			archivedLogPath: '',
			pollIntervalMs: 60_000,
			fs: realFs(dir),
			allowedModels: [],
		});
		await handle.refresh();
		assert.equal(handle.store.read().total.requests, 2);
		assert.equal(handle.status().skippedModels, 0);
		handle.dispose();
	} finally {
		await fsp.rm(dir, { recursive: true, force: true });
	}
});

test('ingester: skippedModels survives a cursor round-trip via memento', async () => {
	const dir = await mkTmpDir();
	try {
		const f1 = path.join(dir, 's.jsonl');
		await writeFile(
			f1,
			tokenCountLine({ model: 'other-model', ts: '2026-06-09T10:00:00Z', input: 1, output: 1, messageId: 'a' }) + '\n',
		);
		const memento = new FakeMemento();
		const h1 = createCodexIngest({
			globalState: memento,
			logPath: dir,
			archivedLogPath: '',
			pollIntervalMs: 60_000,
			fs: realFs(dir),
			allowedModels: ['MiniMax-M3'],
		});
		await h1.refresh();
		assert.equal(h1.status().skippedModels, 1);
		h1.dispose();
		const h2 = createCodexIngest({
			globalState: memento,
			logPath: dir,
			archivedLogPath: '',
			pollIntervalMs: 60_000,
			fs: realFs(dir),
			allowedModels: ['MiniMax-M3'],
		});
		await h2.refresh();
		assert.equal(h2.status().skippedModels, 1);
		h2.dispose();
	} finally {
		await fsp.rm(dir, { recursive: true, force: true });
	}
});

test('ingester: changing the allowlist resets the cursor so historical lines are re-evaluated', async () => {
	const dir = await mkTmpDir();
	try {
		const f1 = path.join(dir, 's.jsonl');
		// One MiniMax row + one gpt-5 row. The first ingester
		// filters to ['MiniMax-M3']; the gpt-5 row is skipped.
		// The second ingester broadens the allowlist to include
		// gpt-5; the v1 cursor's fingerprint mismatch resets the
		// per-file offsets to 0, so the next poll re-reads both
		// rows. We assert on the per-model buckets (the property
		// the test guards) rather than on the cumulative request
		// count, because the M3 row is also re-read and the
		// per-instance LRU is empty at the second h2 construction.
		const m3Line = tokenCountLine({
			model: 'MiniMax-M3',
			ts: '2026-06-09T10:00:00Z',
			input: 10,
			output: 20,
			id: 'a',
		});
		const otherLine = tokenCountLine({
			model: 'gpt-5',
			ts: '2026-06-09T10:01:00Z',
			input: 5,
			output: 5,
			id: 'b',
		});
		await writeFile(f1, m3Line + '\n' + otherLine + '\n');
		const memento = new FakeMemento();
		const h1 = createCodexIngest({
			globalState: memento,
			logPath: dir,
			archivedLogPath: '',
			pollIntervalMs: 60_000,
			fs: realFs(dir),
			allowedModels: ['MiniMax-M3'],
		});
		await h1.refresh();
		assert.equal(h1.status().skippedModels, 1);
		const beforeStats = h1.store.read();
		assert.ok(beforeStats.byModel['MiniMax-M3'], 'M3 line counted under M3-only filter');
		assert.ok(!beforeStats.byModel['gpt-5'], 'non-MiniMax line not counted');
		h1.dispose();
		const h2 = createCodexIngest({
			globalState: memento,
			logPath: dir,
			archivedLogPath: '',
			pollIntervalMs: 60_000,
			fs: realFs(dir),
			allowedModels: ['MiniMax-M3', 'gpt-5'],
		});
		await h2.refresh();
		const afterStats = h2.store.read();
		assert.ok(
			afterStats.byModel['gpt-5'],
			'historical non-MiniMax line is now counted under the broader filter',
		);
		assert.ok(
			afterStats.byModel['MiniMax-M3'],
			'M3 line still counted after the allowlist expansion',
		);
		h2.dispose();
	} finally {
		await fsp.rm(dir, { recursive: true, force: true });
	}
});
