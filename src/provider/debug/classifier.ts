import * as vscode from 'vscode';
import type { MiniMaxMessage, MiniMaxTool } from '../../types';

export type RequestKind =
	| 'main-agent'
	| 'terminal-steering'
	| 'todo-tracker'
	| 'settings-resolver'
	| 'background'
	| 'unknown';

const TODO_TRACKER_PREFIX = 'You are a background task tracker';
const SETTINGS_RESOLVER_PREFIX =
	'You are a Visual Studio Code assistant. Your job is to assist users in using Visual Studio Code by returning settings';
const MAIN_AGENT_PREFIX = 'You are an expert AI programming assistant';
const TERMINAL_NOTIFICATION_PATTERN = /^\[Terminal\s+\S+\s+notification:/;

export function formatModelFields(vscodeModelId: string, apiModelId?: string): string {
	const apiField = apiModelId && apiModelId !== vscodeModelId ? ` apiModel=${apiModelId}` : '';
	return `model=${vscodeModelId}${apiField}`;
}

export function formatRequestLogLine(requestKind: RequestKind, message: string): string {
	return `[${requestKind}] ${message}`;
}

export function classifyProviderRequest(input: {
	messages: readonly vscode.LanguageModelChatRequestMessage[];
	tools?: readonly vscode.LanguageModelChatTool[];
}): RequestKind {
	return classifyRequest({
		firstText: getFirstVscodeText(input.messages),
		latestUserText: getLatestVscodeUserText(input.messages),
		toolNames: input.tools?.map((tool) => tool.name) ?? [],
	});
}

export function classifyMiniMaxRequest(input: {
	request: { messages: MiniMaxMessage[]; tools?: MiniMaxTool[] };
	inputMessages?: readonly vscode.LanguageModelChatRequestMessage[];
}): RequestKind {
	return classifyRequest({
		firstText:
			(typeof input.request.messages[0]?.content === 'string'
				? input.request.messages[0]?.content
				: '') ??
			(input.inputMessages ? getFirstVscodeText(input.inputMessages) : ''),
		latestUserText:
			(input.inputMessages ? getLatestVscodeUserText(input.inputMessages) : '') ||
			getLatestMiniMaxUserText(input.request),
		toolNames: input.request.tools?.map(getMiniMaxToolName) ?? [],
	});
}

function classifyRequest(input: {
	firstText: string;
	latestUserText: string;
	toolNames: readonly string[];
}): RequestKind {
	const firstText = input.firstText.trimStart();
	const latestUserText = input.latestUserText.trimStart();
	if (TERMINAL_NOTIFICATION_PATTERN.test(latestUserText)) {
		return 'terminal-steering';
	}
	if (
		isOnlyTool(input.toolNames, 'manage_todo_list') ||
		firstText.startsWith(TODO_TRACKER_PREFIX)
	) {
		return 'todo-tracker';
	}
	if (firstText.startsWith(SETTINGS_RESOLVER_PREFIX)) {
		return 'settings-resolver';
	}
	if (
		firstText.startsWith(MAIN_AGENT_PREFIX) ||
		firstText.includes('<skills>') ||
		firstText.includes('<agents>')
	) {
		return 'main-agent';
	}
	if (input.toolNames.length > 0 || firstText.length > 0) {
		return 'background';
	}
	return 'unknown';
}

function isOnlyTool(toolNames: readonly string[], toolName: string): boolean {
	return toolNames.length === 1 && toolNames[0] === toolName;
}

function getMiniMaxToolName(tool: MiniMaxTool): string {
	return tool.name;
}

function getFirstVscodeText(messages: readonly vscode.LanguageModelChatRequestMessage[]): string {
	const firstMessage = messages[0];
	if (!firstMessage) {
		return '';
	}

	return getVscodeMessageText(firstMessage);
}

function getLatestVscodeUserText(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role === vscode.LanguageModelChatMessageRole.User) {
			return getVscodeMessageText(message);
		}
	}
	return '';
}

function getVscodeMessageText(message: vscode.LanguageModelChatRequestMessage): string {
	let text = '';
	for (const part of message.content) {
		if (part instanceof vscode.LanguageModelTextPart) {
			text += part.value;
		}
	}
	return text;
}

function getLatestMiniMaxUserText(request: { messages: MiniMaxMessage[] }): string {
	for (let index = request.messages.length - 1; index >= 0; index -= 1) {
		const message = request.messages[index];
		if (message.role === 'user') {
			return typeof message.content === 'string' ? message.content : '';
		}
	}
	return '';
}
