// Regression tests for the **VS Code "Manage Language Models" context-size column**.
//
// Background: VS Code's `chatModelsWidget.ts`
// (`src/vs/workbench/contrib/chat/browser/chatManagement/chatModelsWidget.ts`,
// `TokenLimitsColumnRenderer.renderModelElement` ~line 779) renders the
// picker's context-size column by **summing** `maxInputTokens + maxOutputTokens`
// and then formatting the total via `formatTokenCount()`
// (`src/vs/base/common/numbers.ts`). The contract for the picker column is:
//
//   `displayedContextSize = formatTokenCount(maxInputTokens + maxOutputTokens)`
//
// with these bands (`formatTokenCount` rules):
//   - total >= 1_000_000         → "X.YM" (floored to 0.1M)
//   - 900_000 < total < 1_000_000 → "1M"  (the explicit band)
//   - total >= 1_000              → "XK"  (Math.round(total / 1000))
//   - else                        → toString()
//
// For the M3 family, the desired display is:
//
//   - 1M toggle OFF → "512K"  (the safe default cap most users pay for)
//   - 1M toggle ON  → "1M"    (the lifted cap for users with >512K access)
//
// Setting `maxOutputTokens = 0` on the M3 picker entries makes the sum equal
// to `maxInputTokens` directly, which lets `formatTokenCount` land on the
// desired K/M boundary. Without that tweak the previous `maxOutputTokens:
// 512_000` made the sum cross the 1M threshold (`512K + 512K = 1_024_000 →
// "1M"`) regardless of the toggle state — a misleading "1M" label that
// disagreed with the actual 512K input cap.
//
// This file guards against two regressions:
//
//   1. Anyone bumping `maxOutputTokens` back to a non-zero value, which
//      would silently push the displayed context to "1M" again.
//   2. Anyone changing `getM3ContextWindow()` to a non-512K/non-1M value
//      (e.g. 2M), which would now mis-format as "2M" instead of either
//      "512K" or "1M" depending on the toggle.
//
// The actual upstream rendering lives in `microsoft/vscode` and is
// out-of-scope for this extension; the input we control is the
// `LanguageModelChatInformation` returned from `toChatInfo`. The
// `formatTokenCount` reference implementation is vendored locally for the
// tests below so we don't depend on the upstream source changing.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findModelById, getModels } from '../src/models/registry.js';
import { mockConfig, resetMockConfig } from './helpers/vscodeMock.js';

function setM31MContext(enabled: boolean) {
	mockConfig['minimax.enableM31MContext'] = enabled;
}

/**
 * Local mirror of `vs/base/common/numbers.ts#formatTokenCount` from
 * `microsoft/vscode`. Keep the implementation in lockstep with the
 * upstream helper — the tests below assume the bands documented in the
 * file header.
 */
function formatTokenCount(count: number): string {
	if (count >= 1_000_000) {
		const value = count / 1_000_000;
		const floored = Math.floor(value * 10) / 10;
		return floored % 1 === 0 ? `${floored.toFixed(0)}M` : `${floored.toFixed(1)}M`;
	}
	if (count > 900_000) {
		return '1M';
	}
	if (count >= 1000) {
		return `${Math.round(count / 1000)}K`;
	}
	return count.toString();
}

/** Replicate the upstream column-renderer sum. */
function displayedContextSize(maxInputTokens: number, maxOutputTokens: number): string {
	return formatTokenCount((maxInputTokens ?? 0) + (maxOutputTokens ?? 0));
}

test.beforeEach(() => {
	resetMockConfig();
});

test('M3 picker displays "512K" when the 1M toggle is off (regression: was "1M")', () => {
	setM31MContext(false);
	const m3 = findModelById('MiniMax-M3')!;
	assert.equal(m3.maxInputTokens, 512_000);
	assert.equal(
		displayedContextSize(m3.maxInputTokens, m3.maxOutputTokens),
		'512K',
		'M3 context-size column must read "512K" with the toggle off; the previous maxOutputTokens=512_000 produced "1M"',
	);
});

test('M3 picker displays "1M" when the 1M toggle is on', () => {
	setM31MContext(true);
	const m3 = findModelById('MiniMax-M3')!;
	assert.equal(m3.maxInputTokens, 1_000_000);
	assert.equal(
		displayedContextSize(m3.maxInputTokens, m3.maxOutputTokens),
		'1M',
		'M3 context-size column must read "1M" with the toggle on',
	);
});

test('M3-Priority picker tracks the same toggle-driven labels', () => {
	setM31MContext(false);
	const off = findModelById('MiniMax-M3-Priority')!;
	assert.equal(displayedContextSize(off.maxInputTokens, off.maxOutputTokens), '512K');

	setM31MContext(true);
	const on = findModelById('MiniMax-M3-Priority')!;
	assert.equal(displayedContextSize(on.maxInputTokens, on.maxOutputTokens), '1M');
});

test('M2.7 / M2.7 (High-Speed) display "205K" — matches the official 204_800 input cap', () => {
	// M2.7 context = 204_800. maxOutputTokens is 0 (same display-only
	// workaround as M3 — see the M3 test for the rationale), so the
	// Manage Models column shows formatTokenCount(204_800) = "205K".
	const expected = '205K';
	for (const id of ['MiniMax-M2.7', 'MiniMax-M2.7-highspeed']) {
		const m = findModelById(id)!;
		assert.ok(m);
		assert.equal(
			displayedContextSize(m.maxInputTokens, m.maxOutputTokens),
			expected,
			`${id} context-size column must read "${expected}"`,
		);
	}
});

test('maxOutputTokens stays 0 on every M3 family entry (display-only workaround)', () => {
	// If a future contributor bumps `maxOutputTokens` back to a non-zero
	// value on the M3 family, the upstream column will start mis-formatting
	// (e.g. `512K + 65_536 = 577_536 → "578K"` is a less catastrophic but
	// still misleading display). Pin both family entries to `0` and
	// require an explicit comment when lifting the cap.
	for (const id of ['MiniMax-M3', 'MiniMax-M3-Priority']) {
		for (const enabled of [false, true]) {
			setM31MContext(enabled);
			const m = findModelById(id)!;
			assert.ok(m, `${id} missing from registry under toggle=${enabled}`);
			assert.equal(
				m.maxOutputTokens,
				0,
				`${id}.maxOutputTokens must stay at 0 to keep VS Code's context-size column honest; see registry.ts comments and CLAUDE.md`,
			);
		}
	}
});

test('request layer does NOT read maxOutputTokens from the picker info', () => {
	// Sanity check: confirm the upstream `max_tokens` parameter is sourced
	// from the user's `minimax.maxOutputTokens` setting, not from the
	// picker's `maxOutputTokens` (which we just set to 0). If a future
	// change accidentally clamps `max_tokens` to `modelDef.maxOutputTokens`,
	// requests would be sent with `max_tokens: 0` and the API would
	// 400 every call.
	//
	// We can't easily mock `getMaxTokens()` here without rewiring imports,
	// but we can grep the source for the dangerous pattern and fail the
	// build if it ever creeps back in. The grep matches code uses
	// (`max_tokens: ... modelDef.maxOutputTokens` or
	// `modelDef?.maxOutputTokens`) but not the JSDoc comment block at
	// request.ts:154-162 that mentions the policy.
	const fs = require('node:fs');
	const path = require('node:path');
	const requestTs = fs.readFileSync(
		path.join(process.cwd(), 'src', 'provider', 'request.ts'),
		'utf8',
	);
	// Strip /** … */ block comments so the JSDoc explanation doesn't
	// trigger the regex (the comment literally mentions
	// `modelDef.maxOutputTokens` to explain why we don't clamp).
	const stripped = requestTs.replace(/\/\*[\s\S]*?\*\//g, '');
	// Look for code that assigns `modelDef.maxOutputTokens` into the
	// request path. Allowed: reading `modelDef.maxInputTokens` for body
	// size pre-flight. Forbidden: clamping `max_tokens` to
	// `modelDef.maxOutputTokens`.
	assert.ok(
		!/max_tokens\s*[:=]\s*[^,;\n]*modelDef\.maxOutputTokens/.test(stripped),
		'request.ts must not clamp max_tokens to modelDef.maxOutputTokens; see the JSDoc comment at request.ts:154-162',
	);
});

test('ALL registered models produce a non-empty context-size label', () => {
	// Defensive: any future model that ships with `maxInputTokens = 0`
	// would have its row entirely suppressed by VS Code's
	// `if (modelEntry.metadata.maxInputTokens || modelEntry.metadata.maxOutputTokens)`
	// guard (chatModelsWidget.ts ~line 782). Walk every entry and make
	// sure the sum is large enough that formatTokenCount renders
	// something meaningful.
	for (const enabled of [false, true]) {
		setM31MContext(enabled);
		for (const m of getModels()) {
			const label = displayedContextSize(m.maxInputTokens, m.maxOutputTokens);
			assert.ok(
				label && label !== '0',
				`${m.id} (toggle=${enabled}) renders an empty context-size label; sum is ${m.maxInputTokens + m.maxOutputTokens}`,
			);
		}
	}
});