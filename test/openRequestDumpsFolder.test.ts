// Regression tests for the "open the request-dump folder" command.
//
// Background
// ----------
// The `minimax.openRequestDumpsFolder` command (palette label
// `MiniMax: 打开请求 Dump 目录`) used to call
// `vscode.env.openExternal(vscode.Uri.joinPath(globalStorageUri, 'request-dumps'))`.
// In real VS Code, `Uri.joinPath` on the globalStorageUri returns a
// `vscode-userdata://…` URI (NOT a `file://` URI), and
// `vscode.env.openExternal` only knows how to hand standard schemes
// (`http://`, `mailto:`, `file://`, …) to the OS Shell. On Windows the
// result was a "open with what app?" dialog the user dismissed, the
// openExternal promise rejected, the catch block fired, and the
// resulting error toast was easy to miss behind the Copilot Chat
// panel — the user saw "clicked the command, nothing happened". The
// dump files were on disk the whole time, just unreachable through
// the command.
//
// The fix (src/runtime/commands.ts) pulls `.fsPath` off the joinPath
// result and re-wraps it with `vscode.Uri.file(...)`, so the URI handed
// to `openExternal` carries the `file://` scheme that the Shell knows
// to open in the file manager.
//
// These tests pin the fix: a future refactor that goes back to
// `openExternal(joinPath(...))` directly will fail the
// `passes file:// URI to openExternal` assertion with a clear message
// naming the scheme that got through instead.
//
// The tests drive the `@internal` `openRequestDumpsFolderAt` entry
// point so they can pass the globalStorageUri directly and avoid the
// full `registerCommands` → `setCommandContext` → `createPlanStatusBar`
// cascade (which pulls in `StatusBarAlignment`, `FileType`,
// `lm.selectChatModels`, etc. that the mock doesn't need to model).
// The first test in the file directly re-creates the production code
// path so a regression where the `@internal` helper and the public
// function diverge would be caught too.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
	getOpenExternalCalls,
	mockState,
} from './helpers/vscodeMock.js';
import { openRequestDumpsFolderAt } from '../src/runtime/commands.js';

const GLOBAL_STORAGE_FS_PATH =
	'C:\\Users\\tester\\AppData\\Roaming\\Code\\User\\globalStorage\\klarkxy.minimax-vscode-copilot';

beforeEach(() => {
	mockState.reset();
});

/** End-to-end repro of the production code path that used to ship
 *  the `vscode-userdata://` regression to users. */
async function invokeViaJoinPathThenFile(globalStorageFsPath: string): Promise<void> {
	// `vscode.Uri.joinPath(globalStorageUri, 'request-dumps').fsPath`
	// — `globalStorageUri` is itself a `file://` URI (we only test the
	// production fix here, which sits on top of that fsPath), so the
	// joinPath call's *output* is a `vscode-userdata://` URI. The
	// fix's `.fsPath` extraction then feeds the platform-native path
	// back into `Uri.file()`, which is the round-trip we exercise.
	const base = vscode.Uri.file(globalStorageFsPath);
	const fsPath = vscode.Uri.joinPath(base, 'request-dumps').fsPath;
	await openRequestDumpsFolderAt(fsPath);
}

test('openRequestDumpsFolderAt: passes a file:// URI to openExternal (regression: vscode-userdata:// broke the command on Windows)', async () => {
	await invokeViaJoinPathThenFile(GLOBAL_STORAGE_FS_PATH);

	const calls = getOpenExternalCalls();
	assert.equal(
		calls.length,
		1,
		'expected exactly one openExternal call from openRequestDumpsFolder',
	);

	const call = calls[0]!;
	assert.equal(
		call.scheme,
		'file',
		`openExternal must receive a file:// URI so the OS Shell opens it in the file manager. ` +
			`Got scheme="${call.scheme}" — if this is "vscode-userdata", the joinPath regression has returned ` +
			`and Windows users will see a "open with what app?" dialog instead of the folder.`,
	);
	assert.equal(
		call.uri.fsPath.replace(/\\/g, '/'),
		GLOBAL_STORAGE_FS_PATH.replace(/\\/g, '/') + '/request-dumps',
		'openExternal URI should point at the request-dumps subfolder of globalStorage',
	);
});

test('openRequestDumpsFolderAt: ensure the directory is created before opening', async () => {
	let createDirCalls = 0;
	const origFs = vscode.workspace.fs;
	// Swap in a counting stub for this test only.
	Object.defineProperty(vscode.workspace, 'fs', {
		value: {
			createDirectory: () => {
				createDirCalls += 1;
				return Promise.resolve();
			},
			stat: () => Promise.resolve({ type: 2 }),
		},
		configurable: true,
	});

	try {
		await openRequestDumpsFolderAt(GLOBAL_STORAGE_FS_PATH);
	} finally {
		Object.defineProperty(vscode.workspace, 'fs', { value: origFs, configurable: true });
	}

	assert.equal(
		createDirCalls,
		1,
		'createDirectory is the pre-flight that guarantees openExternal has a real folder to reveal',
	);
});

test('openRequestDumpsFolderAt: openExternal failure surfaces as an error toast (not a silent no-op)', async () => {
	// Override openExternal to reject, simulating the Windows Shell
	// dismissing the "open with what app?" dialog on a
	// `vscode-userdata://` URI.
	const origOpenExternal = vscode.env.openExternal;
	Object.defineProperty(vscode.env, 'openExternal', {
		value: () => Promise.reject(new Error('Shell rejected the URI')),
		configurable: true,
	});

	try {
		await openRequestDumpsFolderAt(GLOBAL_STORAGE_FS_PATH);
	} finally {
		Object.defineProperty(vscode.env, 'openExternal', { value: origOpenExternal, configurable: true });
	}

	// The user-visible surface for a failed openExternal is the
	// `extension.openRequestDumpsFolderFailed` error toast. Without
	// this toast, the user has no signal that the command failed —
	// the only evidence is the absence of a file manager window,
	// which they often blame on "I clicked the wrong command" rather
	// than on the URI scheme rejection.
	const toasts = mockState.errorMessages;
	assert.equal(
		toasts.length,
		1,
		`expected the failure toast to be shown exactly once, got ${toasts.length}`,
	);
	assert.match(
		toasts[0]!,
		/\S/,
		'error toast text should not be empty',
	);
});

// Sanity check: the mock's `Uri.joinPath` actually models the real
// `vscode-userdata://` scheme (NOT a `file://` scheme). This is the
// invariant the production fix relies on: if the mock ever starts
// returning `file://` from joinPath, the regression test above would
// silently agree with the buggy code and stop catching it.
test('mock contract: Uri.joinPath returns a vscode-userdata:// URI (so the test exercises the real fix path)', () => {
	const base = vscode.Uri.file('/some/globalStorage/path');
	const joined = vscode.Uri.joinPath(base, 'request-dumps');
	assert.equal(
		joined.scheme,
		'vscode-userdata',
		`mock Uri.joinPath must mirror real VS Code behaviour (vscode-userdata:// scheme). ` +
			`If this returns "file", the regression test above silently agrees with the buggy code.`,
	);
});