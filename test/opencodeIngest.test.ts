// Unit tests for the OpenCode storage directory ingester.
//
// Mirrors `test/claudeCodeIngest.test.ts` and `test/codexIngest.test.ts`
// pattern 1:1 — same `FakeMemento`, same `realFs` adapter, same
// `mkTmpDir` helper. Differences:
//
//   - The fixture creates nested directories
//     (`<root>/session/message/<sessionID>/<messageID>.json`) because
//     OpenCode stores one object per file, not in a JSONL log.
//   - "Append" tests create a new file with a different ID rather
//     than appending to an existing file.
//   - The "truncation" test is replaced with a "delete" test (a
//     deleted message file just drops out of the next walk — we
//     keep the seen-set entry but the file is gone, so no double
//     count).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
	extractOpencodeUsage,
	createOpencodeIngest,
	type FileSystemLike,
} from '../src/dashboard/opencodeIngest.js';
import {
	OPENCODE_USAGE_STATS_KEY,
	OPENCODE_INGEST_SEEN_KEY,
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
	return await fsp.mkdtemp(path.join(os.tmpdir(), 'opencodeIngest-test-'));
}

function writeFile(p: string, content: string): Promise<void> {
	return fsp.writeFile(p, content, 'utf8');
}

/** Write a message file under `<root>/session/message/<sessionID>/<id>.json`. */
async function writeMessage(
	root: string,
	sessionId: string,
	id: string,
	opts: {
		model: string;
		input: number;
		output: number;
		cacheRead?: number;
		cacheWrite?: number;
		reasoning?: number;
		role?: string;
		created?: number;
	},
): Promise<string> {
	const dir = path.join(root, 'session', 'message', sessionId);
	await fsp.mkdir(dir, { recursive: true });
	const file = path.join(dir, id + '.json');
	const msg = {
		id,
		sessionID: sessionId,
		role: opts.role ?? 'assistant',
		modelID: opts.model,
		providerID: 'anthropic',
		time: { created: opts.created ?? Date.now() },
		tokens: {
			input: opts.input,
			output: opts.output,
			cache: { read: opts.cacheRead ?? 0, write: opts.cacheWrite ?? 0 },
			reasoning: opts.reasoning ?? 0,
		},
	};
	await writeFile(file, JSON.stringify(msg));
	return file;
}

// ---- Parser tests ----

test('extractOpencodeUsage: empty / whitespace text returns null', () => {
	assert.equal(extractOpencodeUsage(''), null);
	assert.equal(extractOpencodeUsage('   '), null);
});

test('extractOpencodeUsage: valid assistant message returns usage + dayKey + messageId', () => {
	const text = JSON.stringify({
		id: 'msg_abc',
		sessionID: 'ses_1',
		role: 'assistant',
		modelID: 'MiniMax-M3',
		time: { created: 1749552000000 }, // 2025-06-10 UTC
		tokens: {
			input: 100,
			output: 50,
			cache: { read: 10, write: 5 },
			reasoning: 7,
		},
	});
	const out = extractOpencodeUsage(text);
	assert.ok(out);
	assert.equal(out.modelId, 'MiniMax-M3');
	assert.equal(out.usage.inputTokens, 100);
	assert.equal(out.usage.outputTokens, 57);
	assert.equal(out.usage.cacheReadTokens, 10);
	assert.equal(out.usage.cacheWriteTokens, 5);
	assert.equal(out.dayKey, '2025-06-10');
	assert.equal(out.messageId, 'msg_abc');
});

test('extractOpencodeUsage: flat top-level usage shape is accepted', () => {
	const text = JSON.stringify({
		id: 'msg_xyz',
		role: 'assistant',
		modelID: 'MiniMax-M3',
		input_tokens: 8,
		output_tokens: 16,
		cached_input_tokens: 2,
	});
	const out = extractOpencodeUsage(text);
	assert.ok(out);
	assert.equal(out.usage.inputTokens, 8);
	assert.equal(out.usage.outputTokens, 16);
	assert.equal(out.usage.cacheReadTokens, 2);
});

test('extractOpencodeUsage: user / system roles return null', () => {
	const userText = JSON.stringify({
		id: 'msg_user',
		role: 'user',
		modelID: 'MiniMax-M3',
		tokens: { input: 10, output: 0, cache: { read: 0, write: 0 } },
	});
	assert.equal(extractOpencodeUsage(userText), null);
});

test('extractOpencodeUsage: missing id returns null', () => {
	const text = JSON.stringify({
		role: 'assistant',
		modelID: 'MiniMax-M3',
		tokens: { input: 10, output: 0, cache: { read: 0, write: 0 } },
	});
	assert.equal(extractOpencodeUsage(text), null);
});

test('extractOpencodeUsage: missing modelID returns null', () => {
	const text = JSON.stringify({
		id: 'msg_1',
		role: 'assistant',
		tokens: { input: 10, output: 0, cache: { read: 0, write: 0 } },
	});
	assert.equal(extractOpencodeUsage(text), null);
});

test('extractOpencodeUsage: all-zero usage returns null', () => {
	const text = JSON.stringify({
		id: 'msg_1',
		role: 'assistant',
		modelID: 'm',
		tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
	});
	assert.equal(extractOpencodeUsage(text), null);
});

test('extractOpencodeUsage: malformed JSON returns null', () => {
	assert.equal(extractOpencodeUsage('{not json'), null);
});

test('extractOpencodeUsage: negative numbers clamp to 0', () => {
	const text = JSON.stringify({
		id: 'm1',
		role: 'assistant',
		modelID: 'm',
		tokens: {
			input: -10,
			output: 5,
			cache: { read: -1, write: 0 },
			reasoning: 0,
		},
	});
	const out = extractOpencodeUsage(text);
	assert.ok(out);
	assert.equal(out.usage.inputTokens, 0);
	assert.equal(out.usage.outputTokens, 5);
	assert.equal(out.usage.cacheReadTokens, 0);
});

// ---- Ingester integration tests ----

test('ingester: first poll reads all message files under session/message/', async () => {
	const dir = await mkTmpDir();
	try {
		await writeMessage(dir, 'ses_a', 'msg_1', { model: 'm1', input: 10, output: 20 });
		await writeMessage(dir, 'ses_a', 'msg_2', { model: 'm2', input: 5, output: 7 });
		const handle = createOpencodeIngest({
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
		await writeMessage(dir, 'ses_a', 'msg_1', { model: 'm', input: 10, output: 20 });
		const handle = createOpencodeIngest({
			globalState: new FakeMemento(),
			logPath: dir,
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

test('ingester: a new message file is picked up on the next poll', async () => {
	const dir = await mkTmpDir();
	try {
		await writeMessage(dir, 'ses_a', 'msg_1', { model: 'm', input: 10, output: 20 });
		const handle = createOpencodeIngest({
			globalState: new FakeMemento(),
			logPath: dir,
			pollIntervalMs: 60_000,
			allowedModels: [],
			fs: realFs(dir),
		});
		await handle.refresh();
		assert.equal(handle.store.read().total.requests, 1);
		await new Promise((r) => setTimeout(r, 10));
		await writeMessage(dir, 'ses_a', 'msg_2', { model: 'm', input: 3, output: 4 });
		await handle.refresh();
		const stats = handle.store.read();
		assert.equal(stats.total.requests, 2);
		assert.equal(stats.total.inputTokens, 13);
		handle.dispose();
	} finally {
		await fsp.rm(dir, { recursive: true, force: true });
	}
});

test('ingester: deleting a message file drops it from the next walk', async () => {
	const dir = await mkTmpDir();
	try {
		const file = await writeMessage(dir, 'ses_a', 'msg_1', { model: 'm', input: 10, output: 20 });
		const handle = createOpencodeIngest({
			globalState: new FakeMemento(),
			logPath: dir,
			pollIntervalMs: 60_000,
			allowedModels: [],
			fs: realFs(dir),
		});
		await handle.refresh();
		assert.equal(handle.status().filesTracked, 1);
		await fsp.unlink(file);
		await handle.refresh();
		// filesTracked is the size of the seen set, which still
		// holds the deleted ID — the walk just doesn't re-read it.
		// The dashboard semantics: "we tracked this message" is
		// still true, it just no longer exists on disk.
		assert.equal(handle.status().filesTracked, 1);
		// Stats should not have grown.
		assert.equal(handle.store.read().total.requests, 1);
		handle.dispose();
	} finally {
		await fsp.rm(dir, { recursive: true, force: true });
	}
});

test('ingester: malformed JSON increments parseErrors but does not break the poll', async () => {
	const dir = await mkTmpDir();
	try {
		const msgDir = path.join(dir, 'session', 'message', 'ses_a');
		await fsp.mkdir(msgDir, { recursive: true });
		await writeFile(path.join(msgDir, 'broken.json'), '{not json');
		await writeMessage(dir, 'ses_a', 'msg_1', { model: 'm', input: 10, output: 20 });
		const handle = createOpencodeIngest({
			globalState: new FakeMemento(),
			logPath: dir,
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

test('ingester: seen cursor is persisted to memento after each poll', async () => {
	const dir = await mkTmpDir();
	try {
		await writeMessage(dir, 'ses_a', 'msg_1', { model: 'm', input: 10, output: 20 });
		const memento = new FakeMemento();
		const handle = createOpencodeIngest({
			globalState: memento,
			logPath: dir,
			pollIntervalMs: 60_000,
			allowedModels: [],
			fs: realFs(dir),
		});
		await handle.refresh();
		const seen = memento.get<{ version: number; seen: string[] }>(
			OPENCODE_INGEST_SEEN_KEY,
		);
		assert.ok(seen);
		assert.equal(seen.version, 1);
		assert.equal(seen.seen.length, 1);
		assert.equal(seen.seen[0], 'msg_1');
		handle.dispose();
	} finally {
		await fsp.rm(dir, { recursive: true, force: true });
	}
});

test('ingester: re-creating with the same memento resumes from the persisted seen set', async () => {
	const dir = await mkTmpDir();
	try {
		await writeMessage(dir, 'ses_a', 'msg_1', { model: 'm', input: 10, output: 20 });
		const memento = new FakeMemento();
		const h1 = createOpencodeIngest({
			globalState: memento,
			logPath: dir,
			pollIntervalMs: 60_000,
			allowedModels: [],
			fs: realFs(dir),
		});
		await h1.refresh();
		assert.equal(h1.store.read().total.requests, 1);
		h1.dispose();
		const h2 = createOpencodeIngest({
			globalState: memento,
			logPath: dir,
			pollIntervalMs: 60_000,
			allowedModels: [],
			fs: realFs(dir),
		});
		await h2.refresh();
		assert.equal(h2.store.read().total.requests, 1);
		h2.dispose();
	} finally {
		await fsp.rm(dir, { recursive: true, force: true });
	}
});

test('ingester: subscribe fires on every poll that lands data', async () => {
	const dir = await mkTmpDir();
	try {
		await writeMessage(dir, 'ses_a', 'msg_1', { model: 'm', input: 10, output: 20 });
		const handle = createOpencodeIngest({
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
		await writeMessage(dir, 'ses_a', 'msg_1', { model: 'm', input: 10, output: 20 });
		const handle = createOpencodeIngest({
			globalState: new FakeMemento(),
			logPath: dir,
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

test('ingester: status reports empty when no message files exist', async () => {
	const dir = await mkTmpDir();
	try {
		const handle = createOpencodeIngest({
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

test('ingester: per-day buckets use the message timestamp, not the wall clock', async () => {
	const dir = await mkTmpDir();
	try {
		await writeMessage(dir, 'ses_a', 'msg_1', {
			model: 'm',
			input: 1,
			output: 1,
			created: Date.UTC(2026, 5, 7),
		});
		await writeMessage(dir, 'ses_a', 'msg_2', {
			model: 'm',
			input: 2,
			output: 2,
			created: Date.UTC(2026, 5, 8),
		});
		await writeMessage(dir, 'ses_a', 'msg_3', {
			model: 'm',
			input: 3,
			output: 3,
			created: Date.UTC(2026, 5, 9),
		});
		const handle = createOpencodeIngest({
			globalState: new FakeMemento(),
			logPath: dir,
			pollIntervalMs: 60_000,
			allowedModels: [],
			fs: realFs(dir),
		});
		await handle.refresh();
		const stats = handle.store.read();
		assert.equal(stats.total.requests, 3, 'all three records must be counted');
		// The 5-day window returned by `readDailySeries(5)` is
		// anchored on today's local date, so the three fixture
		// dates are outside it and would zero out. Assert the
		// underlying `stats.daily` map directly — that's the
		// property we care about (line-anchored bucketing, not
		// wall-clock bucketing).
		const dailyKeys = Object.keys(stats.daily).sort();
		assert.deepEqual(
			dailyKeys,
			['2026-06-07', '2026-06-08', '2026-06-09'],
			'daily buckets should use the message timestamp, not the wall clock',
		);
		handle.dispose();
	} finally {
		await fsp.rm(dir, { recursive: true, force: true });
	}
});

test('ingester: store.reset() clears all in-memory stats and the seen set', async () => {
	const dir = await mkTmpDir();
	try {
		await writeMessage(dir, 'ses_a', 'msg_1', { model: 'm', input: 10, output: 20 });
		const handle = createOpencodeIngest({
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
		assert.equal(handle.status().filesTracked, 0);
		handle.dispose();
	} finally {
		await fsp.rm(dir, { recursive: true, force: true });
	}
});

test('ingester: dispose() is idempotent', async () => {
	const dir = await mkTmpDir();
	try {
		const handle = createOpencodeIngest({
			globalState: new FakeMemento(),
			logPath: dir,
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
		const handle = createOpencodeIngest({
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
		await writeMessage(dir, 'ses_a', 'msg_1', { model: 'm', input: 10, output: 20 });
		const memento = new FakeMemento();
		const handle = createOpencodeIngest({
			globalState: memento,
			logPath: dir,
			pollIntervalMs: 60_000,
			allowedModels: [],
			fs: realFs(dir),
		});
		await handle.refresh();
		const stats = memento.get(OPENCODE_USAGE_STATS_KEY);
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
		await writeMessage(dir, 'ses_a', 'msg_1', { model: 'MiniMax-M3', input: 100, output: 50 });
		await writeMessage(dir, 'ses_a', 'msg_2', { model: 'gpt-5', input: 200, output: 80 });
		await writeMessage(dir, 'ses_a', 'msg_3', { model: 'gpt-5-mini', input: 300, output: 90 });
		const handle = createOpencodeIngest({
			globalState: new FakeMemento(),
			logPath: dir,
			pollIntervalMs: 60_000,
			fs: realFs(dir),
			allowedModels: ['MiniMax-M3'],
		});
		await handle.refresh();
		const stats = handle.store.read();
		assert.equal(stats.total.requests, 1);
		assert.equal(stats.total.inputTokens, 100);
		assert.equal(stats.byModel['MiniMax-M3'].requests, 1);
		assert.equal(stats.byModel['gpt-5'], undefined);
		assert.equal(handle.status().skippedModels, 2);
		handle.dispose();
	} finally {
		await fsp.rm(dir, { recursive: true, force: true });
	}
});

test('ingester: empty allowedModels disables the filter (count every model)', async () => {
	const dir = await mkTmpDir();
	try {
		await writeMessage(dir, 'ses_a', 'msg_1', { model: 'MiniMax-M3', input: 10, output: 20 });
		await writeMessage(dir, 'ses_a', 'msg_2', { model: 'something-else', input: 5, output: 7 });
		const handle = createOpencodeIngest({
			globalState: new FakeMemento(),
			logPath: dir,
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
		await writeMessage(dir, 'ses_a', 'msg_1', { model: 'other-model', input: 1, output: 1 });
		const memento = new FakeMemento();
		const h1 = createOpencodeIngest({
			globalState: memento,
			logPath: dir,
			pollIntervalMs: 60_000,
			fs: realFs(dir),
			allowedModels: ['MiniMax-M3'],
		});
		await h1.refresh();
		assert.equal(h1.status().skippedModels, 1);
		h1.dispose();
		const h2 = createOpencodeIngest({
			globalState: memento,
			logPath: dir,
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

test('ingester: changing the allowlist resets the seen set so historical messages are re-evaluated', async () => {
	const dir = await mkTmpDir();
	try {
		await writeMessage(dir, 'ses_a', 'msg_m3', { model: 'MiniMax-M3', input: 10, output: 20 });
		await writeMessage(dir, 'ses_a', 'msg_other', { model: 'gpt-5', input: 5, output: 5 });
		const memento = new FakeMemento();
		const h1 = createOpencodeIngest({
			globalState: memento,
			logPath: dir,
			pollIntervalMs: 60_000,
			fs: realFs(dir),
			allowedModels: ['MiniMax-M3'],
		});
		await h1.refresh();
		assert.equal(h1.status().skippedModels, 1);
		const beforeStats = h1.store.read();
		assert.ok(beforeStats.byModel['MiniMax-M3'], 'M3 message counted under M3-only filter');
		assert.ok(!beforeStats.byModel['gpt-5'], 'non-MiniMax message not counted');
		h1.dispose();
		const h2 = createOpencodeIngest({
			globalState: memento,
			logPath: dir,
			pollIntervalMs: 60_000,
			fs: realFs(dir),
			allowedModels: ['MiniMax-M3', 'gpt-5'],
		});
		await h2.refresh();
		const afterStats = h2.store.read();
		assert.ok(
			afterStats.byModel['gpt-5'],
			'historical non-MiniMax message is now counted under the broader filter',
		);
		assert.ok(
			afterStats.byModel['MiniMax-M3'],
			'M3 message still counted after the allowlist expansion',
		);
		h2.dispose();
	} finally {
		await fsp.rm(dir, { recursive: true, force: true });
	}
});
