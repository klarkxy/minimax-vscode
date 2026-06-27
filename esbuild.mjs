import * as esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

// Main extension bundle — Node target, `vscode` external.
const extension = await esbuild.context({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "out/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: !production,
  minify: production,
  treeShaking: true,
  logLevel: "info",
});

// Dashboard webview bundle — browser target, IIFE (the webview
// <script> tag is a plain non-module <script>), no `vscode` import
// (we talk to the host via `acquireVsCodeApi()`, a global the host
// injects at runtime). The host loads this file via
// `webview.asWebviewUri` so the produced filename must stay stable.
const webview = await esbuild.context({
  entryPoints: ["src/dashboard/webview/main.ts"],
  bundle: true,
  outfile: "out/dashboard-webview.js",
  format: "iife",
  platform: "browser",
  target: "es2020",
  sourcemap: !production,
  minify: production,
  treeShaking: true,
  logLevel: "info",
});

if (watch) {
  await Promise.all([extension.watch(), webview.watch()]);
} else {
  await Promise.all([extension.rebuild(), webview.rebuild()]);
  await Promise.all([extension.dispose(), webview.dispose()]);
}
