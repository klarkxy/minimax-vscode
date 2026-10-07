// Unit tests for the Claude Code env injection helpers in src/claudeCode/env.ts.

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import {
	adoptUnrecordedEntries,
	buildManagedEnv,
	isProxyUrl,
	planEnvironmentVariables,
	resolvePassthroughUrl,
	sameEnv,
} from '../src/claudeCode/env';
import { describeTiers } from '../src/claudeCode/bridge';

const PROXY = 'http://127.0.0.1:4000';
const ROUTED = { ANTHROPIC_BASE_URL: PROXY, ANTHROPIC_DEFAULT_HAIKU_MODEL: 'MiniMax-M3' };

describe('buildManagedEnv', () => {
	it('sets the base URL and only the non-empty tier overrides', () => {
		assert.deepEqual(buildManagedEnv(PROXY, { haiku: 'MiniMax-M3', sonnet: ' ', opus: '' }), ROUTED);
	});

	it('never sets credentials', () => {
		const env = buildManagedEnv('http://x', { haiku: 'a', sonnet: 'b', opus: 'c' });
		assert.equal('ANTHROPIC_AUTH_TOKEN' in env, false);
		assert.equal('ANTHROPIC_API_KEY' in env, false);
		assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'c');
	});
});

describe('planEnvironmentVariables', () => {
	const user = { name: 'FOO', value: '1' };
	const gateway = { name: 'ANTHROPIC_BASE_URL', value: 'https://gateway.example' };
	const opus = { name: 'ANTHROPIC_DEFAULT_OPUS_MODEL', value: 'claude-opus-custom' };

	it('changes nothing while routing is off and nothing is held', () => {
		const existing = [user, gateway, opus];
		const plan = planEnvironmentVariables(existing, {}, {});
		assert.deepEqual(plan.entries, existing);
		assert.deepEqual(plan.owned, {});
	});

	it('injects in place, records originals and leaves unrouted tiers alone', () => {
		const plan = planEnvironmentVariables([user, gateway, opus], ROUTED, {});
		assert.deepEqual(plan.entries, [
			user,
			{ name: 'ANTHROPIC_BASE_URL', value: PROXY },
			opus,
			{ name: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', value: 'MiniMax-M3' },
		]);
		assert.deepEqual(plan.owned, {
			ANTHROPIC_BASE_URL: { original: 'https://gateway.example', injected: PROXY },
			ANTHROPIC_DEFAULT_HAIKU_MODEL: { injected: 'MiniMax-M3' },
		});
		assert.deepEqual(plan.userEdits, []);
	});

	it('restores the exact previous configuration when routing is turned off', () => {
		const before = [user, gateway, opus];
		const on = planEnvironmentVariables(before, ROUTED, {});
		const off = planEnvironmentVariables(on.entries, {}, on.owned);
		assert.deepEqual(off.entries, before);
		assert.deepEqual(off.owned, {});
	});

	it('keeps the first original across re-applies and tier changes', () => {
		const on = planEnvironmentVariables([gateway], ROUTED, {});
		const again = planEnvironmentVariables(on.entries, { ...ROUTED, ANTHROPIC_DEFAULT_HAIKU_MODEL: 'MiniMax-M2.7' }, on.owned);
		assert.equal(sameEnv([again.owned.ANTHROPIC_BASE_URL], [on.owned.ANTHROPIC_BASE_URL]), true);
		const off = planEnvironmentVariables(again.entries, {}, again.owned);
		assert.deepEqual(off.entries, [gateway]);
	});

	it('restores a tier that is no longer routed while routing stays on', () => {
		const sonnet = { name: 'ANTHROPIC_DEFAULT_SONNET_MODEL', value: 'claude-sonnet-custom' };
		const on = planEnvironmentVariables([sonnet], { ...ROUTED, ANTHROPIC_DEFAULT_SONNET_MODEL: 'MiniMax-M3' }, {});
		const next = planEnvironmentVariables(on.entries, ROUTED, on.owned);
		assert.deepEqual(next.entries.find((e) => (e as { name: string }).name === 'ANTHROPIC_DEFAULT_SONNET_MODEL'), sonnet);
		assert.equal('ANTHROPIC_DEFAULT_SONNET_MODEL' in next.owned, false);
	});

	it('treats a hand edit while routing is on as the new restore value', () => {
		const on = planEnvironmentVariables([], ROUTED, {});
		const edited = on.entries.map((e) =>
			(e as { name: string }).name === 'ANTHROPIC_BASE_URL' ? { name: 'ANTHROPIC_BASE_URL', value: 'https://mine' } : e,
		);
		const reasserted = planEnvironmentVariables(edited, ROUTED, on.owned);
		assert.deepEqual(reasserted.userEdits, ['ANTHROPIC_BASE_URL']);
		assert.deepEqual(reasserted.entries, on.entries);
		assert.equal(reasserted.owned.ANTHROPIC_BASE_URL.original, 'https://mine');
		const off = planEnvironmentVariables(reasserted.entries, {}, reasserted.owned);
		assert.deepEqual(off.entries, [{ name: 'ANTHROPIC_BASE_URL', value: 'https://mine' }]);
	});

	it('does not report a release by another window as a hand edit', () => {
		const on = planEnvironmentVariables([gateway], ROUTED, {});
		const released = planEnvironmentVariables(on.entries, {}, on.owned);
		// Another window re-injects with the stale (pre-release) record.
		const healed = planEnvironmentVariables(released.entries, ROUTED, on.owned);
		assert.deepEqual(healed.userEdits, []);
		assert.deepEqual(healed.entries, on.entries);
		assert.deepEqual(healed.owned, on.owned);
	});

	it('leaves a value the user changed alone when routing is turned off', () => {
		const on = planEnvironmentVariables([], ROUTED, {});
		const edited = [...on.entries.slice(0, 1), { name: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', value: 'claude-haiku-x' }];
		const off = planEnvironmentVariables(edited, {}, on.owned);
		assert.deepEqual(off.entries, [{ name: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', value: 'claude-haiku-x' }]);
		assert.deepEqual(off.owned, {});
	});

	it('preserves malformed entries untouched', () => {
		const plan = planEnvironmentVariables([null, 'junk', user], { ANTHROPIC_BASE_URL: 'u' }, {});
		assert.deepEqual(plan.entries, [null, 'junk', user, { name: 'ANTHROPIC_BASE_URL', value: 'u' }]);
		const off = planEnvironmentVariables(plan.entries, {}, plan.owned);
		assert.deepEqual(off.entries, [null, 'junk', user]);
	});
});

describe('adoptUnrecordedEntries', () => {
	it('claims entries left by builds that did not record ownership, so they are removed', () => {
		const legacy = [
			{ name: 'ANTHROPIC_BASE_URL', value: PROXY },
			{ name: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', value: 'MiniMax-M3' },
			{ name: 'ANTHROPIC_DEFAULT_OPUS_MODEL', value: 'claude-opus-custom' },
		];
		const owned = adoptUnrecordedEntries(legacy, 4000);
		assert.deepEqual(Object.keys(owned).sort(), ['ANTHROPIC_BASE_URL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL']);
		assert.deepEqual(planEnvironmentVariables(legacy, {}, owned).entries, [legacy[2]]);
	});

	it('does not claim a base URL that is not this proxy', () => {
		const router = [
			{ name: 'ANTHROPIC_BASE_URL', value: 'http://127.0.0.1:3456' },
			{ name: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', value: 'MiniMax-M3' },
		];
		assert.deepEqual(adoptUnrecordedEntries(router, 4000), {});
	});
});

describe('resolvePassthroughUrl', () => {
	const owned = { ANTHROPIC_BASE_URL: { original: 'https://gateway.example', injected: PROXY } };

	it('prefers the explicit setting, then the replaced base URL, then Anthropic', () => {
		assert.equal(resolvePassthroughUrl('https://explicit', owned, 4000), 'https://explicit');
		assert.equal(resolvePassthroughUrl('', owned, 4000), 'https://gateway.example');
		assert.equal(resolvePassthroughUrl('', {}, 4000), 'https://api.anthropic.com');
	});

	it('never passes through to the proxy itself', () => {
		const loop = { ANTHROPIC_BASE_URL: { original: 'http://localhost:4000/', injected: PROXY } };
		assert.equal(resolvePassthroughUrl('', loop, 4000), 'https://api.anthropic.com');
	});
});

describe('isProxyUrl', () => {
	it('matches loopback hosts on the proxy port only', () => {
		assert.equal(isProxyUrl('http://127.0.0.1:4000', 4000), true);
		assert.equal(isProxyUrl('http://[::1]:4000/x', 4000), true);
		assert.equal(isProxyUrl('http://127.0.0.1:4001', 4000), false);
		assert.equal(isProxyUrl('https://api.anthropic.com', 4000), false);
		assert.equal(isProxyUrl('not a url', 4000), false);
	});
});

describe('describeTiers', () => {
	it('summarises the active overrides', () => {
		assert.equal(
			describeTiers({ models: { haiku: 'MiniMax-M3', sonnet: '', opus: 'MiniMax-M3' } }),
			'MiniMax-M3 → Haiku, MiniMax-M3 → Opus',
		);
		assert.equal(describeTiers({ models: { haiku: '', sonnet: '', opus: '' } }), '—');
	});
});
