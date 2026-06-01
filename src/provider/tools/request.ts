import * as vscode from 'vscode';
import { t } from '../../i18n';
import type { MiniMaxMessage, MiniMaxTool } from '../../types';
import { convertTools } from '../convert';
import { DEEPSEEK_TOOLS_LIMIT } from './consts';

export function prepareRequestTools(
	toolCallingCapability: boolean | number | undefined,
	options: vscode.ProvideLanguageModelChatResponseOptions,
): MiniMaxTool[] | undefined {
	const tools = toolCallingCapability ? convertTools(options.tools) : undefined;
	const toolLimit = getToolCallingLimit(toolCallingCapability);
	const toolsCount = tools?.length ?? 0;
	if (toolsCount > toolLimit) {
		throw new Error(t('request.toolsLimitExceeded', toolLimit, toolsCount));
	}
	return tools;
}

export function collectTrailingToolResultIds(
	messages: readonly MiniMaxMessage[],
): string[] {
	// Anthropic's protocol embeds tool_result blocks inside user messages,
	// not as standalone `role: 'tool'` messages. We walk from the tail to
	// find contiguous trailing tool_result blocks.
	const trailingToolResultIds: string[] = [];
	let done = false;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		const content = message.content;
		if (typeof content === 'string') {
			if (content.length === 0 && trailingToolResultIds.length === 0) {
				continue;
			}
			break;
		}
		for (let blockIndex = content.length - 1; blockIndex >= 0; blockIndex -= 1) {
			const block = content[blockIndex];
			if (block.type === 'tool_result' && block.tool_use_id) {
				trailingToolResultIds.push(block.tool_use_id);
			} else {
				done = true;
				break;
			}
		}
		if (done) {
			break;
		}
	}
	return trailingToolResultIds.reverse();
}

function getToolCallingLimit(toolCallingCapability: boolean | number | undefined): number {
	return typeof toolCallingCapability === 'number' ? toolCallingCapability : DEEPSEEK_TOOLS_LIMIT;
}
