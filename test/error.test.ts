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
	//
	// The base URL is a recognised MiniMax international endpoint so
	// the action link is rendered (an unrecognised URL now suppresses
	// the platform link entirely — see the "third-party proxy → no
	// platform link" test).
	const err = new MiniMaxRequestError({
		message: 'HTTP 401',
		userSummary: 'MiniMax API request failed with HTTP 401',
		kind: 'http',
		status: 401,
		baseUrl: 'https://api.minimax.io/anthropic',
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

// ---- Issue #2 regression: 402 surfaces upstream type + request_id --------
//
// The MiniMax international gateway returns 402 for Token Plan keys used
// on the Anthropic-compatible surface, with a body shape like
// `{ type: "error", error: { type: "insufficient_balance_error",
//   message: "insufficient balance (1008)" }, request_id: "06747ff0…" }`.
// The previous code re-serialised the SDK error and dropped both
// `error.type` and `request_id` — the user only saw a generic
// "Insufficient balance. Please renew your subscription." toast with
// nothing to quote when contacting support. These tests pin the new
// contract.

test('createHttpError: 402 from MiniMax preserves error.type and request_id on the error object', async () => {
	// The exact body shape from issue #2. Verbatim.
	const body = JSON.stringify({
		type: 'error',
		error: {
			type: 'insufficient_balance_error',
			message: 'insufficient balance (1008)',
		},
		request_id: '06747ff086b4d8dbe7fdb3f4539c41b3',
	});
	const err = await createHttpError(
		makeResponse(402, body),
		'https://api.minimax.io/anthropic',
	);
	assert.ok(err instanceof MiniMaxRequestError);
	assert.equal(err.status, 402);
	assert.equal(err.serverErrorType, 'insufficient_balance_error');
	assert.equal(err.serverRequestId, '06747ff086b4d8dbe7fdb3f4539c41b3');
	// The diagnostic channel captures both fields so the "MiniMax: Show
	// Logs" output and the request-dump writer have enough context to
	// reproduce the issue.
	assert.match(err.diagnosticMessage, /serverErrorType=insufficient_balance_error/);
	assert.match(err.diagnosticMessage, /serverRequestId=06747ff086b4d8dbe7fdb3f4539c41b3/);
	assert.match(err.diagnosticMessage, /serverMessage=insufficient balance \(1008\)/);
});

test('createHttpError: 402 toast mentions the configured endpoint host', async () => {
	// The international user reports the bug. The base URL we're
	// calling has `api.minimax.io`, so the toast should reference
	// that host — not the hard-coded `api.minimaxi.com` the previous
	// implementation rendered for everyone.
	const body = JSON.stringify({
		type: 'error',
		error: { type: 'insufficient_balance_error', message: 'insufficient balance (1008)' },
		request_id: '06747ff0',
	});
	const err = await createHttpError(
		makeResponse(402, body),
		'https://api.minimax.io/anthropic',
	);
	assert.match(err.userSummary, /api\.minimax\.io/);
	assert.ok(!err.userSummary.includes('api.minimaxi.com'), 'should not mention the China host');
});

test('createHttpError: 402 toast includes the upstream detail when present', async () => {
	const body = JSON.stringify({
		type: 'error',
		error: { type: 'insufficient_balance_error', message: 'insufficient balance (1008)' },
		request_id: '06747ff086b4d8dbe7fdb3f4539c41b3',
	});
	const err = await createHttpError(
		makeResponse(402, body),
		'https://api.minimax.io/anthropic',
	);
	// The toast text should mention both the error type and the
	// request_id — these are the fields the user can quote to MiniMax
	// support to get a concrete answer.
	assert.match(err.userSummary, /insufficient_balance_error/);
	assert.match(err.userSummary, /insufficient balance \(1008\)/);
	assert.match(err.userSummary, /request_id=06747ff086b4d8dbe7fdb3f4539c41b3/);
});

test('createHttpError: 402 toast still surfaces the raw body when the body is non-JSON', async () => {
	// The gateway in front of MiniMax (nginx, an LB) might return an
	// HTML error page instead of a JSON envelope. We can't parse out
	// the structured fields, but the raw text is still useful for
	// debugging — show it in the upstream segment rather than dropping
	// it on the floor.
	const err = await createHttpError(
		makeResponse(402, '<html>nginx 502</html>'),
		'https://api.minimax.io/anthropic',
	);
	assert.equal(err.serverErrorType, undefined);
	assert.equal(err.serverRequestId, undefined);
	assert.match(err.userSummary, /Upstream: <html>nginx 502<\/html>/);
});

test('createHttpError: 401 also surfaces the upstream type and request_id', async () => {
	const body = JSON.stringify({
		type: 'error',
		error: { type: 'authentication_error', message: 'invalid x-api-key' },
		request_id: 'abc123',
	});
	const err = await createHttpError(
		makeResponse(401, body),
		'https://api.minimax.io/anthropic',
	);
	assert.equal(err.serverErrorType, 'authentication_error');
	assert.equal(err.serverRequestId, 'abc123');
	assert.match(err.userSummary, /api\.minimax\.io/);
});

test('createHttpError: action-button host follows the configured baseUrl', async () => {
	// The 401/402 "Create API Key" / "Set API Key" action buttons used
	// to always point at platform.minimaxi.com — sending international
	// users to the China platform. After the fix, the host follows
	// the configured `minimax.apiBaseUrl`, AND the URL is the real
	// *platform* host (`platform.minimax.io`, not `api.minimax.io`).
	// The previous fix shipped a regression that produced
	// `https://platform.api.minimax.io/...` — an invalid hostname —
	// because the API host was being pasted into the platform URL
	// template. This test pins the corrected URL exactly.
	const body = JSON.stringify({
		type: 'error',
		error: { type: 'insufficient_balance_error', message: 'oops' },
	});
	const err402 = await createHttpError(
		makeResponse(402, body),
		'https://api.minimax.io/anthropic',
	);
	const display = createUserFacingError(err402);
	// The exact platform URL the user is sent to. The /user-center/
	// payment/token-plan suffix is the same on both regions.
	assert.match(
		display.message,
		/https:\/\/platform\.minimax\.io\/user-center\/payment\/token-plan/,
		`expected the 402 action link to point at platform.minimax.io, got: ${display.message}`,
	);
	// And the regression we shipped before must NOT appear:
	// `https://platform.api.minimax.io` was the invalid hostname.
	assert.ok(
		!display.message.includes('platform.api.minimax.io'),
		`expected no platform.api.minimax.io (invalid hostname) in toast, got: ${display.message}`,
	);
	// The bare API host is fine to mention in the toast TEXT (the i18n
	// template's `{1}` placeholder), but it must not appear as a URL.
	assert.ok(
		!display.message.includes('https://api.minimax.io'),
		`expected the toast not to link to the API host, got: ${display.message}`,
	);
});

test('createHttpError: 401 China action link points at platform.minimaxi.com', async () => {
	// Pinned regression test: the China user's "Set API Key" button
	// must open `platform.minimaxi.com`, NOT the invalid
	// `platform.api.minimaxi.com` (the broken URL the previous fix
	// produced) and NOT the international `platform.minimax.io`.
	const err = await createHttpError(
		makeResponse(401, '{"error":{"message":"bad key"}}'),
		'https://api.minimaxi.com/anthropic',
	);
	const display = createUserFacingError(err);
	assert.match(
		display.message,
		/https:\/\/platform\.minimaxi\.com\/user-center\/payment\/token-plan/,
		`expected China 401 link to be platform.minimaxi.com, got: ${display.message}`,
	);
	assert.ok(
		!display.message.includes('platform.minimaxi.io'),
		`China 401 must not link to international platform, got: ${display.message}`,
	);
	assert.ok(
		!display.message.includes('platform.api.minimaxi.com'),
		`China 401 must not have the broken api-prefixed hostname, got: ${display.message}`,
	);
});

test('createHttpError: 401 Global action link points at platform.minimax.io', async () => {
	// Pinned regression test: the international user's "Set API Key"
	// button must open `platform.minimax.io`, NOT the broken
	// `platform.api.minimax.io` that the previous fix produced.
	const err = await createHttpError(
		makeResponse(401, '{"error":{"message":"bad key"}}'),
		'https://api.minimax.io/anthropic',
	);
	const display = createUserFacingError(err);
	assert.match(
		display.message,
		/https:\/\/platform\.minimax\.io\/user-center\/payment\/token-plan/,
		`expected Global 401 link to be platform.minimax.io, got: ${display.message}`,
	);
	assert.ok(
		!display.message.includes('platform.api.minimax.io'),
		`Global 401 must not have the broken api-prefixed hostname, got: ${display.message}`,
	);
	assert.ok(
		!display.message.includes('minimaxi.com'),
		`Global 401 must not link to the China platform, got: ${display.message}`,
	);
});

test('createHttpError: third-party proxy → no platform link in the toast', async () => {
	// A user pointing `minimax.apiBaseUrl` at a third-party Anthropic-
	// compatible proxy (e.g. a self-hosted gateway) must NOT see a
	// "Set API Key" / "Create API Key" button — the button would
	// either send them to the wrong platform or (worse) anchor the
	// action on a hostname that's not their real platform. The
	// 401/402 still renders the diagnostic-only actions (e.g. "View
	// error details") via `errorActionUrlStore` if configured, but
	// no platform URL is generated from the proxy base URL.
	const err = await createHttpError(
		makeResponse(401, '{"error":{"message":"bad key"}}'),
		'https://my-proxy.example.com/anthropic',
	);
	const display = createUserFacingError(err);
	assert.ok(
		!display.message.includes('my-proxy.example.com'),
		`proxy URL must not appear in the toast, got: ${display.message}`,
	);
	assert.ok(
		!display.message.includes('Set API Key'),
		`no "Set API Key" button for proxy users, got: ${display.message}`,
	);
	assert.ok(
		!display.message.includes('Create API Key'),
		`no "Create API Key" button for proxy users, got: ${display.message}`,
	);
	assert.ok(
		!display.message.includes('platform.minimaxi.com') &&
			!display.message.includes('platform.minimax.io'),
		`no platform URL must appear for proxy users, got: ${display.message}`,
	);
	// The userSummary goes through the i18n `{1}` placeholder which
	// is fed the resolved host. For proxy users the implementation
	// coerces `null` → `''` so the slot renders as empty parens,
	// not the literal string "null" (which `i18n.formatTemplate`
	// would otherwise stringify via `String(null)`). Pin both the
	// raw userSummary and the rendered display.message to enforce
	// the no-literal-"null" contract.
	assert.ok(
		!err.userSummary.includes('null'),
		`userSummary must not render literal "null", got: ${err.userSummary}`,
	);
	assert.ok(
		!display.message.includes('null'),
		`display.message must not render literal "null", got: ${display.message}`,
	);
});

test('createHttpError: 401/402 userSummary never contains literal "null" for any host', async () => {
	// Pin the inverse side: for China and global hosts the userSummary
	// mentions the host, but it must not render the string "null"
	// anywhere — this is a regression guard for the `null → ''`
	// coercion in `createHttpError`. The `formatTemplate` helper
	// would otherwise stringify `String(null)` = "null" if a future
	// refactor drops the coercion.
	for (const baseUrl of [
		'https://api.minimaxi.com/anthropic',
		'https://api.minimax.io/anthropic',
		'https://my-proxy.example.com/anthropic',
	]) {
		for (const status of [401, 402]) {
			const err = await createHttpError(
				makeResponse(status, '{"error":{"message":"x"}}'),
				baseUrl,
			);
			assert.ok(
				!err.userSummary.includes('null'),
				`${status} for ${baseUrl} must not render literal "null", got: ${err.userSummary}`,
			);
		}
	}
});
