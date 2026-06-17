#!/usr/bin/env node
// Strip the developer-only sections of README.md so the result is
// safe to publish on the VS Code Marketplace. Run as part of
// `npm run vscode:prepublish` (and directly via `npm run prepare:readme`).
//
// Recognised markers (HTML comments, line-scoped):
//   <!-- marketplace-readme:remove-start --> ... <!-- marketplace-readme:remove-end -->
//       The enclosed block — including the markers themselves — is
//       dropped. Used for "Install from Marketplace" badges and the
//       dev-only buttons (rebuild instructions, etc.) that already
//       exist on the Marketplace page.
//   <!-- marketplace-readme:cut-start --> ... <!-- marketplace-readme:cut-end -->
//       The enclosed block is dropped. Used for downstream sections
//       of the README that are aimed at the source repository
//       (contributing, development setup, etc.) rather than the
//       Marketplace listing.
//
// The output is written to `dist/README.marketplace.md` so `vsce
// package --readme-path dist/README.marketplace.md` picks it up.
//
// Pure Node.js — no npm dependencies. Keep this script zero-dep so
// it runs before `npm install` finishes if needed.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const ROOT = resolve(process.cwd());
const SOURCE = resolve(ROOT, 'README.md');
const OUTPUT = resolve(ROOT, 'dist/README.marketplace.md');

const REMOVE_RE = /[ \t]*<!--\s*marketplace-readme:remove-start\s*-->[^]*?<!--\s*marketplace-readme:remove-end\s*-->\r?\n?/g;
const CUT_RE = /[ \t]*<!--\s*marketplace-readme:cut-start\s*-->[^]*?<!--\s*marketplace-readme:cut-end\s*-->\r?\n?/g;

async function main() {
	const raw = await readFile(SOURCE, 'utf8');
	// Apply cut first (broader removal) then remove. Order does not
	// matter for non-overlapping markers, but both regexes tolerate
	// nesting only by accident — keep the source clean.
	const stripped = raw.replace(CUT_RE, '').replace(REMOVE_RE, '');

	await mkdir(dirname(OUTPUT), { recursive: true });
	await writeFile(OUTPUT, stripped, 'utf8');

	const sourceBytes = Buffer.byteLength(raw, 'utf8');
	const outBytes = Buffer.byteLength(stripped, 'utf8');
	process.stdout.write(
		`prepare-marketplace-readme: wrote ${OUTPUT} ` +
			`(${outBytes} bytes, removed ${sourceBytes - outBytes} bytes)\n`,
	);
}

main().catch((error) => {
	process.stderr.write(
		`prepare-marketplace-readme failed: ${
			error instanceof Error ? error.message : String(error)
		}\n`,
	);
	process.exit(1);
});
