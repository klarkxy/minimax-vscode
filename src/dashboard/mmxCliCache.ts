// Persistent cache of the last-known mmx-cli status.
//
// The mmx-cli detection path (`readMmxCliStatus` in mmxCli.ts) shells
// out to `where mmx` / `mmx --version` and reads `~/.mmx/config.json`.
// That is fast (a few ms) but still happens on every dashboard open
// — the user sees the cards flicker from "unknown" to their actual
// state every time they re-open the panel. This cache is the same
// shape as `PlanCache`: an in-process snapshot that survives across
// panel opens, plus a `Memento` write-through so the snapshot also
// survives across VS Code restarts. Subsequent re-opens paint the
// last-known state in the very first frame, and the refresh() call
// that follows in the background only fires if the user explicitly
// asked for a re-check.

import * as vscode from 'vscode';
import { MMX_CLI_STATUS_KEY } from '../consts';
import { readMmxCliStatus, type MmxCliStatus } from './mmxCli';

export interface MmxCliSnapshot {
	status: MmxCliStatus;
	detectedAt: number;
}

export interface MmxCliCache {
	/** Most recent snapshot, or `undefined` if we have never detected. */
	read(): MmxCliSnapshot | undefined;
	/**
	 * Re-run `readMmxCliStatus` in the background and update the cache
	 * (both in-memory and memento) on success. Concurrent callers share
	 * the same in-flight promise so we never probe more than once.
	 * Failure is NOT cached; the previous snapshot stays intact so the
	 * dashboard continues to show a valid state.
	 */
	refresh(): Promise<MmxCliStatus>;
	/** Subscribe to cache-changed events. Returns a Disposable. */
	subscribe(listener: () => void): vscode.Disposable;
	/** Invalidate the in-memory snapshot (kept for symmetry with PlanCache). */
	invalidate(): void;
}

export interface CreateMmxCliCacheOptions {
	/**
	 * Memento used to persist the last-known status across VS Code
	 * restarts. Pass `undefined` in tests / before activation to get
	 * an in-process-only cache.
	 */
	globalState: vscode.Memento | undefined;
	/** Override the clock for tests. */
	now?: () => number;
}

/**
 * Create a `MmxCliCache`. One instance per extension host, shared
 * with the dashboard panel. Reads the persisted snapshot at
 * construction time so the first render after a restart is already
 * correct.
 */
export function createMmxCliCache(
	options: CreateMmxCliCacheOptions,
): MmxCliCache {
	const now = options.now ?? Date.now;
	const memento = options.globalState;
	let snapshot: MmxCliSnapshot | undefined = readPersisted(memento);
	let inFlight: Promise<MmxCliStatus> | undefined;
	const listeners = new Set<() => void>();

	function notify(): void {
		for (const fn of listeners) {
			try {
				fn();
			} catch {
				// Listener errors must not poison the broadcaster.
			}
		}
	}

	function persist(next: MmxCliSnapshot): void {
		if (!memento) return;
		// Fire-and-forget: memento updates are async but the in-memory
		// snapshot is already up to date, so listeners and the
		// dashboard render don't have to wait on the write.
		void memento.update(MMX_CLI_STATUS_KEY, next);
	}

	return {
		read() {
			return snapshot;
		},
		async refresh() {
			if (inFlight) {
				return inFlight;
			}
			const promise = readMmxCliStatus()
				.then((status) => {
					inFlight = undefined;
					const next: MmxCliSnapshot = { status, detectedAt: now() };
					snapshot = next;
					persist(next);
					notify();
					return status;
				})
				.catch((err) => {
					inFlight = undefined;
					// Keep the previous snapshot — failure must not
					// wipe the dashboard's last known state.
					throw err;
				});
			inFlight = promise;
			return promise;
		},
		subscribe(listener) {
			listeners.add(listener);
			return {
				dispose() {
					listeners.delete(listener);
				},
			};
		},
		invalidate() {
			snapshot = undefined;
			inFlight = undefined;
			notify();
		},
	};
}

function readPersisted(
	memento: vscode.Memento | undefined,
): MmxCliSnapshot | undefined {
	if (!memento) return undefined;
	const raw = memento.get<MmxCliSnapshot | undefined>(MMX_CLI_STATUS_KEY);
	if (!raw || typeof raw !== 'object') return undefined;
	if (!raw.status || typeof raw.status !== 'object') return undefined;
	if (typeof raw.detectedAt !== 'number') return undefined;
	// Memento serialises through JSON, so the nested MmxCliStatus is
	// already a fresh POJO — no need to deep-clone. We just re-narrow
	// the shape to satisfy TypeScript.
	return { status: raw.status, detectedAt: raw.detectedAt };
}
