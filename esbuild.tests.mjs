// Build the unit test bundle.
//
// The extension itself is bundled as a single CJS file (out/extension.js)
// by esbuild.mjs. For the tests, however, we keep a CommonJS module per
// test file so Node's built-in test runner can import them with
// `node --test`. esbuild produces a CJS bundle per entry while still
// sharing the production source via normal `import` statements.

import * as esbuild from "esbuild";
import * as path from "node:path";
import { glob } from "node:fs/promises";

const entries = [];
for await (const file of glob("test/**/*.test.ts")) {
	entries.push(file);
}

if (entries.length === 0) {
	console.log("No test files found under test/");
	process.exit(0);
}

await esbuild.build({
	entryPoints: entries,
	outdir: "out-test",
	bundle: true,
	platform: "node",
	target: "node20",
	format: "cjs",
	sourcemap: true,
	logLevel: "info",
	external: ["node:test", "node:assert", "node:fs", "node:path", "node:url"],
	alias: {
		vscode: path.resolve("./test/helpers/vscodeMock.ts").replace(/\\/g, "/"),
	},
});
