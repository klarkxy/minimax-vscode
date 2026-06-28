// Unit tests for DashboardPanel's lifecycle gate.
//
// Phase 0 regression: when the user closes the dashboard panel
// (or VS Code disposes the webview for any other reason) while a
// `refreshOnce` is mid-flight, the tail of the refresh used to call
// `this.panel.webview.postMessage` on a torn-down webview. VS Code
// threw `Error: Webview is disposed`, the panel caught it in the
// generic `catch` block, and logged it as `Dashboard refresh
// failed` — drowning out real failures in the diagnostic channel.
//
// These tests pin the four invariants the lifecycle gate must hold:
//
//   1. `postMessage` after `dispose()` is a no-op (no throw,
//      no warning logged).
//   2. A `refreshOnce` that started before `dispose()` does NOT
//      call `postMessage` after `dispose()` returns, even when
//      `authForRefresh` and the plan-cache refresh resolve on
//      later ticks.
//   3. VS Code's own "Webview is disposed" throw is downgraded
//      to a `debug` log line; `warn` / `error` channels stay
//      quiet so real failures are not buried.
//   4. `dispose()` clears `pendingRefresh`. A late notification
//      (e.g. `auth.onDidChangeApiKey` firing during teardown)
//      must NOT spawn a follow-up refresh against a dead panel.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createUsageStore } from '../src/usage.js';
import { DashboardPanel } from '../src/dashboard/panel.js';
import { mockState, mockConfig, resetMockConfig } from './helpers/vscodeMock.js';

class FakeMemento {
	private store = new Map<string, unknown>();
	get<T>(key: string): T | undefined {
		return this.store.get(key) as T | undefined;
	}
	update(_key: string, _value: unknown): Promise<void> {
		return Promise.resolve();
	}
}

/**
 * Build a DashboardPanel-shaped dependency bundle for tests. The
 * plan / mmx caches return immediately; tests that need to gate
 * the refresh tail on `dispose()` substitute their own.
 */
function showPanelWith(overrides: {
	planCache?: unknown;
	mmxCliCache?: unknown;
	authApiKey?: string | undefined;
}): ReturnType<typeof DashboardPanel.show> {
	for (const panel of mockState.webviewPanels.slice()) panel.dispose();
	// Drop the disposed panels from the array so the next
	// `DashboardPanel.show` call lands at index 0. Without this,
	// every test would see `mockState.webviewPanels[0]` as the
	// very first panel created in the suite (already disposed
	// by an earlier test's `webviewPanel.dispose()`), and any
	// mutation the test makes to `webviewPanel.webview.postMessage`
	// would be applied to a dead panel that the production code
	// never reaches.
	while (mockState.webviewPanels.length > 0) mockState.webviewPanels.pop();
	// Reset everything EXCEPT the output-channel log. The lazy
	// `getChannel()` inside `src/logger.ts` is module-scoped, so
	// once a channel has been created, `mockState.reset()` clearing
	// the `outputChannels` array orphans the logger's reference and
	// every subsequent log line lands in a channel the tests can no
	// longer observe. Drain the log in place instead.
	mockState.informationMessages.length = 0;
	mockState.errorMessages.length = 0;
	mockState.warningMessages.length = 0;
	mockState.quickPicks.length = 0;
	for (const channel of mockState.outputChannels) {
		channel.log.length = 0;
	}
	// Seed the minimal config the dashboard's MCP host picker and
	// base-URL accessor expect. Without this the dashboard would
	// not even reach its first postMessage.
	resetMockConfig();
	mockConfig['minimax.apiBaseUrl'] = 'https://api.minimaxi.com/anthropic';
	// The lifecycle gate logs `dispose skip` at `debug` level.
	// We want the assertions to observe those lines, so drop the
	// gate to `trace` for the whole suite.
	mockConfig['minimax.logLevel'] = 'trace';
	const store = createUsageStore(new FakeMemento());
	const planCache = (overrides.planCache as never) ?? {
		read: () => undefined,
		refresh: () => Promise.resolve({ ok: false, reason: 'unsupported' as const }),
		subscribe: () => ({ dispose() {} }),
		invalidate: () => {},
	};
	const mmxCliCache = (overrides.mmxCliCache as never) ?? {
		read: () => undefined,
		refresh: () => Promise.resolve(null),
		subscribe: () => ({ dispose() {} }),
	};
	return DashboardPanel.show({
		extensionUri: { scheme: 'file', path: '/extension', fsPath: '/extension' } as never,
		auth: {
			getApiKey: () => Promise.resolve(overrides.authApiKey ?? undefined),
			onDidChangeApiKey: () => ({ dispose() {} }),
		} as never,
		usageStore: store,
		planCache: planCache as never,
		mmxCliCache: mmxCliCache as never,
		getHost: () => 'china',
	});
}

/** Snapshot the diagnostic channel's log so we can assert against it. */
function captureChannelLog(): string[] {
	const channel = mockState.outputChannels[0];
	if (!channel) return [];
	return channel.log.map((line) => String(line));
}

/** Convenience: line that mentions a `dashboard.refresh.skip`
 *  lifecycle event for the given `refreshSeq`. The skip event
 *  always carries a `disposed_*` reason. */
function hasSkipLine(log: string[], seq: number): boolean {
	return log.some(
		(line) =>
			line.includes('dashboard.refresh#' + seq) &&
			line.includes('disposed'),
	);
}

async function waitForClosedRefreshSpans(timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const current = captureChannelLog();
		const starts = current
			.filter((line) => line.startsWith('[dashboard.refresh.start]'))
			.map((line) => line.match(/traceId=(dashboard\.refresh#\d+)/)?.[1])
			.filter((t): t is string => typeof t === 'string');
		const ends = new Set(current
			.filter((line) => line.startsWith('[dashboard.refresh.end]'))
			.map((line) => line.match(/traceId=(dashboard\.refresh#\d+)/)?.[1])
			.filter((t): t is string => typeof t === 'string'));
		if (starts.length > 0 && starts.every((traceId) => ends.has(traceId))) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

// ---------------------------------------------------------------------------
// Test 1 — `dispose()` makes `postData`/`postError` a silent no-op
// ---------------------------------------------------------------------------

test('DashboardPanel: postData after dispose is a silent no-op (no throw, no warn)', async () => {
	const panel = showPanelWith({});
	// Yield so the initial refresh() can post the cached view.
	await new Promise((resolve) => setImmediate(resolve));
	const webviewPanel = mockState.webviewPanels[0]!;
	const postedBefore = webviewPanel.webview.postedMessages.length;

	webviewPanel.dispose();
	// dispose() flips the gate synchronously, but the test
	// mirrors how production reaches this: from a
	// `panel.onDidDispose` listener, which runs before the next
	// `await` boundary.
	const beforeLog = captureChannelLog();

	// After dispose, calling the private postData/postError
	// surface must be safe. We exercise it through `refresh()`
	// (the public entry point) and assert no message lands on
	// the dead webview.
	await (panel as unknown as { refresh(): Promise<void> }).refresh();
	// Drain any pending microtasks.
	await new Promise((resolve) => setImmediate(resolve));

	const postedAfter = webviewPanel.webview.postedMessages.length;
	assert.equal(
		postedAfter,
		postedBefore,
		'no further postMessage calls should land after dispose',
	);
	const log = captureChannelLog().slice(beforeLog.length);
	// No new `dashboard.refresh.fail` warn was emitted. The
	// production warn marker is `dashboard.refresh.fail`,
	// surfaced via `logger.operation`'s `fail()` arm.
	const refreshFailedLines = log.filter((line) =>
		line.includes('dashboard.refresh.fail'),
	);
	assert.equal(
		refreshFailedLines.length,
		0,
		`dispose must NOT escalate to dashboard.refresh.fail. saw: ${JSON.stringify(refreshFailedLines)}`,
	);
});

// ---------------------------------------------------------------------------
// Test 2 — mid-flight refresh aborts at the next disposed checkpoint
// ---------------------------------------------------------------------------

test('DashboardPanel: refresh in flight when dispose() runs is cancelled before final postMessage', async () => {
	// Gate `planCache.refresh` on an external `release()` so we can
	// reproduce the "user closes the panel while the plan HTTP call
	// is in flight" race deterministically.
	let release!: () => void;
	const planGate = new Promise<{ ok: false; reason: 'unsupported' }>((resolve) => {
		release = () => resolve({ ok: false, reason: 'unsupported' });
	});
	const planCache = {
		read: () => undefined,
		refresh: () => planGate,
		subscribe: () => ({ dispose() {} }),
		invalidate: () => {},
	};
	const panel = showPanelWith({ planCache });
	await new Promise((resolve) => setImmediate(resolve));

	const webviewPanel = mockState.webviewPanels[0]!;
	const cachedPostsBefore = webviewPanel.webview.postedMessages.filter(
		(message) =>
			!!message && typeof message === 'object' && (message as { type?: string }).type === 'data',
	).length;

	// Close the panel BEFORE the gated plan refresh resolves. The
	// tail of `refreshOnce` is now awaiting `planRefreshPromise`,
	// the very next checkpoint after which is `isTornDown()`.
	webviewPanel.dispose();

	// Let any finalisation work between dispose and the plan
	// refresh resolution settle without yielding to the gate.
	release();
	// Drain microtasks long enough for the post-release `await
	// planRefreshPromise` tail to run. The exact checkpoint
	// that fires depends on timing; either `disposed_after_plan_refresh`
	// or `disposed_before_final_post` is acceptable.
	for (let i = 0; i < 100; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 20));
		if (captureChannelLog().some(
			(line) =>
				line.includes('disposed_after_plan_refresh') ||
				line.includes('disposed_before_final_post'),
		)) {
			break;
		}
	}

	const cachedPostsAfter = webviewPanel.webview.postedMessages.filter(
		(message) =>
			!!message && typeof message === 'object' && (message as { type?: string }).type === 'data',
	).length;
	assert.equal(
		cachedPostsAfter,
		cachedPostsBefore,
		'the cached post already landed; no further data postMessage after dispose',
	);
	const log = captureChannelLog();
	// The exact checkpoint that fires depends on the timing of
	// `release()` relative to the `dispose()` path. Both the
	// post-plan-refresh and the pre-final-post checkpoints are
	// valid; what matters is that SOMETHING between the plan
	// refresh and the final postData short-circuited the race,
	// and no warn-level `dashboard.refresh.fail` line slipped
	// through.
	const checkpointed = log.some(
		(line) =>
			line.includes('disposed_after_plan_refresh') ||
			line.includes('disposed_before_final_post'),
	);
	assert.ok(
		checkpointed,
		`expected a dispose-skip line between plan refresh and final post. saw:\n${log.join('\n')}`,
	);
	// The dashboard refresh operation emits `.fail` (not
	// `refresh failed`) on a true failure path; we don't want
	// any `.fail` line here either.
	assert.equal(
		log.filter((line) => line.includes('dashboard.refresh.fail')).length,
		0,
		'no dashboard.refresh.fail line should appear',
	);
});

// ---------------------------------------------------------------------------
// Test 3 — VS Code "Webview is disposed" throw → debug, not warn
// ---------------------------------------------------------------------------

test('DashboardPanel: webview-is-disposed throw from postMessage is swallowed as debug', async () => {
	const panel = showPanelWith({});
	const webviewPanel = mockState.webviewPanels[0]!;

	// Wait for the initial `void instance.refresh()` from
	// `DashboardPanel.show` to LAND its cached postMessage.
	// After this, the initial refresh is still in-flight (it's
	// awaiting the plan/mmx refreshes), but its cached view has
	// already been delivered. We deliberately replace postMessage
	// NOW so that subsequent refreshes throw on every post.
	const initialDeadline = Date.now() + 2_000;
	while (webviewPanel.webview.postedMessages.length === 0 && Date.now() < initialDeadline) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.ok(
		webviewPanel.webview.postedMessages.length > 0,
		'initial refresh should have posted at least the cached view before we mutate postMessage',
	);

	// Drain any pending work so the initial refresh has fully
	// completed its do-while (the initial refresh's
	// `pendingRefresh` was false because nothing scheduled a
	// follow-up, so the loop exits after the first iteration).
	for (let i = 0; i < 50; i += 1) {
		if (captureChannelLog().some((line) => line.includes('refresh loop end'))) break;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}

	// Now poison postMessage. EVERY postMessage from this point
	// on will throw "Webview is disposed" — the exact message
	// VS Code throws in production when the webview has been
	// torn down out from under the host.
	const originalPost = webviewPanel.webview.postMessage;
	let throwCount = 0;
	webviewPanel.webview.postMessage = () => {
		throwCount += 1;
		throw new Error('Webview is disposed (test)');
	};
	void originalPost;

	const beforeLog = captureChannelLog().length;
	// Trigger a fresh refresh via the public API. The first
	// postMessage inside `refreshOnce` (the cached-view post)
	// will throw "Webview is disposed". The lifecycle gate must
	// (a) not propagate, (b) downgrade to a debug skip line
	// rather than the old "Dashboard refresh failed" warning.
	await assert.doesNotReject(
		async () => (panel as unknown as { refresh(): Promise<void> }).refresh(),
	);
	// Drain long enough for the catch handler to log and for the
	// do-while loop to terminate. The first postData triggers
	// the throw, the catch logs a debug skip, and the next
	// iteration's entry checkpoint logs another skip.
	for (let i = 0; i < 100; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 20));
		if (captureChannelLog().slice(beforeLog).some((line) => line.includes('disposed_throw'))) {
			break;
		}
	}

	const log = captureChannelLog().slice(beforeLog);
	// Sanity-print the state if the assertion below fails so the
	// failure message includes the throwCount and the channel log.
	const detail = `throwCount=${throwCount} log=${JSON.stringify(log)}`;
	// The dashboard refresh operation emits `.fail` (not
	// `refresh failed`) on a true failure path; we don't want
	// any `.fail` line here either.
	const escalated = log.filter(
		(line) => line.includes('dashboard.refresh.fail'),
	);
	assert.equal(
		escalated.length,
		0,
		`Webview-is-disposed must NOT escalate to dashboard.refresh.fail. saw: ${JSON.stringify(escalated)} detail=${detail}`,
	);
	// And the debug skip must be present so a future maintainer
	// can still trace the lifecycle event.
	assert.ok(
		throwCount > 0,
		`postMessage replacement must have fired at least once. throwCount=${throwCount} detail=${detail}`,
	);
	assert.ok(
		log.some((line) => line.includes('disposed_throw')),
		`expected a disposed_throw debug skip line. throwCount=${throwCount} detail=${detail}`,
	);

	// Restore the mock for other tests in this file.
	webviewPanel.webview.postMessage = originalPost;
});

// ---------------------------------------------------------------------------
// Test 4 — `dispose()` clears `pendingRefresh`
// ---------------------------------------------------------------------------

test('DashboardPanel: dispose clears pendingRefresh — late triggers do not resurrect the panel', async () => {
	const panel = showPanelWith({});
	await new Promise((resolve) => setImmediate(resolve));
	const webviewPanel = mockState.webviewPanels[0]!;

	// Reach into the private `refreshSeq` so we can identify the
	// sequence id the next `refresh()` will assign. The exact
	// value is an implementation detail; what matters is that
	// the next refresh increments it.
	const refreshSeq = (panel as unknown as { refreshSeq: number }).refreshSeq;
	const nextSeq = refreshSeq + 1;

	// Close the panel, then poke the private `pendingRefresh`
	// flag to mimic the race where a subscriber callback (e.g.
	// `auth.onDidChangeApiKey` firing during teardown) sets the
	// flag on a panel that is already on its way out.
	webviewPanel.dispose();
	(panel as unknown as { pendingRefresh: boolean }).pendingRefresh = true;
	(panel as unknown as { pendingRefreshForce: boolean }).pendingRefreshForce = true;

	const beforeLog = captureChannelLog().length;
	await (panel as unknown as { refresh(): Promise<void> }).refresh();
	await new Promise((resolve) => setImmediate(resolve));

	const log = captureChannelLog().slice(beforeLog);
	// Either the refresh short-circuited at the entry checkpoint
	// (seq matches the pre-disposed counter) or it never made
	// past the entry. In both cases no refresh should emit a
	// `dashboard.refresh.start` line carrying the post-dispose
	// traceId, because the panel must NOT honour a refresh
	// request issued after dispose.
	const startedFreshRefresh = log.some(
		(line) =>
			line.includes('dashboard.refresh.start') &&
			line.includes(`traceId=dashboard.refresh#${nextSeq}`),
	);
	assert.equal(
		startedFreshRefresh,
		false,
		`disposed panel must not start a new refresh. saw:\n${log.join('\n')}`,
	);
	const skip = hasSkipLine(log, nextSeq);
	// Either the entry-checkpoint skip is there, or the refresh
	// was a complete no-op (no start line at all). Both are
	// acceptable; a dashboard.refresh.fail is NOT.
	assert.equal(
		log.filter((line) => line.includes('dashboard.refresh.fail')).length,
		0,
		`pendingRefresh set after dispose must not resurrect a fail line. saw: ${JSON.stringify(
			log.filter((line) => line.includes('dashboard.refresh.fail')),
		)}`,
	);
	// When `refresh()` was already mid-flight, the entry
	// checkpoint will skip with a reason; when it wasn't, no skip
	// line is emitted either. We don't assert on skip explicitly
	// here — the absence of `start` and `dashboard.refresh.fail`
	// is the load-bearing assertion.
	void skip;
});

// ---------------------------------------------------------------------------
// Test 5 — happy-path operation: every dashboard.refresh emits a
// complete `start → … → end` traceable by traceId.
// ---------------------------------------------------------------------------

test('DashboardPanel: happy-path refresh emits a start→end span with matching traceId', async () => {
	showPanelWith({});
	const webviewPanel = mockState.webviewPanels[0]!;
	// Wait for the initial refresh to land its first post so we
	// know the panel is past `refreshOnce` entry.
	const initialDeadline = Date.now() + 2_000;
	while (webviewPanel.webview.postedMessages.length === 0 && Date.now() < initialDeadline) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	// Drain until every observed start has a matching end. The
	// webview `ready` message may queue a follow-up refresh while
	// the first one is in flight, so a single `loop.end` line is
	// too early: a second start can already be logged while its end
	// is still pending.
	await waitForClosedRefreshSpans();
	const log = captureChannelLog();
	// Every `dashboard.refresh.start` line must have a matching
	// `dashboard.refresh.end` line carrying the same traceId.
	const startTraces = log
		.filter((line) => line.startsWith('[dashboard.refresh.start]'))
		.map((line) => {
			const match = line.match(/traceId=(dashboard\.refresh#\d+)/);
			return match?.[1] ?? null;
		})
		.filter((t): t is string => t !== null);
	const endTraces = log
		.filter((line) => line.startsWith('[dashboard.refresh.end]'))
		.map((line) => {
			const match = line.match(/traceId=(dashboard\.refresh#\d+)/);
			return match?.[1] ?? null;
		})
		.filter((t): t is string => t !== null);
	assert.ok(startTraces.length >= 1, 'expected at least one start');
	// Each start traceId MUST appear in the end list — the
	// operation close-once contract means end is exactly-once,
	// so the traceId set is equal.
	assert.deepEqual(
		new Set(startTraces),
		new Set(endTraces),
		`start/end traceId mismatch. starts=${JSON.stringify(startTraces)} ends=${JSON.stringify(endTraces)}`,
	);
	// `dashboard.refresh.end` carries an `elapsedMs` field.
	const endWithElapsed = log.find(
		(line) => line.startsWith('[dashboard.refresh.end]') && line.includes('elapsedMs='),
	);
	assert.ok(endWithElapsed, 'end record should carry elapsedMs');
});
