// Structured logger for the MiniMax extension.
//
// Output backend: VS Code's built-in `LogOutputChannel('MiniMax')` —
// the existing `MiniMax` channel the user opens from the Output
// panel. The `level` argument on `channel.info|warn|error|debug|trace`
// flows into VS Code's own log UI, where the user can filter by
// level. We do NOT replace that surface; we add a thin wrapper that
// gives every line:
//
//   - An `event` namespace (e.g. `dashboard.refresh.start`).
//   - Optional structured `fields` (component, traceId, ...).
//   - Automatic redaction of well-known secret field names.
//   - A level gate driven by `minimax.logLevel` so the user can
//     quiet the output without losing the channel entirely.
//
// # Two call shapes, kept backward compatible
//
//   1. Legacy: `logger.info(...args)` — same shape as the previous
//      logger, just joined with ` ` and pushed through `channel.info`.
//      This is the form every pre-Phase-1 call site uses; we keep it
//      working unchanged so the migration can land as small, isolated
//      PRs (one module at a time) instead of one giant rename.
//   2. Structured: `logger.info(event, fields?, error?)` — `event` is
//      a dotted namespace string, `fields` is a plain object. When
//      the second argument is a non-Error object, we treat the call
//      as structured; otherwise we fall back to the legacy shape.
//      This is the shape new code (and eventually every existing
//      call site) should use.
//
// The gate between the two shapes is intentionally permissive — the
// goal is "new code gets the better path" rather than "throw a type
// error on legacy callers" — so it lives in `route()` below.

import * as vscode from 'vscode';
import { CONFIG_SECTION } from './consts';

/** Severity levels the user can pick from `minimax.logLevel`. */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

/** Numeric ordering used by the level gate. Higher = more verbose. */
const LEVEL_RANK: Record<LogLevel, number> = {
	error: 0,
	warn: 1,
	info: 2,
	debug: 3,
	trace: 4,
};

/**
 * Read the user's `minimax.logLevel` setting. Falls back to `info`
 * when the value is missing or unknown — `info` matches what the
 * previous logger emitted by default.
 */
export function getConfiguredLogLevel(): LogLevel {
	const raw = vscode.workspace
		.getConfiguration(CONFIG_SECTION)
		.get<unknown>('logLevel');
	if (typeof raw === 'string') {
		const candidate = raw.toLowerCase() as LogLevel;
		if (candidate in LEVEL_RANK) return candidate;
	}
	return 'info';
}

/**
 * Read the value of one of the `minimax.diagnostics.trace.*` switches.
 * Used by `logger.child` to gate component-specific verbose channels.
 *
 * VS Code's `getConfiguration('minimax').get('diagnostics.traceDashboard')`
 * is the correct read path — `package.json` registers each switch as a
 * flat key under the `minimax` section, NOT as a nested object under
 * `diagnostics`. Earlier revisions called
 * `get('diagnostics')` and indexed into the result, which silently
 * always returned `false` because the workspace config object for that
 * key is undefined.
 */
export function getTraceSwitch(component: TraceComponent): boolean {
	const key = `diagnostics.trace${component[0]!.toUpperCase()}${component.slice(1)}` as
		| 'diagnostics.traceDashboard'
		| 'diagnostics.traceRequests'
		| 'diagnostics.traceMcp'
		| 'diagnostics.traceKeys';
	return Boolean(
		vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>(key, false),
	);
}

export type TraceComponent = 'dashboard' | 'requests' | 'mcp' | 'keys';

let channel: vscode.LogOutputChannel | undefined;

function getChannel(): vscode.LogOutputChannel {
	if (!channel) {
		channel = vscode.window.createOutputChannel('MiniMax', { log: true });
	}
	return channel;
}

/**
 * Test-only: drop the cached channel so the next `getChannel()` call
 * re-creates it. Used by tests that want to assert on a fresh
 * `outputChannels[0]` after resetting `mockState`. Production code
 * never calls this.
 */
export function _resetChannelForTests(): void {
	channel?.dispose();
	channel = undefined;
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Field names whose values must never reach the output channel. The
 * matcher is case-insensitive; substring matches catch the
 * `anthropic-*` and `x-api-*` headers without enumerating every
 * prefix. The list intentionally overlaps the redaction rules in
 * `client/error.ts` so an `Authorization: Bearer <key>` that slips
 * through as a plain object field is still scrubbed here.
 */
const REDACTED_KEYS = new Set([
	'apikey',
	'api_key',
	'authorization',
	'x-api-key',
	'x-anthropic-api-key',
	'token',
	'accesstoken',
	'refresh_token',
	'secret',
	'password',
	'requestbody',
	'responsebody',
	'messages',
	'system',
	'prompt',
	'content',
]);

const REDACTION_MARKER = '***';

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== 'object') return false;
	if (Array.isArray(value)) return false;
	if (value instanceof Error) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function redactValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((entry) => redactValue(entry));
	}
	if (!isPlainObject(value)) return value;
	const out: Record<string, unknown> = {};
	for (const [key, raw] of Object.entries(value)) {
		if (REDACTED_KEYS.has(key.toLowerCase())) {
			out[key] = REDACTION_MARKER;
			continue;
		}
		out[key] = redactValue(raw);
	}
	return out;
}

/**
 * Scrub the well-known credential / header forms that may appear
 * INSIDE a string field. `redactValue` operates on object keys;
 * `redactString` is its complement for values whose name we do
 * not control — typically `error.message`, `error.cause` (when
 * the SDK composes the upstream envelope as a string), or stack
 * fragments composed from response headers.
 *
 * The patterns below catch the four shapes we have seen in the
 * wild:
 *   - `Authorization: Bearer <key>` / `x-api-key: <key>` (HTTP header)
 *   - `apiKey=<key>` / `api_key=<key>` (URL query)
 *   - `sk-…` (Anthropic-style API keys)
 *   - Bearer tokens in free text
 *
 * Anything that survives the scrub is opaque diagnostic context
 * the user can quote to support without compromising a secret.
 *
 * `REDACT_STRING_PATTERNS` is intentionally limited to a handful
 * of regexes — every additional pattern adds latency on the hot
 * log path and risks scrubbing something we actually wanted to
 * keep. Adding a new pattern should be driven by an actual log
 * line we'd otherwise leak, not by a "what if" worry.
 */
const REDACT_STRING_PATTERNS: ReadonlyArray<RegExp> = [
	// `Authorization: Bearer xxx` / `Authorization: Basic xxx` /
	// case-insensitive, optional surrounding whitespace.
	/(authorization\s*:\s*(?:bearer|basic)\s+)[^\s,;"']+/gi,
	// `x-api-key: xxx` / `x-anthropic-api-key: xxx`
	/(x-(?:anthropic-)?api-key\s*:\s*)[^\s,;"']+/gi,
	// `apiKey=xxx` / `api_key=xxx` (URL query strings)
	/((?:api[_-]?key|apikey)\s*=\s*)[^\s&;"']+/gi,
	// Anthropic-style keys (`sk-ant-…` / `sk-…` prefixed strings
	// 20+ chars long). Anchored on the literal `sk-` prefix the
	// SDK uses, so we do not match arbitrary random-looking hex.
	/\bsk-[A-Za-z0-9_-]{16,}\b/g,
];

function redactString(input: string): string {
	let out = input;
	for (const pattern of REDACT_STRING_PATTERNS) {
		out = out.replace(pattern, (_match, prefix?: string) =>
			prefix ? `${prefix}${REDACTION_MARKER}` : REDACTION_MARKER,
		);
	}
	return out;
}

/**
 * Fields the cause of an upstream error is allowed to carry
 * through to the log channel. Anything outside this allowlist is
 * dropped before the cause is stringified, because SDK errors
 * often carry the full HTTP response (headers, body, request
 * envelope) on their `cause`, and forwarding those bytes
 * verbatim would re-introduce the API-key / request-body
 * leak that the rest of the logger is built to prevent.
 *
 * `request_id` and `type` are the two fields MiniMax support
 * routinely asks the user to quote; everything else on the
 * allowlist is diagnostic context that's safe to share.
 */
const CAUSE_ALLOWLIST = new Set([
	'request_id',
	'type',
	'status',
	'code',
	'message',
	'errno',
	'syscall',
]);

function pickCauseFields(cause: unknown): Record<string, unknown> {
	if (cause === null || typeof cause !== 'object') return {};
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(cause as Record<string, unknown>)) {
		if (CAUSE_ALLOWLIST.has(key) && value !== undefined) {
			out[key] = typeof value === 'string' || typeof value === 'number'
				? value
				: String(value);
		}
	}
	return out;
}

function serializeError(error: unknown): Record<string, unknown> {
	if (error instanceof Error) {
		// `message` and `stack` may also embed header values when
		// the SDK composes them. Scrubbing them through
		// `redactString` catches the four common forms:
		// `Authorization: Bearer <key>`, `x-api-key: <key>`,
		// `apiKey=<key>`, and `sk-…` tokens. This is the layer
		// that closes the string-cause / string-message leak that
		// the plain `redactValue` gate does not catch (object-key
		// redactor only operates on object fields, not on values
		// whose name we do not control).
		const out: Record<string, unknown> = {
			name: error.name,
			message: redactString(error.message),
			stack: error.stack === undefined ? undefined : redactString(error.stack),
		};
		// The SDK frequently attaches a structured `cause` to its
		// errors. We deliberately do NOT forward its raw bytes —
		// the upstream envelope can carry `Authorization`,
		// `x-api-key`, and the full request body, all of which
		// the redaction rules above are designed to keep out of
		// the channel. Pulling only the diagnostic fields off the
		// allowlist preserves the `request_id` (which the user is
		// asked to quote to support) without leaking anything
		// else. String causes get `redactString` applied (NOT
		// `redactValue`, which would no-op on a string and leave
		// an embedded `Authorization: Bearer …` in the log).
		if (error.cause !== undefined) {
			if (typeof error.cause === 'string') {
				out['cause'] = redactString(error.cause);
			} else if (typeof error.cause === 'object' && error.cause !== null) {
				const allowlisted = pickCauseFields(error.cause);
				if (Object.keys(allowlisted).length > 0) {
					out['cause'] = redactValue(allowlisted);
				}
			}
		}
		return out;
	}
	if (typeof error === 'string') return { message: redactString(error) };
	if (error === undefined || error === null) return {};
	return { value: redactString(String(error)) };
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/**
 * Render a structured event into the single text line the channel
 * receives. The format mirrors what the existing log lines look
 * like (`[event] k=v`) so eyeballing the Output panel still
 * works, while making each call grep-friendly by `event`.
 */
function renderStructured(
	level: LogLevel,
	event: string,
	fields: Record<string, unknown>,
): string {
	const redacted = redactValue(fields) as Record<string, unknown>;
	const parts: string[] = [`[${event}]`];
	flattenFields(redacted, parts, '');
	// `levelTag` is shared with `renderLegacy`. The shared prefix
	// tells the Output panel this line was rendered through the
	// structured path; `renderLegacy` uses the same tag because
	// both paths funnel through the same `ch.info|warn|...` API
	// and the level itself is what the LogOutputChannel filters on.
	return parts.join(' ');
}

/**
 * Recursively flatten a (redacted) fields object into a list of
 * `k=v` strings. Nested objects use dotted keys
 * (`inner.Authorization=***`) so the Output panel filter still
 * works on individual fields. The flattened form is what the user
 * sees in `MiniMax` Output today, and it keeps each value
 * greppable on its own.
 */
function flattenFields(
	fields: Record<string, unknown>,
	out: string[],
	prefix: string,
): void {
	for (const [key, value] of Object.entries(fields)) {
		if (value === undefined) continue;
		const fullKey = prefix ? `${prefix}.${key}` : key;
		if (key === 'error' && isPlainObject(value)) {
			const errObj = value as Record<string, unknown>;
			if (typeof errObj['name'] === 'string') out.push(`${fullKey}.name=${errObj['name']}`);
			if (typeof errObj['message'] === 'string') out.push(`${fullKey}.message=${errObj['message']}`);
			if (typeof errObj['stack'] === 'string') out.push(`${fullKey}.stack=${errObj['stack']}`);
			// `cause` survives the allowlist in `serializeError`
			// as either a string (forwarded through redact) or a
			// small object of `{ request_id, type, status, code,
			// message, errno, syscall }`. Recurse into objects so
			// each allowlisted field shows up as a separately
			// greppable dotted key; keep string causes verbatim
			// (they have already been redacted at the source).
			const cause = errObj['cause'];
			if (typeof cause === 'string') {
				out.push(`${fullKey}.cause=${cause}`);
			} else if (isPlainObject(cause)) {
				flattenFields(cause, out, `${fullKey}.cause`);
			}
			continue;
		}
		if (isPlainObject(value)) {
			flattenFields(value, out, fullKey);
			continue;
		}
		if (Array.isArray(value)) {
			// Render arrays as `key=[a,b,c]` when their entries are
			// scalar; recurse when nested. This is what makes
			// `messages=[***]` greppable on the top level instead
			// of dumping a JSON blob the user has to mentally
			// decode.
			const flat: string[] = [];
			for (const entry of value) {
				if (isPlainObject(entry)) {
					flat.push(safeJsonStringify(entry));
				} else if (typeof entry === 'string') {
					flat.push(entry);
				} else {
					flat.push(safeJsonStringify(entry));
				}
			}
			out.push(`${fullKey}=[${flat.join(',')}]`);
			continue;
		}
		const rendered =
			typeof value === 'string' ? value : safeJsonStringify(value);
		out.push(`${fullKey}=${rendered}`);
	}
}

/**
 * Render a legacy `logger.info('msg', err)`-style call as a single
 * line. The level itself is what the LogOutputChannel filters on,
 * so we do NOT prefix the line with the level name — that would
 * duplicate the column. We also do NOT mark the line as
 * "legacy" in any user-visible way; a maintainer reading the
 * Output panel should not have to think about which path a
 * given line took.
 */
function renderLegacy(level: LogLevel, args: unknown[]): string {
	const message = args
		.map((a) => {
			if (typeof a === 'string') return a;
			if (a instanceof Error) return a.stack ?? a.message;
			return safeJsonStringify(a);
		})
		.join(' ');
	return message;
}

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function route(
	level: LogLevel,
	args: unknown[],
	child: { component?: string; traceId?: string; spanId?: string } = {},
): void {
	const configured = getConfiguredLogLevel();
	if (LEVEL_RANK[level] > LEVEL_RANK[configured]) return;

	// `child` binding: when the call site did not supply a
	// component via `fields`, inject the one from the child context
	// so log lines from a single subsystem carry a stable tag.
	const channel = getChannel();
	const ch = channel;

	const first = args[0];
	const looksStructured =
		typeof first === 'string' &&
		// A namespace event has at least one dot and is not a
		// natural-language sentence (no spaces). This is a
		// pragmatic gate, not a type-system guarantee.
		first.includes('.') &&
		!first.includes(' ') &&
		args.length >= 2 &&
		isPlainObject(args[1]);

	let body: string;
	let recordEvent: string | undefined;
	let recordFields: Record<string, unknown> | undefined;
	let recordError: LogRecord['error'] | undefined;
	if (looksStructured) {
		const event = first as string;
		const fields = {
			...(child.component ? { component: child.component } : {}),
			...(child.traceId ? { traceId: child.traceId } : {}),
			...(child.spanId ? { spanId: child.spanId } : {}),
			...((args[1] as Record<string, unknown>) ?? {}),
		};
		const maybeError = args[2];
		if (maybeError !== undefined) {
			(fields as Record<string, unknown>)['error'] = serializeError(maybeError);
			recordError = serializeError(maybeError);
		}
		body = renderStructured(level, event, fields);
		recordEvent = event;
		recordFields = fields;
	} else {
		const tagged: unknown[] = child.component || child.traceId
			? [
					child.component ? `[${child.component}]` : '',
					child.traceId ? `trace=${child.traceId}` : '',
					child.spanId ? `span=${child.spanId}` : '',
					...args.map((a) => (typeof a === 'string' ? a : safeJsonStringify(a))),
				].filter(Boolean)
			: args;
		body = renderLegacy(level, tagged);
	}

	switch (level) {
		case 'error':
			ch.error(body);
			break;
		case 'warn':
			ch.warn(body);
			break;
		case 'info':
			ch.info(body);
			break;
		case 'debug':
			ch.debug(body);
			break;
		case 'trace':
			// VS Code's LogOutputChannel exposes `trace` only on
			// newer versions; fall back to `debug` so older hosts
			// still surface the line in their debug column.
			if (typeof ch.trace === 'function') ch.trace(body);
			else ch.debug(body);
			break;
	}

	// The ring buffer is what the diagnostic-export command
	// ships to support. It MUST be as safe as the Output panel —
	// a key that reaches the ring buffer but not the channel is
	// worse than the reverse, because the user is the one who
	// triggers the export and then attaches the file to a
	// bug report. Redact `fields` and `error` here, even though
	// the channel path already redacts them through
	// `renderStructured` — the channel text and the buffer
	// structure are two different surfaces and must each carry
	// their own gate.
	const safeFields = recordFields
		? (redactValue(recordFields) as Record<string, unknown>)
		: undefined;
	const safeError = recordError
		? (redactValue(recordError) as LogRecord['error'])
		: undefined;
	// Pull `elapsedMs` from the unredacted `recordFields`
	// before it goes through redact — redactValue only mutates
	// fields whose key matches the secret-name set, so the
	// numeric value is identical, but reading from the source
	// keeps the contract explicit. The export command reads
	// the top-level `elapsedMs` to sort spans by duration.
	const elapsedMs =
		recordFields && typeof recordFields['elapsedMs'] === 'number'
			? (recordFields['elapsedMs'] as number)
			: undefined;
	pushRecord({
		ts: Date.now(),
		level,
		event: recordEvent,
		component: child.component,
		traceId: child.traceId,
		spanId: child.spanId,
		elapsedMs,
		text: body,
		fields: safeFields,
		error: safeError,
	});
}

// ---------------------------------------------------------------------------
// Ring buffer for diagnostic export
// ---------------------------------------------------------------------------

/**
 * Single log record kept in the in-memory ring buffer. The buffer
 * is the source of truth for the `MiniMax: Export Diagnostic Logs`
 * command (Phase 7). It exists in parallel to the LogOutputChannel
 * — the channel is the live "tail" the user reads while a problem
 * is in flight, the buffer is the "recent history" the export
 * command ships to support.
 */
export interface LogRecord {
	ts: number;
	level: LogLevel;
	event?: string;
	component?: string;
	traceId?: string;
	spanId?: string;
	elapsedMs?: number;
	text: string;
	fields?: Record<string, unknown>;
	// `cause` is either a redacted string (when the SDK
	// composed the cause as a string) or a small allowlisted
	// object of diagnostic fields (when the cause was a
	// structured value, e.g. `{ request_id, type }`). The
	// string form has already been passed through
	// `redactString`; the object form is whatever the allowlist
	// selector left after dropping the upstream envelope. The
	// union is intentional — flattening the object into a
	// string at this layer would lose the `request_id` /
	// `type` greppability that the export command relies on.
	error?: {
		name?: string;
		message?: string;
		stack?: string;
		cause?: string | Record<string, unknown>;
	};
}

/** Cap matches "small enough to fit in a single export file, large
 *  enough to span a single user's incident". 1000 lines at ~200
 *  chars each is roughly 200 KB, well under the VS Code log
 *  channel's per-line limit. Mutable so tests can dial the cap
 *  down to assert the eviction policy without writing 1000
 *  records. */
let ringBufferCap = 1_000;
const ringBuffer: LogRecord[] = [];

export function getRecentLogRecords(): readonly LogRecord[] {
	return ringBuffer.slice();
}

/** Push a single record and evict the oldest entries when the
 *  buffer exceeds its cap. Splitting the push out of `route()`
 *  keeps the hot path free of object allocation when the
 *  caller's level is filtered out. */
function pushRecord(record: LogRecord): void {
	ringBuffer.push(record);
	while (ringBuffer.length > ringBufferCap) {
		ringBuffer.shift();
	}
}

/** Test-only — wipe the buffer between cases so a record from a
 *  prior test cannot pollute the next case's assertions. Also
 *  restores the default 1000-record cap; tests that dial it
 *  down via `_setRingBufferCapForTests` would otherwise leak a
 *  smaller cap into the next case and silently evict the start
 *  record of a 2-line span. */
export function _resetRingBufferForTests(): void {
	ringBuffer.length = 0;
	ringBufferCap = 1_000;
}

/** Test-only — override the cap so a stress test can assert the
 *  eviction policy without writing 1000 records. Returns the
 *  previous cap so the caller can restore it. */
export function _setRingBufferCapForTests(cap: number): number {
	const previous = ringBufferCap;
	ringBufferCap = Math.max(1, cap | 0);
	while (ringBuffer.length > ringBufferCap) ringBuffer.shift();
	return previous;
}

export interface ChildLogger {
	info: (event: string, fields?: Record<string, unknown>) => void;
	warn: (event: string, fields?: Record<string, unknown>, error?: unknown) => void;
	error: (event: string, fields?: Record<string, unknown>, error?: unknown) => void;
	debug: (event: string, fields?: Record<string, unknown>) => void;
	trace: (event: string, fields?: Record<string, unknown>) => void;
}

/**
 * A lightweight span handle. Spawned by `logger.operation(...)`,
 * it stamps every nested log call with `traceId` and `spanId` so
 * the diagnostic export can stitch the start / checkpoint / end
 * lines of a single user-visible operation back together.
 *
 * Three reasons this is plain instead of, say, OpenTelemetry:
 *   1. No new runtime dependency. The extension currently ships
 *      with one runtime dep (`@anthropic-ai/sdk`); pulling in
 *      `@opentelemetry/api` would 10× the bundle for two fields
 *      per log line.
 *   2. We already have a single-process model. `traceId` only
 *      needs to be unique per `logger.operation` invocation.
 *   3. The Output panel's grep-by-`traceId` is the primary
 *      affordance; structured span metadata is a nice-to-have
 *      for the export command, not a hot path.
 */
export interface Operation {
	/** Stable identifier shared by every line this span emits. */
	readonly traceId: string;
	/** Unique identifier for this span within the trace. The
	 *  root span uses `op-<seq>`; nested spans get a suffix. */
	readonly spanId: string;
	/** Stamp a child span under this one. Used when a refresh
	 *  spawns sub-operations (e.g. `plan.refresh`). */
	child: (subEvent: string, fields?: Record<string, unknown>) => Operation;
	/** Record a checkpoint event (no `end`/`fail` semantics). */
	info: (event: string, fields?: Record<string, unknown>) => void;
	warn: (event: string, fields?: Record<string, unknown>, error?: unknown) => void;
	debug: (event: string, fields?: Record<string, unknown>) => void;
	trace: (event: string, fields?: Record<string, unknown>) => void;
	error: (event: string, fields?: Record<string, unknown>, error?: unknown) => void;
	/** Mark the span as successfully completed. Emits a final
	 *  `<event>.end` event with `elapsedMs` derived from the
	 *  operation's start timestamp. Idempotent — calling twice
	 *  does NOT emit a second `end`. */
	end: (fields?: Record<string, unknown>) => void;
	/** Mark the span as failed. Emits `<event>.fail` with the
	 *  error serialised and `elapsedMs` derived from start.
	 *  Idempotent. */
	fail: (error: unknown, fields?: Record<string, unknown>) => void;
}

let operationSeq = 0;

export const logger = {
	info: (...args: unknown[]) => route('info', args),
	warn: (...args: unknown[]) => route('warn', args),
	error: (...args: unknown[]) => route('error', args),
	debug: (...args: unknown[]) => route('debug', args),
	trace: (...args: unknown[]) => route('trace', args),
	show: () => getChannel().show(),
	dispose: () => {
		channel?.dispose();
		channel = undefined;
	},

	/**
	 * Bind a `component` (and optional `traceId`) to subsequent log
	 * calls so every line from one subsystem shares the same tag.
	 * The returned child logger accepts BOTH the new structured
	 * shape AND the legacy variadic shape, so call sites can be
	 * migrated one at a time without losing the child binding.
	 */
	child(bindings: { component: string; traceId?: string }): ChildLogger & {
		legacy: (...args: unknown[]) => void;
	} {
		const wrapped: ChildLogger = {
			info: (event, fields) => route('info', [event, fields ?? {}], bindings),
			warn: (event, fields, error) => route('warn', [event, fields ?? {}, error], bindings),
			error: (event, fields, error) => route('error', [event, fields ?? {}, error], bindings),
			debug: (event, fields) => route('debug', [event, fields ?? {}], bindings),
			trace: (event, fields) => route('trace', [event, fields ?? {}], bindings),
		};
		return {
			...wrapped,
			legacy: (...args: unknown[]) => route('info', args, bindings),
		};
	},

	/**
	 * Open a span. Emits `<event>.start` immediately and returns
	 * an `Operation` handle the caller uses to record checkpoints
	 * and either `end()` (success) or `fail(error)` (failure).
	 *
	 * The handle stamps every nested log line with `traceId` +
	 * `spanId` so the diagnostic export can present the call
	 * sequence in order. `logger.operation` does NOT swallow
	 * exceptions — the caller's `await` / try-catch drives
	 * `end` vs `fail`.
	 */
	operation(
		event: string,
		bindings: {
			component: string;
			traceId?: string;
			/** Optional caller-supplied suffix to keep nested spans
			 *  distinct when many siblings share one parent trace.
			 *  Falls back to a per-call sequence number, so two
			 *  child spans spawned in sequence still get unique ids. */
			spanSuffix?: string;
			fields?: Record<string, unknown>;
		},
	): Operation {
		const traceId =
			bindings.traceId ?? `${event.replace(/\./g, '-')}-${++operationSeq}`;
		const spanSuffix = bindings.spanSuffix ?? `#${++operationSeq}`;
		const spanId = `${traceId}${spanSuffix}`;
		const startedAt = Date.now();
		let closed = false;
		const childBindings = {
			component: bindings.component,
			traceId,
			spanId,
		};
		route('info', [
			`${event}.start`,
			{ ...(bindings.fields ?? {}), spanId },
		], childBindings);

		const stamp = (extra?: { elapsedMs?: number }): Record<string, unknown> => ({
			spanId,
			elapsedMs: extra?.elapsedMs ?? Date.now() - startedAt,
		});

		return {
			traceId,
			spanId,
			child: (subEvent, fields) =>
				logger.operation(subEvent, {
					component: bindings.component,
					traceId,
					spanSuffix: `#${subEvent.replace(/\./g, '-')}`,
					// `parentSpanId` is the parent span's id, not the
					// caller's spanId — passed in via `fields` so it
					// shows up as a regular field on the child span's
					// start record.
					fields: { ...(fields ?? {}), parentSpanId: spanId },
				}),
			info: (event, fields) => route('info', [event, { ...(fields ?? {}) }], childBindings),
			warn: (event, fields, error) => route('warn', [event, fields ?? {}, error], childBindings),
			error: (event, fields, error) => route('error', [event, fields ?? {}, error], childBindings),
			debug: (event, fields) => route('debug', [event, fields ?? {}], childBindings),
			trace: (event, fields) => route('trace', [event, fields ?? {}], childBindings),
			end: (fields) => {
				if (closed) return;
				closed = true;
				route('info', [
					`${event}.end`,
					{ ...(fields ?? {}), ...stamp() },
				], childBindings);
			},
			fail: (error, fields) => {
				if (closed) return;
				closed = true;
				route('warn', [
					`${event}.fail`,
					{ ...(fields ?? {}), ...stamp() },
					error,
				], childBindings);
			},
		};
	},
};