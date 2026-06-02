// Chat-turn boundary event.
//
// VS Code's `LanguageModelChatProvider.provideLanguageModelChatResponse`
// is called once per Copilot user-facing turn. A single turn can fan
// out to many Anthropic API requests (tool calls, thinking sub-steps,
// cache-write retries), so subscribing to per-request events would
// pulse the plan cache 10+ times per turn. This notifier collapses
// the fan-out to one event per turn, with a min-interval throttle
// so a user banging out 5 turns in 30s triggers at most one platform
// fetch.
//
// Two events are exposed:
//   - onTurnStart — fires the moment a turn enters the provider. Useful
//     for "warm up the cache, the user is about to need data".
//   - onTurnEnd   — fires after `streamChatCompletion` resolves or throws.
//     This is the canonical "we just spent tokens" signal.

import * as vscode from 'vscode';

export interface ChatTurnNotifier {
	/** Call once at the top of `provideLanguageModelChatResponse`. */
	notifyTurnStart(): void;
	/** Call once at the bottom (finally) of the same handler. */
	notifyTurnEnd(): void;
	/** Subscribe to turn-start events. Returns a Disposable. */
	onTurnStart(listener: () => void): vscode.Disposable;
	/** Subscribe to turn-end events. Returns a Disposable. */
	onTurnEnd(listener: () => void): vscode.Disposable;
	/**
	 * Minimum interval between two turn-end broadcasts. Defaults to
	 * 30s. Subscribers that fire too soon are dropped (the underlying
	 * turn still happened; the listener is just not woken up).
	 * Set to 0 to disable throttling.
	 */
	readonly minIntervalMs: number;
}

export function createChatTurnNotifier(options: { minIntervalMs?: number } = {}): ChatTurnNotifier {
	const minIntervalMs = options.minIntervalMs ?? 30_000;
	const startListeners = new Set<() => void>();
	const endListeners = new Set<() => void>();
	let lastEndBroadcast = 0;

	function fire(set: Set<() => void>): void {
		for (const fn of set) {
			try {
				fn();
			} catch {
				// Listener errors must not poison the broadcaster.
			}
		}
	}

	return {
		minIntervalMs,
		notifyTurnStart() {
			fire(startListeners);
		},
		notifyTurnEnd() {
			const now = Date.now();
			if (minIntervalMs > 0 && now - lastEndBroadcast < minIntervalMs) {
				// Throttled. The next eligible broadcast will be the one
				// that wakes the listener — the in-between turns are
				// dropped on purpose to keep the platform-call rate sane.
				return;
			}
			lastEndBroadcast = now;
			fire(endListeners);
		},
		onTurnStart(listener) {
			startListeners.add(listener);
			return new vscode.Disposable(() => {
				startListeners.delete(listener);
			});
		},
		onTurnEnd(listener) {
			endListeners.add(listener);
			return new vscode.Disposable(() => {
				endListeners.delete(listener);
			});
		},
	};
}
