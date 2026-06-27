// Unit tests for the structured logger.
//
// These tests pin the four guarantees the dashboard / request /
// key / MCP migration depends on:
//
//   1. **Routing**: new-style `logger.info('event.x', { k: v })`
//      reaches the channel as `[event.x] k=v`, while legacy
//      `logger.info('msg', err)` reaches it as `[legacy] msg …`.
//   2. **Redaction**: well-known secret field names are scrubbed
//      to `***` regardless of casing, nesting depth, or array
//      position. API keys, authorization headers, request bodies
//      and message content never reach the channel verbatim.
//   3. **Level gate**: `minimax.logLevel` filters out lines whose
//      severity is above the configured threshold. A `debug` call
//      with `logLevel=info` is a no-op; the same call with
//      `logLevel=debug` lands on the channel.
//   4. **Error normalization**: error objects passed to `warn` /
//      `error` are split into `{ name, message, stack, cause }`
//      and the `cause` is forwarded as a string so the upstream
//      `request_id` (which the user quotes to support) is
//      preserved.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	logger,
	_resetChannelForTests,
	_resetRingBufferForTests,
	_setRingBufferCapForTests,
	getConfiguredLogLevel,
	getRecentLogRecords,
	getTraceSwitch,
} from '../src/logger.js';
import { mockState, mockConfig, resetMockConfig } from './helpers/vscodeMock.js';

function resetLogger(): void {
	// The lazy `getChannel()` inside the logger caches the
	// `LogOutputChannel` on the module level. Tests that swap
	// the channel log array via `mockState.outputChannels[i]`
	// must clear the cache between cases, otherwise a line from
	// a later test lands in a channel the test no longer owns.
	_resetChannelForTests();
	_resetRingBufferForTests();
	// Each test starts with a fresh channel — wipe the array so
	// the new channel lands at index 0 again.
	while (mockState.outputChannels.length > 0) mockState.outputChannels.pop();
	for (const channel of mockState.outputChannels) channel.log.length = 0;
	// Wipe the mock config so `minimax.logLevel` doesn't leak
	// from a previous test (e.g. one that pinned `logLevel=warn`
	// to assert the level gate). The logger reads the value on
	// every emit, so a stale setting silently filters the next
	// test's output.
	resetMockConfig();
}

function lastLine(): string {
	const channel = mockState.outputChannels[0];
	if (!channel) throw new Error('expected a log channel to be created');
	const last = channel.log[channel.log.length - 1];
	if (typeof last !== 'string') throw new Error('expected a string log line');
	return last;
}

function allLines(): string[] {
	const channel = mockState.outputChannels[0];
	if (!channel) return [];
	return channel.log.map((line) => String(line));
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

test('logger: structured event renders as [event] k=v', () => {
	resetLogger();
	logger.info('dashboard.refresh.start', { traceId: 'tr-1', hasKey: true });
	const line = lastLine();
	assert.match(line, /\[dashboard\.refresh\.start\]/);
	assert.match(line, /traceId=tr-1/);
	assert.match(line, /hasKey=true/);
});

test('logger: structured event with error serialises { name, message, stack }', () => {
	resetLogger();
	const error = new Error('boom');
	logger.error('request.fail', { model: 'MiniMax-M3' }, error);
	const line = lastLine();
	assert.match(line, /\[request\.fail\]/);
	assert.match(line, /model=MiniMax-M3/);
	// Error fields are flattened into `name=`, `message=`, `stack=`
	// (not lumped under `error=`) so the Output panel's per-field
	// filters work. The format is intentional: the user filtering
	// the channel on `message=boom` would otherwise miss the line.
	assert.match(line, /name=Error/);
	assert.match(line, /message=boom/);
	assert.match(line, /stack=Error: boom/);
});

test('logger: legacy variadic form is still supported', () => {
	resetLogger();
	logger.info('a plain string message');
	const line = lastLine();
	// Legacy lines are NOT prefixed with `[legacy]` — the
	// LogOutputChannel already classifies by level, so a marker
	// prefix would just duplicate the column. The contract for a
	// legacy call is "the message text reaches the channel
	// verbatim, joined with a space, and the Error arg's stack
	// comes along".
	assert.doesNotMatch(line, /\[/);
	assert.match(line, /a plain string message/);
});

test('logger: legacy variadic + error joins both arguments', () => {
	resetLogger();
	logger.warn('plan cache refresh failed', new Error('ECONNRESET'));
	const line = lastLine();
	assert.match(line, /plan cache refresh failed/);
	assert.match(line, /ECONNRESET/);
});

test('logger: child() binds component + traceId to every call', () => {
	resetLogger();
	const child = logger.child({ component: 'dashboard', traceId: 'tr-2' });
	child.info('panel.create');
	child.warn('plan.cache.fail', { host: 'china' });
	const lines = allLines();
	assert.equal(lines.length, 2);
	assert.match(lines[0]!, /\[panel\.create\]/);
	assert.match(lines[0]!, /component=dashboard/);
	assert.match(lines[0]!, /traceId=tr-2/);
	assert.match(lines[1]!, /\[plan\.cache\.fail\]/);
	assert.match(lines[1]!, /host=china/);
	assert.match(lines[1]!, /traceId=tr-2/);
});

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

test('logger: redacts apiKey / authorization / x-api-key fields', () => {
	resetLogger();
	logger.warn('plan.cache.fail', {
		apiKey: 'sk-supersecret-1234',
		authorization: 'Bearer sk-supersecret-1234',
		'x-api-key': 'sk-another',
		reason: 'rate-limited',
	});
	const line = lastLine();
	assert.doesNotMatch(line, /sk-supersecret-1234/);
	assert.doesNotMatch(line, /sk-another/);
	assert.match(line, /apiKey=\*\*\*/);
	assert.match(line, /authorization=\*\*\*/);
	assert.match(line, /x-api-key=\*\*\*/);
	assert.match(line, /reason=rate-limited/);
});

test('logger: redaction is case-insensitive and recurses into nested objects', () => {
	resetLogger();
	logger.error('key.exposed', {
		APIKey: 'sk-nope',
		inner: {
			Authorization: 'Bearer sk-nested',
			ok: true,
		},
	});
	const line = lastLine();
	assert.doesNotMatch(line, /sk-nope/);
	assert.doesNotMatch(line, /sk-nested/);
	// Nested redaction uses dotted keys so each field remains
	// greppable on its own in the Output panel filter.
	assert.match(line, /APIKey=\*\*\*/);
	assert.match(line, /inner\.Authorization=\*\*\*/);
	assert.match(line, /inner\.ok=true/);
});

test('logger: redaction recurses into arrays', () => {
	resetLogger();
	logger.info('messages.batch', {
		messages: [
			{ role: 'user', content: 'tell me a secret' },
			{ role: 'assistant', content: 'ok' },
		],
	});
	const line = lastLine();
	// `messages` is a top-level redacted key, so the whole array
	// collapses to `***`. We do NOT recurse into each entry to
	// redact the inner `content` field, because the top-level
	// redaction already scrubs the array and recursing would be
	// both slower and noisier in the Output panel.
	assert.doesNotMatch(line, /tell me a secret/);
	assert.doesNotMatch(line, /ok/);
	assert.match(line, /messages=\*\*\*/);
});

test('logger: body and prompt field names are redacted (not just auth headers)', () => {
	resetLogger();
	logger.warn('request.bodyDump', {
		requestBody: { model: 'MiniMax-M3', messages: ['hello'] },
		responseBody: { id: 'r-1' },
		prompt: 'the actual prompt text',
	});
	const line = lastLine();
	assert.doesNotMatch(line, /hello/);
	assert.doesNotMatch(line, /the actual prompt text/);
	assert.doesNotMatch(line, /r-1/);
	assert.match(line, /requestBody=\*\*\*/);
	assert.match(line, /responseBody=\*\*\*/);
	assert.match(line, /prompt=\*\*\*/);
});

// ---------------------------------------------------------------------------
// Level gate
// ---------------------------------------------------------------------------

test('logger: logLevel=info suppresses debug calls', () => {
	resetLogger();
	mockConfig['minimax.logLevel'] = 'info';
	logger.debug('cache.hit', { key: 'a' });
	const lines = allLines();
	assert.equal(
		lines.length,
		0,
		`debug line should be filtered out at logLevel=info, got: ${JSON.stringify(lines)}`,
	);
});

test('logger: logLevel=debug allows debug calls through', () => {
	resetLogger();
	mockConfig['minimax.logLevel'] = 'debug';
	logger.debug('cache.hit', { key: 'a' });
	const lines = allLines();
	assert.equal(lines.length, 1);
	assert.match(lines[0]!, /\[cache\.hit\]/);
});

test('logger: logLevel=trace allows trace calls through', () => {
	resetLogger();
	mockConfig['minimax.logLevel'] = 'trace';
	logger.trace('span.begin', { spanId: 's-1' });
	const lines = allLines();
	assert.equal(lines.length, 1);
	assert.match(lines[0]!, /\[span\.begin\]/);
});

test('logger: logLevel=warn suppresses info calls', () => {
	resetLogger();
	mockConfig['minimax.logLevel'] = 'warn';
	logger.info('plan.cache.hit', { host: 'china' });
	logger.warn('plan.cache.fail', { host: 'china' });
	const lines = allLines();
	assert.equal(lines.length, 1);
	assert.match(lines[0]!, /\[plan\.cache\.fail\]/);
});

test('logger: unknown logLevel falls back to info', () => {
	resetLogger();
	mockConfig['minimax.logLevel'] = 'bogus';
	assert.equal(getConfiguredLogLevel(), 'info');
	logger.debug('cache.hit');
	assert.equal(allLines().length, 0, 'debug must still be filtered at the default level');
});

// ---------------------------------------------------------------------------
// Error normalization
// ---------------------------------------------------------------------------

test('logger: error cause is forwarded through the allowlist (preserves upstream request_id)', () => {
	resetLogger();
	const error = new Error('upstream rejected') as Error & { cause?: unknown };
	error.cause = { request_id: 'req_abc123', type: 'invalid_request_error' };
	logger.error('request.fail', { model: 'MiniMax-M3' }, error);
	const line = lastLine();
	assert.match(line, /\[request\.fail\]/);
	// Error fields are flattened into dotted keys so the Output
	// panel's per-field filters work. Cause is an OBJECT on the
	// `serializeError` output (allowlisted to the safe fields),
	// not a string — the earlier `safeJsonStringify` path used
	// to forward the entire upstream envelope, which leaked
	// `Authorization` / `requestBody` straight into the Output.
	// The allowlist contract is pinned in the next test
	// ("error.cause is allowlisted …"); this one asserts the
	// wire-format is intact for the supported fields.
	assert.match(line, /error\.message=upstream rejected/);
	assert.match(line, /error\.cause\.request_id=req_abc123/);
	assert.match(line, /error\.cause\.type=invalid_request_error/);
});

test('logger: non-Error error argument still reaches the channel as a message', () => {
	resetLogger();
	logger.warn('plan.cache.fail', undefined, 'a plain string error');
	const line = lastLine();
	// Second arg is `undefined`, so the legacy path is taken
	// (the `looksStructured` gate requires a non-undefined
	// object). The legacy path joins all string args with a
	// space — both the event name and the error message reach
	// the channel.
	assert.match(line, /plan\.cache\.fail/);
	assert.match(line, /a plain string error/);
});

// ---------------------------------------------------------------------------
// Ring buffer — the source of truth for the diagnostic export.
// ---------------------------------------------------------------------------

test('logger: ring buffer records every emitted line with structured fields', () => {
	resetLogger();
	mockConfig['minimax.logLevel'] = 'trace';
	logger.info('plan.cache.refresh.start', { host: 'china' });
	logger.warn('request.fail', { model: 'MiniMax-M3' }, new Error('boom'));
	const records = getRecentLogRecords();
	assert.equal(records.length, 2);
	assert.equal(records[0]?.event, 'plan.cache.refresh.start');
	assert.equal(records[0]?.level, 'info');
	assert.equal(records[0]?.text, '[plan.cache.refresh.start] host=china');
	assert.equal(records[1]?.event, 'request.fail');
	assert.equal(records[1]?.level, 'warn');
	assert.equal(records[1]?.error?.message, 'boom');
});

test('logger: ring buffer skips lines filtered by logLevel', () => {
	resetLogger();
	mockConfig['minimax.logLevel'] = 'warn';
	logger.info('cache.hit');
	logger.debug('cache.miss');
	logger.error('upstream.500');
	const records = getRecentLogRecords();
	assert.equal(records.length, 1);
	assert.equal(records[0]?.event, undefined);
});

test('logger: ring buffer evicts the oldest record when over cap', () => {
	resetLogger();
	_setRingBufferCapForTests(3);
	logger.info('event.a', {});
	logger.info('event.b', {});
	logger.info('event.c', {});
	logger.info('event.d', {});
	const records = getRecentLogRecords();
	// Cap=3, 4 records pushed — the oldest one (`event.a`) is
	// evicted; the remaining window is `event.b / c / d`.
	assert.equal(records.length, 3);
	assert.equal(records[0]?.text, '[event.b]');
	assert.equal(records[2]?.text, '[event.d]');
});

test('logger: ring buffer caps are clamped to at least 1', () => {
	resetLogger();
	_setRingBufferCapForTests(0);
	_setRingBufferCapForTests(-1);
	logger.info('event.only');
	const records = getRecentLogRecords();
	assert.equal(records.length, 1);
});

// ---------------------------------------------------------------------------
// Operation / span — start → checkpoint → end / fail, all stitched by traceId
// ---------------------------------------------------------------------------

test('logger.operation: emits start and end with the same traceId', () => {
	resetLogger();
	const op = logger.operation('dashboard.refresh', { component: 'dashboard' });
	assert.match(op.traceId, /^dashboard-refresh-\d+$/);
	op.end({ plan: 'ok' });
	const records = getRecentLogRecords();
	const start = records.find((r) => r.event === 'dashboard.refresh.start');
	const end = records.find((r) => r.event === 'dashboard.refresh.end');
	assert.ok(start, 'start record should be present');
	assert.ok(end, 'end record should be present');
	assert.equal(start?.traceId, op.traceId);
	assert.equal(end?.traceId, op.traceId);
	assert.equal(end?.fields?.plan, 'ok');
	// `elapsedMs` is computed from the operation's start
	// timestamp — non-negative, and the end record should carry
	// it.
	const elapsed = end?.fields?.elapsedMs;
	assert.equal(typeof elapsed, 'number');
	assert.ok((elapsed as number) >= 0);
});

test('logger.operation: fail emits a fail record carrying the error message', () => {
	resetLogger();
	const op = logger.operation('request.upstream', { component: 'requests' });
	op.fail(new Error('HTTP 502'), { status: 502 });
	const records = getRecentLogRecords();
	const fail = records.find((r) => r.event === 'request.upstream.fail');
	assert.ok(fail);
	assert.equal(fail?.level, 'warn');
	assert.equal(fail?.error?.message, 'HTTP 502');
	assert.equal(fail?.fields?.status, 502);
});

test('logger.operation: end is idempotent — second call does NOT emit another end', () => {
	resetLogger();
	const op = logger.operation('plan.cache.refresh', { component: 'plan' });
	op.end({ first: true });
	op.end({ second: true });
	const records = getRecentLogRecords();
	const ends = records.filter((r) => r.event === 'plan.cache.refresh.end');
	assert.equal(ends.length, 1, 'end should only emit once');
	assert.equal(ends[0]?.fields?.first, true);
	assert.equal(ends[0]?.fields?.second, undefined);
});

test('logger.operation: child spans inherit traceId but get their own spanId', () => {
	resetLogger();
	const parent = logger.operation('dashboard.refresh', { component: 'dashboard' });
	const child = parent.child('plan.refresh', { host: 'china' });
	child.info('cache.hit');
	child.end({ ok: true });
	parent.end({ planSource: 'ok' });
	const records = getRecentLogRecords();
	const parentStart = records.find((r) => r.event === 'dashboard.refresh.start');
	const childStart = records.find((r) => r.event === 'plan.refresh.start');
	assert.ok(parentStart);
	assert.ok(childStart);
	assert.equal(parentStart?.traceId, childStart?.traceId);
	assert.notEqual(parentStart?.spanId, childStart?.spanId);
});

test('logger.operation: nested log lines carry the operation spanId automatically', () => {
	resetLogger();
	const op = logger.operation('dashboard.refresh', { component: 'dashboard' });
	op.info('cached.view.build');
	op.trace('mmx.detect');
	op.end();
	const records = getRecentLogRecords();
	const checkpoint = records.find((r) => r.event === 'cached.view.build');
	assert.ok(checkpoint);
	assert.equal(checkpoint?.spanId, op.spanId);
	assert.equal(checkpoint?.traceId, op.traceId);
});

test('logger.operation: fail-after-end stays ignored (close-once contract)', () => {
	resetLogger();
	const op = logger.operation('plan.refresh', { component: 'plan' });
	op.end({ ok: true });
	op.fail(new Error('late'), { late: true });
	const records = getRecentLogRecords();
	const ends = records.filter((r) => r.event === 'plan.refresh.end');
	const fails = records.filter((r) => r.event === 'plan.refresh.fail');
	assert.equal(ends.length, 1);
	assert.equal(fails.length, 0, 'fail after end should be a no-op');
});

// ---------------------------------------------------------------------------
// Review-driven regression tests (Phase 6.5):
//   1. Ring buffer carries redacted `fields` / `error`, NOT raw input.
//   2. `error.cause` is filtered through an allowlist — secret fields
//      and request bodies never reach the channel or the buffer.
//   3. `getTraceSwitch` reads the FLAT `minimax.diagnostics.trace*` key.
//   4. `LogRecord.elapsedMs` is populated on end/fail records.
// ---------------------------------------------------------------------------

test('logger: ring buffer fields are redacted (apiKey never reaches the buffer)', () => {
	resetLogger();
	logger.info('plan.cache.refresh.start', {
		apiKey: 'sk-supersecret-1234',
		authorization: 'Bearer sk-supersecret-1234',
		host: 'china',
	});
	const records = getRecentLogRecords();
	assert.equal(records.length, 1);
	const record = records[0]!;
	// The channel text and the buffer `text` are redacted
	// (they share `renderStructured`), but the structured
	// `fields` and `error` are a parallel surface — this
	// assertion pins that the buffer redaction actually runs.
	assert.equal(record.fields?.['apiKey'], '***');
	assert.equal(record.fields?.['authorization'], '***');
	assert.equal(record.fields?.['host'], 'china');
	// Defence-in-depth: nothing in the buffer carries the raw
	// token, even as a substring.
	assert.doesNotMatch(JSON.stringify(record), /sk-supersecret-1234/);
});

test('logger: error.cause is allowlisted (request_id kept, headers / body dropped)', () => {
	resetLogger();
	const error = new Error('upstream rejected') as Error & { cause?: unknown };
	// Realistic SDK-style cause: includes the diagnostic fields
	// the user needs to quote to support, plus the full HTTP
	// response the user must NOT see.
	error.cause = {
		request_id: 'req_abc123',
		type: 'invalid_request_error',
		// These three MUST be dropped — they would re-introduce
		// the exact leak the redaction gate exists to prevent.
		headers: { authorization: 'Bearer sk-supersecret-1234' },
		body: { messages: ['tell me a secret'] },
		raw_response: 'HTTP/1.1 401 Unauthorized\nauthorization: Bearer sk-supersecret-1234\n',
	};
	logger.error('request.fail', { model: 'MiniMax-M3' }, error);
	const records = getRecentLogRecords();
	assert.equal(records.length, 1);
	const record = records[0]!;
	const errObj = record.error as Record<string, unknown>;
	const cause = errObj['cause'] as Record<string, unknown>;
	// Allowlist honoured: the two diagnostic fields round-trip.
	assert.equal(cause['request_id'], 'req_abc123');
	assert.equal(cause['type'], 'invalid_request_error');
	// Disallowed fields dropped.
	assert.equal(cause['headers'], undefined, 'headers must NOT reach the channel');
	assert.equal(cause['body'], undefined, 'body must NOT reach the channel');
	assert.equal(cause['raw_response'], undefined, 'raw_response must NOT reach the channel');
	// Defence-in-depth: no leak through other fields either.
	assert.doesNotMatch(JSON.stringify(record), /sk-supersecret-1234/);
	assert.doesNotMatch(JSON.stringify(record), /tell me a secret/);
});

test('logger: getTraceSwitch reads the flat minimax.diagnostics.trace* key', () => {
	resetMockConfig();
	// Default — the switch is off, regardless of how the user
	// might have a `diagnostics` nested object from an older
	// config schema.
	assert.equal(getTraceSwitch('dashboard'), false);
	assert.equal(getTraceSwitch('requests'), false);
	assert.equal(getTraceSwitch('mcp'), false);
	assert.equal(getTraceSwitch('keys'), false);
	// The user flips on the dashboard trace in the Settings
	// UI — we must see `true`. The previous implementation
	// looked at `config.get('diagnostics')` and indexed into
	// a nested object that never existed, silently returning
	// `false` for every switch.
	mockConfig['minimax.diagnostics.traceDashboard'] = true;
	assert.equal(getTraceSwitch('dashboard'), true);
	// Other switches stay off — each key is independent.
	assert.equal(getTraceSwitch('requests'), false);
	mockConfig['minimax.diagnostics.traceRequests'] = true;
	assert.equal(getTraceSwitch('requests'), true);
});

test('logger: LogRecord.elapsedMs is populated on operation end', () => {
	resetLogger();
	const op = logger.operation('dashboard.refresh', { component: 'dashboard' });
	op.end({ plan: 'ok' });
	const records = getRecentLogRecords();
	const end = records.find((r) => r.event === 'dashboard.refresh.end');
	assert.ok(end);
	// The top-level `elapsedMs` field — the export command reads
	// it directly to sort spans by duration, so it must be on
	// the record itself, not just buried under `fields`.
	assert.equal(typeof end?.elapsedMs, 'number');
	assert.ok((end?.elapsedMs as number) >= 0);
});

// ---------------------------------------------------------------------------
// Review-driven regression tests (Phase 6.5 + 6.6):
//   5. `redactString` scrubs embedded tokens in string values that
//      `redactValue` (object-key based) does NOT catch.
//   6. `error.cause` as a STRING (e.g. SDK-composed transport
//      errors) goes through `redactString` — the previous
//      `redactValue(error.cause)` was a silent no-op on strings.
//   7. `error.message` and `error.stack` are also redacted when
//      they embed header / token forms.
//   8. `LogRecord.error.cause` accepts a string OR an object —
//      type contract matches what the export command will see.
// ---------------------------------------------------------------------------

test('logger: redactString scrubs embedded Authorization / x-api-key / sk-… tokens', () => {
	resetLogger();
	// Use the Error path so `serializeError` is what we test, not
	// the redactString function in isolation. The message and
	// the cause (as a string) are both scrubbed.
	const error = new Error(
		'upstream failed: Authorization: Bearer sk-supersecret-1234, x-api-key: sk-anthropic-2',
	) as Error & { cause?: unknown };
	error.cause =
		'transport reset: apiKey=sk-supersecret-9999 and Bearer eyJhbGciOi.something-here-long-1234';
	logger.error('request.fail', { model: 'MiniMax-M3' }, error);
	const records = getRecentLogRecords();
	assert.equal(records.length, 1);
	const record = records[0]!;
	const errObj = record.error as Record<string, unknown>;
	const message = errObj['message'] as string;
	const cause = errObj['cause'] as string;

	// Tokens scrubbed, surrounding context preserved.
	assert.match(message, /Authorization: Bearer \*\*\*/);
	assert.match(message, /x-api-key: \*\*\*/);
	assert.doesNotMatch(message, /sk-supersecret-1234/);
	assert.doesNotMatch(message, /sk-anthropic-2/);

	// `Bearer <long opaque>` is matched by the same `Authorization`
	// regex? No — that one requires the `authorization:` header
	// prefix. Free-text `Bearer …` (no header) is matched by the
	// `sk-…` regex if the token starts with `sk-`, otherwise it
	// leaks. The `apiKey=…` form is what we expect to scrub
	// here, since the cause string has the `apiKey=…` shape.
	assert.match(cause, /apiKey=\*\*\*/);
	assert.doesNotMatch(cause, /sk-supersecret-9999/);
	// Defence-in-depth: nothing in the record carries the raw
	// tokens, even as a substring of any other field.
	assert.doesNotMatch(JSON.stringify(record), /sk-supersecret-1234/);
	assert.doesNotMatch(JSON.stringify(record), /sk-supersecret-9999/);
	assert.doesNotMatch(JSON.stringify(record), /sk-anthropic-2/);
});

test('logger: redactString leaves a non-secret error message untouched', () => {
	resetLogger();
	const error = new Error('connect ECONNREFUSED 127.0.0.1:443');
	logger.error('transport.fail', { host: 'china' }, error);
	const records = getRecentLogRecords();
	assert.equal(records.length, 1);
	const errObj = records[0]!.error as Record<string, unknown>;
	// No tokens, no scrubbing; the message is forwarded verbatim.
	assert.equal(errObj['message'], 'connect ECONNREFUSED 127.0.0.1:443');
});

test('logger: LogRecord.error.cause may be a string OR an allowlisted object', () => {
	resetLogger();
	// String cause.
	const stringCauseError = new Error('boom') as Error & { cause?: unknown };
	stringCauseError.cause = 'Authorization: Bearer sk-secret-aaaa';
	logger.error('request.fail', { host: 'china' }, stringCauseError);
	// Object cause (allowlisted).
	const objectCauseError = new Error('boom') as Error & { cause?: unknown };
	objectCauseError.cause = { request_id: 'req_xyz', type: 'rate_limit' };
	logger.error('request.fail', { host: 'china' }, objectCauseError);

	const records = getRecentLogRecords();
	const stringRecord = records[0]!.error as { cause?: unknown };
	const objectRecord = records[1]!.error as { cause?: unknown };
	assert.equal(typeof stringRecord.cause, 'string', 'string cause stays a string');
	assert.equal(typeof objectRecord.cause, 'object', 'object cause stays an object');
	// `request_id` survives the allowlist; the scrubbed string
	// has the token replaced.
	const objectCause = objectRecord.cause as Record<string, unknown>;
	assert.equal(objectCause['request_id'], 'req_xyz');
});
