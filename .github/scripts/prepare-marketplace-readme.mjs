#!/usr/bin/env node
// Strip the `<!-- marketplace-readme:remove-start/end -->` block from the
// source README and write the result to the marketplace README. This lets
// the repo keep a GitHub-specific header (badges, build status, etc.)
// while the VSIX uploaded to the Marketplace only contains a clean
// "what the extension does" page.
//
// The marketplace README is the file that vsce bundles into the VSIX
// (via --readme-path); GitHub continues to use the source README.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const START = /<!--\s*marketplace-readme:remove-start\s*-->/;
const END = /<!--\s*marketplace-readme:remove-end\s*-->/;

const sourceArg = process.argv[2] ?? 'README.md';
const outputArg = process.argv[3] ?? 'dist/README.marketplace.md';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..');
const sourcePath = resolve(repoRoot, sourceArg);
const outputPath = resolve(repoRoot, outputArg);

const raw = await readFile(sourcePath, 'utf8');
const lines = raw.split(/\r?\n/);

let removing = false;
let removedBlocks = 0;
const out = [];

for (const line of lines) {
	if (START.test(line)) {
		if (removing) {
			throw new Error('Nested marketplace-readme remove block.');
		}
		removing = true;
		removedBlocks += 1;
		continue;
	}
	if (END.test(line)) {
		if (!removing) {
			throw new Error('Unexpected marketplace-readme remove end marker.');
		}
		removing = false;
		continue;
	}
	if (!removing) {
		out.push(line);
	}
}

if (removing) {
	throw new Error('Unclosed marketplace-readme remove block.');
}
if (removedBlocks !== 1) {
	throw new Error(
		`Expected 1 marketplace-readme remove block, found ${removedBlocks}.`,
	);
}

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, out.join('\n'), 'utf8');

console.log(`Wrote ${outputPath} (${out.length} lines, ${removedBlocks} block removed).`);
