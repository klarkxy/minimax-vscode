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

export interface ClaudeCodeModelOverrides {
	haiku: string;
	sonnet: string;
	opus: string;
}

export interface EnvEntry {
	name: string;
	value: string;
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

/**
 * Merge `desired` into the `claudeCode.environmentVariables` array:
 * user-owned entries are preserved in order, every managed name is
 * replaced by its desired value (or dropped when absent from `desired`).
 * Pass `{}` to remove all managed entries.
 */
export function mergeEnvironmentVariables(existing: readonly unknown[], desired: Record<string, string>): EnvEntry[] {
	const managed = new Set<string>(MANAGED_ENV_NAMES);
	const kept = existing.filter(
		(entry): entry is EnvEntry =>
			typeof entry === 'object' &&
			entry !== null &&
			typeof (entry as EnvEntry).name === 'string' &&
			!managed.has((entry as EnvEntry).name),
	);
	return [...kept, ...Object.entries(desired).map(([name, value]) => ({ name, value }))];
}

export function sameEnv(a: readonly unknown[], b: readonly EnvEntry[]): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}
