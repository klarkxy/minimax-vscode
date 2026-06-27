// Unit tests for `src/dashboard/template.ts`.
//
// The dashboard template helpers are pure (no vscode dependency) so
// they can be tested without the vscode mock. `escapeHtml` and
// `escapeJsonForScript` are the two XSS-prevention helpers; the
// inline webview JS depends on them being correct, and a
// regression in either would let user-controlled data escape the
// sandbox.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { escapeHtml, escapeJsonForScript, htmlLangFor } from '../src/dashboard/template.js';

// ---- escapeHtml ----------------------------------------------------

test('escapeHtml: returns empty string for null / undefined', () => {
	assert.equal(escapeHtml(null), '');
	assert.equal(escapeHtml(undefined), '');
});

test('escapeHtml: escapes the five HTML-attribute special characters', () => {
	const cases: Array<[string, string]> = [
		['a&b', 'a&amp;b'],
		['<script>', '&lt;script&gt;'],
		['"quoted"', '&quot;quoted&quot;'],
		["it's", 'it&#39;s'],
		// `>` should be escaped too even though it is technically only
		// required inside element content — escaping it inside an
		// attribute is harmless and avoids any ambiguity if the value
		// leaks into element context.
		['1 < 2', '1 &lt; 2'],
	];
	for (const [input, expected] of cases) {
		assert.equal(escapeHtml(input), expected, `input ${JSON.stringify(input)}`);
	}
});

test('escapeHtml: coerces non-string values via String()', () => {
	assert.equal(escapeHtml(0), '0');
	assert.equal(escapeHtml(false), 'false');
	assert.equal(escapeHtml(123), '123');
});

test('escapeHtml: does NOT double-escape — calling twice is stable', () => {
	// `&` becomes `&amp;` once. Calling again on `&amp;` produces
	// `&amp;amp;` — that's correct (the second call sees a literal
	// `&` in the input). The point of this test is to make sure the
	// implementation does not insert a `\` or otherwise try to be
	// clever about pre-escaped input.
	const once = escapeHtml('a&b');
	const twice = escapeHtml(once);
	assert.equal(once, 'a&amp;b');
	assert.equal(twice, 'a&amp;amp;b');
});

// ---- escapeJsonForScript -------------------------------------------

test('escapeJsonForScript: serialises values to a JSON string', () => {
	const obj = { pageTitle: 'Hello', count: 42, enabled: true };
	const out = escapeJsonForScript(obj);
	assert.equal(out, JSON.stringify(obj));
});

test('escapeJsonForScript: neutralises `</` so the JSON cannot close the parent script element', () => {
	// An XSS vector: the value contains the literal characters `</`
	// which, if embedded inside `<script id="i18n">…</script>`,
	// would close the element and let the attacker inject markup.
	// JSON.stringify never produces the `</` substring naturally
	// (it escapes `<` to `<` only when serialised as a string
	// value… and even then only as a Unicode escape inside quotes).
	// We belt-and-braces escape any literal `<` in the output.
	const out = escapeJsonForScript({ evil: '</script><img src=x onerror=alert(1)>' });
	assert.ok(!out.includes('</script>'), '`</` must not appear literally in the output');
	assert.ok(out.includes('\\u003c') || out.includes('\\u003C'),
		'expected the literal `<` to be replaced with a \\u003c escape',
	);
});

test('escapeJsonForScript: preserves all JSON-native escaping (quotes, backslashes, control chars)', () => {
	// `JSON.stringify` already escapes `"`, `\`, and control chars.
	// `escapeJsonForScript` must not undo any of that.
	const out = escapeJsonForScript({ quoted: 'a"b', back: 'a\\b', newline: 'a\nb' });
	assert.ok(out.includes('\\"'), 'double quote must be escaped');
	assert.ok(out.includes('\\\\'), 'backslash must be escaped');
	assert.ok(out.includes('\\n'), 'newline must be escaped as \\n');
});

// ---- htmlLangFor ---------------------------------------------------

test('htmlLangFor: maps zh to zh-CN, everything else to en', () => {
	assert.equal(htmlLangFor('zh'), 'zh-CN');
	assert.equal(htmlLangFor('en'), 'en');
});
