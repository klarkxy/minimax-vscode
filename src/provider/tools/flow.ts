import * as vscode from 'vscode';
import { t } from '../../i18n';
import { logToolFlowDiagnostics, type RequestKind } from '../debug';
import { ACTIVATE_TOOL_PREFIX, MAX_PREFLIGHT_ROUNDS_PER_USER_REQUEST } from './consts';
import { createToolDriftNotice, filterProviderNotices } from './notices';
import {
	createPreflightToolCallId,
	filterPreflightControlFlow,
	inspectActivatePreflight,
} from './preflight';

interface ToolFlowOptions {
	stabilizeToolList: boolean;
	messages: readonly vscode.LanguageModelChatRequestMessage[];
	tools: readonly vscode.LanguageModelChatTool[] | undefined;
	progress: vscode.Progress<vscode.LanguageModelResponsePart>;
	requestKind: RequestKind;
}

interface ToolFlowResult {
	preflightHandled: boolean;
	messages: readonly vscode.LanguageModelChatRequestMessage[];
	initialResponseNotice?: string;
}

/**
 * Tool flow control.
 *
 * 1. Strip our own provider-emitted tool-drift notices from history.
 * 2. Strip preflight activate_* tool calls and results.
 * 3. If the user has enabled the experimental `stabilizeToolList` setting
 *    and the host still presents `activate_*` placeholders, synthesise the
 *    missing activator calls so the host can expand them to real tools.
 * 4. When the request still has unexpanded activate tools, inject a
 *    visible-to-user tool-drift notice so the model can act on it.
 */
export function processToolFlow({
	stabilizeToolList,
	messages,
	tools,
	progress,
	requestKind,
}: ToolFlowOptions): ToolFlowResult {
	const filteredMessages = filterProviderNotices(filterPreflightControlFlow(messages));
	const messagesFiltered = filteredMessages !== messages;

	if (!stabilizeToolList) {
		logToolFlowDiagnostics({
			requestKind,
			tools,
			messagesFiltered,
			preflight: 'skipped',
		});
		return {
			preflightHandled: false,
			messages: filteredMessages,
		};
	}

	const activatePreflight = inspectActivatePreflight(messages, tools);
	if (activatePreflight.remainingActivatorNames.length > 0) {
		if (activatePreflight.rounds >= MAX_PREFLIGHT_ROUNDS_PER_USER_REQUEST) {
			logToolFlowDiagnostics({
				requestKind,
				tools,
				messagesFiltered,
				preflight: 'round-limit',
				activatePreflight,
			});
			throw new Error(
				t('request.preflightRoundLimitExceeded', MAX_PREFLIGHT_ROUNDS_PER_USER_REQUEST),
			);
		}

		const nextRound = activatePreflight.rounds + 1;
		logToolFlowDiagnostics({
			requestKind,
			tools,
			messagesFiltered,
			preflight: 'handled',
			activatePreflight,
			nextRound,
		});
		for (const toolName of activatePreflight.remainingActivatorNames) {
			progress.report(
				new vscode.LanguageModelToolCallPart(
					createPreflightToolCallId(nextRound, toolName),
					toolName,
					{},
				),
			);
		}

		return { preflightHandled: true, messages };
	}

	const hasUnexpandedActivateTools =
		activatePreflight.rounds > 0 &&
		tools?.some((tool) => tool.name.startsWith(ACTIVATE_TOOL_PREFIX));
	logToolFlowDiagnostics({
		requestKind,
		tools,
		messagesFiltered,
		preflight: 'ready',
		activatePreflight,
		initialResponseNotice: hasUnexpandedActivateTools,
	});

	return {
		preflightHandled: false,
		messages: filteredMessages,
		initialResponseNotice: hasUnexpandedActivateTools ? createToolDriftNotice() : undefined,
	};
}
