// Unit tests for the mmx-cli detection helpers + the official
// install prompt helper.
//
// The detection functions shell out to `where mmx` (Windows) /
// `which mmx` (POSIX) and to `mmx auth status` / `mmx --version`.
// In the test sandbox `mmx` is not on PATH, so the "missing" branch
// is the canonical result we assert on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	candidateSkillDirs,
	extractVersion,
	mmxInstallPrompt,
	readMmxCliStatus,
	readMmxSkillState,
	readMmxVersion,
} from '../src/dashboard/mmxCli.js';

// --- extractVersion ---------------------------------------------------

test('extractVersion: pulls X.Y.Z out of --version output', () => {
	assert.equal(extractVersion('mmx 1.2.3'), '1.2.3');
	assert.equal(extractVersion('1.4.0-beta.2\n'), '1.4.0-beta.2');
	assert.equal(extractVersion('version 0.0.1+build.4'), '0.0.1+build.4');
});

test('extractVersion: falls back to the first line when no semver token', () => {
	assert.equal(extractVersion('mmx (development)'), 'mmx (development)');
	assert.equal(extractVersion(''), null);
});

// --- candidateSkillDirs -----------------------------------------------

test('candidateSkillDirs: returns the standard install locations', () => {
	const dirs = candidateSkillDirs('/home/test');
	// path.join uses backslashes on Windows; build the expected list
	// the same way so the assertion is platform-agnostic.
	const expected = [
		join('/home/test', '.claude', 'skills', 'minimax-cli'),
		join('/home/test', '.copilot', 'skills', 'minimax-cli'),
		join('/home/test', '.mmx', 'skills', 'minimax-cli'),
	];
	assert.deepEqual(dirs, expected);
});

// --- readMmxSkillState -----------------------------------------------

test('readMmxSkillState: missing when no SKILL.md is present', async () => {
	const home = mkdtempSync(join(tmpdir(), 'mmx-test-'));
	try {
		const state = await readMmxSkillState(home);
		assert.equal(state, 'missing');
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test('readMmxSkillState: installed when SKILL.md exists in .claude/', async () => {
	const home = mkdtempSync(join(tmpdir(), 'mmx-test-'));
	try {
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

// --- readMmxVersion / readMmxCliStatus --------------------------------

test('readMmxVersion: returns null when mmx is not on PATH', async () => {
	// In the test sandbox mmx is not installed; execFile rejects
	// with ENOENT and readMmxVersion should return null (not throw).
	const version = await readMmxVersion('mmx-definitely-not-on-path');
	assert.equal(version, null);
});

test('readMmxCliStatus: shape is well-formed in the test sandbox', async () => {
	const status = await readMmxCliStatus();
	// The CI sandbox may or may not have mmx installed depending on
	// the host machine, so we don't assert a specific install state.
	// We do assert the shape: every field is one of the documented
	// values, and agentReady is the correct boolean for the rest.
	const installStates: ReadonlyArray<typeof status.install> = [
		'unknown',
		'installed',
		'missing',
	];
	assert.ok(installStates.includes(status.install), `unexpected install=${status.install}`);
	assert.equal(typeof status.version === 'string' || status.version === null, true);
	assert.equal(typeof status.binPath === 'string' || status.binPath === null, true);
	if (status.install === 'installed') {
		assert.ok(status.binPath, 'binPath should be set when install=installed');
	} else {
		// When not installed, auth has to be notInstalled — the
		// dashboard relies on this to skip the auth probe.
		assert.equal(status.auth, 'notInstalled');
	}
	assert.equal(typeof status.agentReady, 'boolean');
	// agentReady implies install=installed + auth=loggedIn + skill=installed
	if (status.agentReady) {
		assert.equal(status.install, 'installed');
		assert.equal(status.auth, 'loggedIn');
		assert.equal(status.skill, 'installed');
	}
});

// --- mmxInstallPrompt (locale-aware) ----------------------------------

test('mmxInstallPrompt(china): returns the Chinese prompt', () => {
	const p = mmxInstallPrompt('china');
	// Step 1 - npm install.
	assert.match(p, /npm install -g mmx-cli/);
	// Step 2 - mmx auth login with the placeholder key.
	assert.match(p, /mmx auth login --api-key sk-xxxxx/);
	// Step 3 - the official SKILL slug.
	assert.match(p, /MiniMax-AI\/cli/);
	// The Chinese version uses Chinese connective phrasing.
	assert.match(p, /请帮我接入|全局安装|登录并配置|安装官方 SKILL/);
});

test('mmxInstallPrompt(global): returns the English prompt', () => {
	const p = mmxInstallPrompt('global');
	// Same canonical three steps.
	assert.match(p, /npm install -g mmx-cli/);
	assert.match(p, /mmx auth login --api-key sk-xxxxx/);
	assert.match(p, /MiniMax-AI\/cli/);
	// The English version uses English connectives.
	assert.match(p, /Globally install the CLI/);
	assert.match(p, /Login and configure the API Key/);
	assert.match(p, /Install the official SKILL/);
});

test('mmxInstallPrompt: never contains a real-looking key', () => {
	for (const host of ['china', 'global'] as const) {
		const p = mmxInstallPrompt(host);
		// The prompt should only have the literal `sk-xxxxx`
		// placeholder in the auth step. Any other `sk-` token of
		// meaningful length is a leak.
		const matches = p.match(/sk-[A-Za-z0-9_-]{4,}/g) ?? [];
		for (const m of matches) {
			assert.equal(m, 'sk-xxxxx', `unexpected key-like token in ${host} prompt: ${m}`);
		}
	}
});

test('mmxInstallPrompt: default locale is global (English)', () => {
	const defaultPrompt = mmxInstallPrompt();
	const explicitGlobal = mmxInstallPrompt('global');
	assert.equal(defaultPrompt, explicitGlobal);
});
