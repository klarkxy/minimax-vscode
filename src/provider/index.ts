import * as vscode from 'vscode';
import { AuthManager } from '../auth';
import { getStabilizeToolListEnabled } from '../config';
import { t } from '../i18n';
import { getVisibleModels } from '../models/registry';
import { createUsageStore, type UsageStore } from '../usage';
import { createChatTurnNotifier, type ChatTurnNotifier } from '../dashboard/chatTurnNotifier';
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

	/**
	 * Fires once per Copilot user-facing turn (not per internal API
	 * request). A single turn can fan out to many Anthropic requests
	 * (tool calls, thinking sub-steps, cache retries); the dashboard
	 * plan cache listens to this so it pulses at most once per turn.
	 */
	private readonly _chatTurnNotifier: ChatTurnNotifier = createChatTurnNotifier();

	/** Public accessor for cross-module subscribers (e.g. dashboard). */
	get chatTurnNotifier(): ChatTurnNotifier {
		return this._chatTurnNotifier;
	}

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
				// The thinking on/off switch is a per-model dropdown
				// rendered from `configurationSchema` (see
				// `provider/models.ts`). Copilot Chat owns that
				// dropdown's state, so the provider does **not**
				// need to listen to it here — the user picks
				// `开启 / 关闭` in the picker and the next chat
				// request carries the choice through
				// `options.modelConfiguration[THINKING_ENABLED_KEY]`.
				// This mirrors the `deepseek-v4-for-copilot`
				// `reasoningEffort` wiring, which is also dropdown-
				// only with no companion command or setting.
				//
				// `minimax.enableM31MContext` is watched for the
				// same reason: it controls M3's effective context
				// window in the picker, so the "上下文窗口" indicator
				// has to update live without an editor reload. The
				// boolean is flipped via the `minimax.toggleM31MContext`
				// command (which pops a modal warning first).
				//
				// `minimax.maxTokens`, `minimax.sampling`, and
				// `minimax.experimental.*` are also watched so the
				// picker reflects any per-model cap, sampling
				// override, or experimental knob the user flipped
				// — without these, a session would need to be
				// re-created to pick up the new value.
				if (
					e.affectsConfiguration('minimax.apiKey') ||
					e.affectsConfiguration('minimax.visibleModels') ||
					e.affectsConfiguration('minimax.apiBaseUrl') ||
					e.affectsConfiguration('minimax.debugMode') ||
					e.affectsConfiguration('minimax.modelIdOverrides') ||
					e.affectsConfiguration('minimax.enableM31MContext') ||
					e.affectsConfiguration('minimax.maxTokens') ||
					e.affectsConfiguration('minimax.sampling') ||
					e.affectsConfiguration('minimax.experimental.stabilizeToolList') ||
					e.affectsConfiguration('minimax.experimental.modelDefPresets')
				) {
					this.onDidChangeLanguageModelChatInformationEmitter.fire();
				}

				// `minimax.visionModel` changes invalidate the cached
				// vision-proxy model handle so the next request picks
				// up the new model.
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

		// Pulse the chat-turn notifier for EVERY user-facing turn —
		// including the preflight round (which consumes tool calls on
		// the host side) and prepare-time failures (which still count
		// toward the user's mental model of "one prompt, one round").
		// Without the start/end pair around the early returns, the
		// dashboard plan cache would only pulse on the round that
		// actually streamed a response.
		this._chatTurnNotifier.notifyTurnStart();
		try {
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

			return await streamChatCompletion({
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
		} finally {
			// Fire on both resolve and throw — the platform quota is
			// affected by every attempt that consumed a request, even
			// ones that errored mid-stream.
			this._chatTurnNotifier.notifyTurnEnd();
		}
	}

	provideTokenCount(
		_modelInfo: vscode.LanguageModelChatInformation,
		text: string | vscode.LanguageModelChatRequestMessage,
		_token: vscode.CancellationToken,
	): Thenable<number> {
		return Promise.resolve(estimateTokenCount(text, this.charsPerToken));
	}
}
