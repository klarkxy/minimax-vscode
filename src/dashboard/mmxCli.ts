// mmx-cli detection ONLY.
//
// The official Token Plan onboarding doc
// (platform.minimaxi.com/docs/token-plan/minimax-cli) describes a
// three-step flow that the user (or their AI agent) drives from
// outside the extension. The extension's job here is just to report
// the three statuses on the dashboard:
//   1. Is the `mmx` binary on PATH?
//   2. Has `mmx auth login` been run?
//   3. Has the official agent SKILL been installed?
//
// Everything else — installing the CLI, logging in, installing the
// SKILL — is left to the user. The dashboard exposes a single
// "Copy official install prompt" action whose target text is the
// verbatim prompt from the docs, in the language that matches the
// configured endpoint (china → 简体中文, otherwise → English).
//
// `mmxInstallPrompt()` and the clipboard helper are the only
// mutating-ish things in this file, and they never read or write
// the user's API key — the prompt template uses the literal
// `sk-xxxxx` placeholder that the docs themselves use, and the
// user fills in their real key themselves before pasting.

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import * as vscode from 'vscode';

const execFileAsync = promisify(execFile);

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
	/**
	 * `true` when the user has installed both the CLI and the SKILL,
	 * in which case the agent (Copilot Chat / Claude Code / Cursor)
	 * can use the multimodal capabilities of mmx-cli from a prompt.
	 */
	agentReady: boolean;
}

interface ExecOptions {
	timeoutMs?: number;
}

/**
 * Wrap `execFile` with consistent timeout + error handling.
 *
 * On Windows we have to go through `cmd.exe /c` for any `.cmd` /
 * `.bat` target — Node 18+ blocks direct `execFile` of those
 * extensions with `EINVAL` as a security hardening measure. POSIX
 * uses the literal argv.
 */
async function run(
	file: string,
	args: string[],
	options: ExecOptions = {},
): Promise<{ ok: boolean; stdout: string; stderr: string; missing?: boolean; error: string | null }> {
	const timeoutMs = options.timeoutMs ?? 15_000;
	const isWin = process.platform === 'win32';
	const isCmdLike = /\.(cmd|bat)$/i.test(file);
	const finalArgs = isWin && isCmdLike ? ['/c', file, ...args] : args;
	const finalFile = isWin && isCmdLike ? 'cmd.exe' : file;
	try {
		const result = await execFileAsync(finalFile, finalArgs, {
			timeout: timeoutMs,
			maxBuffer: 4 * 1024 * 1024,
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
 * Resolve the absolute path to the `mmx` binary, or `null` if it's
 * not on PATH. On Windows we prefer the `.cmd` form because that's
 * what `execFile` can actually launch — `where mmx` typically
 * returns BOTH `mmx` (no ext, a stub on the Windows npm global
 * layout) and `mmx.cmd` (the real launcher), and the bare name
 * fails with ENOENT when execFile'd directly.
 */
export async function resolveMmxBin(
	options: { platformOverride?: NodeJS.Platform } = {},
): Promise<string | null> {
	const platform = options.platformOverride ?? process.platform;
	try {
		if (platform === 'win32') {
			const result = await run('where', ['mmx'], { timeoutMs: 5_000 });
			if (!result.ok) return null;
			const lines = result.stdout
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter((line) => line.length > 0);
			// Same preference as resolveNpmBin: prefer the executable
			// extension that execFile can actually launch.
			const cmdLike = lines.find((line) => line.toLowerCase().endsWith('.cmd'));
			if (cmdLike) return cmdLike;
			const exeLike = lines.find((line) => line.toLowerCase().endsWith('.exe'));
			if (exeLike) return exeLike;
			return lines[0] ?? null;
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
 * Read the version reported by `mmx --version`. Returns `null` when
 * the binary is missing or doesn't speak the `--version` flag.
 */
export async function readMmxVersion(
	mmxPath: string = 'mmx',
): Promise<string | null> {
	const result = await run(mmxPath, ['--version'], { timeoutMs: 15_000 });
	if (!result.ok) {
		const alt = await run(mmxPath, ['-v'], { timeoutMs: 15_000 });
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
 * API key. Different mmx-cli builds report this slightly
 * differently; we treat "any line that looks like an API key id" as
 * logged in and "no key" / non-zero exit as logged out. Missing
 * binary is reported as `'notInstalled'`.
 */
export async function readMmxAuthState(
	mmxPath: string = 'mmx',
): Promise<{ state: MmxCliAuthState; detail: string | null }> {
	const result = await run(mmxPath, ['auth', 'status'], { timeoutMs: 15_000 });
	if (result.missing) {
		return { state: 'notInstalled', detail: null };
	}
	if (!result.ok) {
		const text = (result.stdout + '\n' + result.stderr).toLowerCase();
		if (
			text.includes('not logged in') ||
			text.includes('no api key') ||
			text.includes('unauthorized')
		) {
			return {
				state: 'loggedOut',
				detail: result.stderr.trim() || result.stdout.trim() || null,
			};
		}
		return { state: 'loggedOut', detail: result.error };
	}
	const text = (result.stdout + '\n' + result.stderr).trim();
	const lower = text.toLowerCase();
	if (
		lower.includes('logged in') ||
		lower.includes('authenticated') ||
		/\bsk-[A-Za-z0-9_-]{4,}\b/.test(text)
	) {
		return { state: 'loggedIn', detail: text || null };
	}
	return { state: 'loggedOut', detail: text || null };
}

/**
 * Where the `npx skills add MiniMax-AI/cli` flow writes its files.
 * The official CLI uses the user's home directory; we look in three
 * well-known places (Claude Code, GitHub Copilot user skills, and
 * the legacy `~/.mmx/skills`). The first hit wins.
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
 * official `npx skills add MiniMax-AI/cli -y -g` has been run
 * before). Returns `'installed'` when any of the candidate
 * directories contains a `SKILL.md` file, `'missing'` otherwise.
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
export async function readMmxCliStatus(mmxPath?: string): Promise<MmxCliStatus> {
	const resolved = mmxPath ?? (await resolveMmxBin());
	if (!resolved) {
		const skill = await readMmxSkillState();
		return {
			install: 'missing',
			version: null,
			binPath: null,
			auth: 'notInstalled',
			skill,
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
		agentReady: version != null && auth.state === 'loggedIn' && skill === 'installed',
	};
}

// ---- official install prompt -----------------------------------------
//
// The only mutating-ish thing the extension offers: a copy-to-clipboard
// of the verbatim prompt from the official docs
// (platform.minimaxi.com/docs/token-plan/minimax-cli), in the
// language that matches the user's configured endpoint. The prompt
// references the API key only as the literal `sk-xxxxx` placeholder;
// the user is expected to fill in their real key themselves before
// pasting the prompt into a chat (or, if they prefer, to drive the
// install themselves in a terminal).

/** The user's configured endpoint, used to choose prompt language. */
export type MmxPromptHost = 'china' | 'global';

/**
 * The Chinese install prompt — copied verbatim from
 *   https://platform.minimaxi.com/docs/token-plan/minimax-cli
 * (the "通过Agent安装" section). Sourced from the official docs so
 * any tweak the MiniMax team makes to the prompt there propagates
 * to us on the next round of copy-paste.
 */
const MMX_INSTALL_PROMPT_ZH = [
	'请帮我接入 MiniMax CLI（https://github.com/MiniMax-AI/cli），按以下三步完成安装与配置：',
	'',
	'1. 全局安装 CLI：执行 `npm install -g mmx-cli`，完成后用 `mmx --version` 验证',
	'2. 登录并配置 API Key：执行 `mmx auth login --api-key sk-xxxxx`；（请将 sk-xxxxx 替换为你的实际密钥）',
	'3. 安装官方 SKILL：执行 `npx skills add MiniMax-AI/cli -y -g`',
	'',
	'完成后请执行 `mmx quota` 查看我的 Token Plan 余额，确认整体配置生效。',
].join('\n');

/**
 * The English install prompt — the international-site equivalent of
 * MMX_INSTALL_PROMPT_ZH (platform.minimax.io/docs/token-plan/minimax-cli).
 */
const MMX_INSTALL_PROMPT_EN = [
	'Please help me connect to MiniMax CLI (https://github.com/MiniMax-AI/cli), follow these three steps to complete installation and configuration:',
	'',
	'1. Globally install the CLI: run `npm install -g mmx-cli`, then verify with `mmx --version`',
	'2. Login and configure the API Key: run `mmx auth login --api-key sk-xxxxx`; (please replace sk-xxxxx with your actual key)',
	'3. Install the official SKILL: run `npx skills add MiniMax-AI/cli -y -g`',
	'',
	'Once done, please run `mmx quota` to view my Token Plan balance and confirm the overall configuration is working.',
].join('\n');

/**
 * Return the install prompt whose language matches the configured
 * endpoint. The default is the international (English) prompt; the
 * Chinese prompt is returned for hosts that contain `minimaxi.com`.
 */
export function mmxInstallPrompt(host: MmxPromptHost = 'global'): string {
	return host === 'china' ? MMX_INSTALL_PROMPT_ZH : MMX_INSTALL_PROMPT_EN;
}

/**
 * Copy the official install prompt (in the right language) to the
 * clipboard. Best-effort: returns whether the write succeeded so the
 * caller can show a follow-up notification. The user decides whether
 * to paste it into a chat or run the commands themselves.
 */
export async function copyMmxInstallPrompt(
	host: MmxPromptHost = 'global',
): Promise<{ copied: boolean; prompt: string }> {
	const prompt = mmxInstallPrompt(host);
	let copied = false;
	try {
		await vscode.env.clipboard.writeText(prompt);
		copied = true;
	} catch {
		copied = false;
	}
	return { copied, prompt };
}
