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
	readonly repositories: GitRepository[];
	readonly onDidOpenRepository: vscode.Event<GitRepository>;
}

interface GitExtension {
	readonly enabled: boolean;
	getAPI(version: number): GitApi;
}

/**
 * Resolve the VS Code built-in `git` extension API. Returns `undefined`
 * when the extension is not installed (e.g. `git.enabled: false` in
 * settings), disabled, or has not finished activating.
 */
export async function getGitApi(): Promise<GitApi | undefined> {
	const gitEnabled = vscode.workspace.getConfiguration('git').get<boolean>('enabled', true);
	const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
	if (!extension) {
		logger.warn(
			`VS Code git extension is not installed or disabled (git.enabled=${gitEnabled})`,
		);
		return undefined;
	}
	const gitExt = (await extension.activate()) as GitExtension | undefined;
	if (!gitExt || !gitExt.getAPI) {
		logger.warn('VS Code git extension activation failed or returned an unexpected API shape');
		return undefined;
	}
	try {
		return gitExt.getAPI(1);
	} catch (error) {
		logger.warn('Failed to obtain Git extension API', error);
		return undefined;
	}
}

function isGitRepository(value: unknown): value is GitRepository {
	return (
		!!value &&
		typeof value === 'object' &&
		'rootUri' in value &&
		'inputBox' in value &&
		typeof (value as { inputBox?: { value?: unknown } })?.inputBox?.value === 'string'
	);
}

function isUriLike(value: unknown): value is vscode.Uri {
	return (
		!!value &&
		typeof value === 'object' &&
		'scheme' in value &&
		typeof (value as { scheme?: unknown })?.scheme === 'string' &&
		typeof (value as { path?: unknown })?.path === 'string'
	);
}

function asUri(value: unknown): vscode.Uri | undefined {
	if (value instanceof vscode.Uri) {
		return value;
	}
	if (!isUriLike(value)) {
		return undefined;
	}
	const external = (value as { external?: unknown }).external;
	if (typeof external === 'string') {
		try {
			return vscode.Uri.parse(external);
		} catch {
			// fall through to manual construction
		}
	}
	try {
		return vscode.Uri.parse((value as { path: string }).path);
	} catch {
		return undefined;
	}
}

/**
 * Pick the most relevant repository for the current editor or SCM command.
 * When the command was triggered from the SCM input box, VS Code passes
 * the repository root `Uri` as `commandArg`; we use it to pick the
 * matching GitRepository without asking the user.
 */
export async function pickRelevantRepository(
	api: GitApi,
	activeFile: vscode.Uri | undefined,
	commandArg?: unknown,
): Promise<GitRepository | undefined> {
	logger.debug('pickRelevantRepository', {
		repositoryCount: api.repositories.length,
		activeFile: activeFile?.fsPath,
		commandArgType: typeof commandArg,
		commandArgIsUri: isUriLike(commandArg),
		commandArgIsRepo: isGitRepository(commandArg),
	});

	if (isGitRepository(commandArg)) {
		logger.debug('pickRelevantRepository: using commandArg repository');
		return commandArg;
	}

	if (api.repositories.length === 0) {
		logger.debug('pickRelevantRepository: no repositories available');
		return undefined;
	}

	const argUri = asUri(commandArg);
	if (argUri) {
		const match = api.repositories.find((repo) => isInside(argUri, repo.rootUri));
		if (match) {
			logger.debug('pickRelevantRepository: matched commandArg Uri to repository', {
				repoRoot: match.rootUri.fsPath,
			});
			return match;
		}
		logger.debug('pickRelevantRepository: commandArg Uri did not match any repository', {
			argUri: argUri.fsPath,
		});
	}

	if (activeFile) {
		const match = api.repositories.find((repo) => isInside(activeFile, repo.rootUri));
		if (match) {
			logger.debug('pickRelevantRepository: matched active file to repository', {
				repoRoot: match.rootUri.fsPath,
			});
			return match;
		}
	}

	if (api.repositories.length === 1) {
		logger.debug('pickRelevantRepository: single repository fallback', {
			repoRoot: api.repositories[0].rootUri.fsPath,
		});
		return api.repositories[0];
	}

	const pickItems = api.repositories.map((repo) => ({
		label: repo.rootUri.fsPath,
		description: repo.state.HEAD?.name ? `Branch: ${repo.state.HEAD.name}` : undefined,
		repo,
	}));

	const selection = await vscode.window.showQuickPick(pickItems, {
		placeHolder: 'Select the Git repository to generate the commit message for',
		ignoreFocusOut: true,
	});

	return selection?.repo;
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

export function buildScmContext(
	repository: GitRepository,
	commandArg?: unknown,
): ScmContext {
	const existingMessage = repository.inputBox?.value ?? '';

	// 1. Try the SourceControl passed in via `commandArg` first — it's
	//    the most reliable source of staged/working change lists.
	const fromCommandArg = extractScmResourcesFromCommandArg(commandArg);
	// 2. Try the Git extension v1 API `state` fields.
	const state = repository.state ?? {};
	const stagedFromState = (state.indexChanges ?? []).slice();
	const workingFromState = (state.workingTreeChanges ?? []).slice();
	// 3. Try the repository's nested `repository.state` / `raw.state`.
	const fallback = readScmResourceGroups(repository);

	const stagedResources = fromCommandArg.staged.length > 0
		? fromCommandArg.staged
		: stagedFromState.length > 0
			? stagedFromState
			: fallback.staged;
	const workingResources = fromCommandArg.working.length > 0
		? fromCommandArg.working
		: workingFromState.length > 0
			? workingFromState
			: fallback.working;
	const allChanges = stagedResources.length > 0 ? stagedResources : workingResources;

	const seen = new Set<string>();
	const fileNames: string[] = [];
	for (const resource of allChanges) {
		const resourceUri = (resource as { resourceUri?: { fsPath?: string } })?.resourceUri;
		const fsPath = resourceUri?.fsPath;
		if (typeof fsPath !== 'string' || fsPath.length === 0) {
			continue;
		}
		const name = fsPath.replace(/\\/g, '/');
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

interface ScmResourceGroups {
	staged: ScmResource[];
	working: ScmResource[];
}

/**
 * A subset of VS Code's `SourceControl` shape. When the user invokes
 * the commit-message command from the SCM input box, VS Code passes
 * the active `SourceControl` instance as `commandArg[1]`. Walking its
 * `resourceGroups` is the only reliable way to enumerate staged and
 * working-tree changes in modern VS Code.
 */
export interface SourceControlSnapshot {
	resourceGroups?: Array<{
		id?: string;
		resources?: Array<{ resourceUri?: { fsPath?: string } }>;
	}>;
}

/** Extract the staged/working change lists from a `commandArg` payload. */
export function extractScmResourcesFromCommandArg(
	commandArg: unknown,
): ScmResourceGroups {
	const result: ScmResourceGroups = { staged: [], working: [] };
	if (!Array.isArray(commandArg) || commandArg.length < 2) {
		return result;
	}
	const sc = commandArg[1] as SourceControlSnapshot | undefined;
	if (!sc || !Array.isArray(sc.resourceGroups)) {
		return result;
	}
	for (const group of sc.resourceGroups) {
		if (!group || !Array.isArray(group.resources)) {
			continue;
		}
		const mapped = group.resources
			.map((entry) => {
				const fsPath = entry?.resourceUri?.fsPath;
				if (typeof fsPath !== 'string' || fsPath.length === 0) {
					return undefined;
				}
				return { resourceUri: { fsPath } } as ScmResource;
			})
			.filter((entry): entry is ScmResource => entry !== undefined);
		if (group.id === 'index') {
			result.staged = result.staged.concat(mapped);
		} else if (group.id === 'workingTree') {
			result.working = result.working.concat(mapped);
		}
	}
	return result;
}

/**
 * Try the Git extension's `Repository` instance directly when the v1
 * API's `state` object doesn't carry change lists. The real
 * `Repository` class exposes `diffWith`, `diffIndexWith`, and a
 * `state` that *does* expose `workingTreeChanges` / `indexChanges`
 * after a `recompute` cycle — the `getAPI(1)` call hands us the same
 * instance, so we can reach in via duck typing.
 */
function readScmResourceGroups(repository: GitRepository): ScmResourceGroups {
	const result: ScmResourceGroups = { staged: [], working: [] };
	const candidates = [
		repository as unknown as { state?: { indexChanges?: ScmResource[]; workingTreeChanges?: ScmResource[] } },
		(repository as unknown as { repository?: { state?: { indexChanges?: ScmResource[]; workingTreeChanges?: ScmResource[] } } }).repository,
		(repository as unknown as { raw?: { state?: { indexChanges?: ScmResource[]; workingTreeChanges?: ScmResource[] } } }).raw,
	];
	for (const candidate of candidates) {
		if (!candidate || typeof candidate !== 'object') {
			continue;
		}
		const state = (candidate as { state?: { indexChanges?: ScmResource[]; workingTreeChanges?: ScmResource[] } }).state;
		if (!state) {
			continue;
		}
		if (Array.isArray(state.indexChanges)) {
			result.staged = result.staged.concat(state.indexChanges);
		}
		if (Array.isArray(state.workingTreeChanges)) {
			result.working = result.working.concat(state.workingTreeChanges);
		}
	}
	return result;
}

function truncatePath(name: string): string {
	if (name.length <= MAX_FILE_PATH_LENGTH) {
		return name;
	}
	return `…${name.slice(name.length - MAX_FILE_PATH_LENGTH + 1)}`;
}

function extractDiff(repository: GitRepository): string {
	const diff = (repository.state ?? {}).diff;
	if (!diff) {
		return '';
	}
	if ('contents' in diff && typeof (diff as { contents?: unknown }).contents === 'string') {
		return sliceDiff((diff as { contents: string }).contents);
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
	const refs = (repository.state ?? {}).refs;
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
	logger.debug('setScmMessage', {
		repoRoot: repository.rootUri.fsPath,
		messagePreview: message.slice(0, 120),
	});
	repository.inputBox.value = message;
}

/**
 * Open the SCM view so the generated message is visible. No-op when
 * the view is already the active one.
 */
export function focusScmView(): void {
	logger.debug('focusScmView');
	void vscode.commands.executeCommand('workbench.view.scm');
}
