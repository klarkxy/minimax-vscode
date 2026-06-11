// Unit tests for the Claude Code JSONL log ingester.
//
// Strategy: use the injectable `fs` and `clock` options so we never
// touch the real filesystem. The `FakeMemento` mirrors the helper
// used in `test/usage.test.ts`. We use Node's real `tmpdir` to host
// the synthetic JSONL files because `fs.createReadStream` (used
// inside the ingester) needs a real path that the stream can open.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
	extractUsage,
	createClaudeCodeIngest,
	type FileSystemLike,
} from '../src/dashboard/claudeCodeIngest.js';
import {
	CLAUDE_CODE_USAGE_STATS_KEY,
	CLAUDE_CODE_INGEST_CURSOR_KEY,
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

/** Real-fs adapter, packaged to satisfy the `FileSystemLike` interface
 *  so the ingester can use `fs.createReadStream` on a real file. */
function realFs(rootDir: string): FileSystemLike {
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
	return await fsp.mkdtemp(path.join(os.tmpdir(), 'claudeCodeIngest-test-'));
}

function writeFile(p: string, content: string): Promise<void> {
	return fsp.writeFile(p, content, 'utf8');
}

function appendFile(p: string, content: string): Promise<void> {
	return fsp.appendFile(p, content, 'utf8');
}

function assistantLine(opts: {
	model: string;
	ts: string;
	input: number;
	output: number;
	cacheCreate?: number;
	cacheRead?: number;
	messageId?: string;
}): string {
	return JSON.stringify({
		type: 'assistant',
		uuid: 'uuid-' + Math.random().toString(36).slice(2),
		sessionId: 'sess-1',
		timestamp: opts.ts,
		message: {
			id: opts.messageId ?? 'msg_' + Math.random().toString(36).slice(2),
			model: opts.model,
			role: 'assistant',
			content: [{ type: 'text', text: 'hello' }],
			usage: {
				input_tokens: opts.input,
				output_tokens: opts.output,
				cache_creation_input_tokens: opts.cacheCreate ?? 0,
				cache_read_input_tokens: opts.cacheRead ?? 0,
			},
		},
	});
}

function userLine(text: string): string {
	return JSON.stringify({ type: 'user', content: text });
}

// ---- Parser tests ----

test('extractUsage: empty / whitespace line returns null', () => {
	assert.equal(extractUsage(''), null);
	assert.equal(extractUsage('   '), null);
});

test('extractUsage: valid assistant line returns usage + dayKey + messageId', () => {
	const line = assistantLine({
		model: 'claude-sonnet-4-5',
		ts: '2026-06-10T10:00:00.000Z',
		input: 100,
		output: 50,
		cacheCreate: 200,
		cacheRead: 10,
		messageId: 'msg_abc',
	});
	const out = extractUsage(line);
	assert.ok(out);
	assert.equal(out.modelId, 'claude-sonnet-4-5');
	assert.equal(out.usage.inputTokens, 100);
	assert.equal(out.usage.outputTokens, 50);
	assert.equal(out.usage.cacheReadTokens, 10);
	assert.equal(out.usage.cacheWriteTokens, 200);
	assert.equal(out.dayKey, '2026-06-10');
	assert.equal(out.messageId, 'msg_abc');
});

test('extractUsage: user / system lines return null', () => {
	assert.equal(extractUsage(userLine('hi')), null);
	assert.equal(
		extractUsage(
			JSON.stringify({ type: 'system', content: 'sysprompt' }),
		),
		null,
	);
});

test('extractUsage: assistant without a usage block returns null', () => {
	assert.equal(
		extractUsage(
			JSON.stringify({
				type: 'assistant',
				message: { model: 'claude-sonnet-4-5', role: 'assistant' },
			}),
		),
		null,
	);
});

test('extractUsage: assistant with all-zero usage returns null', () => {
	const line = assistantLine({ model: 'm', ts: '2026-06-10T10:00:00Z', input: 0, output: 0 });
	assert.equal(extractUsage(line), null);
});

test('extractUsage: malformed JSON returns null', () => {
	assert.equal(extractUsage('{not json'), null);
});

test('extractUsage: negative numbers clamp to 0', () => {
	const line = JSON.stringify({
		type: 'assistant',
		timestamp: '2026-06-10T10:00:00Z',
		message: {
			id: 'm1',
			model: 'm',
			role: 'assistant',
			usage: {
				input_tokens: -10,
				output_tokens: 5,
				cache_creation_input_tokens: -1,
				cache_read_input_tokens: 0,
			},
		},
	});
	const out = extractUsage(line);
	assert.ok(out);
	assert.equal(out.usage.inputTokens, 0);
	assert.equal(out.usage.outputTokens, 5);
	assert.equal(out.usage.cacheWriteTokens, 0);
	assert.equal(out.usage.cacheReadTokens, 0);
});

test('extractUsage: missing model field returns null', () => {
	assert.equal(
		extractUsage(
			JSON.stringify({
				type: 'assistant',
				timestamp: '2026-06-10T10:00:00Z',
				message: { id: 'm1', role: 'assistant', usage: { input_tokens: 5, output_tokens: 5 } },
			}),
		),
		null,
	);
});

// ---- Ingester integration tests ----

test('ingester: first poll reads all files in the temp dir', async () => {
	const dir = await mkTmpDir();
	try {
		const f1 = path.join(dir, 'session1.jsonl');
		await writeFile(
			f1,
			assistantLine({ model: 'm1', ts: '2026-06-09T10:00:00Z', input: 10, output: 20, messageId: 'a' }) + '\n' +
			assistantLine({ model: 'm2', ts: '2026-06-09T10:01:00Z', input: 5, output: 7, messageId: 'b' }) + '\n',
		);
		const handle = createClaudeCodeIngest({
			globalState: new FakeMemento(),
			logPath: dir,
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

test('ingester: second poll with no file changes reads zero new lines', async () => {
	const dir = await mkTmpDir();
	try {
		const f1 = path.join(dir, 's.jsonl');
		await writeFile(
			f1,
			assistantLine({ model: 'm', ts: '2026-06-09T10:00:00Z', input: 10, output: 20, messageId: 'a' }) + '\n',
		);
		const handle = createClaudeCodeIngest({
			globalState: new FakeMemento(),
			logPath: dir,
			pollIntervalMs: 60_000,
			allowedModels: [],
			fs: realFs(dir),
		});
		await handle.refresh();
		const first = handle.store.read().total.requests;
		assert.equal(first, 1);
		await handle.refresh();
		const second = handle.store.read().total.requests;
		assert.equal(second, 1);
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
			assistantLine({ model: 'm', ts: '2026-06-09T10:00:00Z', input: 10, output: 20, messageId: 'a' }) + '\n',
		);
		const handle = createClaudeCodeIngest({
			globalState: new FakeMemento(),
			logPath: dir,
			pollIntervalMs: 60_000,
			allowedModels: [],
			fs: realFs(dir),
		});
		await handle.refresh();
		// Bump mtime so the ingester doesn't think the file is unchanged.
		await new Promise((r) => setTimeout(r, 10));
		await appendFile(
			f1,
			assistantLine({ model: 'm', ts: '2026-06-09T10:01:00Z', input: 3, output: 4, messageId: 'b' }) + '\n',
		);
		await handle.refresh();
		const stats = handle.store.read();
		assert.equal(stats.total.requests, 2);
		assert.equal(stats.total.inputTokens, 13);
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
			assistantLine({ model: 'm', ts: '2026-06-09T10:00:00Z', input: 10, output: 20, messageId: 'a' }) + '\n' +
			assistantLine({ model: 'm', ts: '2026-06-09T10:01:00Z', input: 5, output: 7, messageId: 'b' }) + '\n';
		await writeFile(f1, fullContent);
		const handle = createClaudeCodeIngest({
			globalState: new FakeMemento(),
			logPath: dir,
			pollIntervalMs: 60_000,
			allowedModels: [],
			fs: realFs(dir),
		});
		await handle.refresh();
		assert.equal(handle.store.read().total.requests, 2);
		// Truncate the file (size shrinks).
		await writeFile(
			f1,
			assistantLine({ model: 'm', ts: '2026-06-09T11:00:00Z', input: 100, output: 200, messageId: 'c' }) + '\n',
		);
		await new Promise((r) => setTimeout(r, 10));
		await handle.refresh();
		const stats = handle.store.read();
		// After truncation, cursor resets to 0 and re-reads the (now
		// single) line — but the two original lines were already
		// counted and dedup'd by messageId, so the total is 3.
		assert.equal(stats.total.requests, 3);
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
			assistantLine({ model: 'm', ts: '2026-06-09T10:00:00Z', input: 10, output: 20, messageId: 'a' }) + '\n',
		);
		const handle = createClaudeCodeIngest({
			globalState: new FakeMemento(),
			logPath: dir,
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
			assistantLine({ model: 'm', ts: '2026-06-09T10:00:00Z', input: 10, output: 20, messageId: 'a' }) + '\n',
		);
		const handle = createClaudeCodeIngest({
			globalState: new FakeMemento(),
			logPath: dir,
			pollIntervalMs: 60_000,
			allowedModels: [],
			fs: realFs(dir),
		});
		await handle.refresh();
		const status = handle.status();
		assert.equal(status.parseErrors, 1);
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
			assistantLine({ model: 'm', ts: '2026-06-09T10:00:00Z', input: 10, output: 20, messageId: 'a' }) + '\n',
		);
		const memento = new FakeMemento();
		const handle = createClaudeCodeIngest({
			globalState: memento,
			logPath: dir,
			pollIntervalMs: 60_000,
			allowedModels: [],
			fs: realFs(dir),
		});
		await handle.refresh();
		const cursor = memento.get<{ version: number; files: Record<string, unknown> }>(
			CLAUDE_CODE_INGEST_CURSOR_KEY,
		);
		assert.ok(cursor);
		// Cursor version bumped from 1 → 2 in LRN-20260611-005 to
		// carry the `allowedModelsFingerprint` field. The pinned
		// shape (files map + version) is otherwise unchanged.
		assert.equal(cursor.version, 2);
		assert.equal(Object.keys(cursor.files).length, 1);
		// The fingerprint is captured at write time and stamped on
		// the cursor so the next read can detect an allowlist
		// change and trigger a full re-read from offset 0.
		assert.ok(
			typeof (cursor as { allowedModelsFingerprint?: unknown })
				.allowedModelsFingerprint === 'string',
			'allowedModelsFingerprint must be persisted on the cursor',
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
			assistantLine({ model: 'm', ts: '2026-06-09T10:00:00Z', input: 10, output: 20, messageId: 'a' }) + '\n',
		);
		const memento = new FakeMemento();
		// First instance.
		const h1 = createClaudeCodeIngest({
			globalState: memento,
			logPath: dir,
			pollIntervalMs: 60_000,
			allowedModels: [],
			fs: realFs(dir),
		});
		await h1.refresh();
		const before = memento.get<{ files: Record<string, { offset: number }> }>(
			CLAUDE_CODE_INGEST_CURSOR_KEY,
		)!;
		const offsetBefore = before.files[f1].offset;
		h1.dispose();
		// Second instance — same memento, same dir.
		const h2 = createClaudeCodeIngest({
			globalState: memento,
			logPath: dir,
			pollIntervalMs: 60_000,
			allowedModels: [],
			fs: realFs(dir),
		});
		await h2.refresh();
		// The file was not modified, so requests should not have
		// increased even though we re-created the ingester.
		assert.equal(h2.store.read().total.requests, 1);
		const after = memento.get<{ files: Record<string, { offset: number }> }>(
			CLAUDE_CODE_INGEST_CURSOR_KEY,
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
		// No trailing newline — partial last line.
		const line = assistantLine({
			model: 'm',
			ts: '2026-06-09T10:00:00Z',
			input: 10,
			output: 20,
			messageId: 'msg_dup',
		});
		await writeFile(f1, line);
		const handle = createClaudeCodeIngest({
			globalState: new FakeMemento(),
			logPath: dir,
			pollIntervalMs: 60_000,
			allowedModels: [],
			fs: realFs(dir),
		});
		await handle.refresh();
		// Partial line is not committed; the cursor stays at 0. Append
		// a newline so the same line becomes a complete record.
		await new Promise((r) => setTimeout(r, 10));
		await appendFile(f1, '\n');
		await handle.refresh();
		// The full line has been read; dedup LRU prevents double-count.
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
			assistantLine({ model: 'm', ts: '2026-06-09T10:00:00Z', input: 10, output: 20, messageId: 'a' }) + '\n',
		);
		const handle = createClaudeCodeIngest({
			globalState: new FakeMemento(),
			logPath: dir,
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
			assistantLine({ model: 'm', ts: '2026-06-09T10:00:00Z', input: 10, output: 20, messageId: 'a' }) + '\n',
		);
		const handle = createClaudeCodeIngest({
			globalState: new FakeMemento(),
			logPath: dir,
			pollIntervalMs: 60_000,
			allowedModels: [],
			fs: realFs(dir),
		});
		// Polling is opt-in: before any poll runs, the store has no
		// data and the status reports `empty`.
		assert.equal(handle.status().state, 'empty');
		await handle.refresh();
		assert.equal(handle.status().state, 'ok');
		handle.dispose();
	} finally {
		await fsp.rm(dir, { recursive: true, force: true });
	}
});

test('ingester: start() begins the periodic poll', async () => {
	const dir = await mkTmpDir();
	try {
		const f1 = path.join(dir, 's.jsonl');
		await writeFile(
			f1,
			assistantLine({ model: 'm', ts: '2026-06-09T10:00:00Z', input: 10, output: 20, messageId: 'a' }) + '\n',
		);
		// Inject a clock whose setInterval we control so we can
		// advance the test deterministically and confirm a poll fires
		// after `start()`.
		const timers: Array<{ cb: () => void }> = [];
		const handle = createClaudeCodeIngest({
			globalState: new FakeMemento(),
			logPath: dir,
			allowedModels: [],
			fs: realFs(dir),
			clock: {
				now: () => Date.now(),
				setInterval: (cb) => {
					timers.push({ cb });
					return 1 as unknown as ReturnType<typeof setInterval>;
				},
				clearInterval: () => {
					/* no-op for the test */
				},
			},
		});
		assert.equal(timers.length, 0, 'no timer scheduled before start()');
		handle.start();
		// The first poll runs in a microtask after `start()`. Await
		// `handle.refresh()` directly — it returns the in-flight
		// promise when one is already running, so we wait for the
		// first poll to complete.
		await handle.refresh();
		assert.equal(handle.status().state, 'ok');
		assert.equal(handle.store.read().total.requests, 1);
		// Wait a tick so the .finally(scheduleNext) callback chain
		// has a chance to run after the in-flight poll resolves.
		await new Promise((r) => setImmediate(r));
		assert.equal(
			timers.length,
			1,
			'one timer scheduled after start() (timers=' + timers.length + ')',
		);
		handle.dispose();
	} finally {
		await fsp.rm(dir, { recursive: true, force: true });
	}
});

test('ingester: status reports empty when no JSONL files exist', async () => {
	const dir = await mkTmpDir();
	try {
		const handle = createClaudeCodeIngest({
			globalState: new FakeMemento(),
			logPath: dir,
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
		await writeFile(
			f1,
			assistantLine({ model: 'm', ts: '2026-06-07T00:00:00Z', input: 1, output: 1, messageId: 'd1' }) + '\n' +
			assistantLine({ model: 'm', ts: '2026-06-08T00:00:00Z', input: 2, output: 2, messageId: 'd2' }) + '\n' +
			assistantLine({ model: 'm', ts: '2026-06-09T00:00:00Z', input: 3, output: 3, messageId: 'd3' }) + '\n',
		);
		const handle = createClaudeCodeIngest({
			globalState: new FakeMemento(),
			logPath: dir,
			pollIntervalMs: 60_000,
			allowedModels: [],
			fs: realFs(dir),
		});
		await handle.refresh();
		const series = handle.store.readDailySeries(5);
		const byDay = Object.fromEntries(series.map((s) => [s.date, s.usage.requests]));
		assert.equal(byDay['2026-06-07'], 1);
		assert.equal(byDay['2026-06-08'], 1);
		assert.equal(byDay['2026-06-09'], 1);
		handle.dispose();
	} finally {
		await fsp.rm(dir, { recursive: true, force: true });
	}
});

test('ingester: multiple files across subdirectories all discovered', async () => {
	const dir = await mkTmpDir();
	try {
		const subdir = path.join(dir, 'project-a');
		await fsp.mkdir(subdir);
		const f1 = path.join(dir, 's1.jsonl');
		const f2 = path.join(subdir, 's2.jsonl');
		await writeFile(
			f1,
			assistantLine({ model: 'm', ts: '2026-06-09T10:00:00Z', input: 1, output: 1, messageId: 'a' }) + '\n',
		);
		await writeFile(
			f2,
			assistantLine({ model: 'm', ts: '2026-06-09T10:00:00Z', input: 2, output: 2, messageId: 'b' }) + '\n',
		);
		const handle = createClaudeCodeIngest({
			globalState: new FakeMemento(),
			logPath: dir,
			pollIntervalMs: 60_000,
			allowedModels: [],
			fs: realFs(dir),
		});
		await handle.refresh();
		assert.equal(handle.status().filesTracked, 2);
		assert.equal(handle.store.read().total.requests, 2);
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
			assistantLine({ model: 'm', ts: '2026-06-09T10:00:00Z', input: 10, output: 20, messageId: 'a' }) + '\n',
		);
		const handle = createClaudeCodeIngest({
			globalState: new FakeMemento(),
			logPath: dir,
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
		const handle = createClaudeCodeIngest({
			globalState: new FakeMemento(),
			logPath: dir,
			pollIntervalMs: 60_000,
			allowedModels: [],
			fs: realFs(dir),
		});
		handle.dispose();
		handle.dispose(); // should not throw
		// Refresh after dispose is a no-op (not awaited for errors).
		await handle.refresh();
	} finally {
		await fsp.rm(dir, { recursive: true, force: true });
	}
});

test('ingester: missing log directory is treated as empty (no error)', async () => {
	const dir = await mkTmpDir();
	const missing = path.join(dir, 'does-not-exist');
	try {
		const handle = createClaudeCodeIngest({
			globalState: new FakeMemento(),
			logPath: missing,
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
			assistantLine({ model: 'm', ts: '2026-06-09T10:00:00Z', input: 10, output: 20, messageId: 'a' }) + '\n',
		);
		const memento = new FakeMemento();
		const handle = createClaudeCodeIngest({
			globalState: memento,
			logPath: dir,
			pollIntervalMs: 60_000,
			allowedModels: [],
			fs: realFs(dir),
		});
		await handle.refresh();
		const stats = memento.get(CLAUDE_CODE_USAGE_STATS_KEY);
		assert.ok(stats);
		handle.dispose();
	} finally {
		await fsp.rm(dir, { recursive: true, force: true });
	}
});

// ---- Model allowlist ---------------------------------------------------
//
// The Claude Code JSONL log records every model the CLI / VSCode
// extension talked to, including models from non-MiniMax providers
// (the user might have a third-party Anthropic-compatible endpoint
// configured). The dashboard's job is to count MiniMax usage, so the
// ingester filters to a configurable allowlist and reports the
// dropped lines in `skippedModels` for visibility.

test('ingester: model allowlist counts only matching models and tracks skipped count', async () => {
	const dir = await mkTmpDir();
	try {
		const f1 = path.join(dir, 's.jsonl');
		await writeFile(
			f1,
			// Three models: one in the allowlist, two out. The
			// allowlist is the published picker model ID so the
			// test mirrors what `minimax.claudeCode.allowedModels`
			// would look like in a real install.
			assistantLine({ model: 'MiniMax-M3', ts: '2026-06-09T10:00:00Z', input: 100, output: 50, messageId: 'a' }) + '\n' +
			assistantLine({ model: 'deepseek-v4-flash', ts: '2026-06-09T10:01:00Z', input: 200, output: 80, messageId: 'b' }) + '\n' +
			assistantLine({ model: 'deepseek-ai/DeepSeek-V4-Pro', ts: '2026-06-09T10:02:00Z', input: 300, output: 90, messageId: 'c' }) + '\n',
		);
		const handle = createClaudeCodeIngest({
			globalState: new FakeMemento(),
			logPath: dir,
			pollIntervalMs: 60_000,
			fs: realFs(dir),
			allowedModels: ['MiniMax-M3'],
		});
		await handle.refresh();
		const stats = handle.store.read();
		// Only the MiniMax-M3 row was counted.
		assert.equal(stats.total.requests, 1);
		assert.equal(stats.total.inputTokens, 100);
		assert.equal(stats.total.outputTokens, 50);
		assert.equal(stats.byModel['MiniMax-M3'].requests, 1);
		// Non-allowlist models are NOT recorded.
		assert.equal(stats.byModel['deepseek-v4-flash'], undefined);
		assert.equal(stats.byModel['deepseek-ai/DeepSeek-V4-Pro'], undefined);
		// The status surfaces the dropped count for visibility.
		const status = handle.status();
		assert.equal(status.skippedModels, 2);
		handle.dispose();
	} finally {
		await fsp.rm(dir, { recursive: true, force: true });
	}
});

test('ingester: empty allowedModels disables the filter (count every model)', async () => {
	// The explicit opt-out. The other ingester tests in this file
	// pass `[]` for the same reason — they assert cursor / LRU /
	// parse-error semantics that should not be entangled with the
	// user's settings.json.
	const dir = await mkTmpDir();
	try {
		const f1 = path.join(dir, 's.jsonl');
		await writeFile(
			f1,
			assistantLine({ model: 'MiniMax-M3', ts: '2026-06-09T10:00:00Z', input: 10, output: 20, messageId: 'a' }) + '\n' +
			assistantLine({ model: 'something-else', ts: '2026-06-09T10:01:00Z', input: 5, output: 7, messageId: 'b' }) + '\n',
		);
		const handle = createClaudeCodeIngest({
			globalState: new FakeMemento(),
			logPath: dir,
			pollIntervalMs: 60_000,
			fs: realFs(dir),
			allowedModels: [],
		});
		await handle.refresh();
		const stats = handle.store.read();
		assert.equal(stats.total.requests, 2);
		assert.equal(handle.status().skippedModels, 0);
		handle.dispose();
	} finally {
		await fsp.rm(dir, { recursive: true, force: true });
	}
});

test('ingester: skippedModels survives a cursor round-trip via memento', async () => {
	// The skip count is part of the cursor blob so it survives
	// extension restarts — otherwise the dashboard would always
	// restart at 0 even after a long Claude Code session that
	// produced thousands of non-MiniMax rows.
	const dir = await mkTmpDir();
	try {
		const f1 = path.join(dir, 's.jsonl');
		await writeFile(
			f1,
			assistantLine({ model: 'other-model', ts: '2026-06-09T10:00:00Z', input: 1, output: 1, messageId: 'a' }) + '\n',
		);
		const memento = new FakeMemento();
		const h1 = createClaudeCodeIngest({
			globalState: memento,
			logPath: dir,
			pollIntervalMs: 60_000,
			fs: realFs(dir),
			allowedModels: ['MiniMax-M3'],
		});
		await h1.refresh();
		assert.equal(h1.status().skippedModels, 1);
		h1.dispose();

		// Re-create the ingester against the same memento. The
		// file is unchanged, so the next poll should not add new
		// skips; but the *cumulative* counter is preserved
		// (1 stays at 1).
		const h2 = createClaudeCodeIngest({
			globalState: memento,
			logPath: dir,
			pollIntervalMs: 60_000,
			fs: realFs(dir),
			allowedModels: ['MiniMax-M3'],
		});
		await h2.refresh();
		assert.equal(h2.status().skippedModels, 1, 'cumulative skip count is preserved across re-creation');
		h2.dispose();
	} finally {
		await fsp.rm(dir, { recursive: true, force: true });
	}
});

test('ingester: changing the allowlist resets the cursor so historical lines are re-evaluated', async () => {
	// Pinned regression for Codex Finding 3 (and 2nd-review follow-up):
	// changing `allowedModels` previously only affected FUTURE lines —
	// historical lines (0..offset bytes) were silently kept in
	// `stats.byModel` under the old filter, so the dashboard could
	// not retroactively correct itself. The v2 cursor carries an
	// `allowedModelsFingerprint`; a mismatch at read time resets
	// the per-file offsets to 0 so the next poll re-reads every
	// line under the new filter. The LRU dedup (by message.id)
	// keeps the re-evaluation from double-counting already-
	// recorded rows in the same session.
	const dir = await mkTmpDir();
	try {
		const f1 = path.join(dir, 's.jsonl');
		const m3Line = assistantLine({
			model: 'MiniMax-M3',
			ts: '2026-06-09T10:00:00Z',
			input: 10,
			output: 20,
			messageId: 'm3-1',
		});
		const otherLine = assistantLine({
			model: 'deepseek-v4-flash',
			ts: '2026-06-09T10:00:01Z',
			input: 100,
			output: 200,
			messageId: 'other-1',
		});
		await writeFile(f1, m3Line + '\n' + otherLine + '\n');

		const memento = new FakeMemento();
		// First ingester: only count M3. The non-M3 line is skipped.
		const h1 = createClaudeCodeIngest({
			globalState: memento,
			logPath: dir,
			pollIntervalMs: 60_000,
			fs: realFs(dir),
			allowedModels: ['MiniMax-M3'],
		});
		await h1.refresh();
		assert.equal(h1.status().skippedModels, 1);
		const beforeStats = h1.store.read();
		assert.ok(beforeStats.byModel['MiniMax-M3'], 'M3 line counted under M3-only filter');
		assert.ok(!beforeStats.byModel['deepseek-v4-flash'], 'non-M3 line not counted');
		h1.dispose();

		// Second ingester: also allow `deepseek-v4-flash`. The cursor
		// has the v1 fingerprint (no fingerprint field); readCursor
		// detects the mismatch, resets the file offsets, and the
		// next poll re-reads both lines under the new filter.
		const h2 = createClaudeCodeIngest({
			globalState: memento,
			logPath: dir,
			pollIntervalMs: 60_000,
			fs: realFs(dir),
			allowedModels: ['MiniMax-M3', 'deepseek-v4-flash'],
		});
		await h2.refresh();
		const afterStats = h2.store.read();
		assert.ok(
			afterStats.byModel['deepseek-v4-flash'],
			'historical non-M3 line is now counted under the broader filter',
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

test('ingester: store.reset() also clears the per-file cursor so the next poll re-reads from offset 0', async () => {
	// Pinned regression for the Reset button behaviour change in
	// LRN-20260611-005. Before this fix, `store.reset()` only wiped
	// the stats — the cursor offsets stayed at the last-read byte
	// position, so the next poll would skip 0..offset on every
	// file and the user would see a "Reset" button that didn't
	// actually re-read anything.
	const dir = await mkTmpDir();
	try {
		const f1 = path.join(dir, 's.jsonl');
		await writeFile(
			f1,
			assistantLine({ model: 'm', ts: '2026-06-09T10:00:00Z', input: 10, output: 20, messageId: 'a' }) + '\n',
		);
		const memento = new FakeMemento();
		const handle = createClaudeCodeIngest({
			globalState: memento,
			logPath: dir,
			pollIntervalMs: 60_000,
			fs: realFs(dir),
			allowedModels: [],
		});
		await handle.refresh();
		assert.equal(handle.store.read().total.requests, 1);

		await handle.store.reset();
		assert.equal(handle.store.read().total.requests, 0);

		// Append a new line. After Reset, the cursor is empty, so
		// the next poll re-reads the file from offset 0 and counts
		// the new line (the LRU dedup is fresh, so the old `a`
		// message is counted AGAIN — this is the "Reset means
		// start over" semantic).
		await writeFile(
			f1,
			assistantLine({ model: 'm', ts: '2026-06-09T10:00:00Z', input: 10, output: 20, messageId: 'a' }) + '\n' +
				assistantLine({ model: 'm', ts: '2026-06-09T10:00:01Z', input: 30, output: 40, messageId: 'b' }) + '\n',
		);
		await handle.refresh();
		// Both lines counted — the LRU was reset (no entries
		// carried over) and the cursor re-read from offset 0.
		assert.equal(
			handle.store.read().total.requests,
			2,
			'post-Reset poll re-reads from offset 0, counts both lines',
		);
		handle.dispose();
	} finally {
		await fsp.rm(dir, { recursive: true, force: true });
	}
});
