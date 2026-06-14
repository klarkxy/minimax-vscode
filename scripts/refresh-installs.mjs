#!/usr/bin/env node
// scripts/refresh-installs.mjs
//
// Polls the public VS Code Marketplace Gallery API for the install count
// of `klarkxy.minimax-vscode-copilot`, appends a (date, install) point to
// `data/installs.json`, and re-renders the Mermaid xychart block between
// the `<!-- installs:start/end -->` markers in README.md / README.zh.md.
//
// The Gallery API is the same one VS Code itself uses when browsing the
// marketplace in the IDE; no auth is required.
//
// Designed to run from the daily GitHub Action in
// .github/workflows/installs.yml, but also works locally:
//
//   node scripts/refresh-installs.mjs

import { readFile, writeFile } from 'node:fs/promises';

export const EXT_ID = 'klarkxy.minimax-vscode-copilot';
export const DATA_PATH = 'data/installs.json';
const READMES = ['README.md', 'README.zh.md'];
const MARKER_RE = /<!-- installs:start -->[\s\S]*?<!-- installs:end -->/;

/** Fetch the current install count from the Marketplace Gallery API. */
export async function fetchInstall() {
	const r = await fetch(
		'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery',
		{
			method: 'POST',
			// The Gallery API now requires an explicit api-version; without it
			// the request is rejected with HTTP 400 "VssVersionNotSpecifiedException".
			// `7.2-preview.1` is the latest preview that still exposes `statistics`.
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json; api-version=7.2-preview.1',
			},
			body: JSON.stringify({
				filters: [{ criteria: [{ filterType: 7, value: EXT_ID }] }],
				// Flag bits: 0x1=IncludeVersions, 0x100=IncludeStatistics.
				// The script only needs statistics, so omit versions to keep the
				// payload small. Note: 0x1 is NOT IncludeStatistics — that was a
				// pre-existing bug masked by the 400 error.
				flags: 0x100,
			}),
		},
	);
	if (!r.ok) throw new Error(`Marketplace API HTTP ${r.status}`);
	const data = await r.json();
	const stats = data?.results?.[0]?.extensions?.[0]?.statistics ?? [];
	const install = stats.find(s => s.statisticName === 'install')?.value;
	if (typeof install !== 'number') {
		throw new Error(`install statistic missing (got: ${JSON.stringify(stats)})`);
	}
	return install;
}

/** Load the history from disk; returns [] if the file does not exist yet. */
export async function loadHistory(path = DATA_PATH) {
	try {
		const raw = await readFile(path, 'utf8');
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch (err) {
		if (err && err.code === 'ENOENT') return [];
		throw err;
	}
}

/**
 * Append a new (date, install) point to the history. If the most recent
 * point has the same date, overwrite it in place so same-day re-runs do
 * not pad the chart with duplicates.
 */
export function appendPoint(history, point) {
	const last = history.at(-1);
	if (last && last.date === point.date) {
		history[history.length - 1] = point;
	} else {
		history.push(point);
	}
	return history;
}

/** Render the Mermaid xychart-beta block. Falls back to a placeholder on empty. */
export function renderMermaid(history) {
	if (history.length === 0) {
		return '_No data yet — the first daily run will populate this._';
	}
	const dates = history.map(p => p.date);
	const counts = history.map(p => p.install);
	const yMax = Math.max(...counts, 10);
	const yAxisMax = Math.ceil(yMax * 1.1);
	return [
		'```mermaid',
		'xychart-beta',
		'    title "Marketplace installs"',
		`    x-axis [${dates.join(', ')}]`,
		`    y-axis "Installs" 0 --> ${yAxisMax}`,
		`    line [${counts.join(', ')}]`,
		'```',
	].join('\n');
}

/** Replace the marker block in `file` with a freshly rendered chart. */
export async function updateReadme(file, history) {
	const md = await readFile(file, 'utf8');
	if (!MARKER_RE.test(md)) {
		return { updated: false, reason: 'markers not found' };
	}
	const block = `<!-- installs:start -->\n${renderMermaid(history)}\n<!-- installs:end -->`;
	await writeFile(file, md.replace(MARKER_RE, block));
	return { updated: true };
}

export async function main() {
	const install = await fetchInstall();
	const today = new Date().toISOString().slice(0, 10);
	const history = await loadHistory();
	appendPoint(history, { date: today, install });
	await writeFile(DATA_PATH, JSON.stringify(history, null, 2) + '\n');
	for (const f of READMES) {
		const r = await updateReadme(f, history);
		console.log(`[installs] ${f}: ${r.updated ? 'updated' : `skipped (${r.reason})`}`);
	}
	console.log(`[installs] current install = ${install} (history length = ${history.length})`);
}

// Run only when invoked directly, not when imported by tests.
// `import.meta.url` is a real `file://...` string when Node runs this file
// as ESM (e.g. `node scripts/refresh-installs.mjs`), and the empty string
// when esbuild bundles it into the CJS test output — so a truthy check
// is enough to disambiguate.
if (import.meta.url) {
	main().catch(err => {
		console.error('[installs] failed:', err);
		process.exit(1);
	});
}
