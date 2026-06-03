// Unit tests for the mmx-cli detection / install helpers.
//
// We don't actually shell out to npm / npx / mmx in tests — the
// helpers in src/dashboard/mmxCli.ts use `node:child_process` and
// are tested indirectly by running the unit-test sandbox where
// `mmx` is not on PATH (so the "missing" branch is the canonical
// result we assert on).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	candidateSkillDirs,
	extractVersion,
	readMmxCliStatus,
	readMmxSkillState,
	readMmxVersion,
} from '../src/dashboard/mmxCli.js';

test('extractVersion: pulls X.Y.Z out of --version output', () => {
	assert.equal(extractVersion('mmx 1.2.3'), '1.2.3');
	assert.equal(extractVersion('1.4.0-beta.2\n'), '1.4.0-beta.2');
	assert.equal(extractVersion('version 0.0.1+build.4'), '0.0.1+build.4');
});

test('extractVersion: falls back to the first line when no semver token', () => {
	assert.equal(extractVersion('mmx (development)'), 'mmx (development)');
	assert.equal(extractVersion(''), null);
});

test('candidateSkillDirs: returns the standard install locations', () => {
	const dirs = candidateSkillDirs('/home/test');
	// Use path.join to build the expected values so the assertion is
	// platform-agnostic (path.join uses backslashes on Windows).
	const expected = [
		join('/home/test', '.claude', 'skills', 'minimax-cli'),
		join('/home/test', '.copilot', 'skills', 'minimax-cli'),
		join('/home/test', '.mmx', 'skills', 'minimax-cli'),
	];
	assert.deepEqual(dirs, expected);
});

test('readMmxSkillState: missing when no SKILL.md is present', async () => {
	const home = mkdtempSync(join(tmpdir(), 'mmx-test-'));
	try {
		const state = await readMmxSkillState(home);
		assert.equal(state, 'missing');
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test('readMmxSkillState: installed when SKILL.md exists in any candidate', async () => {
	const home = mkdtempSync(join(tmpdir(), 'mmx-test-'));
	try {
		// Drop a SKILL.md in the first candidate and confirm we find it.
		const target = join(home, '.claude', 'skills', 'minimax-cli');
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, 'SKILL.md'), '# test');
		const state = await readMmxSkillState(home);
		assert.equal(state, 'installed');
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test('readMmxSkillState: installed also matches the .copilot location', async () => {
	const home = mkdtempSync(join(tmpdir(), 'mmx-test-'));
	try {
		const target = join(home, '.copilot', 'skills', 'minimax-cli');
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, 'SKILL.md'), '# test');
		const state = await readMmxSkillState(home);
		assert.equal(state, 'installed');
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test('readMmxVersion: returns null when mmx is not on PATH', async () => {
	// In the test sandbox mmx is not installed; execFile rejects with
	// ENOENT and readMmxVersion should return null (not throw).
	const version = await readMmxVersion('mmx-definitely-not-on-path');
	assert.equal(version, null);
});

test('readMmxCliStatus: missing install + notInstalled auth in the test sandbox', async () => {
	const status = await readMmxCliStatus();
	// We're running under Node test runner without `mmx` on PATH.
	assert.equal(status.install, 'missing');
	assert.equal(status.binPath, null);
	assert.equal(status.auth, 'notInstalled');
	assert.equal(status.agentReady, false);
});
