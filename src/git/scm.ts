import * as vscode from 'vscode';
import { logger } from '../logger';

/**
 * Read the SCM input box of the first repository. The commit-message
 * generator uses the input box to show progress + accept the generated
 * message, and to detect "user has already typed something" so we can
 * run a polish pass instead of a from-scratch generation.
 */
export interface ScmContext {
	uri: vscode.Uri;
	/** Current value in the SCM commit-message input box (may be empty). */
	existingMessage: string;
	/** Staged change summary, formatted for the prompt. */
	stagedDiff: string;
	/** Tracked file names in the staging area (deduplicated). */
	stagedFileNames: string[];
	/** Optional branch name to feed into the prompt for context. */
	branch?: string;
}

/** A single changed resource, in the shape VS Code's git API returns. */
interface ScmResource {
	resourceUri: vscode.Uri;
	/** Multi-file change kind: 0 = added, 1 = modified, 2 = deleted, etc. */
	type?: number;
}

/** Result wrapper from the `git` extension's API. */
interface GitRepository {
	rootUri: vscode.Uri;
	state: {
		/** What's currently in the index. */
		workingTreeChanges?: ScmResource[];
		/** What's currently in the index (staged). */
		indexChanges?: ScmResource[];
		/** Tracked refs. */
		refs?: Array<{ name?: string; type?: number }>;
		/** HEAD commit short message (informational). */
		HEAD?: { name?: string; commit?: string; message?: string };
		/** Diff between HEAD and index (we prefer this for staged diffs). */
		diff?: { contents: string } | { with?: (other: string) => { contents: string } } & unknown;
	};
	inputBox: {
		value: string;
	};
}

interface GitApi {
	readonly state: 'uninitialized' | 'initialized';
	readonly repositories: GitRepository[];
	readonly onDidOpenRepository: vscode.Event<GitRepository>;
}

/**
 * Resolve the VS Code built-in `git` extension API. Returns `undefined`
 * when the extension is not installed (e.g. `git.enabled: false` in
 * settings), disabled, or has not finished activating.
 */
export async function getGitApi(): Promise<GitApi | undefined> {
	const extension = vscode.extensions.getExtension('vscode.git');
	if (!extension) {
		logger.warn('VS Code git extension is not installed');
		return undefined;
	}
	const api = (await extension.activate()) as GitApi | undefined;
	if (!api || api.state !== 'initialized') {
		logger.warn('VS Code git extension API is not initialised yet');
		return undefined;
	}
	return api;
}

/**
 * Pick the most relevant repository for the current editor. We prefer
 * the one whose working tree contains the active file; we fall back to
 * the first available repository.
 */
export function pickActiveRepository(
	api: GitApi,
	activeFile: vscode.Uri | undefined,
): GitRepository | undefined {
	if (api.repositories.length === 0) {
		return undefined;
	}
	if (activeFile) {
		const match = api.repositories.find((repo) =>
			isInside(activeFile, repo.rootUri),
		);
		if (match) {
			return match;
		}
	}
	return api.repositories[0];
}

/** First open file in the active editor, used to choose the right repo. */
export function getActiveFileUri(): vscode.Uri | undefined {
	return vscode.window.tabGroups.activeTabGroup?.activeTab?.input instanceof vscode.TabInputText
		? (vscode.window.tabGroups.activeTabGroup.activeTab.input as vscode.TabInputText).uri
		: undefined;
}

function isInside(file: vscode.Uri, root: vscode.Uri): boolean {
	if (file.scheme !== root.scheme) {
		return false;
	}
	const fileFsPath = file.fsPath.replace(/\\/g, '/');
	const rootFsPath = root.fsPath.replace(/\\/g, '/');
	return fileFsPath === rootFsPath || fileFsPath.startsWith(rootFsPath + '/');
}

/**
 * Build a human-readable summary of the staged changes suitable for an
 * LLM prompt. We deliberately do not paste the raw diff when it's huge
 * — we cap it and substitute a placeholder so the model still gets the
 * file list but isn't overloaded with 100K lines of compile output.
 */
const MAX_DIFF_BYTES = 32 * 1024;
const MAX_FILE_LIST = 80;
const MAX_FILE_PATH_LENGTH = 160;

export function buildScmContext(repository: GitRepository): ScmContext {
	const existingMessage = repository.inputBox?.value ?? '';

	// Prefer the VS Code git extension's "index changes" (i.e. the
	// files currently in the staging area). These are the files that
	// will end up in the commit. We also include working-tree changes
	// as a fallback when nothing is staged, so the user can still
	// generate a draft from their un-staged work.
	const stagedResources = (repository.state.indexChanges ?? []).slice();
	const workingResources = (repository.state.workingTreeChanges ?? []).slice();
	const allChanges = stagedResources.length > 0 ? stagedResources : workingResources;

	const seen = new Set<string>();
	const fileNames: string[] = [];
	for (const resource of allChanges) {
		const name = resource.resourceUri.fsPath.replace(/\\/g, '/');
		if (seen.has(name)) {
			continue;
		}
		seen.add(name);
		fileNames.push(truncatePath(name));
		if (fileNames.length >= MAX_FILE_LIST) {
			break;
		}
	}

	const summaryLines: string[] = [];
	if (fileNames.length > 0) {
		const verb = stagedResources.length > 0 ? 'Staged' : 'Unstaged working-tree';
		summaryLines.push(`${verb} files (${allChanges.length} change${allChanges.length === 1 ? '' : 's'}):`);
		for (const name of fileNames) {
			summaryLines.push(`  - ${name}`);
		}
		if (allChanges.length > fileNames.length) {
			summaryLines.push(`  - ... and ${allChanges.length - fileNames.length} more`);
		}
	} else {
		summaryLines.push('No staged or working-tree changes detected.');
	}

	const diffText = extractDiff(repository);
	if (diffText && diffText.length > 0) {
		summaryLines.push('', 'Diff (truncated to 32KB):', '```diff', diffText, '```');
	}

	const branch = extractBranch(repository);

	return {
		uri: repository.rootUri,
		existingMessage,
		stagedDiff: summaryLines.join('\n'),
		stagedFileNames: fileNames,
		branch,
	};
}

function truncatePath(name: string): string {
	if (name.length <= MAX_FILE_PATH_LENGTH) {
		return name;
	}
	return `…${name.slice(name.length - MAX_FILE_PATH_LENGTH + 1)}`;
}

function extractDiff(repository: GitRepository): string {
	const diff = repository.state.diff;
	if (!diff) {
		return '';
	}
	if ('contents' in diff && typeof diff.contents === 'string') {
		return sliceDiff(diff.contents);
	}
	const callable = (diff as { with?: (other: string) => { contents: string } }).with;
	if (typeof callable === 'function') {
		try {
			const result = callable('HEAD');
			if (result && typeof result.contents === 'string') {
				return sliceDiff(result.contents);
			}
		} catch (error) {
			logger.debug('git diff with HEAD failed', error);
		}
	}
	return '';
}

function sliceDiff(text: string): string {
	if (text.length <= MAX_DIFF_BYTES) {
		return text;
	}
	return `${text.slice(0, MAX_DIFF_BYTES)}\n... (truncated, ${text.length - MAX_DIFF_BYTES} more bytes)`;
}

function extractBranch(repository: GitRepository): string | undefined {
	const refs = repository.state.refs;
	if (!Array.isArray(refs)) {
		return undefined;
	}
	const head = refs.find((ref) => ref.type === 0 && ref.name);
	return head?.name;
}

/**
 * Replace the SCM input-box contents. The user can then review / tweak
 * the message before committing. We use `inputBox.value =` so the
 * provider-driven commit generation behaves like a user typing in the
 * box (other extensions that observe the input box continue to work).
 */
export function setScmMessage(repository: GitRepository, message: string): void {
	repository.inputBox.value = message;
}

/**
 * Open the SCM view so the generated message is visible. No-op when
 * the view is already the active one.
 */
export function focusScmView(): void {
	void vscode.commands.executeCommand('workbench.view.scm');
}
