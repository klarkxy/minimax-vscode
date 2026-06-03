// Unit tests for the mmx-cli detection helpers + the official
// install prompt helper.
//
// The detection functions shell out to `where mmx` (Windows) /
// `which mmx` (POSIX) and to `mmx auth status` / `mmx --version`.
// In the test sandbox `mmx` may or may not be on PATH, so the
// tests only assert on the shape and the prompt content.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	candidateSkillDirs,
	extractVersion,
	mmxInstallPrompt,
	parseAuthStatusText,
	readMmxAuthState,
	readMmxCliStatus,
	readMmxConfigAuth,
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

test('candidateSkillDirs: returns the canonical install locations (mmx-cli slug)', () => {
	const home = '/home/test';
	const dirs = candidateSkillDirs(home);
	// Use path.join to build the expected values so the assertion is
	// platform-agnostic (path.join uses backslashes on Windows).
	// We assert membership rather than full equality so adding more
	// candidate dirs in the future doesn't break this test.
	const expected = [
		join(home, '.agents', 'skills', 'mmx-cli'),
		join(home, '.copilot', 'skills', 'mmx-cli'),
		join(home, '.mmx', 'skills', 'mmx-cli'),
	];
	for (const e of expected) {
		assert.ok(dirs.includes(e), `expected ${e} in candidateSkillDirs output`);
	}
});

// --- readMmxSkillState -----------------------------------------------

test('readMmxSkillState: returns installed when SKILL.md exists in .agents/skills/mmx-cli', async () => {
	const home = mkdtempSync(join(tmpdir(), 'mmx-test-'));
	try {
		const target = join(home, '.agents', 'skills', 'mmx-cli');
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, 'SKILL.md'), '# test');
		assert.ok(statSync(join(target, 'SKILL.md')).isFile(), 'sanity: file should exist on disk');
		const state = await readMmxSkillState(home);
		assert.equal(state, 'installed');
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test('readMmxSkillState: returns installed when SKILL.md exists in .copilot/skills/mmx-cli', async () => {
	const home = mkdtempSync(join(tmpdir(), 'mmx-test-'));
	try {
		const target = join(home, '.copilot', 'skills', 'mmx-cli');
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, 'SKILL.md'), '# test');
		const state = await readMmxSkillState(home);
		assert.equal(state, 'installed');
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test('readMmxSkillState: returns missing when no candidate dir has a SKILL.md', async () => {
	const home = mkdtempSync(join(tmpdir(), 'mmx-test-'));
	try {
		const state = await readMmxSkillState(home);
		assert.equal(state, 'missing');
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

// --- parseAuthStatusText (pure parser) -------------------------------

test('parseAuthStatusText: recognises the mmx ≥ 1.0 status block', () => {
	// The exact output format the dashboard encounters in the wild on
	// mmx-cli 1.0.16 — the auth probe was silently failing on this
	// because the regex didn't allow `.` inside the masked key token.
	const text = [
		'Authentication Status:',
		'  Method: api-key',
		'  Source: config.json',
		'  Key:    sk-c...4fB4',
		'Fetching quota snapshot...',
		'<… quota panel …>',
	].join('\n');
	assert.equal(parseAuthStatusText(text), 'loggedIn');
});

test('parseAuthStatusText: recognises OAuth method as logged in', () => {
	assert.equal(parseAuthStatusText('Method: oauth\nKey: ••••••'), 'loggedIn');
});

test('parseAuthStatusText: returns loggedOut for the negative markers', () => {
	for (const snippet of [
		'not logged in',
		'Error: no api key configured',
		'401 unauthorized',
		'Not authenticated. Run `mmx auth login`.',
	]) {
		assert.equal(parseAuthStatusText(snippet), 'loggedOut', `snippet: ${snippet}`);
	}
});

test('parseAuthStatusText: returns unknown for empty / unrelated text', () => {
	assert.equal(parseAuthStatusText(''), 'unknown');
	assert.equal(parseAuthStatusText('hello world'), 'unknown');
});

// --- readMmxConfigAuth (fast file-based path) ------------------------

test('readMmxConfigAuth: returns loggedIn when ~/.mmx/config.json has api_key', async () => {
	const home = mkdtempSync(join(tmpdir(), 'mmx-auth-'));
	try {
		mkdirSync(join(home, '.mmx'), { recursive: true });
		writeFileSync(
			join(home, '.mmx', 'config.json'),
			JSON.stringify({ region: 'cn', api_key: 'sk-test-abcdef1234' }),
		);
		const result = await readMmxConfigAuth(home);
		assert.equal(result.state, 'loggedIn');
		assert.ok(result.detail?.includes('config.json'));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test('readMmxConfigAuth: returns loggedOut when config has no api_key', async () => {
	const home = mkdtempSync(join(tmpdir(), 'mmx-auth-'));
	try {
		mkdirSync(join(home, '.mmx'), { recursive: true });
		writeFileSync(
			join(home, '.mmx', 'config.json'),
			JSON.stringify({ region: 'cn' }),
		);
		const result = await readMmxConfigAuth(home);
		assert.equal(result.state, 'loggedOut');
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test('readMmxConfigAuth: returns loggedOut when api_key is empty string', async () => {
	const home = mkdtempSync(join(tmpdir(), 'mmx-auth-'));
	try {
		mkdirSync(join(home, '.mmx'), { recursive: true });
		writeFileSync(
			join(home, '.mmx', 'config.json'),
			JSON.stringify({ api_key: '   ' }),
		);
		const result = await readMmxConfigAuth(home);
		assert.equal(result.state, 'loggedOut');
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test('readMmxConfigAuth: returns unknown when config file is missing', async () => {
	const home = mkdtempSync(join(tmpdir(), 'mmx-auth-'));
	try {
		// Don't create .mmx/ at all
		const result = await readMmxConfigAuth(home);
		assert.equal(result.state, 'unknown');
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test('readMmxConfigAuth: returns unknown when config file is malformed JSON', async () => {
	const home = mkdtempSync(join(tmpdir(), 'mmx-auth-'));
	try {
		mkdirSync(join(home, '.mmx'), { recursive: true });
		writeFileSync(join(home, '.mmx', 'config.json'), '{not valid json');
		const result = await readMmxConfigAuth(home);
		assert.equal(result.state, 'unknown');
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test('readMmxAuthState: prefers config.json over shelling out to mmx', async () => {
	// With a valid config.json, the function should return loggedIn
	// without ever spawning `mmx auth status` (which would also run
	// a full quota fetch — the slowness bug we're fixing). We
	// assert the result; the no-network property is implicit from
	// the fact that the fast path is just a file read.
	const home = mkdtempSync(join(tmpdir(), 'mmx-auth-'));
	try {
		mkdirSync(join(home, '.mmx'), { recursive: true });
		writeFileSync(
			join(home, '.mmx', 'config.json'),
			JSON.stringify({ api_key: 'sk-test-1234567890' }),
		);
		// mmxPath='mmx' would never be reached because the fast path
		// returns first, but we pass it for type signature reasons.
		const result = await readMmxAuthState('mmx', home);
		assert.equal(result.state, 'loggedIn');
		assert.ok(result.detail?.includes('config.json'));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

// --- readMmxVersion / readMmxCliStatus --------------------------------

test('readMmxVersion: returns null when the given path is not on PATH', async () => {
	// In the test sandbox the resolver might or might not find mmx
	// depending on the host. We assert that the call doesn't throw;
	// a non-null return is fine too (the user may have mmx installed
	// globally on their dev box).
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
	assert.match(p, /npm install -g mmx-cli/);
	assert.match(p, /mmx auth login --api-key sk-xxxxx/);
	assert.match(p, /MiniMax-AI\/cli/);
	// The Chinese version uses Chinese connective phrasing.
	assert.match(p, /请帮我接入|全局安装|登录并配置|安装官方 SKILL/);
});

test('mmxInstallPrompt(global): returns the English prompt', () => {
	const p = mmxInstallPrompt('global');
	assert.match(p, /npm install -g mmx-cli/);
	assert.match(p, /mmx auth login --api-key sk-xxxxx/);
	assert.match(p, /MiniMax-AI\/cli/);
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
