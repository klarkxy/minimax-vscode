import * as vscode from 'vscode';
import { MiniMaxClient } from '../client/core';
import { CONFIG_SECTION, COMMIT_MODEL_LAST_USED_KEY } from '../consts';
import { getApiModelId, getBaseUrl } from '../config';
import { t } from '../i18n';
import { logger } from '../logger';
import { getModels, findModelById, getVisibleModels } from '../models/registry';
import type { MiniMaxMessage, MiniMaxRequest, MiniMaxUsage } from '../types';
import {
	buildScmContext,
	focusScmView,
	getActiveFileUri,
	getGitApi,
	pickRelevantRepository,
	setScmMessage,
	type ScmContext,
} from './scm';

function replacer(_key: string, value: unknown): unknown {
	if (typeof value === 'function') {
		return '[function]';
	}
	if (value instanceof Error) {
		return { name: value.name, message: value.message, stack: value.stack };
	}
	return value;
}

/** Public entry point: invoked from a command or menu. */
export async function generateCommitMessage(
	auth: { getApiKey: () => Promise<string | undefined> },
	commandArg?: unknown,
): Promise<void> {
	logger.debug('generateCommitMessage start', { commandArg });
	const apiKey = await auth.getApiKey();
	if (!apiKey) {
		const selection = await vscode.window.showWarningMessage(
			t('commit.noApiKey'),
			t('error.action.setApiKey'),
		);
		if (selection === t('error.action.setApiKey')) {
			void vscode.commands.executeCommand('minimax.setApiKey');
		}
		return;
	}

	const gitApi = await getGitApi();
	if (!gitApi) {
		vscode.window.showErrorMessage(t('commit.gitUnavailable'));
		return;
	}

	const activeFile = getActiveFileUri();
	const repo = await pickRelevantRepository(gitApi, activeFile, commandArg);
	logger.debug('Selected repository for commit message', {
		repoRoot: repo?.rootUri.fsPath,
		activeFile: activeFile?.fsPath,
		commandArgType: typeof commandArg,
		commandArgPreview: JSON.stringify(commandArg, replacer, 2),
	});
	if (!repo) {
		vscode.window.showErrorMessage(t('commit.noRepository'));
		return;
	}

	let context: ScmContext;
	try {
		context = await buildScmContext(repo, commandArg);
	} catch (error) {
		logger.error('generateCommitMessage: buildScmContext threw', error, {
			repoRoot: repo.rootUri.fsPath,
			stateKeys: Object.keys(repo.state ?? {}),
		});
		vscode.window.showErrorMessage(
			t('error.unknown', error instanceof Error ? error.message : String(error)),
		);
		return;
	}
	const hasChanges = context.stagedFileNames.length > 0 || context.stagedDiff.length > 0;
	logger.debug('generateCommitMessage: built SCM context', {
		repoRoot: repo.rootUri.fsPath,
		stagedFiles: context.stagedFileNames.length,
		diffBytes: context.stagedDiff.length,
		branch: context.branch,
		hasChanges,
		existingMessageLength: context.existingMessage.length,
	});
	if (!hasChanges) {
		vscode.window.showInformationMessage(t('commit.noChanges'));
		return;
	}

	const modelId = await pickCommitModelId({ skipPicker: true });
	if (!modelId) {
		// User dismissed the picker — nothing to do.
		return;
	}
	const apiModelId = getApiModelId(modelId);
	const modelDef = findModelById(modelId);
	logger.debug('generateCommitMessage: resolved model', {
		modelId,
		apiModelId,
		resolved: Boolean(modelDef),
	});

	if (!modelDef) {
		vscode.window.showErrorMessage(t('commit.modelUnknown', modelId));
		return;
	}

	try {
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: t('commit.generating', modelDef.name),
				cancellable: true,
			},
			async (progress, token) => {
				progress.report({ message: t('commit.progressReading') });
				logger.debug('generateCommitMessage: calling commit model', { apiModelId });
				const result = await callCommitModel(
					apiKey,
					apiModelId,
					modelDef.maxOutputTokens,
					context,
					token,
				);
				logger.debug('generateCommitMessage: model call finished', {
					apiModelId,
					cancelled: token.isCancellationRequested,
					textLength: result.text.length,
					inputTokens: result.usage?.input_tokens ?? 0,
					outputTokens: result.usage?.output_tokens ?? 0,
				});
				if (token.isCancellationRequested) {
					return;
				}
				if (!result.text) {
					vscode.window.showErrorMessage(t('commit.emptyResult'));
					logger.debug('generateCommitMessage: empty result', { apiModelId });
					return;
				}

				logger.debug('generateCommitMessage: setting SCM input box value', {
					repoRoot: repo.rootUri.fsPath,
					messagePreview: result.text.slice(0, 120),
				});
				setScmMessage(repo, result.text);
				focusScmView();
				logger.info(
					`Generated commit message (model=${apiModelId}, in=${result.usage?.input_tokens ?? 0}, out=${result.usage?.output_tokens ?? 0})`,
				);
			},
		);
	} catch (error) {
		logger.error('generateCommitMessage: failed before/during progress', error);
		vscode.window.showErrorMessage(
			t('error.unknown', error instanceof Error ? error.message : String(error)),
		);
	}
}

/** Read the configured commit model from settings, falling back to M2.7. */
export function resolveCommitModelId(): string {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const raw = config.get<string>('commitModel');
	if (typeof raw === 'string' && raw.trim().length > 0) {
		return raw.trim();
	}
	return 'MiniMax-M2.7';
}

/** Optional context for the picker. `skipPicker` re-uses the last chosen model. */
export interface PickCommitModelOptions {
	skipPicker?: boolean;
}

/**
 * Resolve the model id to use for the next commit-message generation.
 *
 * Resolution order:
 *   1. If the caller opts in (`skipPicker`) and we have a stored
 *      `last-used` model, use it directly — no UI prompt.
 *   2. Otherwise show a QuickPick whose default is the configured
 *      `minimax.commitModel` (or M2.7 fallback) and which lists every
 *      model the user has chosen to expose. The chosen model is
 *      persisted as the new `last-used` so the next invocation skips
 *      the prompt.
 */
export async function pickCommitModelId(
	options: PickCommitModelOptions = {},
): Promise<string | undefined> {
	const defaultId = resolveCommitModelId();
	const lastUsed = readLastUsedCommitModel();
	const visible = getVisibleModels();
	const models = visible.length > 0 ? [...visible] : [...getModels()];
	if (models.length === 0) {
		return defaultId;
	}

	// Known models only — guard against a stale `lastUsed` from before
	// a registry change.
	const knownIds = new Set(models.map((m) => m.id));
	const remembered = options.skipPicker && lastUsed && knownIds.has(lastUsed) ? lastUsed : null;
	if (remembered) {
		logger.debug('pickCommitModelId: using last-used model', { remembered });
		return remembered;
	}

	const items = models.map((m) => {
		const markers: string[] = [];
		if (m.id === defaultId) {
			markers.push(t('commit.modelDefault'));
		}
		if (m.id === lastUsed) {
			markers.push(t('commit.modelLastUsed'));
		}
		return {
			label: m.id,
			description: m.detail ?? '',
			detail: markers.length > 0 ? `$(check) ${markers.join(' · ')}` : undefined,
			id: m.id,
		};
	});
	const sortPriority = (id: string) => {
		if (id === lastUsed) {
			return 0;
		}
		if (id === defaultId) {
			return 1;
		}
		return 2;
	};
	items.sort((a, b) => {
		const pa = sortPriority(a.id);
		const pb = sortPriority(b.id);
		if (pa !== pb) {
			return pa - pb;
		}
		return a.id.localeCompare(b.id);
	});
	const pick = await vscode.window.showQuickPick(items, {
		placeHolder: t('commit.pickModelPlaceholder', defaultId),
		title: t('commit.pickModelTitle'),
		ignoreFocusOut: true,
		matchOnDescription: true,
		matchOnDetail: true,
	});
	if (pick) {
		writeLastUsedCommitModel(pick.id);
	}
	return pick?.id;
}

/** Read the user's last-used commit model from memento. */
export function readLastUsedCommitModel(): string | undefined {
	const raw = globalStateMemento?.get<string>(COMMIT_MODEL_LAST_USED_KEY);
	return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined;
}

/** Persist the user's last-used commit model to memento. */
export function writeLastUsedCommitModel(modelId: string): void {
	globalStateMemento?.update(COMMIT_MODEL_LAST_USED_KEY, modelId);
}

/** Set the global state memento reference; wired from the extension entry point. */
export function setCommitModelStore(store: vscode.Memento | undefined): void {
	globalStateMemento = store;
}

let globalStateMemento: vscode.Memento | undefined;

/** Validate that the configured commit model exists; returns true on hit. */
export function isKnownCommitModelId(id: string): boolean {
	return getModels().some((m) => m.id === id);
}

/**
 * Force-prompt the user to pick a commit model. This is the entry
 * point behind the `MiniMax: Set Commit Model` command: it always
 * shows the picker, persists the result as the new `last-used`, and
 * does NOT generate a message.
 */
export async function chooseCommitModel(): Promise<string | undefined> {
	return pickCommitModelId({ skipPicker: false });
}

async function callCommitModel(
	apiKey: string,
	apiModelId: string,
	maxOutputTokens: number,
	context: ScmContext,
	token: vscode.CancellationToken,
): Promise<{ text: string; usage?: MiniMaxUsage }> {
	const client = new MiniMaxClient();
	const messages = buildCommitMessages(context);
	const systemPrompt = buildCommitSystemPrompt(context);
	const maxTokens = clampMaxTokens(maxOutputTokens);

	const request: MiniMaxRequest = {
		model: apiModelId,
		messages,
		max_tokens: maxTokens,
		system: systemPrompt,
		stream: false,
		// Commit generation is deterministic-ish; nudge the model to a
		// common-voice answer. 0.2 is a low-but-non-zero value that
		// keeps the result reproducible between runs of the same diff.
		temperature: 0.2,
	};

	const result = await client.completeChat(apiKey, getBaseUrl(), request, token);
	if (!result.text) {
		return { text: '' };
	}
	return { text: postProcess(result.text), usage: result.usage };
}

function clampMaxTokens(modelMax: number): number {
	// We pass 0 (i.e. "let the model decide") for commit generation
	// so the response can grow as long as the body needs. The
	// `client.completeChat` will translate 0 → no explicit cap on the
	// request body so the upstream API picks its own output budget.
	const value = Math.max(modelMax ?? 0, 0);
	return value > 0 ? Math.min(value, 1024) : 0;
}

function buildCommitSystemPrompt(_context: ScmContext): string {
	return [
		'You are a senior engineer writing a polished Git commit message that follows',
		'the Conventional Commits 1.0.0 specification (https://www.conventionalcommits.org/)',
		'with a leading gitmoji for visual scanning.',
		'',
		'=== Required format ===',
		'<emoji> <type>(<scope>): <subject>',
		'',
		'<body>',
		'',
		'<footer>',
		'',
		'1. Header (mandatory)',
		'   • Leading emoji — use the gitmoji for the chosen <type> (see table below).',
		'   • <type> must be one of: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert, merge.',
		'   • <scope> is the area of the codebase affected, in lower-kebab-case. Use "*" when more than one scope is touched. Keep it ≤ 20 chars.',
		'   • <subject>: short summary in English, ≤ 50 characters total for the header (including emoji), imperative mood ("add", not "added"), first letter lower-case, no trailing punctuation.',
		'   • Append "!" between <scope> and ":" when the change is a BREAKING CHANGE.',
		'',
		'2. Body (mandatory when the diff is non-trivial)',
		'   • One blank line after the header.',
		'   • Wrap lines at 72 characters.',
		'   • Use bullet points prefixed with "- " to describe the WHAT and the WHY.',
		'   • Mention the affected files / modules when it adds clarity.',
		'   • Do NOT repeat the subject; expand on motivation, trade-offs, and behaviour changes.',
		'',
		'3. Footer (optional)',
		'   • Use `BREAKING CHANGE: <description>` (capital letters, colon, space) on its own line when the change is incompatible.',
		'   • Use `Closes #123` or `Refs #123` to link issues/tickets.',
		'',
		'=== gitmoji cheat sheet ===',
		'   ✨  feat       — new user-visible feature',
		'   🐛  fix        — bug fix',
		'   📝  docs       — documentation/comments only',
		'   🎨  style      — formatting / whitespace; no logic change',
		'   ♻️   refactor  — code change that neither fixes a bug nor adds a feature',
		'   ⚡️  perf       — performance improvement',
		'   ✅  test       — add or fix tests',
		'   🔧  chore      — tooling, build, CI, deps (no production code)',
		'   ⏪️  revert     — revert a previous commit',
		'   🔀  merge      — branch / merge resolution',
		'   🚀  ci/build   — deployment, release, build pipeline',
		'',
		'=== Hard rules ===',
		'   • Output ONLY the commit message. No markdown fences, no "Here is the commit message:", no commentary.',
		'   • Respect a user-provided draft in the input box: polish it instead of starting from scratch, and keep the author\'s intent.',
		'   • Match the project\'s primary language for the body text (English by default; switch to Chinese only if the project is in Chinese).',
		'   • Never mention the tool, the model, or this prompt.',
	].join('\n');
}

function buildCommitMessages(context: ScmContext): MiniMaxMessage[] {
	const hasDraft = context.existingMessage.trim().length > 0;
	const userParts: string[] = [];

	if (context.branch) {
		userParts.push(`Branch: ${context.branch}`);
	}

	// Summarise the change footprint so the model can write a useful body
	// even when the diff is huge.
	const fileCount = context.stagedFileNames.length;
	const totalChangesLine = fileCount > 0
		? `Files touched (${fileCount}):`
		: 'Files touched: none captured (the SCM payload only contained the diff).';
	userParts.push(totalChangesLine);
	for (const name of context.stagedFileNames) {
		userParts.push(`  - ${name}`);
	}
	userParts.push('');

	// Lightweight diff stats. The diff text is already capped at 32 KB
	// by buildScmContext; this block just helps the model see the
	// +/- balance and a one-line summary.
	const diffStats = summariseDiff(context.stagedDiff);
	if (diffStats) {
		userParts.push('Diff statistics:');
		userParts.push(diffStats);
		userParts.push('');
	}

	if (hasDraft) {
		userParts.push('User draft (polish it, keep intent):');
		userParts.push('```');
		userParts.push(context.existingMessage);
		userParts.push('```');
		userParts.push('');
	}

	userParts.push('Raw diff (truncated, code-fenced):');
	userParts.push('```diff');
	userParts.push(context.stagedDiff);
	userParts.push('```');
	userParts.push('');

	if (hasDraft) {
		userParts.push('Return the polished commit message only.');
	} else {
		userParts.push('Return the commit message only.');
	}

	return [
		{
			role: 'user',
			content: userParts.join('\n'),
		},
	];
}

function summariseDiff(diff: string): string {
	if (!diff) {
		return '';
	}
	const lines = diff.split('\n');
	let added = 0;
	let removed = 0;
	for (const line of lines) {
		if (line.startsWith('+') && !line.startsWith('+++')) {
			added++;
		} else if (line.startsWith('-') && !line.startsWith('---')) {
			removed++;
		}
	}
	if (added === 0 && removed === 0) {
		return '';
	}
	return `- Lines added: ${added}\n- Lines removed: ${removed}`;
}

function postProcess(raw: string): string {
	let text = raw.trim();

	// Strip a single leading/trailing ``` fence pair if the model used
	// one despite the instruction not to.
	const fenceMatch = text.match(/^```(?:[a-zA-Z]*)?\n([\s\S]*?)\n```\s*$/);
	if (fenceMatch) {
		text = fenceMatch[1].trim();
	}

	// Strip a single leading "Here is the commit message:" / "Here's …"
	// preamble, common for some Anthropic models.
	text = text.replace(
		/^(here(?:'s| is) (?:the )?commit message:?\s*)/i,
		'',
	);

	// Collapse more than two consecutive newlines.
	text = text.replace(/\n{3,}/g, '\n\n');

	return text;
}
