// Server-side helpers for the dashboard webview template.
//
// The dashboard's HTML/CSS/JS is intentionally a single inline
// template literal in `panel.ts#renderHtml` (it ships inside the
// webview's HTML and never round-trips through a webview resource
// URI). What we CAN extract to TypeScript are the small pure
// helpers the inline JS needs: HTML escaping, JSON-embedding
// escaping, and the `<script id="i18n">` payload builder.
//
// All helpers in this module are intentionally vscode-free so they
// can be unit-tested without the vscode mock.

/**
 * Escape a string for safe embedding inside a double-quoted HTML
 * attribute. The five characters we replace are the ones the HTML
 * spec requires entities for inside an attribute value; the
 * `</script>`-injection guard is not here because this helper is
 * for attribute values, not for the JSON payload below.
 */
export function escapeHtml(value: unknown): string {
	if (value === null || value === undefined) {
		return '';
	}
	return String(value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/**
 * Serialise a value as a JSON string safe to embed inside a
 * `<script type="application/json">` block. The only transformation
 * beyond `JSON.stringify` is the `</`-escape — without it, a value
 * containing the literal characters `</` would close the script
 * element and let an attacker inject markup. JSON's own escaping
 * (backslashes, double-quotes, control chars) is already safe.
 */
export function escapeJsonForScript(value: unknown): string {
	return JSON.stringify(value).replace(/</g, '\\u003c');
}

/**
 * Pick the HTML `lang` attribute for the dashboard webview root.
 * Chinese users get `zh-CN` (the locale code VS Code reports);
 * everyone else gets `en` (the dashboard's only other fully-
 * translated locale today).
 */
export function htmlLangFor(locale: 'en' | 'zh'): string {
	return locale === 'zh' ? 'zh-CN' : 'en';
}
