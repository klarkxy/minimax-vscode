// Regression tests for the M3 / M3-Priority picker pricing.
//
// Background: opening the M3 1M context toggle used to also flip the
// picker entry's pricing row to the >512K tier (`m3Large` /
// `m3LargePriority`), which made every token in the picker look
// 1.5×–3× more expensive than the ≤512K base rate the user is
// actually billed for on most requests. The contract is:
//
//   - The picker price column always shows the **≤512K base rate**
//     for the model (¥2.1 / ¥3.15 in CNY; $0.3 / $0.45 in USD).
//   - Lifting the cap to 1M only changes `maxInputTokens` /
//     `maxOutputTokens` on the model definition.
//   - The >512K input portion of an actual request is billed
//     per-token at the rate in `LARGE_CONTEXT_PRICING_KEY[pricingKey]`
//     by the upstream API; the tooltip appends a hint when the
//     picker advertises >512K so the user knows.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getModels, findModelById } from '../src/models/registry.js';
import { formatPricingTooltip } from '../src/provider/models.js';
import { mockConfig, resetMockConfig, env } from './helpers/vscodeMock.js';

const CNY_BASE_URL = 'https://api.minimaxi.com/anthropic';
const USD_BASE_URL = 'https://api.minimax.io/anthropic';

function setM31MContext(enabled: boolean) {
	mockConfig['minimax.enableM31MContext'] = enabled;
}

test.beforeEach(() => {
	resetMockConfig();
	// Force the CN-locale i18n strings for the tooltip-hint assertions
	// below; the default test environment is `en` so the hint would
	// read "**3×** /M ($0.9 input / …)" without the ¥ values.
	env.language = 'zh-cn';
});

test.afterEach(() => {
	env.language = 'en';
});

test('M3 picker shows ≤512K base rate (¥2.1) when 1M toggle is off', () => {
	setM31MContext(false);
	const m3 = findModelById('MiniMax-M3', CNY_BASE_URL);
	assert.ok(m3);
	assert.equal(m3!.maxInputTokens, 512_000);
	assert.equal(m3!.pricing.input, 2.1);
	assert.equal(m3!.pricing.output, 8.4);
	assert.equal(m3!.pricing.cacheRead, 0.42);
});

test('M3 picker STILL shows ≤512K base rate (¥2.1) when 1M toggle is on (regression)', () => {
	// The old buggy behaviour switched the entire pricing row to
	// `m3Large` (¥4.2 / ¥16.8 / ¥0.84) when the toggle was on.
	// After the fix the picker keeps showing the ≤512K base rate;
	// only `maxInputTokens` is lifted.
	setM31MContext(true);
	const m3 = findModelById('MiniMax-M3', CNY_BASE_URL);
	assert.ok(m3);
	assert.equal(m3!.maxInputTokens, 1_000_000);
	assert.equal(m3!.pricing.input, 2.1, 'M3 input price must stay at the ≤512K base rate');
	assert.equal(m3!.pricing.output, 8.4, 'M3 output price must stay at the ≤512K base rate');
	assert.equal(m3!.pricing.cacheRead, 0.42, 'M3 cache-read price must stay at the ≤512K base rate');
});

test('M3 maxInputTokens tracks the toggle exactly: 512K off, 1M on, never 2M', () => {
	// Pin down the contract that `getM3ContextWindow()` is the only
	// place that decides the picker denominator, and that it never
	// doubles the cap. The "位置: N / 2M" symptom in the picker
	// would be a regression of this invariant.
	setM31MContext(false);
	assert.equal(findModelById('MiniMax-M3')!.maxInputTokens, 512_000);
	setM31MContext(true);
	assert.equal(findModelById('MiniMax-M3')!.maxInputTokens, 1_000_000);
	setM31MContext(false);
	assert.equal(findModelById('MiniMax-M3')!.maxInputTokens, 512_000);
});

test('M3-Priority picker STILL shows ≤512K base rate (¥3.15) when 1M toggle is on (regression)', () => {
	setM31MContext(true);
	const m3p = findModelById('MiniMax-M3-Priority', CNY_BASE_URL);
	assert.ok(m3p);
	assert.equal(m3p!.maxInputTokens, 1_000_000);
	assert.equal(m3p!.pricing.input, 3.15, 'M3-Priority input price must stay at the ≤512K base rate');
	assert.equal(m3p!.pricing.output, 12.6, 'M3-Priority output price must stay at the ≤512K base rate');
	assert.equal(m3p!.pricing.cacheRead, 0.63, 'M3-Priority cache-read price must stay at the ≤512K base rate');
});

test('USD pricing follows the same rule: 1M toggle does not change the picker rate', () => {
	// The default test environment is `en`, and the international
	// baseUrl also selects the USD table — CN-locale users default
	// to CNY even on the international host (see `pickPricingTable`).
	// Temporarily switch the env back to `en` for this test only.
	const saved = env.language;
	env.language = 'en';
	try {
		setM31MContext(false);
		const m3Off = findModelById('MiniMax-M3', USD_BASE_URL);
		assert.ok(m3Off);
		assert.equal(m3Off!.pricing.input, 0.3);

		setM31MContext(true);
		const m3On = findModelById('MiniMax-M3', USD_BASE_URL);
		assert.ok(m3On);
		assert.equal(m3On!.maxInputTokens, 1_000_000);
		assert.equal(m3On!.pricing.input, 0.3, 'USD M3 input must stay at the ≤512K base rate');
		assert.equal(m3On!.pricing.output, 1.2);
		assert.equal(m3On!.pricing.cacheRead, 0.06);
	} finally {
		env.language = saved;
	}
});

test('M2.7 family is unaffected by the 1M toggle (no pricing tier split exists)', () => {
	setM31MContext(true);
	const m27 = findModelById('MiniMax-M2.7', CNY_BASE_URL);
	const m27hs = findModelById('MiniMax-M2.7-highspeed', CNY_BASE_URL);
	assert.ok(m27 && m27hs);
	assert.equal(m27!.maxInputTokens, 204_800);
	assert.equal(m27!.pricing.input, 2.1);
	assert.equal(m27hs!.maxInputTokens, 204_800);
	assert.equal(m27hs!.pricing.input, 4.2);
});

test('M3 picker tooltip announces the >512K per-token rate when the toggle is on', () => {
	setM31MContext(true);
	const m3 = findModelById('MiniMax-M3', CNY_BASE_URL);
	assert.ok(m3);
	const tooltip = formatPricingTooltip(m3!);
	// The tooltip must mention the ¥4.2 / 1.5× rate so the user
	// knows what the >512K portion costs without leaving the picker.
	assert.match(tooltip, /1\.5/, 'tooltip should mention the 1.5× multiplier');
	assert.match(tooltip, /¥4\.2/, 'tooltip should mention the ¥4.2 >512K input rate');
	assert.match(tooltip, /¥16\.8/, 'tooltip should mention the ¥16.8 >512K output rate');
});

test('M3-Priority picker tooltip announces the >512K 3× rate when the toggle is on', () => {
	setM31MContext(true);
	const m3p = findModelById('MiniMax-M3-Priority', CNY_BASE_URL);
	assert.ok(m3p);
	const tooltip = formatPricingTooltip(m3p!);
	// Priority variant: 1.5× priority stacked on the 1.5× >512K
	// rate = 3× of the ≤512K base. The CN-locale hint surfaces the
	// stacked ¥6.3 / ¥25.2 / ¥1.26 numbers and the literal "3 倍".
	assert.match(tooltip, /3\s*倍/, 'tooltip should mention the 3× stacked rate');
	assert.match(tooltip, /¥6\.3/);
	assert.match(tooltip, /¥25\.2/);
	assert.match(tooltip, /¥1\.26/);
});

test('M3 picker tooltip does NOT mention the >512K hint when the toggle is off', () => {
	setM31MContext(false);
	const m3 = findModelById('MiniMax-M3', CNY_BASE_URL);
	assert.ok(m3);
	const tooltip = formatPricingTooltip(m3!);
	// The hint is only added once the picker advertises >512K.
	// With the toggle off the tooltip is the standard pricing block.
	assert.doesNotMatch(tooltip, /1\.5/);
	// CN hint wording would show "1\.5 倍" if the hint leaked.
	assert.doesNotMatch(tooltip, /1\.5\s*倍|1\.5×/);
});

test('getModels() returns a fresh M3 entry per toggle state (no cross-contamination)', () => {
	// The previous implementation cached `m3Large` in the returned
	// definition object; mutating the model definitions later (e.g.
	// flipping the toggle) would have leaked the >512K rate into the
	// base view. Confirm the helper re-resolves cleanly.
	setM31MContext(false);
	const off = getModels(CNY_BASE_URL);
	const m3Off = off.find((m) => m.id === 'MiniMax-M3')!;
	assert.equal(m3Off.pricing.input, 2.1);

	setM31MContext(true);
	const on = getModels(CNY_BASE_URL);
	const m3On = on.find((m) => m.id === 'MiniMax-M3')!;
	assert.equal(m3On.maxInputTokens, 1_000_000);
	assert.equal(m3On.pricing.input, 2.1, 'pricing must not carry over the >512K rate');
});
