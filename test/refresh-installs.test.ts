// Unit tests for the marketplace install-count chart script.
// Run via `node esbuild.tests.mjs && node --test out-test/refresh-installs.test.js`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	appendPoint,
	renderMermaid,
	updateReadme,
	loadHistory,
} from '../scripts/refresh-installs.mjs';

test('renderMermaid returns a placeholder when history is empty', () => {
	const out = renderMermaid([]);
	assert.match(out, /No data yet/);
	assert.doesNotMatch(out, /mermaid/);
});

test('renderMermaid produces a valid xychart for a single point', () => {
	const out = renderMermaid([{ date: '2026-06-12', install: 528 }]);
	assert.match(out, /```mermaid\nxychart-beta/);
	assert.match(out, /x-axis \[2026-06-12\]/);
	assert.match(out, /line \[528\]/);
	// y-axis max should be ceil(528 * 1.1) = 581
	assert.match(out, /y-axis "Installs" 0 --> 581/);
});

test('renderMermaid rounds y-axis up to 110% of max for multiple points', () => {
	const out = renderMermaid([
		{ date: '2026-06-10', install: 100 },
		{ date: '2026-06-11', install: 200 },
		{ date: '2026-06-12', install: 500 },
	]);
	// y-axis max should be ceil(500 * 1.1) = 550
	assert.match(out, /y-axis "Installs" 0 --> 550/);
	assert.match(out, /x-axis \[2026-06-10, 2026-06-11, 2026-06-12\]/);
	assert.match(out, /line \[100, 200, 500\]/);
});

test('renderMermaid clamps y-axis to at least 10 when counts are tiny', () => {
	const out = renderMermaid([{ date: '2026-06-12', install: 1 }]);
	assert.match(out, /y-axis "Installs" 0 --> 11/);
});

test('appendPoint pushes a new point on a new day', () => {
	const h: Array<{ date: string; install: number }> = [
		{ date: '2026-06-10', install: 100 },
	];
	appendPoint(h, { date: '2026-06-11', install: 200 });
	assert.deepEqual(h, [
		{ date: '2026-06-10', install: 100 },
		{ date: '2026-06-11', install: 200 },
	]);
});

test('appendPoint overwrites in place on the same day', () => {
	const h: Array<{ date: string; install: number }> = [
		{ date: '2026-06-10', install: 100 },
	];
	appendPoint(h, { date: '2026-06-10', install: 150 });
	assert.deepEqual(h, [{ date: '2026-06-10', install: 150 }]);
	assert.equal(h.length, 1);
});

test('updateReadme replaces the marker block in place', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'installs-test-'));
	const file = join(dir, 'README.md');
	await writeFile(
		file,
		[
			'# Title',
			'',
			'<!-- installs:start -->',
			'old content',
			'<!-- installs:end -->',
			'',
			'## Footer',
			'',
		].join('\n'),
	);
	const r = await updateReadme(file, [{ date: '2026-06-12', install: 528 }]);
	assert.equal(r.updated, true);
	const after = await readFile(file, 'utf8');
	assert.match(after, /xychart-beta/);
	assert.match(after, /line \[528\]/);
	assert.doesNotMatch(after, /old content/);
	// Content outside the markers should be untouched.
	assert.match(after, /^# Title\n/);
	assert.match(after, /\n## Footer\n?$/);
	await rm(dir, { recursive: true, force: true });
});

test('updateReadme returns skipped when markers are missing', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'installs-test-'));
	const file = join(dir, 'README.md');
	await writeFile(file, '# No markers here\n');
	const r = await updateReadme(file, [{ date: '2026-06-12', install: 528 }]);
	assert.equal(r.updated, false);
	assert.match(r.reason ?? '', /markers not found/);
	await rm(dir, { recursive: true, force: true });
});

test('loadHistory returns [] when the file is missing', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'installs-test-'));
	const missing = join(dir, 'no-such.json');
	const h = await loadHistory(missing);
	assert.deepEqual(h, []);
	await rm(dir, { recursive: true, force: true });
});

test('loadHistory returns the parsed array when the file exists', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'installs-test-'));
	const file = join(dir, 'installs.json');
	await writeFile(file, JSON.stringify([{ date: '2026-06-10', install: 100 }]));
	const h = await loadHistory(file);
	assert.deepEqual(h, [{ date: '2026-06-10', install: 100 }]);
	await rm(dir, { recursive: true, force: true });
});
