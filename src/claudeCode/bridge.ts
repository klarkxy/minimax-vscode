import * as vscode from 'vscode';
import { getClaudeCodeRoutingConfig, type ClaudeCodeRoutingConfig } from '../config';
import { t } from '../i18n';
import type { KeyManager } from '../keyManager';
import { logger } from '../logger';
import { MANAGED_ENV_NAMES, buildManagedEnv, mergeEnvironmentVariables, sameEnv } from './env';
import { probeExistingProxy, startProxy, type MiniMaxTarget, type RunningProxy } from './proxy';

/** How often a window that does not own the shared proxy checks whether it can take over. */
const TAKEOVER_INTERVAL_MS = 5_000;

export type BridgeState =
	| { kind: 'off'; reason: 'disabled' | 'noKey' }
	/** This window serves the proxy. */
	| { kind: 'owner'; port: number }
	/** Another VS Code window serves the proxy; this one stands by. */
	| { kind: 'shared'; port: number }
	/** The port is held by something that is not our proxy. */
	| { kind: 'error'; port: number; message: string };

/**
 * Wires the routing proxy into Claude Code:
 *  - runs the proxy (or stands by while another window runs it),
 *  - injects `ANTHROPIC_BASE_URL` + model overrides into new Claude Code
 *    sessions via `claudeCode.environmentVariables` and into VS Code
 *    terminals via the extension's environment variable collection.
 *
 * Injection is scoped to VS Code on purpose: a standalone `claude` CLI
 * outside VS Code never points at a proxy that may not be running.
 */
export class ClaudeCodeBridge implements vscode.Disposable {
	private proxy?: RunningProxy;
	private proxySignature?: string;
	private takeoverTimer?: ReturnType<typeof setInterval>;
	private state: BridgeState = { kind: 'off', reason: 'disabled' };
	private queue: Promise<void> = Promise.resolve();
	private disposed = false;
	private readonly statusItem: vscode.StatusBarItem;
	private readonly subscriptions: vscode.Disposable[] = [];

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly keyManager: KeyManager,
	) {
		this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 61);
		this.statusItem.command = 'minimax.claudeCode.menu';
		this.subscriptions.push(
			this.statusItem,
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('minimax.claudeCode.routing')) {
					void this.refresh();
				}
			}),
			keyManager.onDidChange(() => void this.refresh()),
		);
	}

	get currentState(): BridgeState {
		return this.state;
	}

	/** Re-read settings / key state and converge. Calls are serialised. */
	refresh(): Promise<void> {
		this.queue = this.queue
			.then(() => this.apply())
			.catch((error) => logger.error('[ClaudeCode] Failed to apply routing', error));
		return this.queue;
	}

	private async apply(): Promise<void> {
		if (this.disposed) {
			return;
		}
		const cfg = getClaudeCodeRoutingConfig();
		const hasKey = Boolean(await this.keyManager.getActiveApiKey());
		if (!cfg.enabled || !hasKey) {
			// The proxy is left running (if this window owns it) so sessions
			// started before the switch keep working until they restart.
			this.stopTakeoverTimer();
			this.setState({ kind: 'off', reason: cfg.enabled ? 'noKey' : 'disabled' });
			await this.writeEnv({}, cfg);
			return;
		}
		await this.ensureProxy(cfg);
		if (this.state.kind === 'error') {
			// Never point Claude Code at a port some other program owns.
			await this.writeEnv({}, cfg);
			return;
		}
		await this.writeEnv(buildManagedEnv(`http://127.0.0.1:${cfg.port}`, cfg.models), cfg);
	}

	private async ensureProxy(cfg: ClaudeCodeRoutingConfig): Promise<void> {
		const signature = `${cfg.port}|${cfg.passthroughUrl}`;
		if (this.proxy && this.proxySignature === signature) {
			this.setState({ kind: 'owner', port: cfg.port });
			return;
		}
		await this.stopProxy();
		try {
			this.proxy = await startProxy({
				port: cfg.port,
				passthroughBaseUrl: cfg.passthroughUrl,
				resolveMiniMax: () => this.resolveTarget(),
				missingKeyMessage: t('claudeCode.missingKey'),
				logger,
			});
			this.proxySignature = signature;
			this.stopTakeoverTimer();
			this.setState({ kind: 'owner', port: cfg.port });
			logger.info(`[ClaudeCode] Routing proxy listening on ${this.proxy.url} (passthrough ${cfg.passthroughUrl})`);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === 'EADDRINUSE' && (await probeExistingProxy(cfg.port))) {
				this.setState({ kind: 'shared', port: cfg.port });
				this.startTakeoverTimer(cfg.port);
				logger.info(`[ClaudeCode] Port ${cfg.port} is served by another VS Code window; standing by.`);
				return;
			}
			const message = error instanceof Error ? error.message : String(error);
			const wasError = this.state.kind === 'error' && this.state.port === cfg.port;
			this.stopTakeoverTimer();
			this.setState({ kind: 'error', port: cfg.port, message });
			logger.error(`[ClaudeCode] Could not start routing proxy on port ${cfg.port}`, error);
			if (!wasError) {
				void vscode.window.showErrorMessage(t('claudeCode.portBusy', cfg.port, message));
			}
		}
	}

	private async resolveTarget(): Promise<MiniMaxTarget | undefined> {
		const apiKey = await this.keyManager.getActiveApiKey();
		if (!apiKey) {
			return undefined;
		}
		return { apiKey, baseUrl: await this.keyManager.getActiveApiBaseUrl() };
	}

	private startTakeoverTimer(port: number): void {
		if (this.takeoverTimer) {
			return;
		}
		this.takeoverTimer = setInterval(() => {
			void probeExistingProxy(port).then((alive) => {
				if (!alive && !this.disposed) {
					logger.info(`[ClaudeCode] Proxy owner on port ${port} went away; taking over.`);
					void this.refresh();
				}
			});
		}, TAKEOVER_INTERVAL_MS);
	}

	private stopTakeoverTimer(): void {
		if (this.takeoverTimer) {
			clearInterval(this.takeoverTimer);
			this.takeoverTimer = undefined;
		}
	}

	private async stopProxy(): Promise<void> {
		const proxy = this.proxy;
		this.proxy = undefined;
		this.proxySignature = undefined;
		if (proxy) {
			await proxy.close();
			logger.info('[ClaudeCode] Routing proxy stopped');
		}
	}

	private async writeEnv(desired: Record<string, string>, cfg: ClaudeCodeRoutingConfig): Promise<void> {
		// Terminals: only touch variables whose value actually changes so
		// VS Code does not flag every terminal as stale on each refresh.
		const collection = this.context.environmentVariableCollection;
		collection.description = t('claudeCode.terminalDescription');
		for (const name of MANAGED_ENV_NAMES) {
			const value = desired[name];
			if (value === undefined) {
				if (collection.get(name)) {
					collection.delete(name);
				}
			} else if (collection.get(name)?.value !== value) {
				collection.replace(name, value);
			}
		}

		// Claude Code extension sessions.
		const claudeConfig = vscode.workspace.getConfiguration('claudeCode');
		const existing = claudeConfig.inspect<unknown[]>('environmentVariables')?.globalValue ?? [];
		const merged = mergeEnvironmentVariables(Array.isArray(existing) ? existing : [], desired);
		if (sameEnv(existing, merged)) {
			return;
		}
		try {
			await claudeConfig.update('environmentVariables', merged, vscode.ConfigurationTarget.Global);
		} catch (error) {
			// The setting is only registered while the Claude Code extension
			// is installed; terminals still get the env above.
			logger.warn('[ClaudeCode] Could not update claudeCode.environmentVariables', error);
			return;
		}
		const tiers = describeTiers(cfg);
		if (Object.keys(desired).length > 0) {
			logger.info(`[ClaudeCode] Injected routing env: ${tiers}`);
			void vscode.window.showInformationMessage(t('claudeCode.envApplied', tiers));
		} else {
			logger.info('[ClaudeCode] Removed routing env');
			void vscode.window.showInformationMessage(t('claudeCode.envRemoved'));
		}
	}

	private setState(state: BridgeState): void {
		this.state = state;
		const cfg = getClaudeCodeRoutingConfig();
		const item = this.statusItem;
		const tiers = describeTiers(cfg);
		switch (state.kind) {
			case 'off':
				if (state.reason === 'disabled') {
					item.hide();
					return;
				}
				item.text = '$(warning) MiniMax CC';
				item.tooltip = t('claudeCode.status.noKey');
				break;
			case 'owner':
			case 'shared':
				item.text = '$(arrow-swap) MiniMax CC';
				item.tooltip = t(
					state.kind === 'owner' ? 'claudeCode.status.owner' : 'claudeCode.status.shared',
					state.port,
					tiers,
				);
				break;
			case 'error':
				item.text = '$(error) MiniMax CC';
				item.tooltip = t('claudeCode.portBusy', state.port, state.message);
				break;
		}
		item.show();
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.stopTakeoverTimer();
		// Another window (if any) takes over within TAKEOVER_INTERVAL_MS.
		void this.stopProxy();
		for (const d of this.subscriptions) {
			d.dispose();
		}
	}
}

/** "MiniMax-M3 → Haiku" style summary of the active overrides. */
export function describeTiers(cfg: Pick<ClaudeCodeRoutingConfig, 'models'>): string {
	const parts: string[] = [];
	const labels: Array<[keyof ClaudeCodeRoutingConfig['models'], string]> = [
		['haiku', 'Haiku'],
		['sonnet', 'Sonnet'],
		['opus', 'Opus'],
	];
	for (const [tier, label] of labels) {
		const model = cfg.models[tier].trim();
		if (model) {
			parts.push(`${model} → ${label}`);
		}
	}
	return parts.length > 0 ? parts.join(', ') : '—';
}

/** Quick-pick menu behind the status bar item. */
export async function showClaudeCodeMenu(bridge: ClaudeCodeBridge): Promise<void> {
	const enabled = getClaudeCodeRoutingConfig().enabled;
	type Item = vscode.QuickPickItem & { run: () => Thenable<unknown> | void };
	const items: Item[] = [
		enabled
			? { label: `$(debug-stop) ${t('claudeCode.menu.disable')}`, run: () => setRoutingEnabled(false) }
			: { label: `$(play) ${t('claudeCode.menu.enable')}`, run: () => setRoutingEnabled(true) },
		{
			label: `$(settings-gear) ${t('claudeCode.menu.settings')}`,
			run: () => vscode.commands.executeCommand('workbench.action.openSettings', 'minimax.claudeCode.routing'),
		},
		{ label: `$(key) ${t('claudeCode.menu.keys')}`, run: () => vscode.commands.executeCommand('minimax.manageApiKeys') },
		{ label: `$(output) ${t('claudeCode.menu.logs')}`, run: () => vscode.commands.executeCommand('minimax.showLogs') },
	];
	const state = bridge.currentState;
	const picked = await vscode.window.showQuickPick(items, {
		title: `MiniMax → Claude Code (${state.kind})`,
	});
	await picked?.run();
}

export function setRoutingEnabled(enabled: boolean): Thenable<void> {
	return vscode.workspace
		.getConfiguration('minimax')
		.update('claudeCode.routing.enabled', enabled, vscode.ConfigurationTarget.Global);
}
