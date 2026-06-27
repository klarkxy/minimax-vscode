// Unit tests for `src/dashboard/planStatusBar.ts`.
//
// The status bar's rendering logic is mostly pure helpers
// (`buildPoolTooltip`, `usedPctOf`, `remainingPctOf`, `emptyText`)
// that decide which i18n strings / colour to apply. The full
// `createPlanStatusBar` factory depends on the real `vscode` API,
// so we exercise the public surface through the mock's status-bar
// factory and assert on the captured `text` / `tooltip` strings.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildPoolTooltip } from '../src/dashboard/planStatusBar.js';
import { t } from '../src/i18n.js';

// ---- buildPoolTooltip (pure) ---------------------------------------

test('buildPoolTooltip: empty pool returns empty string', () => {
	assert.equal(buildPoolTooltip(undefined, undefined), '');
	assert.equal(buildPoolTooltip([], undefined), '');
});

test('buildPoolTooltip: single key without activeName shows just the bullet line', () => {
	const out = buildPoolTooltip(
		[{ name: 'copilot-1', region: 'global', fingerprint: 'fp1', isActive: true }],
		undefined,
	);
	assert.match(out, /^• copilot-1/);
	assert.ok(!out.includes('Active key'));
	assert.ok(!out.includes('当前 Key'));
});

test('buildPoolTooltip: active marker appears next to the active key only', () => {
	const out = buildPoolTooltip(
		[
			{ name: 'a', region: 'china', fingerprint: 'fpA', isActive: false },
			{ name: 'b', region: 'global', fingerprint: 'fpB', isActive: true },
		],
		undefined,
	);
	// The active marker for the current locale is appended to the
	// active row only. We don't pin the exact translated form —
	// only that the active row carries the marker and the inactive
	// row does not.
	const activeMarker = t('statusBar.plan.activeMarker');
	const activeLine = out.split('\n').find((l) => l.includes('b')) ?? '';
	const inactiveLine = out.split('\n').find((l) => l.includes('a')) ?? '';
	assert.ok(activeLine.includes(activeMarker), `expected "${activeMarker}" on active line, got: ${activeLine}`);
	assert.ok(!inactiveLine.includes(activeMarker), `inactive line should not carry marker, got: ${inactiveLine}`);
});

test('buildPoolTooltip: when activeName is given, header is prepended', () => {
	const out = buildPoolTooltip(
		[{ name: 'copilot-1', region: 'china', fingerprint: 'fpA', isActive: true }],
		'copilot-1',
	);
	const header = t('statusBar.plan.activeKey', 'copilot-1');
	assert.ok(out.startsWith(header), `expected header to lead, got: ${out}`);
	assert.ok(out.includes('• copilot-1'));
});
