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
}

/** Wrap `execFile` with consistent timeout + error handling. */
async function run(
	file: string,
	args: string[],
	options: ExecOptions & { input?: string } = {},
): Promise<MmxCliCommandResult> {
	const timeoutMs = options.timeoutMs ?? RUN_TIMEOUT_MS;
	try {
		const result = await execFileAsync(file, args, {
			timeout: timeoutMs,
			maxBuffer: 4 * 1024 * 1024,
			// Hide the API key from process listings: pass through stdin
			// would require a PTY; `--api-key <key>` on argv is fine
			// because mmx-cli redacts its own argv in `--help` output.
			windowsHide: true,
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
 * Globally install `mmx-cli` via npm. Opens a visible terminal so the
 * user can see the install progress and any npm warnings.
 *
 * On success, re-resolves the binary path and reports the new version.
 * Returns the command result even on failure so the caller can show the
 * captured stderr to the user.
 */
export async function installMmxCli(
	options: { log?: (msg: string) => void } = {},
): Promise<MmxCliCommandResult & { newVersion?: string; binPath?: string }> {
	const log = options.log ?? (() => {});
	log('Running: npm install -g mmx-cli');
	const result = await run('npm', ['install', '-g', MMX_CLI_PACKAGE, '--no-audit', '--no-fund'], {
		timeoutMs: INSTALL_TIMEOUT_MS,
	});
	if (!result.ok) {
		return { ...result };
	}
	const binPath = await resolveMmxBin();
	const newVersion = binPath ? await readMmxVersion(binPath) : null;
	return {
		...result,
		newVersion: newVersion ?? undefined,
		binPath: binPath ?? undefined,
	};
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
	log('Running: npx skills add MiniMax-AI/cli -y -g');
	const result = await run('npx', ['--yes', 'skills', 'add', MMX_SKILL_SLUG, '-y', '-g'], {
		timeoutMs: INSTALL_TIMEOUT_MS,
	});
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
