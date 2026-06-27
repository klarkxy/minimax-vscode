// Unit tests for `src/provider/terminalEnvironment.ts`.
//
// The helpers that compose system-prompt / tool-description text
// are pure and testable. The `getTerminalEnvironmentDescription`
// function reads from `vscode.window.activeTerminal` and the
// user's terminal config, both of which the vscode mock can
// supply.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';

import {
	appendTerminalGuidanceToSystemPrompt,
	appendTerminalGuidanceToToolDescription,
	buildTerminalGuidance,
} from '../src/provider/terminalEnvironment.js';
import { mockConfig } from './helpers/vscodeMock.js';

beforeEach(() => {
	// Clear the active terminal and the relevant config keys between
	// tests so each test starts from a known state.
	(vscode.window as unknown as { activeTerminal: unknown }).activeTerminal = undefined;
	for (const key of [
		'terminal.integrated.defaultProfile.windows',
		'terminal.integrated.defaultProfile.linux',
		'terminal.integrated.defaultProfile.osx',
		'terminal.integrated.automationProfile.windows',
		'terminal.integrated.automationProfile.linux',
		'terminal.integrated.automationProfile.osx',
		'terminal.integrated.automationShell.windows',
		'terminal.integrated.automationShell.linux',
		'terminal.integrated.automationShell.osx',
	]) {
		try {
			vscode.workspace.getConfiguration('terminal.integrated').update(key, undefined);
		} catch {
			// mock may not support `update(undefined)` — ignore.
		}
	}
});

// ---- appendTerminalGuidanceToSystemPrompt -------------------------

test('appendTerminalGuidanceToSystemPrompt: returns the guidance when the system prompt is undefined', () => {
	assert.equal(
		appendTerminalGuidanceToSystemPrompt(undefined, 'TERMINAL GUIDANCE'),
		'TERMINAL GUIDANCE',
	);
});

test('appendTerminalGuidanceToSystemPrompt: returns the system prompt when the guidance is undefined', () => {
	assert.equal(
		appendTerminalGuidanceToSystemPrompt('hello', undefined),
		'hello',
	);
});

test('appendTerminalGuidanceToSystemPrompt: appends with a blank-line separator', () => {
	const out = appendTerminalGuidanceToSystemPrompt('You are helpful.', 'TERMINAL GUIDANCE');
	assert.equal(out, 'You are helpful.\n\nTERMINAL GUIDANCE');
});

test('appendTerminalGuidanceToSystemPrompt: idempotent — second call is a no-op', () => {
	// The detector looks for the literal TERMINAL_GUIDANCE_PREFIX
	// ("The user's terminal environment is") inside the existing
	// system prompt. Use a guidance string that contains it.
	const guidance = "The user's terminal environment is bash. Use POSIX shell syntax.";
	const first = appendTerminalGuidanceToSystemPrompt('You are helpful.', guidance);
	const second = appendTerminalGuidanceToSystemPrompt(first, guidance);
	assert.equal(second, first);
});

test('appendTerminalGuidanceToSystemPrompt: detects a pre-existing guidance and skips', () => {
	// A system prompt that already contains the guidance prefix
	// should be returned unchanged rather than double-appended.
	const seeded = 'You are helpful.\n\nThe user\'s terminal environment is bash.';
	const out = appendTerminalGuidanceToSystemPrompt(seeded, 'The user\'s terminal environment is zsh.');
	assert.equal(out, seeded);
});

// ---- appendTerminalGuidanceToToolDescription ----------------------

test('appendTerminalGuidanceToToolDescription: mirrors the system-prompt logic', () => {
	const out = appendTerminalGuidanceToToolDescription('read a file', 'TERMINAL GUIDANCE');
	assert.equal(out, 'read a file\n\nTERMINAL GUIDANCE');
	assert.equal(
		appendTerminalGuidanceToToolDescription('read a file', undefined),
		'read a file',
	);
	assert.equal(
		appendTerminalGuidanceToToolDescription(undefined, 'TERMINAL GUIDANCE'),
		'TERMINAL GUIDANCE',
	);
});

// ---- buildTerminalGuidance ---------------------------------------

test('buildTerminalGuidance: returns undefined when there is no active terminal and no config', () => {
	assert.equal(buildTerminalGuidance(), undefined);
});

test('buildTerminalGuidance: returns the active terminal name when set', () => {
	(vscode.window as unknown as { activeTerminal: { name: string } }).activeTerminal = {
		name: 'bash',
	};
	const out = buildTerminalGuidance();
	assert.ok(out?.includes('bash'));
	assert.match(out!, /^The user/);
});

test('buildTerminalGuidance: strips local paths from the shellPath', () => {
	// Shell paths on Windows look like `C:\\WINDOWS\\System32\\cmd.exe`.
	// `extractShellName` takes the basename, drops the extension, and
	// `toKnownShellLabel` maps "cmd" to "Command Prompt".
	(vscode.window as unknown as { activeTerminal: { shellPath: string; name: string } }).activeTerminal = {
		shellPath: 'C:\\WINDOWS\\System32\\cmd.exe',
		name: 'irrelevant',
	};
	const out = buildTerminalGuidance();
	assert.ok(out?.includes('Command Prompt'));
	assert.ok(!out?.includes('C:\\\\'));
});

test('buildTerminalGuidance: returns the defaultProfile from config when no active terminal', () => {
	(vscode.window as unknown as { activeTerminal: unknown }).activeTerminal = undefined;
	const suffix =
		process.platform === 'win32' ? 'windows' :
		process.platform === 'darwin' ? 'osx' : 'linux';
	// The vscode mock's `workspace.getConfiguration().update` is a
	// no-op, so seed the config map directly.
	mockConfig[`terminal.integrated.defaultProfile.${suffix}`] = 'zsh';
	const out = buildTerminalGuidance();
	assert.ok(out?.includes('zsh'));
});
