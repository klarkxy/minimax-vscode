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

import { buildPoolTooltip, renderQuota } from '../src/dashboard/planStatusBar.js';
import { t } from '../src/i18n.js';
import type { PlanUsage } from '../src/dashboard/types.js';

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

test('buildPoolTooltip: weekly unlimited renders infinity in active stats', () => {
	const snaps = new Map([
		['k1', { usage: makeUsage({ currentPercentage: 54, weeklyPercentage: 23, weeklyUnlimited: true, currentResetText: '2h 30m' }) }],
	]);
	const out = buildPoolTooltip(
		[{ id: 'k1', name: 'copilot-1', region: 'china', fingerprint: 'fp1', isActive: true }],
		undefined,
		snaps,
	);
	assert.ok(out.includes(`${t('statusBar.plan.weekly')} ∞`), out);
	assert.ok(!out.includes('23%'), out);
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

test('buildPoolTooltip: other key with weekly unlimited renders infinity compactly', () => {
	const snaps = new Map([
		['k1', { usage: makeUsage({ currentPercentage: 80, weeklyPercentage: 50, weeklyUnlimited: true }) }],
		['k2', { usage: makeUsage({ currentPercentage: 10, weeklyPercentage: 5 }) }],
	]);
	const out = buildPoolTooltip(
		[
			{ id: 'k1', name: 'backup', region: 'global', fingerprint: 'fp1', isActive: false },
			{ id: 'k2', name: 'main', region: 'china', fingerprint: 'fp2', isActive: true },
		],
		undefined,
		snaps,
	);
	const compactLine = out.split('\n').find((l) => l.includes('backup')) ?? '';
	assert.ok(compactLine.includes('5h 80%'), compactLine);
	assert.ok(compactLine.includes('∞'), compactLine);
	assert.ok(!compactLine.includes('50%'), compactLine);
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

// ---- renderQuota (status-bar item colour/text for unlimited state) ----

function makeUsage(over: Partial<PlanUsage> = {}): PlanUsage {
	return {
		modelName: 'MiniMax-M3',
		currentUsed: 0,
		currentTotal: 0,
		currentPercentage: 0,
		currentResetText: '0s',
		weeklyUsed: 0,
		weeklyTotal: 0,
		weeklyPercentage: 0,
		weeklyUnlimited: false,
		weeklyResetText: '0s',
		allModels: [],
		...over,
	};
}

test('renderQuota: weekly unlimited tints the item with the "remote" theme colour', () => {
	// Pinned regression: before this PR, the weekly-unlimited branch
	// returned `color: undefined` (i.e. theme default), which left the
	// "∞" item indistinguishable from a key-state placeholder. The
	// change promoted it to `statusBarItem.remoteForeground` so the
	// user can tell at a glance that the "∞" is a real, intentional
	// "no weekly cap" reading — not a loading/error state.
	const state = { key: 'set' as const, usage: makeUsage({ weeklyUnlimited: true }) };
	const out = renderQuota(state, 'weekly', t('statusBar.plan.weekly'), undefined, '');
	assert.ok(out.color, 'weekly-unlimited must set a non-undefined color');
	assert.equal(
		(out.color as { id: string }).id,
		'statusBarItem.remoteForeground',
		'weekly-unlimited must use the remote (calm/positive) theme colour',
	);
	assert.match(out.text, /∞/);
	assert.equal(out.tooltip, t('statusBar.plan.weeklyUnlimited'));
});

test('renderQuota: weekly with a finite quota uses the used-percent colour scale', () => {
	// Negative case for the change above: a finite weekly quota must
	// still flow through the `usedColor` scale (green / yellow / red),
	// NOT the new "unlimited" branch. The previous behaviour was
	// "everything is theme default" — the regression we're guarding
	// against is someone re-introducing the same flatness to the
	// "in the middle" case.
	const state = {
		key: 'set' as const,
		usage: makeUsage({ weeklyUnlimited: false, weeklyPercentage: 73, weeklyTotal: 100, weeklyUsed: 73 }),
	};
	const out = renderQuota(state, 'weekly', t('statusBar.plan.weekly'), undefined, '');
	assert.ok(out.color, 'finite weekly quota must use a used-percent colour, not undefined');
	assert.equal(
		(out.color as { id: string }).id,
		'statusBarItem.warningForeground',
		'73% used should land in the warning bucket (60 ≤ p < 85)',
	);
	assert.match(out.text, /73%/);
});

test('renderQuota: 5h with no key shows theme default colour and "—" placeholder', () => {
	// The "no key" branch still returns `color: undefined` per the
	// file's design rule ("theme default for null/undefined"). Pinned
	// here so the unlimited-branch change above does not accidentally
	// widen to this case too.
	const state = { key: 'unset' as const };
	const out = renderQuota(state, 'current', t('statusBar.plan.fiveHour'), undefined, '');
	assert.equal(out.color, undefined);
	assert.match(out.text, /—/);
});
