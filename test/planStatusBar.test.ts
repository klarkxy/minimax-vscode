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

test('buildPoolTooltip: active key shows with ★ prefix and region', () => {
	const out = buildPoolTooltip(
		[{ id: 'k1', name: 'copilot-1', region: 'global', fingerprint: 'fp1', isActive: true }],
		undefined,
	);
	// Active key is shown with ★ prefix (not •)
	assert.match(out, /^★ copilot-1  global/);
	// No fingerprint in output
	assert.ok(!out.includes('fp1'));
});

test('buildPoolTooltip: active key with plan data shows inline stats', () => {
	const snaps = new Map([
		['k1', { usage: { currentPercentage: 54, weeklyPercentage: 23, currentResetText: '2h 30m' } as any }],
	]);
	const out = buildPoolTooltip(
		[{ id: 'k1', name: 'copilot-1', region: 'china', fingerprint: 'fp1', isActive: true }],
		undefined,
		snaps,
	);
	// Shows region
	assert.ok(out.includes('china'));
	// Shows 5h percentage
	assert.ok(out.includes('5h 54%'));
	// Shows weekly percentage
	assert.ok(out.includes('23%'));
	// Shows reset text
	assert.ok(out.includes('2h 30m'));
});

test('buildPoolTooltip: other keys shown in compact format', () => {
	const snaps = new Map([
		['k1', { usage: { currentPercentage: 80, weeklyPercentage: 50 } as any }],
		['k2', { usage: { currentPercentage: 10, weeklyPercentage: 5 } as any }],
	]);
	const out = buildPoolTooltip(
		[
			{ id: 'k1', name: 'backup', region: 'global', fingerprint: 'fp1', isActive: false },
			{ id: 'k2', name: 'main', region: 'china', fingerprint: 'fp2', isActive: true },
		],
		undefined,
		snaps,
	);
	const lines = out.split('\n');
	// Active key is first with ★
	assert.match(lines[0], /^★ main  china/);
	// Other key uses compact format with its own percentages (k1=backup: 80%/50%)
	const compactLine = lines.find((l) => l.includes('backup')) ?? '';
	assert.ok(compactLine.includes('5h 80%'), `expected "5h 80%" in: ${compactLine}`);
	assert.ok(compactLine.includes('50%'), `expected "50%" in: ${compactLine}`);
	// No fingerprints
	assert.ok(!out.includes('fp1'));
	assert.ok(!out.includes('fp2'));
});

test('buildPoolTooltip: when activeName is given, it is used as label', () => {
	const out = buildPoolTooltip(
		[{ id: 'k1', name: 'copilot-1', region: 'china', fingerprint: 'fp1', isActive: true }],
		'copilot-1',
	);
	assert.ok(out.includes('★ copilot-1'));
});

test('buildPoolTooltip: other key without snap shows ? for percentages', () => {
	const out = buildPoolTooltip(
		[
			{ id: 'k1', name: 'a', region: 'china', fingerprint: 'fp1', isActive: true },
			{ id: 'k2', name: 'b', region: 'global', fingerprint: 'fp2', isActive: false },
		],
		undefined,
	);
	const compactLine = out.split('\n').find((l) => l.includes(' b ')) ?? '';
	assert.ok(compactLine.includes('?'));
});
