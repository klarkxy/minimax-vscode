import * as vscode from 'vscode';
import { MiniMaxClient } from '../client/core';
import { CONFIG_SECTION } from '../consts';
import { getApiModelId, getBaseUrl } from '../config';
import { t } from '../i18n';
import { logger } from '../logger';
import { MODELS, findModelById } from '../models/registry';
import type { MiniMaxMessage, MiniMaxRequest, MiniMaxUsage } from '../types';
import {
	buildScmContext,
	focusScmView,
	getActiveFileUri,
	getGitApi,
	pickActiveRepository,
	setScmMessage,
	type ScmContext,
} from './scm';

/** Public entry point: invoked from a command or menu. */
export async function generateCommitMessage(
	auth: { getApiKey: () => Promise<string | undefined> },
): Promise<void> {
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

	const repo = pickActiveRepository(gitApi, getActiveFileUri());
	if (!repo) {
		vscode.window.showErrorMessage(t('commit.noRepository'));
		return;
	}

	const context = buildScmContext(repo);
	const hasChanges = context.stagedFileNames.length > 0 || context.stagedDiff.length > 0;
	if (!hasChanges) {
		vscode.window.showInformationMessage(t('commit.noChanges'));
		return;
	}

	const modelId = resolveCommitModelId();
	const apiModelId = getApiModelId(modelId);
	const modelDef = findModelById(modelId);

	if (!modelDef) {
		vscode.window.showErrorMessage(t('commit.modelUnknown', modelId));
		return;
	}

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: t('commit.generating', modelDef.name),
			cancellable: true,
		},
		async (progress, token) => {
			progress.report({ message: t('commit.progressReading') });
			const result = await callCommitModel(
				apiKey,
				apiModelId,
				modelDef.maxOutputTokens,
				context,
				token,
			);
			if (token.isCancellationRequested) {
				return;
			}
			if (!result.text) {
				vscode.window.showErrorMessage(t('commit.emptyResult'));
				return;
			}

			setScmMessage(repo, result.text);
			focusScmView();
			logger.info(
				`Generated commit message (model=${apiModelId}, in=${result.usage?.input_tokens ?? 0}, out=${result.usage?.output_tokens ?? 0})`,
			);
		},
	);
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

/** Validate that the configured commit model exists; returns true on hit. */
export function isKnownCommitModelId(id: string): boolean {
	return MODELS.some((m) => m.id === id);
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
	// 256 is plenty for a Conventional-Commits style message; cap so a
	// 512K-cap model doesn't burn a 131K output budget by mistake.
	return Math.min(Math.max(modelMax, 0), 1024) || 256;
}

function buildCommitSystemPrompt(_context: ScmContext): string {
	return [
		'You are a commit-message generator.',
		'',
		'Rules:',
		'1. Output ONLY the commit message text, no preamble, no code fences.',
		'2. Use the Conventional Commits format when it fits: <type>(<scope>)<!>: <subject>.',
		'   Allowed types: feat, fix, refactor, perf, docs, test, build, ci, chore, style, revert.',
		'3. Subject line ≤ 72 characters, no trailing punctuation, imperative mood.',
		'4. Optional body: a blank line, then bullet points starting with "- " explaining the "what" and "why".',
		'5. If the user already typed a draft in the input box, polish and respect their intent rather than starting from scratch.',
		'6. Do NOT mention tool internals, the previous version, or the model itself.',
	].join('\n');
}

function buildCommitMessages(context: ScmContext): MiniMaxMessage[] {
	const hasDraft = context.existingMessage.trim().length > 0;
	const userParts: string[] = [];

	if (context.branch) {
		userParts.push(`Branch: ${context.branch}`);
	}

	if (hasDraft) {
		userParts.push('Current draft in the input box (polish this, do not start over):');
		userParts.push('```');
		userParts.push(context.existingMessage);
		userParts.push('```');
		userParts.push('');
		userParts.push('Below is the staged change context:');
	} else {
		userParts.push('Staged change context:');
	}

	userParts.push(context.stagedDiff);
	userParts.push('');
	if (hasDraft) {
		userParts.push('Return the polished commit message.');
	} else {
		userParts.push('Return the commit message.');
	}

	return [
		{
			role: 'user',
			content: userParts.join('\n'),
		},
	];
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
