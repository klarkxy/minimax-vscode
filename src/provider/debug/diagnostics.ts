import * as vscode from 'vscode';
import { getDebugLoggingEnabled } from '../../config';
import { logger } from '../../logger';
import type { MiniMaxUsage } from '../../types';
import { formatRequestLogLine, type RequestKind } from './classifier';

export interface CacheDiagnosticsDoneInfo {
	reasoningTextChars: number;
	emittedToolCalls: number;
	trailingToolResults: number;
}

export interface CacheDiagnosticsRun {
	onDone(info: CacheDiagnosticsDoneInfo): void;
	onCancellationTokenRequested(): void;
	onUsage(usage: MiniMaxUsage, charsPerToken: number): void;
}

export interface LogToolFlowOptions {
	requestKind: RequestKind;
	tools?: readonly vscode.LanguageModelChatTool[];
	messagesFiltered: boolean;
	preflight: 'skipped' | 'handled' | 'ready' | 'round-limit';
	activatePreflight?: {
		rounds: number;
		calledActivatorNames: string[];
		remainingActivatorNames: string[];
	};
	nextRound?: number;
	initialResponseNotice?: boolean;
}

export function logToolFlowDiagnostics(options: LogToolFlowOptions): void {
	if (!getDebugLoggingEnabled()) {
		return;
	}
	const toolCount = options.tools?.length ?? 0;
	const activateNames = options.activatePreflight?.remainingActivatorNames ?? [];
	logger.info(
		formatRequestLogLine(
			options.requestKind,
			`toolFlow preflight=${options.preflight} tools=${toolCount} messagesFiltered=${options.messagesFiltered} activateRemaining=[${activateNames.join(',')}]`,
		),
	);
	if (options.nextRound !== undefined) {
		logger.info(
			formatRequestLogLine(
				options.requestKind,
				`toolFlow synthesised preflight round=${options.nextRound}`,
			),
		);
	}
}

export function observeCancellationToken(
	token: vscode.CancellationToken,
	diagnostics?: CacheDiagnosticsRun,
): vscode.Disposable {
	return token.onCancellationRequested(() => {
		diagnostics?.onCancellationTokenRequested();
	});
}

/**
 * Lightweight diagnostics recorder. Most call sites only care about the
 * final reasoning char count and tool call count, so we keep the
 * implementation minimal while still being a no-op when debug logging is
 * disabled.
 */
export function createCacheDiagnosticsRecorder(): CacheDiagnosticsRecorder {
	return new CacheDiagnosticsRecorderImpl();
}

export interface CacheDiagnosticsRecorder {
	beginRequest(): CacheDiagnosticsRun;
}

class CacheDiagnosticsRecorderImpl implements CacheDiagnosticsRecorder {
	beginRequest(): CacheDiagnosticsRun {
		return new CacheDiagnosticsRunImpl();
	}
}

class CacheDiagnosticsRunImpl implements CacheDiagnosticsRun {
	private done = false;

	onDone(info: CacheDiagnosticsDoneInfo): void {
		if (this.done) {
			return;
		}
		this.done = true;
		if (getDebugLoggingEnabled()) {
			logger.debug(
				`[cache-diagnostics] done reasoningChars=${info.reasoningTextChars} ` +
					`toolCalls=${info.emittedToolCalls} trailingToolResults=${info.trailingToolResults}`,
			);
		}
	}

	onCancellationTokenRequested(): void {
		if (getDebugLoggingEnabled()) {
			logger.debug('[cache-diagnostics] cancellation requested');
		}
	}

	onUsage(usage: MiniMaxUsage, charsPerToken: number): void {
		const cached = usage.cache_read_input_tokens ?? 0;
		const input = usage.input_tokens ?? 0;
		const output = usage.output_tokens ?? 0;
		if (getDebugLoggingEnabled()) {
			logger.debug(
				`[cache-diagnostics] usage input=${input} ` +
					`output=${output} cached=${cached} ` +
					`charsPerToken=${charsPerToken.toFixed(3)}`,
			);
		}
	}
}
