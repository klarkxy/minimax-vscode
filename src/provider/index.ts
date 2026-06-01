import * as vscode from 'vscode';
import { AuthManager } from '../auth';
import { getStabilizeToolListEnabled } from '../config';
import { t } from '../i18n';
import { getVisibleModels } from '../models/registry';
import { createUsageStore, type UsageStore } from '../usage';
import {
	classifyProviderRequest,
	createCacheDiagnosticsRecorder,
	dumpProviderInput,
} from './debug';
import { toChatInfo } from './models';
import { prepareChatRequest } from './request';
import { resolveConversationSegment } from './segment';
import { streamChatCompletion } from './stream';
import { DEFAULT_CHARS_PER_TOKEN, estimateTokenCount } from './tokens';
import { processToolFlow } from './tools/flow';
import { createVisionModelGetter, setVisionProxyModel } from './vision/index';

/**
 * MiniMax Chat Provider — implements vscode.LanguageModelChatProvider so
 * MiniMax models appear directly in the Copilot Chat model picker.
 */
export class MiniMaxChatProvider implements vscode.LanguageModelChatProvider {
	private readonly authManager: AuthManager;
	private readonly globalStorageUri: vscode.Uri;
	private readonly onDidChangeLanguageModelChatInformationEmitter = new vscode.EventEmitter<void>();
	private readonly usageStore: UsageStore;
	private isActive = true;

	readonly onDidChangeLanguageModelChatInformation =
		this.onDidChangeLanguageModelChatInformationEmitter.event;

	private readonly cacheDiagnostics = createCacheDiagnosticsRecorder();

	/** Vision proxy: resolver + cached model. */
	private readonly vision = createVisionModelGetter();

	/**
	 * Adaptive chars-per-token ratio, calibrated from actual usage data.
	 * Updated via exponential moving average each time the API reports real token counts.
	 */
	private charsPerToken = DEFAULT_CHARS_PER_TOKEN;

	constructor(
		context: vscode.ExtensionContext,
	) {
		this.authManager = new AuthManager(context);
		this.globalStorageUri = context.globalStorageUri;
		this.usageStore = createUsageStore(context.globalState);

		context.subscriptions.push(
			this.onDidChangeLanguageModelChatInformationEmitter,
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (
					e.affectsConfiguration('minimax.apiKey') ||
					e.affectsConfiguration('minimax.visibleModels') ||
					e.affectsConfiguration('minimax.apiBaseUrl') ||
					e.affectsConfiguration('minimax.debugMode') ||
					e.affectsConfiguration('minimax.modelIdOverrides')
				) {
					this.onDidChangeLanguageModelChatInformationEmitter.fire();
				}

				if (e.affectsConfiguration('minimax.visionModel')) {
					this.vision.reset();
				}
			}),
			// Multi-window: SecretStorage changes don't fire onDidChangeConfiguration.
			// When another window sets/clears the API key, refresh this window's
			// model picker so the warning state stays in sync.
			context.secrets.onDidChange((e) => {
				if (e.key === 'minimax-vscode.apiKey') {
					this.onDidChangeLanguageModelChatInformationEmitter.fire();
				}
			}),
		);
	}

	// ---- Public commands ----

	async configureApiKey(): Promise<void> {
		const saved = await this.authManager.promptForApiKey();
		if (saved) {
			this.onDidChangeLanguageModelChatInformationEmitter.fire();
		}
	}

	async clearApiKey(): Promise<void> {
		await this.authManager.deleteApiKey();
		this.onDidChangeLanguageModelChatInformationEmitter.fire();
		vscode.window.showInformationMessage(t('auth.removed'));
	}

	async hasApiKey(): Promise<boolean> {
		return this.authManager.hasApiKey();
	}

	/** Force Copilot Chat to re-query model information. */
	refreshModelPicker(): void {
		this.onDidChangeLanguageModelChatInformationEmitter.fire();
	}

	async prepareForDeactivate(): Promise<void> {
		this.isActive = false;
		this.onDidChangeLanguageModelChatInformationEmitter.fire();

		try {
			await vscode.lm.selectChatModels({ vendor: 'minimax' });
		} catch (error) {
			// Non-fatal: the model picker may already be empty.
			void error;
		}
	}

	/** See provider/vision */
	async setVisionProxyModel(): Promise<void> {
		await setVisionProxyModel();
	}

	// ---- LanguageModelChatProvider ----

	async provideLanguageModelChatInformation(
		_options: vscode.PrepareLanguageModelChatModelOptions,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelChatInformation[]> {
		if (!this.isActive) {
			return [];
		}

		const hasKey = await this.authManager.hasApiKey();
		const models = getVisibleModels();
		return models.map((model) => toChatInfo(model, hasKey));
	}

	async provideLanguageModelChatResponse(
		modelInfo: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const segment = resolveConversationSegment(messages);
		const requestKind = classifyProviderRequest({
			messages,
			tools: options.tools,
		});

		dumpProviderInput({
			globalStorageUri: this.globalStorageUri,
			segment,
			modelInfo,
			messages,
			requestOptions: options,
			requestKind,
		});

		const toolFlow = processToolFlow({
			stabilizeToolList: getStabilizeToolListEnabled(),
			messages,
			tools: options.tools,
			progress,
			requestKind,
		});
		if (toolFlow.preflightHandled) {
			return;
		}

		const prepared = await prepareChatRequest({
			authManager: this.authManager,
			globalStorageUri: this.globalStorageUri,
			modelInfo,
			segment,
			messages: toolFlow.messages,
			options,
			token,
			cacheDiagnostics: this.cacheDiagnostics,
			getVisionModel: () => this.vision.get(),
		});

		return streamChatCompletion({
			prepared,
			progress,
			token,
			initialResponseNotice: toolFlow.initialResponseNotice,
			getCharsPerToken: () => this.charsPerToken,
			setCharsPerToken: (charsPerToken) => {
				this.charsPerToken = charsPerToken;
			},
			onUsage: (usage) => {
				void this.usageStore.record(modelInfo.id, {
					inputTokens: usage.input_tokens,
					outputTokens: usage.output_tokens,
					cacheReadTokens: usage.cache_read_input_tokens,
					cacheWriteTokens: usage.cache_creation_input_tokens,
				});
			},
		});
	}

	provideTokenCount(
		_modelInfo: vscode.LanguageModelChatInformation,
		text: string | vscode.LanguageModelChatRequestMessage,
		_token: vscode.CancellationToken,
	): Thenable<number> {
		return Promise.resolve(estimateTokenCount(text, this.charsPerToken));
	}
}
