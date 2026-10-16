import { createHash, randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { getClaudeCodeRoutingConfig, type ClaudeCodeRoutingConfig } from '../config';
import {
	CLAUDE_CODE_ENV_ANNOUNCED_KEY,
	CLAUDE_CODE_ENV_OWNERSHIP_KEY,
	CLAUDE_CODE_PROXY_SECRET_KEY,
	CONFIG_SECTION,
} from '../consts';
import { t } from '../i18n';
import type { KeyManager } from '../keyManager';
import { logger } from '../logger';
import { getModels } from '../models/registry';
import {
	MANAGED_ENV_NAMES,
	adoptUnrecordedEntries,
	applyManagedEnv,
	buildManagedEnv,
	pickManagedEnv,
	planEnvironmentVariables,
	proxyBaseUrl,
	resolvePassthroughUrl,
	sameEnv,
	shadowedNames,
	type EnvOwnership,
} from './env';
import { probeExistingProxy, startProxy, type MiniMaxTarget, type RunningProxy } from './proxy';

/** How often a window that does not own the shared proxy checks whether it can take over. */
const TAKEOVER_INTERVAL_MS = 5_000;

const CLAUDE_CODE_EXTENSION_ID = 'anthropic.claude-code';

export type BridgeState =
	| { kind: 'off'; reason: 'disabled' | 'noKey' }
	/** This window serves the proxy. */
	| { kind: 'owner'; port: number }
	/** Another VS Code window with the same keys and settings serves the proxy; this one stands by. */
	| { kind: 'shared'; port: number }
	/** The port is held by something this window must not route through. */
	| { kind: 'error'; port: number; message: string };

/**
 * `apply` follows the routing settings; `release` hands the env back
 * because this window's proxy is about to stop.
 */
type EnvWriteReason = 'apply' | 'release';

/**
 * Wires the routing proxy into Claude Code:
 *  - runs the proxy (or stands by while another window runs it),
 *  - while routing is on and a proxy is up, sets `ANTHROPIC_BASE_URL` +
 *    model overrides on this extension host's `process.env` (Claude Code
 *    copies it into every session it spawns) and on the terminal overlay.
 *
 * Both are per window and die with it, so other people logged into the
 * same (shared) remote account never see them and nothing is left
 * pointing at a dead port. The base URL carries the proxy's path secret,
 * which lives in this user's global state (kept on the VS Code client,
 * not on the remote), so only their own windows can use the proxy.
 * `claudeCode.environmentVariables` is only touched to remove what older
 * builds wrote there (see `env.ts`).
 *
 * Windows share one proxy only when it reports the same scope (a hash of
 * the secret), i.e. it reads the same key pool and settings; it resolves
 * the key, region and passthrough upstream per request from those shared
 * stores, so it does not matter which of those windows started it.
 */
export class ClaudeCodeBridge implements vscode.Disposable {
	private proxy?: RunningProxy;
	private takeoverTimer?: ReturnType<typeof setInterval>;
	/** pid of the proxy this window watches while it does not own the port. */
	private watchedPid?: number;
	private state: BridgeState = { kind: 'off', reason: 'disabled' };
	private queue: Promise<void> = Promise.resolve();
	private disposed = false;
	private shutdownPromise?: Promise<void>;
	private readonly statusItem: vscode.StatusBarItem;
	private readonly subscriptions: vscode.Disposable[] = [];
	/** The managed variables as this extension host started with them. */
	private readonly inherited = pickManagedEnv(process.env);
	/** Last `shadowedNames` result the user was warned about. */
	private shadowWarning = '';

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly keyManager: KeyManager,
	) {
		// Terminal env follows the proxy's lifetime: VS Code must not
		// restore it into terminals before this extension runs again.
		context.environmentVariableCollection.persistent = false;
		this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 61);
		this.statusItem.command = 'minimax.claudeCode.menu';
		this.subscriptions.push(
			this.statusItem,
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (
					e.affectsConfiguration('minimax.claudeCode.routing') ||
					e.affectsConfiguration('claudeCode.environmentVariables')
				) {
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
			await this.writeEnv({}, cfg, 'apply');
			return;
		}
		await this.ensureProxy(cfg);
		if (this.state.kind === 'error') {
			// Never point Claude Code at a port we cannot vouch for.
			await this.writeEnv({}, cfg, 'apply');
			return;
		}
		await this.writeEnv(buildManagedEnv(proxyBaseUrl(cfg.port, this.secret()), cfg.models), cfg, 'apply');
	}

	private async ensureProxy(cfg: ClaudeCodeRoutingConfig): Promise<void> {
		if (this.proxy?.port === cfg.port) {
			this.setState({ kind: 'owner', port: cfg.port });
			return;
		}
		await this.stopProxy();
		try {
			this.proxy = await startProxy({
				port: cfg.port,
				resolvePassthrough: () => this.resolvePassthrough(cfg.port),
				resolveMiniMax: () => this.resolveTarget(),
				scope: () => this.scopeId(),
				secret: this.secret(),
				missingKeyMessage: t('claudeCode.missingKey'),
				forbiddenMessage: t('claudeCode.forbidden'),
				logger,
			});
			this.stopTakeoverTimer();
			this.setState({ kind: 'owner', port: cfg.port });
			logger.info(
				`[ClaudeCode] Routing proxy listening on ${this.proxy.url} (passthrough ${this.resolvePassthrough(cfg.port)})`,
			);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === 'EADDRINUSE') {
				const health = await probeExistingProxy(cfg.port);
				if (health && health.scope === this.scopeId()) {
					this.setState({ kind: 'shared', port: cfg.port });
					this.watch(cfg.port, health.pid);
					logger.info(`[ClaudeCode] Port ${cfg.port} is served by another VS Code window (pid ${health.pid}); standing by.`);
					return;
				}
				if (health) {
					// A MiniMax proxy serving other keys / settings: keep
					// watching so routing resumes once it goes away.
					this.watch(cfg.port, health.pid);
					this.fail(cfg.port, t('claudeCode.portForeign', cfg.port, health.pid), error);
					return;
				}
			}
			this.stopTakeoverTimer();
			const message = error instanceof Error ? error.message : String(error);
			this.fail(cfg.port, t('claudeCode.portBusy', cfg.port, message), error);
		}
	}

	private fail(port: number, message: string, error: unknown): void {
		const repeated = this.state.kind === 'error' && this.state.port === port && this.state.message === message;
		this.setState({ kind: 'error', port, message });
		logger.error(`[ClaudeCode] Could not start routing proxy on port ${port}: ${message}`, error);
		if (!repeated) {
			void vscode.window.showErrorMessage(message);
		}
	}

	private async resolveTarget(): Promise<MiniMaxTarget | undefined> {
		const apiKey = await this.keyManager.getActiveApiKey();
		if (!apiKey) {
			return undefined;
		}
		return { apiKey, baseUrl: await this.keyManager.getActiveApiBaseUrl() };
	}

	private resolvePassthrough(port: number): string {
		return resolvePassthroughUrl(
			getClaudeCodeRoutingConfig().passthroughUrl,
			this.inherited.ANTHROPIC_BASE_URL,
			port,
		);
	}

	/** Random proxy path secret shared by every window reading this
	 *  extension's global state. */
	private secret(): string {
		let secret = this.context.globalState.get<string>(CLAUDE_CODE_PROXY_SECRET_KEY);
		if (!secret) {
			secret = randomBytes(24).toString('base64url');
			void this.context.globalState.update(CLAUDE_CODE_PROXY_SECRET_KEY, secret);
		}
		return secret;
	}

	/** What the health endpoint reports: identifies the secret without revealing it. */
	private scopeId(): string {
		return createHash('sha256').update(this.secret()).digest('hex').slice(0, 32);
	}

	/**
	 * Poll the proxy another process serves on `port`: take over when it
	 * goes away, and re-converge when a different window took it over (or,
	 * for a foreign proxy, once it turns out to share our scope).
	 */
	private watch(port: number, pid: number): void {
		this.stopTakeoverTimer();
		this.watchedPid = pid;
		this.takeoverTimer = setInterval(() => {
			void probeExistingProxy(port).then((health) => {
				if (this.disposed || this.watchedPid === undefined) {
					return;
				}
				if (!health) {
					logger.info(`[ClaudeCode] Proxy owner on port ${port} went away; taking over.`);
					void this.refresh();
				} else if (
					health.pid !== this.watchedPid ||
					(this.state.kind === 'error' && health.scope === this.scopeId())
				) {
					void this.refresh();
				}
			});
		}, TAKEOVER_INTERVAL_MS);
	}

	private stopTakeoverTimer(): void {
		this.watchedPid = undefined;
		if (this.takeoverTimer) {
			clearInterval(this.takeoverTimer);
			this.takeoverTimer = undefined;
		}
	}

	private async stopProxy(): Promise<void> {
		const proxy = this.proxy;
		this.proxy = undefined;
		if (proxy) {
			await proxy.close();
			logger.info('[ClaudeCode] Routing proxy stopped');
		}
	}

	private readOwnership(): EnvOwnership {
		const stored = this.context.globalState.get<EnvOwnership>(CLAUDE_CODE_ENV_OWNERSHIP_KEY);
		return stored && typeof stored === 'object' ? stored : {};
	}

	private async saveOwnership(owned: EnvOwnership): Promise<void> {
		if (sameEnv([this.readOwnership()], [owned])) {
			return;
		}
		await this.context.globalState.update(
			CLAUDE_CODE_ENV_OWNERSHIP_KEY,
			Object.keys(owned).length > 0 ? owned : undefined,
		);
	}

	private async writeEnv(
		desired: Record<string, string>,
		cfg: ClaudeCodeRoutingConfig,
		reason: EnvWriteReason,
	): Promise<void> {
		// Terminals: the collection is an overlay VS Code applies on top of
		// the user's own environment, so deleting an entry restores theirs.
		// Only touch variables whose value actually changes so VS Code does
		// not flag every terminal as stale on each refresh.
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

		// Claude Code extension sessions spawned from this window.
		const changed = applyManagedEnv(process.env, desired, this.inherited);

		if (reason === 'release') {
			// Not a user-visible change: the env comes back as soon as a
			// proxy runs again, without another notification.
			if (changed) {
				logger.info('[ClaudeCode] Released routing env (proxy stopping)');
			}
			return;
		}
		await this.cleanUpSetting(desired, cfg);
		if (!changed) {
			return;
		}
		if (Object.keys(desired).length > 0) {
			const tiers = describeTiers(cfg);
			logger.info(`[ClaudeCode] Injected routing env: ${tiers}`);
			const signature = JSON.stringify(desired);
			if (this.context.globalState.get<string>(CLAUDE_CODE_ENV_ANNOUNCED_KEY) !== signature) {
				await this.context.globalState.update(CLAUDE_CODE_ENV_ANNOUNCED_KEY, signature);
				void vscode.window.showInformationMessage(t('claudeCode.envApplied', tiers));
			}
		} else {
			logger.info('[ClaudeCode] Restored the Claude Code env from before routing');
			await this.context.globalState.update(CLAUDE_CODE_ENV_ANNOUNCED_KEY, undefined);
			void vscode.window.showInformationMessage(t('claudeCode.envRemoved'));
		}
	}

	/**
	 * Remove the routing entries older builds wrote to the machine-scoped
	 * `claudeCode.environmentVariables` (restoring the user's values), and
	 * warn when the user's own entries there override routing. Only a
	 * window that loads Claude Code can do this: elsewhere the key is
	 * unregistered and VS Code silently drops the write.
	 */
	private async cleanUpSetting(desired: Record<string, string>, cfg: ClaudeCodeRoutingConfig): Promise<void> {
		if (!vscode.extensions.getExtension(CLAUDE_CODE_EXTENSION_ID)) {
			return;
		}
		const claudeConfig = vscode.workspace.getConfiguration('claudeCode');
		const raw = claudeConfig.inspect<unknown[]>('environmentVariables')?.globalValue;
		let existing = Array.isArray(raw) ? raw : [];
		const held = { ...adoptUnrecordedEntries(existing, cfg.port), ...this.readOwnership() };
		if (Object.keys(held).length > 0) {
			const plan = planEnvironmentVariables(existing, {}, held);
			if (!sameEnv(existing, plan.entries)) {
				try {
					// An empty list is removed rather than left behind as `[]`.
					await claudeConfig.update(
						'environmentVariables',
						plan.entries.length > 0 ? plan.entries : undefined,
						vscode.ConfigurationTarget.Global,
					);
				} catch (error) {
					logger.warn('[ClaudeCode] Could not clean up claudeCode.environmentVariables', error);
					return;
				}
				logger.info('[ClaudeCode] Removed the routing env an older version wrote to claudeCode.environmentVariables');
				existing = plan.entries;
			}
			await this.saveOwnership({});
		}

		const shadowed = shadowedNames(existing, desired).join(', ');
		if (shadowed && shadowed !== this.shadowWarning) {
			logger.warn(`[ClaudeCode] claudeCode.environmentVariables sets ${shadowed}, which overrides routing`);
			void vscode.window.showWarningMessage(t('claudeCode.envShadowed', shadowed));
		}
		this.shadowWarning = shadowed;
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
				item.tooltip = state.message;
				break;
		}
		item.show();
	}

	/**
	 * Stop routing in this window: hand this extension host's env back
	 * (it may outlive the extension, e.g. on an update or disable), then
	 * close the proxy if this window serves it. A standby window takes
	 * over the port within a few seconds.
	 */
	shutdown(): Promise<void> {
		this.shutdownPromise ??= this.doShutdown();
		return this.shutdownPromise;
	}

	private async doShutdown(): Promise<void> {
		this.disposed = true;
		this.stopTakeoverTimer();
		for (const d of this.subscriptions) {
			d.dispose();
		}
		await this.queue;
		try {
			await this.writeEnv({}, getClaudeCodeRoutingConfig(), 'release');
		} catch (error) {
			logger.warn('[ClaudeCode] Could not release the Claude Code env', error);
		}
		await this.stopProxy();
	}

	dispose(): void {
		void this.shutdown();
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
		{
			label: `$(debug-hash) ${t('claudeCode.menu.haikuModel')}`,
			run: () => vscode.commands.executeCommand('minimax.claudeCode.selectHaikuModel'),
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

/**
 * Pick which MiniMax model Claude Code's Haiku tier should be routed to
 * (sets `minimax.claudeCode.routing.haikuModel`). Sources the model list
 * from the registry so picker-only models (M3-Priority, M2.7-highspeed,
 * …) are also offered; the empty/reset choice writes `""` so the
 * `ANTHROPIC_DEFAULT_HAIKU_MODEL` override is dropped and Claude Code
 * keeps Anthropic's own Haiku.
 */
export async function pickHaikuModel(): Promise<void> {
	const current = getClaudeCodeRoutingConfig().models.haiku;
	const models = getModels();
	const isMatch = (id: string) => id === current;
	const items: (vscode.QuickPickItem & { id: string })[] = [
		{
			id: '',
			label: t('claudeCode.haikuPicker.resetLabel'),
			detail: t('claudeCode.haikuPicker.resetDetail'),
		},
		...models.map((m) => ({
			id: m.id,
			label: m.name,
			description: m.id,
			detail: m.detail + (isMatch(m.id) ? `  —  ${t('claudeCode.haikuPicker.current')}` : ''),
		})),
	];
	const picked = await vscode.window.showQuickPick(items, {
		title: t('claudeCode.haikuPicker.title'),
		placeHolder: t('claudeCode.haikuPicker.placeholder'),
		ignoreFocusOut: true,
		matchOnDescription: true,
	});
	if (!picked) return;
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	await config.update('claudeCode.routing.haikuModel', picked.id, vscode.ConfigurationTarget.Global);
	if (picked.id) {
		void vscode.window.showInformationMessage(t('claudeCode.haikuPicker.updated', picked.label));
	}
}

export function setRoutingEnabled(enabled: boolean): Thenable<void> {
	return vscode.workspace
		.getConfiguration('minimax')
		.update('claudeCode.routing.enabled', enabled, vscode.ConfigurationTarget.Global);
}
