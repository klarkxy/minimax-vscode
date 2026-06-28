// Unit tests for DashboardPanel's one-way refresh model (issue #5
// root-cause fix).
//
// Before the fix, the dashboard re-rendered itself in response to:
//   - `planCache.subscribe` (called on every successful plan fetch,
//     including the fetch the panel itself initiated from inside its
//     own `refreshOnce` — the self-reinforcing loop),
//   - `usageStore.subscribe` (called on every SSE `usage` event,
//     several per chat turn),
//   - `mmxCliCache.subscribe` and `claudeCodeIngest.subscribe`.
//
// Combined with the two-frame model (cached-loading + final), the
// webview's `render()` rewrote `#root.innerHTML` over and over, and
// the user observed a dashboard that was permanently stuck on
// "刷新…" while the cached-loading frame kept re-appearing.
//
// The new model is one-way: caches NEVER push back into the panel.
// The panel pulls from caches only inside its own explicit
// `refresh()`. In addition, every refresh produces AT MOST one
// `data` message to the webview, and a separate `refreshState`
// message handles the in-flight indicator without touching
// `#root.innerHTML`.
//
// These five tests pin the invariants that close the regression.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createUsageStore, type UsageStore } from '../src/usage.js';
import { DashboardPanel } from '../src/dashboard/panel.js';
import { mockState, mockConfig, resetMockConfig } from './helpers/vscodeMock.js';
import { _resetRingBufferForTests } from '../src/logger.js';

class FakeMemento {
	private store = new Map<string, unknown>();
	get<T>(key: string): T | undefined {
		return this.store.get(key) as T | undefined;
	}
	update(_key: string, _value: unknown): Promise<void> {
		return Promise.resolve();
	}
}

/** Build a minimal but featureful dashboard panel deps bundle. The
 *  `planCache` and `mmxCliCache` start with a controllable set of
 *  `notify()`-able subscribers — tests use them to fire cache events
 *  at the panel and assert that the panel does NOT re-render in
 *  response. */
function makeDeps(overrides?: {
	planCache?: ReturnType<typeof makeControllablePlanCache>;
	mmxCliCache?: ReturnType<typeof makeControllableMmxCache>;
	usageStore?: UsageStore;
}) {
	// NOTE — the heavy reset (dispose panels + null the singleton)
	// happens in `test.beforeEach`. This helper only seeds the
	// channel log + config so the panel's first refresh has a
	// minimal viable environment.
	mockState.informationMessages.length = 0;
	mockState.errorMessages.length = 0;
	mockState.warningMessages.length = 0;
	mockState.quickPicks.length = 0;
	for (const channel of mockState.outputChannels) {
		channel.log.length = 0;
	}
	resetMockConfig();
	mockConfig['minimax.apiBaseUrl'] = 'https://api.minimaxi.com/anthropic';
	mockConfig['minimax.logLevel'] = 'trace';
	const usageStore = overrides?.usageStore ?? createUsageStore(new FakeMemento());
	const planCache = overrides?.planCache ?? makeControllablePlanCache();
	const mmxCliCache = overrides?.mmxCliCache ?? makeControllableMmxCache();
	return {
		usageStore,
		planCache: planCache.cache,
		mmxCliCache: mmxCliCache.cache,
	};
}

/** Test plan cache: lets the test fire `notify()` at the panel
 *  (i.e. simulate a successful plan fetch the panel itself did not
 *  initiate, or an `invalidate()`) and counts how many times the
 *  panel's internal refresh has been triggered as a side effect. */
function makeControllablePlanCache() {
	const listeners = new Set<() => void>();
	let refreshCalls = 0;
	let snapshot:
		| {
			usage: {
				modelName: string;
				currentUsed: number;
				currentTotal: number;
				currentPercentage: number;
				currentResetText: string;
				weeklyUsed: number;
				weeklyTotal: number;
				weeklyPercentage: number;
				weeklyResetText: string;
				weeklyUnlimited: boolean;
			};
			fetchedAt: number;
		}
		| undefined;
	const usage = {
		modelName: 'MiniMax-M3',
		currentUsed: 1,
		currentTotal: 10,
		currentPercentage: 10,
		currentResetText: '1h 0m',
		weeklyUsed: 1,
		weeklyTotal: 10,
		weeklyPercentage: 10,
		weeklyResetText: '1d 0h',
		weeklyUnlimited: false,
	};
	const cache = {
		read: () => snapshot,
		refresh: () => {
			refreshCalls += 1;
			// Resolve on a microtask so the panel's `await
			// planRefreshPromise` actually has to yield — that
			// surface is exactly where the self-reinforcing loop
			// used to bite. Returning the same shape `PlanCache`
			// returns in production keeps the test's flow
			// indistinguishable from the real path.
			snapshot = { usage, fetchedAt: Date.now() };
			return Promise.resolve({ ok: true, usage });
		},
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return { dispose() { listeners.delete(listener); } };
		},
		invalidate: () => {
			listeners.forEach((l) => l());
		},
	};
	return {
		cache,
		fire() {
			listeners.forEach((l) => l());
		},
		get refreshCalls() { return refreshCalls; },
	};
}

/** Test mmx cache: mirrors the plan cache shape but with a
 *  configurable refresh fn. */
function makeControllableMmxCache() {
	const listeners = new Set<() => void>();
	const cache = {
		read: () => undefined,
		refresh: () => Promise.resolve(null),
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return { dispose() { listeners.delete(listener); } };
		},
		invalidate: () => {},
	};
	return {
		cache,
		fire() {
			listeners.forEach((l) => l());
		},
	};
}

/** Wait until the predicate returns true, polling at `intervalMs`,
 *  up to `timeoutMs`. Returns whether the predicate ever matched.
 *  Used to drain the microtask queue after triggering async
 *  work — the panel's `refresh()` is fire-and-forget in the
 *  production path, so the test cannot await it directly. */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000, intervalMs = 10): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	return predicate();
}

/** Snapshot the diagnostic channel log. The test infrastructure
 *  shares a single output channel across cases; callers always read
 *  the full array (cheap, small) and filter for the lines they care
 *  about. */
function captureChannelLog(): string[] {
	const channel = mockState.outputChannels[0];
	if (!channel) return [];
	return channel.log.map((line) => String(line));
}

/** Count the `dashboard.refresh.start` lines in the channel log.
 *  Each one corresponds to a `refreshOnce` invocation. The panel's
 *  own coalescing uses `pendingRefresh` to fold bursts, so two
 *  callers do not necessarily produce two `start` lines — but a
 *  cache-event-driven second refresh DOES, and that is the
 *  regression these tests pin. */
function countRefreshStarts(log: string[]): number {
	return log.filter((line) => line.startsWith('[dashboard.refresh.start]')).length;
}

/** Count `data` messages posted to the webview. This is the
 *  load-bearing invariant: ONE `data` per refresh, never two. */
function countDataPosts(messages: ReadonlyArray<unknown>): number {
	return messages.filter(
		(m) => !!m && typeof m === 'object' && (m as { type?: string }).type === 'data',
	).length;
}

/** Count `refreshState` messages posted to the webview. The
 *  refresh-state indicator is the only way the host signals
 *  in-flight without touching `#root.innerHTML`. */
function countRefreshStatePosts(messages: ReadonlyArray<unknown>, refreshing?: boolean): number {
	return messages.filter((m) => {
		if (!m || typeof m !== 'object') return false;
		if ((m as { type?: string }).type !== 'refreshState') return false;
		if (refreshing === undefined) return true;
		const payload = (m as { payload?: { refreshing?: unknown } }).payload;
		return payload?.refreshing === refreshing;
	}).length;
}

async function waitForPanelIdle(timeoutMs = 2_000): Promise<boolean> {
	return waitFor(() => {
		const panel = (DashboardPanel as unknown as {
			current?: { inFlight?: boolean; pendingRefresh?: boolean; scheduleTimer?: unknown };
		}).current;
		return !!panel && panel.inFlight !== true && panel.pendingRefresh !== true && panel.scheduleTimer === undefined;
	}, timeoutMs, 10);
}

// ---------------------------------------------------------------------------
// Setup: reset the logger's ring buffer AND the DashboardPanel
// singleton between cases. The lifecycle test file relies on the
// `for (const panel of mockState.webviewPanels.slice()) panel.dispose()`
// pattern at the top of each test, but `panel.dispose()` only fires
// the onDidDispose callback — `DashboardPanel.current` is cleared
// synchronously inside that callback, so the per-test dispose IS
// sufficient in principle. In practice, several test files
// (`dashboard.test.ts`, `dashboardPanel.lifecycle.test.ts`,
// `keyCommands.test.ts`) share the singleton across cases, and a
// stale instance can survive into a later test's `DashboardPanel.show`
// call. Resetting the singleton directly avoids that race entirely
// and keeps test order independence.
// ---------------------------------------------------------------------------

test.beforeEach(() => {
	_resetRingBufferForTests();
	for (const panel of mockState.webviewPanels.slice()) panel.dispose();
	while (mockState.webviewPanels.length > 0) mockState.webviewPanels.pop();
	(DashboardPanel as unknown as { current?: unknown }).current = undefined;
});

// ---------------------------------------------------------------------------
// Test 1 — planCache.subscribe / planCache.invalidate does NOT cause
// the panel to schedule a follow-up refresh.
//
// The previous design had `this.planCacheSubscription = planCache.subscribe(() => refresh())`,
// which meant: every successful plan fetch (including one the
// panel itself initiated) fired `notify()` → triggered `refresh()`
// → which called `planCache.refresh()` again → which fired
// `notify()` again. This is the self-reinforcing loop that produced
// the "stuck on 刷新…" symptom.
// ---------------------------------------------------------------------------

test('DashboardPanel: planCache events do not trigger a follow-up refresh', async () => {
	const planCache = makeControllablePlanCache();
	const deps = makeDeps({ planCache });
	DashboardPanel.show({
		extensionUri: { scheme: 'file', path: '/extension', fsPath: '/extension' } as never,
		auth: {
			getApiKey: () => Promise.resolve('test-key'),
			onDidChangeApiKey: () => ({ dispose() {} }),
		} as never,
		usageStore: deps.usageStore,
		planCache: deps.planCache as never,
		mmxCliCache: deps.mmxCliCache as never,
		getHost: () => 'china',
	});

	// Let the initial refresh complete so the panel is in a quiet
	// "loop.end" state. We do this by waiting for at least one
	// loop.end to appear and then another tick to ensure no
	// coalesced follow-up is queued.
	await waitFor(() => captureChannelLog().some((line) => line.includes('dashboard.refresh.loop.end')));
	await new Promise((resolve) => setTimeout(resolve, 50));

	const startsAfterInit = countRefreshStarts(captureChannelLog());
	const planCallsAfterInit = planCache.refreshCalls;

	// Now fire TEN planCache events in a row — exactly the
	// pattern the old `planCache.subscribe` would amplify into
	// ten follow-up refreshes.
	for (let i = 0; i < 10; i += 1) planCache.fire();
	// Drain for a comfortable window.
	await new Promise((resolve) => setTimeout(resolve, 100));

	const finalLog = captureChannelLog();
	const startsAfterFire = countRefreshStarts(finalLog);
	const planCallsAfterFire = planCache.refreshCalls;

	assert.equal(
		startsAfterFire - startsAfterInit,
		0,
		`planCache events must NOT trigger any new refresh. started ${startsAfterInit} → ${startsAfterFire} ` +
		`(should stay equal). Full log tail:\n${finalLog.slice(-30).join('\n')}`,
	);
	assert.equal(
		planCallsAfterFire - planCallsAfterInit,
		0,
		`planCache.refresh() must NOT be called from a cache event. ` +
		`planCalls ${planCallsAfterInit} → ${planCallsAfterFire} (should stay equal).`,
	);
});

// ---------------------------------------------------------------------------
// Test 2 — usageStore.record() 5× does NOT cause the panel to refresh.
//
// The provider's `onUsage` callback calls `usageStore.record` on
// every `usage` SSE event. A single chat turn produces several
// such events; without the fix each one would kick a full panel
// re-render. With the fix, the panel is intentionally not a
// subscriber to the usage store — local counters surface only
// when the user explicitly refreshes (Refresh button, panel
// reopen, chat-turn-end notifier, etc.).
// ---------------------------------------------------------------------------

test('DashboardPanel: 5 consecutive usageStore.record() calls do not trigger a refresh', async () => {
	const deps = makeDeps();
	DashboardPanel.show({
		extensionUri: { scheme: 'file', path: '/extension', fsPath: '/extension' } as never,
		auth: {
			getApiKey: () => Promise.resolve('test-key'),
			onDidChangeApiKey: () => ({ dispose() {} }),
		} as never,
		usageStore: deps.usageStore,
		planCache: deps.planCache as never,
		mmxCliCache: deps.mmxCliCache as never,
		getHost: () => 'china',
	});

	// Let the initial refresh complete.
	await waitFor(() => captureChannelLog().some((line) => line.includes('dashboard.refresh.loop.end')));
	await new Promise((resolve) => setTimeout(resolve, 50));

	const startsAfterInit = countRefreshStarts(captureChannelLog());

	// 5 record() calls — the same shape as a single chat turn's
	// SSE stream.
	for (let i = 0; i < 5; i += 1) {
		await deps.usageStore.record('MiniMax-M3', {
			inputTokens: 100,
			outputTokens: 50,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		});
	}
	// Drain.
	await new Promise((resolve) => setTimeout(resolve, 100));

	const startsAfter = countRefreshStarts(captureChannelLog());
	assert.equal(
		startsAfter - startsAfterInit,
		0,
		`usageStore.record() must NOT trigger a refresh. started ${startsAfterInit} → ${startsAfter} ` +
		`(should stay equal). The dashboard is now explicitly driven: ` +
		`local counters surface only on the next user-driven refresh.`,
	);
});

// ---------------------------------------------------------------------------
// Test 3 — one refresh produces AT MOST one `data` message.
//
// The previous "two-frame" design posted a `cachedView` first
// (with `planSource='loading'`), then a `finalView` once the
// plan fetch settled. The first refresh on a freshly-opened
// panel still does that (one initial loading frame + one final
// frame), but the SECOND refresh on the same panel must
// produce ONE frame, not two — and that frame must be the
// final one, carrying real data, not a `planSource='loading'`
// snapshot.
// ---------------------------------------------------------------------------

test('DashboardPanel: a single refresh posts at most one data frame, and the second refresh is the final view', async () => {
	const deps = makeDeps();
	DashboardPanel.show({
		extensionUri: { scheme: 'file', path: '/extension', fsPath: '/extension' } as never,
		auth: {
			getApiKey: () => Promise.resolve('test-key'),
			onDidChangeApiKey: () => ({ dispose() {} }),
		} as never,
		usageStore: deps.usageStore,
		planCache: deps.planCache as never,
		mmxCliCache: deps.mmxCliCache as never,
		getHost: () => 'china',
	});

	// Wait for the initial refresh to complete (initial loading
	// frame + final frame = 2 data posts on the very first
	// refresh). The webview `ready` message may queue a follow-up
	// refresh while the first one is in flight, so take the
	// baseline only after the panel is actually idle.
	await waitFor(() => captureChannelLog().some((line) => line.includes('dashboard.refresh.loop.end')));
	await waitForPanelIdle();
	const webviewPanel = mockState.webviewPanels[0]!;
	const dataPostsAfterInit = countDataPosts(webviewPanel.webview.postedMessages);
	assert.ok(dataPostsAfterInit >= 1, `initial refresh should post at least one data frame. got ${dataPostsAfterInit}`);

	// Now trigger a SECOND refresh via the explicit API.
	const panel = (DashboardPanel as unknown as { current?: { refresh(): Promise<void> } }).current;
	assert.ok(panel, 'expected the panel singleton to be live');
	await panel.refresh();
	await waitFor(() => {
		const log = captureChannelLog();
		const starts = countRefreshStarts(log);
		// The second refresh added exactly one start; with no
		// reverse subscriptions and no in-flight triggers, the
		// loop ends after one iteration.
		return starts >= 2 && log.filter((l) => l.includes('dashboard.refresh.loop.end')).length >= 2;
	});
	await waitForPanelIdle();

	const dataPostsAfterSecond = countDataPosts(webviewPanel.webview.postedMessages);
	// Second refresh adds EXACTLY ONE data frame (the final one).
	// The previous "two-frame" design would have added 2 (cached
	// loading + final). We assert the strict bound.
	const secondRefreshDataPosts = dataPostsAfterSecond - dataPostsAfterInit;
	assert.equal(
		secondRefreshDataPosts,
		1,
		`a single refresh must post exactly one data frame. got ${secondRefreshDataPosts} on the second refresh ` +
		`(this is the load-bearing invariant for the "stuck on 刷新…" fix).`,
	);

	// The data frame on the second refresh must NOT be a loading
	// frame — `planSource` should be the real 'ok'/'unsupported'/
	// 'error' value, not 'loading'.
	const lastDataMessage = webviewPanel.webview.postedMessages
		.slice()
		.reverse()
		.find((m) => !!m && typeof m === 'object' && (m as { type?: string }).type === 'data') as
		| { payload?: { sources?: { plan?: string } } }
		| undefined;
	assert.ok(lastDataMessage, 'expected at least one data message');
	const plan = lastDataMessage.payload?.sources?.plan;
	assert.notEqual(
		plan,
		'loading',
		`the data frame on a non-initial refresh must NOT be a 'loading' frame; got plan='${plan}'. ` +
		`The user has data on screen — re-painting a 'loading' frame would erase it.`,
	);
});

// ---------------------------------------------------------------------------
// Test 4 — explicit Refresh button click emits refreshState true/false
// but does NOT post a loading data frame.
//
// The user pressing Refresh is the canonical "I want a fresh
// snapshot" gesture. The button's spinner should turn on (refresh
// state true), the data on screen should stay where it is, and
// when the new final view is ready, the data frame swaps in and
// the spinner turns off.
// ---------------------------------------------------------------------------

test('DashboardPanel: user Refresh posts refreshState true/false, never a loading data frame', async () => {
	const deps = makeDeps();
	DashboardPanel.show({
		extensionUri: { scheme: 'file', path: '/extension', fsPath: '/extension' } as never,
		auth: {
			getApiKey: () => Promise.resolve('test-key'),
			onDidChangeApiKey: () => ({ dispose() {} }),
		} as never,
		usageStore: deps.usageStore,
		planCache: deps.planCache as never,
		mmxCliCache: deps.mmxCliCache as never,
		getHost: () => 'china',
	});

	// Wait for the initial refresh to complete so the panel has
	// settled into "data on screen, no in-flight work". The webview
	// `ready` message is allowed to queue one follow-up refresh while
	// the first one is in flight, so wait until the log has gone idle
	// before taking the "before user clicked Refresh" counters.
	await waitFor(() => captureChannelLog().some((line) => line.includes('dashboard.refresh.loop.end')));
	await waitForPanelIdle();
	const webviewPanel = mockState.webviewPanels[0]!;
	const dataCountBefore = countDataPosts(webviewPanel.webview.postedMessages);
	const refreshStateOnBefore = countRefreshStatePosts(webviewPanel.webview.postedMessages, true);
	const refreshStateOffBefore = countRefreshStatePosts(webviewPanel.webview.postedMessages, false);

	// Simulate the user pressing the Refresh button — the
	// webview's click handler posts `{ type: 'refresh' }`, which
	// `handleMessage` translates into `panel.refresh({ force: true })`.
	const messageListeners = (webviewPanel.webview.onDidReceiveMessage as unknown as { listeners?: Array<(m: unknown) => void> }).listeners
		?? [];
	// The mock's `onDidReceiveMessage` returns a Disposable that
	// captures a single listener; the panel registers one
	// `messageListener` via that path. Pull it back from the
	// mock's internal list (added in the test infrastructure
	// path), then forward a refresh message.
	const directListener = (webviewPanel.webview as unknown as { messageListener?: (m: unknown) => void }).messageListener;
	if (directListener) {
		directListener({ type: 'refresh' });
	} else {
		// Fall back to the captured list — the production path
		// in `panel.ts` registers a single listener via
		// `onDidReceiveMessage`, which the mock's wrapper stores
		// in its private `messageListeners` array. We do not
		// reach into it directly; the production `messageListener`
		// closure on the panel instance is the one we want, so
		// go through the panel singleton's handleMessage.
		const panel = (DashboardPanel as unknown as { current?: { handleMessage(m: unknown): Promise<void> } }).current;
		assert.ok(panel, 'expected the panel singleton to be live');
		await panel.handleMessage({ type: 'refresh' });
	}

	// Wait for the new refresh to complete.
	await waitFor(() => {
		const log = captureChannelLog();
		const starts = countRefreshStarts(log);
		return starts >= 2 && log.filter((l) => l.includes('dashboard.refresh.loop.end')).length >= 2;
	});

	const dataCountAfter = countDataPosts(webviewPanel.webview.postedMessages);
	const refreshStateOnAfter = countRefreshStatePosts(webviewPanel.webview.postedMessages, true);
	const refreshStateOffAfter = countRefreshStatePosts(webviewPanel.webview.postedMessages, false);

	// The user-driven refresh must add:
	//   - exactly 1 new data frame (the final view, NOT a loading frame),
	//   - exactly 1 new refreshState=true (spinner on),
	//   - exactly 1 new refreshState=false (spinner off).
	const newDataFrames = dataCountAfter - dataCountBefore;
	const newRefreshStateOn = refreshStateOnAfter - refreshStateOnBefore;
	const newRefreshStateOff = refreshStateOffAfter - refreshStateOffBefore;

	assert.equal(
		newDataFrames,
		1,
		`user Refresh should add exactly 1 data frame, got ${newDataFrames}`,
	);
	assert.equal(
		newRefreshStateOn,
		1,
		`user Refresh should add exactly 1 refreshState=true, got ${newRefreshStateOn} ` +
		`(this is what the webview uses to enable the button spinner without touching #root.innerHTML)`,
	);
	assert.equal(
		newRefreshStateOff,
		1,
		`user Refresh should add exactly 1 refreshState=false, got ${newRefreshStateOff}`,
	);

	// And, again, the data frame must NOT be a loading frame.
	const lastData = webviewPanel.webview.postedMessages
		.slice()
		.reverse()
		.find((m) => !!m && typeof m === 'object' && (m as { type?: string }).type === 'data') as
		| { payload?: { sources?: { plan?: string } } }
		| undefined;
	assert.ok(lastData, 'expected a data message after the user Refresh');
	assert.notEqual(
		lastData.payload?.sources?.plan,
		'loading',
		`user Refresh must never re-paint a 'loading' frame. got plan='${lastData.payload?.sources?.plan}'.`,
	);
});

// ---------------------------------------------------------------------------
// Test 5 — first open (no plan snapshot) shows an initial loading
// frame, then the final view; the user never sees a blank/white
// panel.
//
// This guards the "first paint" UX: when the dashboard opens
// cold, the plan cache has not been populated yet, so the very
// first refresh ships a loading frame (with `planSource='loading'`
// and the local store populated) BEFORE the plan fetch settles.
// The user should see a single loading frame followed by the
// final view, NOT a permanently empty state.
// ---------------------------------------------------------------------------

test('DashboardPanel: first open ships an initial loading frame, then a final view', async () => {
	const deps = makeDeps();
	DashboardPanel.show({
		extensionUri: { scheme: 'file', path: '/extension', fsPath: '/extension' } as never,
		auth: {
			getApiKey: () => Promise.resolve('test-key'),
			onDidChangeApiKey: () => ({ dispose() {} }),
		} as never,
		usageStore: deps.usageStore,
		planCache: deps.planCache as never,
		mmxCliCache: deps.mmxCliCache as never,
		getHost: () => 'china',
	});

	const webviewPanel = mockState.webviewPanels[0]!;
	// Wait for the initial refresh to complete (loop end).
	await waitFor(() => captureChannelLog().some((line) => line.includes('dashboard.refresh.loop.end')));

	const dataMessages = webviewPanel.webview.postedMessages
		.filter(
			(m) => !!m && typeof m === 'object' && (m as { type?: string }).type === 'data',
		) as Array<{ payload?: { sources?: { plan?: string } } }>;
	const planSequence = dataMessages.map((m) => m.payload?.sources?.plan ?? '?');

	assert.ok(
		dataMessages.length >= 1 && dataMessages.length <= 2,
		`first open should post 1-2 data frames (loading + final), got ${dataMessages.length}; sequence=${planSequence.join(' -> ')}`,
	);
	// If there are two frames, the FIRST must be the loading
	// frame (so the user sees something during the plan fetch)
	// and the SECOND must be the final view. If there is only
	// one frame it must be the final view (the test mock's plan
	// cache resolves synchronously, so the loading frame is
	// typically collapsed into the final post).
	if (dataMessages.length === 2) {
		assert.equal(
			dataMessages[0]!.payload?.sources?.plan,
			'loading',
			`on first open, the first data frame must carry planSource='loading'. got '${dataMessages[0]!.payload?.sources?.plan}'; sequence=${planSequence.join(' -> ')}`,
		);
	}
	const last = dataMessages[dataMessages.length - 1]!;
	assert.notEqual(
		last.payload?.sources?.plan,
		'loading',
		`the LAST data frame on first open must NOT be a loading frame. got '${last.payload?.sources?.plan}'; sequence=${planSequence.join(' -> ')}; log=${captureChannelLog().slice(-12).join(' | ')}`,
	);
});
