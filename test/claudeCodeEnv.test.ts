// Unit tests for the Claude Code env injection helpers in src/claudeCode/env.ts.

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { buildManagedEnv, mergeEnvironmentVariables, sameEnv } from '../src/claudeCode/env';
import { describeTiers } from '../src/claudeCode/bridge';

describe('buildManagedEnv', () => {
	it('sets the base URL and only the non-empty tier overrides', () => {
		assert.deepEqual(buildManagedEnv('http://127.0.0.1:4000', { haiku: 'MiniMax-M3', sonnet: ' ', opus: '' }), {
			ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000',
			ANTHROPIC_DEFAULT_HAIKU_MODEL: 'MiniMax-M3',
		});
	});

	it('never sets credentials', () => {
		const env = buildManagedEnv('http://x', { haiku: 'a', sonnet: 'b', opus: 'c' });
		assert.equal('ANTHROPIC_AUTH_TOKEN' in env, false);
		assert.equal('ANTHROPIC_API_KEY' in env, false);
		assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'c');
	});
});

describe('mergeEnvironmentVariables', () => {
	const user = { name: 'FOO', value: '1' };

	it('keeps user entries and replaces managed ones', () => {
		const merged = mergeEnvironmentVariables(
			[user, { name: 'ANTHROPIC_BASE_URL', value: 'http://old' }, { name: 'ANTHROPIC_DEFAULT_OPUS_MODEL', value: 'x' }],
			{ ANTHROPIC_BASE_URL: 'http://new', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'MiniMax-M3' },
		);
		assert.deepEqual(merged, [
			user,
			{ name: 'ANTHROPIC_BASE_URL', value: 'http://new' },
			{ name: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', value: 'MiniMax-M3' },
		]);
	});

	it('removes every managed entry when desired is empty', () => {
		assert.deepEqual(mergeEnvironmentVariables([{ name: 'ANTHROPIC_BASE_URL', value: 'x' }, user], {}), [user]);
	});

	it('drops malformed entries and is stable for sameEnv', () => {
		const merged = mergeEnvironmentVariables([null, 'junk', user], { ANTHROPIC_BASE_URL: 'u' });
		assert.equal(sameEnv(merged, mergeEnvironmentVariables(merged, { ANTHROPIC_BASE_URL: 'u' })), true);
	});
});

describe('describeTiers', () => {
	it('summarises the active overrides', () => {
		assert.equal(describeTiers({ models: { haiku: 'MiniMax-M3', sonnet: '', opus: 'MiniMax-M3' } }), 'MiniMax-M3 → Haiku, MiniMax-M3 → Opus');
		assert.equal(describeTiers({ models: { haiku: '', sonnet: '', opus: '' } }), '—');
	});
});
