// Unit tests for `src/client/error.ts`.
//
// The error module owns the user-facing / diagnostic split: an HTTP 401
// or a `ECONNREFUSED` should be translated into a localised
// `userSummary` plus a structured `diagnosticMessage` for the log
// channel. We test each path here.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	createHttpError,
	normalizeRequestError,
	createUserFacingError,
	MiniMaxRequestError,
} from '../src/client/error.js';

function makeResponse(status: number, body: string, statusText = ''): Response {
	return new Response(body, { status, statusText });
}

test('createHttpError: 401 carries kind=http and a non-empty user summary', async () => {
	const err = await createHttpError(makeResponse(401, '{"error":{"message":"bad key"}}'), 'https://api.example.com');
	assert.ok(err instanceof MiniMaxRequestError);
	assert.equal(err.kind, 'http');
	assert.equal(err.status, 401);
	assert.equal(err.code, 'HTTP_401');
	assert.ok(err.userSummary.length > 0, 'user summary is present');
	assert.equal(err.baseUrl, 'https://api.example.com');
	assert.match(err.diagnosticMessage, /status=401/);
	assert.match(err.diagnosticMessage, /serverMessage=bad key/);
});

test('createHttpError: 500 keeps the server message in the diagnostic', async () => {
	const err = await createHttpError(
		makeResponse(500, '<html>upstream is on fire</html>'),
		'https://api.example.com',
	);
	assert.equal(err.kind, 'http');
	assert.equal(err.status, 500);
	assert.match(err.diagnosticMessage, /status=500/);
	// Non-JSON bodies get folded into the `serverMessage` field, not a
	// separate `body=` field. We assert that path explicitly.
	assert.match(err.diagnosticMessage, /serverMessage=<html>upstream is on fire<\/html>/);
});

test('createHttpError: 400 with empty body still produces a useful diagnostic', async () => {
	const err = await createHttpError(makeResponse(400, ''), 'https://api.example.com');
	assert.equal(err.kind, 'http');
	assert.equal(err.status, 400);
	// Empty body should NOT add a "body=" or "serverMessage=" fragment.
	assert.ok(!err.diagnosticMessage.includes('body='), 'empty body is not appended');
	assert.ok(!err.diagnosticMessage.includes('serverMessage='), 'empty body has no serverMessage');
});

test('normalizeRequestError: passes through an existing MiniMaxRequestError', () => {
	const original = new MiniMaxRequestError({
		message: 'x',
		kind: 'http',
		status: 401,
	});
	const out = normalizeRequestError(original);
	assert.equal(out, original);
});

test('normalizeRequestError: non-Error value is wrapped', () => {
	const out = normalizeRequestError('boom');
	assert.ok(out instanceof MiniMaxRequestError);
	assert.equal((out as MiniMaxRequestError).kind, 'unknown');
	assert.match(out.message, /non-Error value: boom/);
});

test('normalizeRequestError: network error with code is upgraded to kind=network', () => {
	const inner = new Error('fetch failed');
	(inner as Error & { cause?: unknown }).cause = Object.assign(new Error('connect ECONNREFUSED'), {
		code: 'ECONNREFUSED',
	});
	const out = normalizeRequestError(inner);
	assert.ok(out instanceof MiniMaxRequestError);
	assert.equal((out as MiniMaxRequestError).kind, 'network');
	assert.equal((out as MiniMaxRequestError).code, 'ECONNREFUSED');
	assert.ok(out.userSummary.length > 0, 'network message is localised');
});

test('normalizeRequestError: plain Error without cause is returned unchanged', () => {
	const plain = new Error('boom');
	const out = normalizeRequestError(plain);
	// No cause → no MiniMaxRequestError wrapping; the original Error is
	// returned so the existing error flow keeps working.
	assert.equal(out, plain);
});

test('createUserFacingError: MiniMaxRequestError gets a Markdown summary without stray backslashes', () => {
	// Regression: a previous version of `formatMarkdownMessage` emitted
	// literal `\\` characters between the summary and the action links,
	// which rendered as two backslashes in the chat. The fix uses a
	// single newline.
	const err = new MiniMaxRequestError({
		message: 'HTTP 401',
		userSummary: 'MiniMax API request failed with HTTP 401',
		kind: 'http',
		status: 401,
		baseUrl: 'https://api.example.com',
	});
	const display = createUserFacingError(err);
	// No literal double-backslash in the user-facing string.
	assert.ok(!display.message.includes('\\\\'), `unexpected \\\\ in: ${display.message}`);
	// The summary is wrapped in **...** by the formatter.
	assert.match(display.message, /\*\*MiniMax API request failed with HTTP 401\*\*/);
	// And the action links follow on a new paragraph, not on the same line.
	assert.match(display.message, /\*\*MiniMax API request failed with HTTP 401\*\*\n\n\*\*\[/);
});

test('createUserFacingError: literal asterisks in the summary are escaped', () => {
	// i18n summaries may contain a `*` (e.g. "*foo*" inside a translated
	// string). Without escaping, the surrounding `**...**` would split
	// the bold marker. The Markdown-escape converts every literal `*`
	// to `\*`, which is rendered as a literal asterisk in chat.
	const err = new MiniMaxRequestError({
		message: 'test',
		userSummary: 'prefix *suffix*',
		kind: 'http',
		status: 500,
		baseUrl: 'https://api.example.com',
	});
	const display = createUserFacingError(err);
	assert.match(display.message, /\\\*suffix\\\*/);
});

test('createUserFacingError: plain Error is rendered as plain text', () => {
	const err = new Error('something broke');
	const display = createUserFacingError(err);
	assert.equal(display.message, 'something broke');
	assert.equal(display.stack, undefined, 'we do not leak the original stack to the chat');
});
