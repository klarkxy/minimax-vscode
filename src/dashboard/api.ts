// Platform coding-plan API client.
//
// Endpoints are reverse-engineered from the official platform UI
// (mirrors the behaviour of `minimax-status`). The chat API key works
// as a Bearer token for these admin endpoints — same key, separate
// scope. The client intentionally does NOT throw on transport
// failures: callers expect a discriminated result so the dashboard
// can degrade gracefully when the user is offline / the key is
// unconfigured / the platform is rate-limiting us.

import type { PlanModelInfo, PlanUsage } from './types';

export type PlanApiResult =
	| { ok: true; usage: PlanUsage }
	| { ok: false; reason: 'unconfigured' | 'unsupported' | 'error'; error?: string };

const HOSTS = {
	china: 'https://www.minimaxi.com',
	global: 'https://www.minimax.io',
} as const;

export interface PlanApiOptions {
	apiKey: string;
	/** `china` resolves to `minimaxi.com`, anything else to `minimax.io`. */
	host?: 'china' | 'global';
	/** 8s in-process cache; callers can pre-warm by passing a fresh value. */
	cache?: Map<string, { value: PlanUsage; expiresAt: number }>;
	cacheTtlMs?: number;
	/** Fetch implementation, injectable for tests. */
	fetchImpl?: typeof fetch;
	/** Aborts the request. */
	signal?: AbortSignal;
}

const DEFAULT_TTL_MS = 8_000;

export async function fetchPlanUsage(
	options: PlanApiOptions,
): Promise<PlanApiResult> {
	if (!options.apiKey) {
		return { ok: false, reason: 'unconfigured' };
	}
	const host = options.host ?? 'china';
	const cacheKey = `plan:${host}`;
	const cache = options.cache;
	const ttl = options.cacheTtlMs ?? DEFAULT_TTL_MS;
	if (cache) {
		const hit = cache.get(cacheKey);
		if (hit && hit.expiresAt > Date.now()) {
			return { ok: true, usage: hit.value };
		}
	}

	const url = `${HOSTS[host]}/v1/api/openplatform/coding_plan/remains`;
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	if (!fetchImpl) {
		return { ok: false, reason: 'error', error: 'fetch is not available' };
	}

	let response: Response;
	try {
		response = await fetchImpl(url, {
			method: 'GET',
			headers: {
				Authorization: `Bearer ${options.apiKey}`,
				Referer: 'https://platform.minimaxi.com/',
				Accept: 'application/json',
			},
			signal: options.signal,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, reason: 'error', error: message };
	}

	if (response.status === 401 || response.status === 403) {
		return { ok: false, reason: 'error', error: 'invalid token' };
	}
	if (!response.ok) {
		return {
			ok: false,
			reason: 'error',
			error: `HTTP ${response.status}`,
		};
	}

	let payload: unknown;
	try {
		payload = await response.json();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, reason: 'error', error: `malformed response: ${message}` };
	}

	const usage = parsePlanUsage(payload);
	if (!usage) {
		return { ok: false, reason: 'unsupported' };
	}
	if (cache) {
		cache.set(cacheKey, { value: usage, expiresAt: Date.now() + ttl });
	}
	return { ok: true, usage };
}

/** Parse the platform's `coding_plan/remains` payload into our flat shape. */
function parsePlanUsage(payload: unknown): PlanUsage | null {
	if (!payload || typeof payload !== 'object') {
		return null;
	}
	const root = payload as Record<string, unknown>;
	const modelRemains = root.model_remains;
	if (!Array.isArray(modelRemains) || modelRemains.length === 0) {
		return null;
	}
	const first = modelRemains[0] as Record<string, unknown>;
	if (!first || typeof first !== 'object') {
		return null;
	}

	const totalCount = numberOr(first.current_interval_total_count, 0);
	const remainingPct = optionalNumber(first.current_interval_remaining_percent);
	const usedPercentage = remainingPct !== undefined
		? Math.round(100 - remainingPct)
		: totalCount > 0
			? Math.round((numberOr(first.current_interval_usage_count, 0) / totalCount) * 100)
			: 0;
	const currentUsed = totalCount > 0
		? Math.round((totalCount * usedPercentage) / 100)
		: 0;
	const currentResetText = formatRemainingMs(numberOr(first.remains_time, 0));

	const weeklyTotal = numberOr(first.current_weekly_total_count, 0);
	const weeklyRemainingPct = optionalNumber(first.current_weekly_remaining_percent);
	const weeklyPercentage = weeklyRemainingPct !== undefined
		? Math.round(100 - weeklyRemainingPct)
		: weeklyTotal > 0
			? Math.floor((numberOr(first.current_weekly_usage_count, 0) / weeklyTotal) * 100)
			: 0;
	const weeklyUsed = numberOr(first.current_weekly_usage_count, 0);
	const weeklyUnlimited = weeklyTotal === 0 && weeklyRemainingPct === undefined;
	const weeklyResetText = weeklyUnlimited
		? 'unlimited'
		: formatRemainingMs(numberOr(first.weekly_remains_time, 0));

	const expiryTimestamp = optionalNumber(first.expiry_time);
	const expiry = expiryTimestamp
		? formatExpiry(new Date(expiryTimestamp))
		: undefined;

	const allModels: PlanModelInfo[] = modelRemains
		.filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
		.map((m) => {
			const total = numberOr(m.current_interval_total_count, 0);
			const remPct = optionalNumber(m.current_interval_remaining_percent);
			const pct = remPct !== undefined
				? Math.round(100 - remPct)
				: total > 0
					? Math.round((numberOr(m.current_interval_usage_count, 0) / total) * 100)
					: 0;
			const used = total > 0 ? Math.round((total * pct) / 100) : 0;
			return {
				name: stringOr(m.model_name, 'unknown'),
				used,
				total,
				percentage: pct,
			};
		});

	return {
		modelName: stringOr(first.model_name, 'MiniMax'),
		currentUsed,
		currentTotal: totalCount,
		currentPercentage: usedPercentage,
		currentResetText,
		weeklyUsed,
		weeklyTotal,
		weeklyPercentage,
		weeklyResetText,
		weeklyUnlimited,
		expiryDate: expiry?.date,
		expiryDays: expiry?.days,
		allModels,
	};
}

function numberOr(value: unknown, fallback: number): number {
	const parsed = parseNumber(value);
	return parsed === undefined ? fallback : parsed;
}

function optionalNumber(value: unknown): number | undefined {
	return parseNumber(value);
}

function parseNumber(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === 'string') {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}
	return undefined;
}

function stringOr(value: unknown, fallback: string): string {
	return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function formatRemainingMs(ms: number): string {
	if (!ms || ms <= 0) {
		return '—';
	}
	const totalMinutes = Math.floor(ms / 60_000);
	const days = Math.floor(totalMinutes / (60 * 24));
	const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) {
		return `${days}d ${hours}h`;
	}
	if (hours > 0) {
		return `${hours}h ${minutes}m`;
	}
	return `${minutes}m`;
}

function formatExpiry(date: Date): { date: string; days: number } {
	const iso = date.toISOString().slice(0, 10);
	const diff = date.getTime() - Date.now();
	const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
	return { date: iso, days };
}
