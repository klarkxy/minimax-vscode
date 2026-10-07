import { isMiniMaxModelId } from './proxy';

/**
 * Environment variables the bridge injects into Claude Code sessions.
 *
 * Only `ANTHROPIC_BASE_URL` and the per-tier model overrides are
 * managed. `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` are deliberately
 * NOT set: they would replace the user's own Claude credentials on every
 * request, breaking the subscription passthrough for non-MiniMax models.
 * The proxy injects the MiniMax key itself.
 */

export const MANAGED_ENV_NAMES = [
	'ANTHROPIC_BASE_URL',
	'ANTHROPIC_DEFAULT_HAIKU_MODEL',
	'ANTHROPIC_DEFAULT_SONNET_MODEL',
	'ANTHROPIC_DEFAULT_OPUS_MODEL',
] as const;

export const DEFAULT_PASSTHROUGH_URL = 'https://api.anthropic.com';

export interface ClaudeCodeModelOverrides {
	haiku: string;
	sonnet: string;
	opus: string;
}

export interface EnvEntry {
	name: string;
	value: string;
}

/**
 * The variables this extension currently holds in
 * `claudeCode.environmentVariables`: for each one, the value it wrote and
 * the user's value from before (absent = the variable was not set).
 * Persisted so the user's own configuration can be put back exactly.
 */
export type EnvOwnership = Record<string, { original?: string; injected: string }>;

export interface EnvPlan {
	entries: unknown[];
	owned: EnvOwnership;
	/** Managed names the user changed while routing held them. */
	userEdits: string[];
}

/** The env the bridge wants Claude Code to see; empty overrides are omitted. */
export function buildManagedEnv(proxyUrl: string, models: ClaudeCodeModelOverrides): Record<string, string> {
	const env: Record<string, string> = { ANTHROPIC_BASE_URL: proxyUrl };
	const tiers: Array<[keyof ClaudeCodeModelOverrides, string]> = [
		['haiku', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'],
		['sonnet', 'ANTHROPIC_DEFAULT_SONNET_MODEL'],
		['opus', 'ANTHROPIC_DEFAULT_OPUS_MODEL'],
	];
	for (const [tier, name] of tiers) {
		const model = models[tier].trim();
		if (model) {
			env[name] = model;
		}
	}
	return env;
}

export function proxyUrlForPort(port: number): string {
	return `http://127.0.0.1:${port}`;
}

/** True when `url` points at a loopback listener on `port` (i.e. at the proxy itself). */
export function isProxyUrl(url: string, port: number): boolean {
	try {
		const parsed = new URL(url);
		const host = parsed.hostname.replace(/^\[|\]$/g, '');
		return (host === '127.0.0.1' || host === 'localhost' || host === '::1') && Number(parsed.port) === port;
	} catch {
		return false;
	}
}

function entryName(entry: unknown): string | undefined {
	return typeof entry === 'object' && entry !== null && typeof (entry as EnvEntry).name === 'string'
		? (entry as EnvEntry).name
		: undefined;
}

function entryValue(entry: unknown): string | undefined {
	const value = (entry as Partial<EnvEntry> | undefined)?.value;
	return typeof value === 'string' ? value : undefined;
}

/** Index of the effective (last) entry for `name`, or -1. */
function lastIndexOf(entries: readonly unknown[], name: string): number {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entryName(entries[i]) === name) {
			return i;
		}
	}
	return -1;
}

/**
 * Ownership for entries written by builds that did not record it: the
 * old bridge pointed `ANTHROPIC_BASE_URL` at the proxy and set MiniMax
 * tier models without remembering what was there before. Those entries
 * are claimed with no original, so turning routing off removes them
 * instead of "restoring" a dead localhost URL. Nothing is claimed unless
 * the base URL is this proxy's.
 */
export function adoptUnrecordedEntries(existing: readonly unknown[], port: number): EnvOwnership {
	const owned: EnvOwnership = {};
	const base = entryValue(existing[lastIndexOf(existing, 'ANTHROPIC_BASE_URL')]);
	if (base === undefined || !isProxyUrl(base, port)) {
		return owned;
	}
	owned.ANTHROPIC_BASE_URL = { injected: base };
	for (const name of MANAGED_ENV_NAMES.slice(1)) {
		const value = entryValue(existing[lastIndexOf(existing, name)]);
		if (value !== undefined && isMiniMaxModelId(value)) {
			owned[name] = { injected: value };
		}
	}
	return owned;
}

/**
 * Compute the next `claudeCode.environmentVariables` array.
 *
 *  - Names in `desired` are set; the value they replace is remembered as
 *    the restore value (once — re-applying keeps the first original).
 *  - Names this extension holds but no longer wants are put back to the
 *    remembered value (or removed if there was none) — but only while
 *    they still carry the injected value; a user edit is left alone.
 *  - Everything else, including managed names never touched (e.g. a
 *    user's own `ANTHROPIC_DEFAULT_OPUS_MODEL` when only Haiku is
 *    routed), is preserved untouched and in order.
 *
 * A user edit to a held name while routing is on becomes the new restore
 * value and is reported in `userEdits`. A value equal to the remembered
 * original is not an edit: another window restored it on shutdown.
 */
export function planEnvironmentVariables(
	existing: readonly unknown[],
	desired: Readonly<Record<string, string>>,
	owned: Readonly<EnvOwnership>,
): EnvPlan {
	const entries = [...existing];
	const next: EnvOwnership = {};
	const userEdits: string[] = [];
	const removals: number[] = [];

	for (const name of MANAGED_ENV_NAMES) {
		const index = lastIndexOf(entries, name);
		const current = index >= 0 ? entryValue(entries[index]) : undefined;
		const held = owned[name];
		const want = desired[name];

		if (want !== undefined) {
			let original: string | undefined;
			if (!held) {
				original = current;
			} else if (current === held.injected) {
				original = held.original;
			} else {
				original = current;
				if (current !== held.original) {
					userEdits.push(name);
				}
			}
			if (index >= 0) {
				entries[index] = { name, value: want };
			} else {
				entries.push({ name, value: want });
			}
			next[name] = original === undefined ? { injected: want } : { original, injected: want };
		} else if (held && current === held.injected) {
			if (held.original === undefined) {
				removals.push(index);
			} else {
				entries[index] = { name, value: held.original };
			}
		}
	}

	for (const index of removals.sort((a, b) => b - a)) {
		entries.splice(index, 1);
	}
	return { entries, owned: next, userEdits };
}

/**
 * Upstream for non-MiniMax traffic: the explicit setting, else the
 * `ANTHROPIC_BASE_URL` the user had before routing replaced it (so a
 * corporate gateway or another local router keeps receiving Claude
 * traffic), else Anthropic. Never the proxy itself.
 */
export function resolvePassthroughUrl(configured: string, ownership: Readonly<EnvOwnership>, port: number): string {
	if (configured) {
		return configured;
	}
	const original = ownership.ANTHROPIC_BASE_URL?.original?.trim();
	if (original && !isProxyUrl(original, port)) {
		return original;
	}
	return DEFAULT_PASSTHROUGH_URL;
}

export function sameEnv(a: readonly unknown[], b: readonly unknown[]): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}
