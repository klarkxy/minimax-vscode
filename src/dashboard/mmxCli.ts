// mmx-cli detection, installation, and SKILL management.
//
// The official Token Plan onboarding doc (platform.minimaxi.com/docs/token-plan/minimax-cli)
// describes a three-step flow:
//   1. npm install -g mmx-cli
//   2. mmx auth login --api-key <key>
//   3. npx skills add MiniMax-AI/cli -y -g
//
// This module owns that flow inside the extension so the dashboard and
// the command palette can both surface the same primitives. Everything
// runs through `child_process.execFile` so we never go through a shell —
// the API key (and any other user-supplied data) is passed as argv and
// never ends up in process listings.
//
// `MmxCliStatus` is the small struct that the dashboard consumes; the
// functions in this file return rich `MmxCliCommandResult` objects so
// the caller can show `stdout` / `stderr` to the user when something
// goes wrong.

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import * as vscode from 'vscode';

const execFileAsync = promisify(execFile);

/**
 * Fallback list of directories that may contain `npm.cmd` / `npx.cmd`
 * on Windows. We probe these when `where npm` returns nothing.
 *
 * Why this exists: VS Code on Windows inherits its PATH from the
 * `Environment` registry keys it was launched with. If the user
 * installed Node (or `npm i -g`'d something that added a new bin
 * dir) **after** VS Code was started, the extension process still
 * sees the old PATH and `execFile('npm', …)` fails with
 * `ENOENT: npm not found on PATH` even though `npm --version`
 * works fine in any fresh terminal.
 *
 * We don't touch non-Windows machines (POSIX shells propagate PATH
 * updates immediately on next exec), and the list is ordered by
 * "most likely to be a real install" so we don't get false positives
 * from a stale `nvm` symlink.
 */
const NPM_FALLBACK_DIRS_WIN32: ReadonlyArray<string> = [
	// Default node-windows msi: %ProgramFiles%\nodejs
	path.join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'nodejs'),
	// Per-user npm global install: %AppData%\npm
	path.join(process.env['APPDATA'] ?? '', 'npm'),
	// nvm-windows default install root
	process.env['NVM_HOME']
		? path.join(process.env['NVM_HOME'], process.env['NVM_SYMLINK'] ?? '')
		: '',
	// fnm default install root (newer setups)
	path.join(process.env['LOCALAPPDATA'] ?? '', 'fnm', 'node-versions'),
	// Volta default install root
	path.join(process.env['LOCALAPPDATA'] ?? '', 'Volta', 'bin'),
].filter((dir) => dir.length > 0);

/** npm package name for the CLI; pinned in docs but we just install latest. */
const MMX_CLI_PACKAGE = 'mmx-cli';

/** Skills registry slug used by the official `npx skills add` CLI. */
const MMX_SKILL_SLUG = 'MiniMax-AI/cli';

/** Default install timeout for `npm install -g mmx-cli` (2 minutes). */
const INSTALL_TIMEOUT_MS = 120_000;

/** Smaller timeout for cheap `mmx --version` / `mmx auth status` calls. */
const QUICK_TIMEOUT_MS = 15_000;

/** Per-call ceiling for `mmx quota` and other one-shot commands. */
const RUN_TIMEOUT_MS = 30_000;

/** What the dashboard renders next to "mmx-cli". */
export type MmxCliInstallState = 'unknown' | 'installed' | 'missing';

export type MmxCliAuthState = 'unknown' | 'loggedIn' | 'loggedOut' | 'notInstalled';

export type MmxCliSkillState =
	| 'unknown'
	| 'installed'
	| 'missing'
	| 'notInstalled';

export interface MmxCliStatus {
	install: MmxCliInstallState;
	version: string | null;
	/** Resolved absolute path to the `mmx` executable, when detectable. */
	binPath: string | null;
	auth: MmxCliAuthState;
	skill: MmxCliSkillState;
	/** Free-form note shown next to the section (e.g. last error). */
	note: string | null;
	/**
	 * `true` when the user has installed both the CLI and the SKILL, in
	 * which case the agent (Copilot Chat / Claude Code / Cursor) can use
	 * the multimodal capabilities of mmx-cli from a prompt.
	 */
	agentReady: boolean;
}

export interface MmxCliCommandResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	/** Set when the underlying binary is missing (ENOENT). */
	missing?: boolean;
	/** Free-form error message for the UI when `ok === false`. */
	error: string | null;
}

interface ExecOptions {
	timeoutMs?: number;
	/** Inject an executable to use (mainly for tests). */
	resolveMm?: () => Promise<string | null>;
	/**
	 * Extra environment variables to merge on top of the parent's env.
	 * Used to inject a PATH that contains a freshly-resolved npm dir
	 * when the inherited PATH is stale (e.g. the user added Node
	 * after launching VS Code).
	 */
	env?: NodeJS.ProcessEnv;
}

/**
 * Wrap `execFile` with consistent timeout + error handling.
 *
 * On Windows we have to go through `cmd.exe /c` for any `.cmd` /
 * `.bat` target — Node 18+ blocks direct `execFile` of those
 * extensions with `EINVAL` as a security hardening measure. POSIX
 * uses the literal argv. The trade-off vs. `shell: true` is that
 * the spawn argv still goes through Node's child_process escape
 * path (no shell interpolation of user input), and the API key we
 * pass to `mmx auth login --api-key <key>` never gets concatenated
 * into a shell string.
 */
async function run(
	file: string,
	args: string[],
	options: ExecOptions & { input?: string } = {},
): Promise<MmxCliCommandResult> {
	const timeoutMs = options.timeoutMs ?? RUN_TIMEOUT_MS;
	const env = options.env
		? { ...process.env, ...options.env }
		: process.env;
	const isWin = process.platform === 'win32';
	const isCmdLike = /\.(cmd|bat)$/i.test(file);
	const finalArgs = isWin && isCmdLike ? ['/c', file, ...args] : args;
	const finalFile = isWin && isCmdLike ? 'cmd.exe' : file;
	try {
		const result = await execFileAsync(finalFile, finalArgs, {
			timeout: timeoutMs,
			maxBuffer: 4 * 1024 * 1024,
			// Hide the API key from process listings: pass through stdin
			// would require a PTY; `--api-key <key>` on argv is fine
			// because mmx-cli redacts its own argv in `--help` output.
			windowsHide: true,
			env,
		});
		return {
			ok: true,
			stdout: result.stdout ?? '',
			stderr: result.stderr ?? '',
			error: null,
		};
	} catch (err) {
		const e = err as NodeJS.ErrnoException & {
			stdout?: string;
			stderr?: string;
			killed?: boolean;
		};
		const stdout = typeof e.stdout === 'string' ? e.stdout : '';
		const stderr = typeof e.stderr === 'string' ? e.stderr : '';
		const missing = e.code === 'ENOENT';
		let error: string;
		if (e.killed) {
			error = `timeout after ${timeoutMs}ms`;
		} else if (missing) {
			error = `${file} not found on PATH`;
		} else {
			error = e.message ?? String(err);
		}
		return { ok: false, stdout, stderr, missing, error };
	}
}

/**
 * Resolve the absolute path to the `mmx` binary, or `null` if it's not
 * on PATH. Uses `which` semantics on POSIX and `where` on Windows.
 */
export async function resolveMmxBin(
	options: { platformOverride?: NodeJS.Platform } = {},
): Promise<string | null> {
	const platform = options.platformOverride ?? process.platform;
	try {
		if (platform === 'win32') {
			const result = await run('where', ['mmx'], { timeoutMs: 5_000 });
			if (result.ok) {
				const first = result.stdout
					.split(/\r?\n/)
					.map((line) => line.trim())
					.find((line) => line.length > 0);
				return first ?? null;
			}
			return null;
		}
		const result = await run('which', ['mmx'], { timeoutMs: 5_000 });
		if (!result.ok) return null;
		const first = result.stdout
			.split('\n')
			.map((line) => line.trim())
			.find((line) => line.length > 0);
		return first ?? null;
	} catch {
		return null;
	}
}

/**
 * Resolve the absolute path to the `npm` (or `npx`) executable, or
 * `null` if it's not findable. Mirrors `resolveMmxBin` but also walks
 * the Windows-specific fallback list when `where` returns nothing.
 *
 * Both `npm` and `npx` resolve via the same Node install, so we share
 * the cache between them — calling this twice is a single `where` hit
 * followed by an in-memory lookup.
 */
const npmResolutionCache = new Map<string, string | null>();

async function tryWhere(
	exe: 'npm' | 'npx' | 'node',
	options: { platformOverride?: NodeJS.Platform } = {},
): Promise<string | null> {
	const platform = options.platformOverride ?? process.platform;
	try {
		if (platform === 'win32') {
			const result = await run('where', [exe], { timeoutMs: 5_000 });
			if (!result.ok) return null;
			const lines = result.stdout
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter((line) => line.length > 0);
			// Prefer the .cmd form — that's what `execFile` can actually
			// launch. `where npm` returns BOTH `npm` (no extension, an
			// empty stub on the Windows Node msi) and `npm.cmd` (the
			// real launcher). The first one fails with ENOENT when
			// execFile'd directly; .cmd works.
			const cmdLike = lines.find((line) => line.toLowerCase().endsWith('.cmd'));
			if (cmdLike) return cmdLike;
			const exeLike = lines.find((line) => line.toLowerCase().endsWith('.exe'));
			if (exeLike) return exeLike;
			return lines[0] ?? null;
		}
		const result = await run('which', [exe], { timeoutMs: 5_000 });
		if (!result.ok) return null;
		const first = result.stdout
			.split('\n')
			.map((line) => line.trim())
			.find((line) => line.length > 0);
		return first ?? null;
	} catch {
		return null;
	}
}

async function probeExeInDir(
	dir: string,
	exe: 'npm' | 'npx',
	options: { platformOverride?: NodeJS.Platform } = {},
): Promise<string | null> {
	const platform = options.platformOverride ?? process.platform;
	const candidates =
		platform === 'win32'
			? [`${exe}.cmd`, `${exe}.exe`, exe]
			: [exe];
	for (const candidate of candidates) {
		const full = path.join(dir, candidate);
		try {
			const stat = await fs.stat(full);
			if (stat.isFile()) {
				return full;
			}
		} catch {
			// not present in this dir, keep probing
		}
	}
	return null;
}

export async function resolveNpmBin(
	options: { platformOverride?: NodeJS.Platform; bin?: 'npm' | 'npx' } = {},
): Promise<string | null> {
	const bin = options.bin ?? 'npm';
	const cacheKey = `${options.platformOverride ?? process.platform}::${bin}`;
	const cached = npmResolutionCache.get(cacheKey);
	if (cached !== undefined) {
		return cached;
	}
	const fromWhere = await tryWhere(bin, options);
	if (fromWhere) {
		npmResolutionCache.set(cacheKey, fromWhere);
		return fromWhere;
	}
	// Fallback walk — Windows only. On POSIX shells, `where`/`which`
	// is the source of truth because each exec sees the current PATH.
	if ((options.platformOverride ?? process.platform) === 'win32') {
		// fnm puts binaries one level deeper (`installation/`).
		for (const root of NPM_FALLBACK_DIRS_WIN32) {
			const direct = await probeExeInDir(root, bin, options);
			if (direct) {
				npmResolutionCache.set(cacheKey, direct);
				return direct;
			}
			// fnm: probe one level down for any node-version.
			if (root.endsWith('fnm\\node-versions') || root.endsWith('fnm/node-versions')) {
				try {
					const entries = await fs.readdir(root);
					for (const entry of entries) {
						const installation = path.join(root, entry, 'installation');
						const hit = await probeExeInDir(installation, bin, options);
						if (hit) {
							npmResolutionCache.set(cacheKey, hit);
							return hit;
						}
					}
				} catch {
					// fnm root not present — move on
				}
			}
		}
	}
	npmResolutionCache.set(cacheKey, null);
	return null;
}

/** Clear the npm-path cache. Test-only; lets us re-resolve after mocking. */
export function _resetNpmResolutionCacheForTests(): void {
	npmResolutionCache.clear();
}

/**
 * Build a `PATH` env object that prepends `dir` (the directory of a
 * resolved npm binary) ahead of the inherited PATH. The result is
 * meant to be passed as `options.env` to `run()`.
 *
 * On Windows the env var is named `Path` (case-insensitive, but Node
 * normalises to `Path`); on POSIX it's `PATH`. We touch both to
 * satisfy the strict env-passing code in `child_process` while keeping
 * a single canonical case.
 */
export function buildAugmentedPathEnv(
	dir: string,
	options: { platformOverride?: NodeJS.Platform } = {},
): NodeJS.ProcessEnv {
	const platform = options.platformOverride ?? process.platform;
	const key = platform === 'win32' ? 'Path' : 'PATH';
	const current = process.env[key] ?? '';
	// Skip if already present — avoids pathologically long PATH values
	// and makes the diff in error messages obvious.
	const segments = current.split(platform === 'win32' ? ';' : ':');
	if (segments.includes(dir)) {
		return { [key]: current };
	}
	return { [key]: dir + (platform === 'win32' ? ';' : ':') + current };
}

/**
 * Resolve `npm` and return the env object needed to spawn it without
 * hitting a stale `PATH` in the parent process. Returns `undefined`
 * when npm genuinely isn't on the machine (the caller will then fall
 * through to the missing-binary error path).
 */
export async function resolveNpmEnv(
	options: { platformOverride?: NodeJS.Platform; bin?: 'npm' | 'npx' } = {},
): Promise<{ bin: string; env: NodeJS.ProcessEnv } | null> {
	const bin = await resolveNpmBin(options);
	if (!bin) return null;
	return { bin, env: buildAugmentedPathEnv(path.dirname(bin), options) };
}

/**
 * Read the version reported by `mmx --version`. Returns `null` when the
 * binary is missing or `mmx` doesn't speak the `--version` flag.
 */
export async function readMmxVersion(
	mmxPath: string = 'mmx',
): Promise<string | null> {
	const result = await run(mmxPath, ['--version'], { timeoutMs: QUICK_TIMEOUT_MS });
	if (!result.ok) {
		// Some CLI versions accept `-v` but not `--version`. Try once more.
		const alt = await run(mmxPath, ['-v'], { timeoutMs: QUICK_TIMEOUT_MS });
		if (alt.ok) {
			return extractVersion(alt.stdout);
		}
		return null;
	}
	return extractVersion(result.stdout);
}

/**
 * Pull a `X.Y.Z` (or `X.Y.Z-…`) version out of a CLI's `--version`
 * output. Falls back to trimming the first line when no semver-like
 * token is present, which mirrors what most CLIs print.
 */
export function extractVersion(raw: string): string | null {
	if (!raw) return null;
	const firstLine = raw.split(/\r?\n/)[0]?.trim() ?? '';
	const match = firstLine.match(/\d+\.\d+\.\d+(?:[-+][\w.-]+)?/);
	if (match) return match[0];
	return firstLine || null;
}

/**
 * Probe `mmx auth status` to determine whether the user has a stored
 * API key. Different mmx-cli builds report this slightly differently;
 * we treat "any line that looks like an API key id" as logged in and
 * "no key" / non-zero exit as logged out. Missing binary is reported
 * as `'notInstalled'`.
 */
export async function readMmxAuthState(
	mmxPath: string = 'mmx',
): Promise<{ state: MmxCliAuthState; detail: string | null }> {
	const result = await run(mmxPath, ['auth', 'status'], { timeoutMs: QUICK_TIMEOUT_MS });
	if (result.missing) {
		return { state: 'notInstalled', detail: null };
	}
	if (!result.ok) {
		// Some builds exit non-zero when no key is set. Inspect output.
		const text = (result.stdout + '\n' + result.stderr).toLowerCase();
		if (text.includes('not logged in') || text.includes('no api key') || text.includes('unauthorized')) {
			return { state: 'loggedOut', detail: result.stderr.trim() || result.stdout.trim() || null };
		}
		return { state: 'loggedOut', detail: result.error };
	}
	const text = (result.stdout + '\n' + result.stderr).trim();
	const lower = text.toLowerCase();
	if (lower.includes('logged in') || lower.includes('authenticated') || /\bsk-[A-Za-z0-9_-]{4,}\b/.test(text)) {
		return { state: 'loggedIn', detail: text || null };
	}
	// Some builds print nothing on success. Treat that as logged out
	// (the user can always re-run `mmx auth login` to be sure).
	return { state: 'loggedOut', detail: text || null };
}

/**
 * Where the `npx skills add MiniMax-AI/cli` flow writes its files.
 *
 * The official CLI uses the user's home directory; we look in three
 * well-known places (Claude Code, GitHub Copilot user skills, and the
 * legacy `~/.mmx/skills`). The first hit wins. Returned paths are
 * absolute.
 */
export function candidateSkillDirs(home: string = os.homedir()): string[] {
	return [
		path.join(home, '.claude', 'skills', 'minimax-cli'),
		path.join(home, '.copilot', 'skills', 'minimax-cli'),
		path.join(home, '.mmx', 'skills', 'minimax-cli'),
	];
}

/**
 * Detect whether the mmx-cli SKILL is already installed (i.e. the
 * official `npx skills add MiniMax-AI/cli -y -g` has been run before).
 * Returns `'installed'` when any of the candidate directories contains
 * a `SKILL.md` file, `'missing'` otherwise.
 */
export async function readMmxSkillState(
	home: string = os.homedir(),
): Promise<MmxCliSkillState> {
	const dirs = candidateSkillDirs(home);
	for (const dir of dirs) {
		try {
			const stat = await fs.stat(path.join(dir, 'SKILL.md'));
			if (stat.isFile()) {
				return 'installed';
			}
		} catch {
			// not present — try the next candidate
		}
	}
	return 'missing';
}

/** Compose all the probes into the single struct the dashboard renders. */
export async function readMmxCliStatus(
	mmxPath?: string,
): Promise<MmxCliStatus> {
	const resolved = mmxPath ?? (await resolveMmxBin());
	if (!resolved) {
		const skill = await readMmxSkillState();
		return {
			install: 'missing',
			version: null,
			binPath: null,
			auth: 'notInstalled',
			skill,
			note: null,
			agentReady: false,
		};
	}
	const [version, auth, skill] = await Promise.all([
		readMmxVersion(resolved),
		readMmxAuthState(resolved),
		readMmxSkillState(),
	]);
	return {
		install: 'installed',
		version,
		binPath: resolved,
		auth: auth.state,
		skill,
		note: null,
		agentReady: version != null && auth.state === 'loggedIn' && skill === 'installed',
	};
}

// ---- mutating operations ----------------------------------------------

/**
 * The official install prompt from
 *   platform.minimaxi.com/docs/token-plan/minimax-cli
 * verbatim. We copy it to the user's clipboard so they can paste it
 * into Copilot Chat (or any other AI agent) and have the agent run
 * `npm install -g mmx-cli` for them — agents have richer terminal /
 * package-manager access than our extension does (e.g. they can
 * retry on a permission prompt, install MSVC build tools, etc.).
 *
 * The prompt intentionally references the API key as a *placeholder*
 * (`sk-xxxxx`) — step 2 (login) is the only step that needs the
 * real key, and we run *that* step ourselves inside the extension
 * (key stays in SecretStorage, never enters the chat).
 */
export function mmxInstallPrompt(): string {
	return [
		'请帮我接入 MiniMax CLI（https://github.com/MiniMax-AI/cli），按以下三步完成安装与配置：',
		'',
		'1. 全局安装 CLI：执行 `npm install -g mmx-cli`，完成后用 `mmx --version` 验证',
		'2. 登录并配置 API Key：执行 `mmx auth login --api-key sk-xxxxx`；',
		'3. 安装官方 SKILL：执行 `npx skills add MiniMax-AI/cli -y -g`',
		'',
		'完成后请执行 `mmx quota` 查看我的 Token Plan 余额，确认整体配置生效。',
		'',
		'(第 2 步的 API key 我已存到 VS Code SecretStorage，会在 mmx-cli 装好之后由 MiniMax 扩展代为登录，不需要你拿到 key。)',
	].join('\n');
}

/**
 * Copy the official install prompt to the user's clipboard and open
 * a new Copilot chat so they can paste and send it. This is the
 * "step 1" of the mmx-cli flow that we **delegate to the agent**
 * rather than executing ourselves — see [`mmxInstallPrompt`] for
 * the rationale.
 *
 * The function is best-effort: clipboard write + chat open are both
 * fire-and-forget, and the caller is expected to show a confirmation
 * notification regardless of whether the chat actually opened (the
 * prompt is on the clipboard either way).
 */
export interface CopyPromptResult {
	/** True when the clipboard write succeeded. */
	copied: boolean;
	/** True when a Copilot chat was opened (we don't strictly need to succeed). */
	chatOpened: boolean;
	/** The prompt text that was put on the clipboard, for the UI to display. */
	prompt: string;
}

/**
 * Thin wrapper around `vscode.env.clipboard.writeText` and the
 * `workbench.action.chat.openNewChatEditor` command. We don't take
 * a hard dependency on the chat command being available — some
 * remote / flatpak builds strip it — so we treat it as best-effort.
 */
export async function copyMmxInstallPromptToChat(): Promise<CopyPromptResult> {
	const prompt = mmxInstallPrompt();
	let copied = false;
	let chatOpened = false;
	try {
		await vscode.env.clipboard.writeText(prompt);
		copied = true;
	} catch {
		copied = false;
	}
	try {
		await vscode.commands.executeCommand('workbench.action.chat.openNewChatEditor');
		chatOpened = true;
	} catch {
		chatOpened = false;
	}
	return { copied, chatOpened, prompt };
}

/**
 * Login to mmx-cli with the user's Token Plan API key. Equivalent to
 * `mmx auth login --api-key <key>`. The key is passed via argv (not
 * stdin) so the call stays synchronous; mmx-cli itself does not echo
 * the key back in its argv listing.
 */
export async function loginMmxCli(
	apiKey: string,
	mmxPath: string = 'mmx',
): Promise<MmxCliCommandResult> {
	const trimmed = apiKey.trim();
	if (!trimmed) {
		return {
			ok: false,
			stdout: '',
			stderr: '',
			error: 'API key is empty',
		};
	}
	return run(mmxPath, ['auth', 'login', '--api-key', trimmed], {
		timeoutMs: QUICK_TIMEOUT_MS,
	});
}

/**
 * Run the official `npx skills add MiniMax-AI/cli -y -g` to install the
 * mmx-cli SKILL. The SKILL is what tells agents (Claude Code, Cursor,
 * GitHub Copilot) how to call the multimodal mmx-cli commands.
 *
 * If `npx` is not on PATH (very rare on a Node install) we fall back to
 * copying the bundled `SKILL.md` from the extension's `skills/minimax-cli/`
 * directory to the first writable candidate location.
 */
export async function installMmxSkill(
	options: { log?: (msg: string) => void; extensionUri?: vscode.Uri } = {},
): Promise<MmxCliCommandResult & { installedAt?: string; source?: 'npx' | 'bundled' }> {
	const log = options.log ?? (() => {});
	const npx = await resolveNpmEnv({ bin: 'npx' });
	if (!npx) {
		// npx isn't available — skip straight to the bundled fallback.
		log('npx not found on PATH; using bundled SKILL.md');
		const fallback = await installBundledMmxSkill(options.extensionUri);
		if (fallback.ok) {
			return { ...fallback, source: 'bundled' };
		}
		return {
			ok: false,
			stdout: '',
			stderr: '',
			missing: true,
			error: 'npx not found on PATH and bundled SKILL copy failed',
		};
	}
	log(`Running: ${npx.bin} skills add ${MMX_SKILL_SLUG} -y -g`);
	const result = await run(
		npx.bin,
		['--yes', 'skills', 'add', MMX_SKILL_SLUG, '-y', '-g'],
		{ timeoutMs: INSTALL_TIMEOUT_MS, env: npx.env },
	);
	if (result.ok) {
		return { ...result, source: 'npx' };
	}
	// npx failed (network, missing binary, etc.) — try the bundled copy
	// as a fallback. The bundled file is a complete copy of the SKILL
	// shipped in this extension; the user gets the same end result
	// (their agent can read the SKILL and call mmx).
	const fallback = await installBundledMmxSkill(options.extensionUri);
	if (fallback.ok) {
		return { ...fallback, source: 'bundled' };
	}
	return result;
}

/**
 * Copy the SKILL.md bundled in this extension to the user's home. The
 * first candidate directory that doesn't exist yet is created; if all
 * candidates are read-only, the call returns `ok: false`.
 */
export async function installBundledMmxSkill(
	extensionUri?: vscode.Uri,
	home: string = os.homedir(),
): Promise<MmxCliCommandResult & { installedAt?: string }> {
	if (!extensionUri) {
		return {
			ok: false,
			stdout: '',
			stderr: '',
			error: 'Extension URI not available; cannot install bundled SKILL',
		};
	}
	const sourceSkill = vscode.Uri.joinPath(extensionUri, 'skills', 'minimax-cli', 'SKILL.md');
	let sourceContents: string;
	try {
		const buf = await vscode.workspace.fs.readFile(sourceSkill);
		sourceContents = Buffer.from(buf).toString('utf8');
	} catch (err) {
		return {
			ok: false,
			stdout: '',
			stderr: '',
			error: `Bundled SKILL.md not found at ${sourceSkill.fsPath}: ${(err as Error).message}`,
		};
	}
	const targets = candidateSkillDirs(home);
	for (const target of targets) {
		try {
			await fs.mkdir(path.dirname(target), { recursive: true });
			await fs.writeFile(path.join(target, 'SKILL.md'), sourceContents, 'utf8');
			return {
				ok: true,
				stdout: `Installed bundled SKILL to ${target}`,
				stderr: '',
				error: null,
				installedAt: target,
			};
		} catch {
			// try the next location
		}
	}
	return {
		ok: false,
		stdout: '',
		stderr: '',
		error: 'No writable candidate directory for the SKILL',
	};
}
