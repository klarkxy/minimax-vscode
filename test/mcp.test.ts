// Unit tests for the MiniMax Web Search MCP provider.
//
// These tests assert the four properties that make the provider safe
// + useful:
//
//   1. Host mapping is strict — China/Global endpoints map to their
//      official API host (without the `/anthropic` suffix); unknown
//      hosts return `null` so we refuse to inject a credential.
//   2. The provider never registers when there's no API key OR
//      when the host is unrecognised — VS Code won't see a server
//      definition it can't start.
//   3. When registered, the env injection contains the user's API
//      key + the resolved host, nothing else.
//   4. The provider listens to API key / `minimax.apiBaseUrl` config
//      changes so VS Code re-resolves with fresh env on the next
//      MCP call.
//
// The `vscode` namespace comes from `test/helpers/vscodeMock.ts`
// (aliased by esbuild.tests.mjs) — see that file for the recording
// infrastructure used by these assertions.

import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';

import {
	buildMiniMaxMcpDefinition,
	MCP_PROVIDER_ID,
	MCP_PROVIDER_LABEL,
	pickMcpApiHost,
	provideMiniMaxMcpServers,
	registerMiniMaxMcpProvider,
} from '../src/runtime/mcp.js';
import { buildMcpStatus } from '../src/dashboard/aggregator.js';

import {
	getRecordedMcpProviders,
	mockConfig,
	mockState,
	resetRecordedMcpProviders,
} from './helpers/vscodeMock.js';

interface FakeSecretStorage {
	get(key: string): Promise<string | undefined>;
	store(key: string, value: string): Promise<void>;
	delete(key: string): Promise<void>;
	onDidChange: { event: unknown };
}

interface FakeContext {
	secrets: FakeSecretStorage;
	globalState: { get: () => unknown; update: () => Promise<void> };
	extension: { packageJSON: { version: string } };
	subscriptions: { dispose(): unknown }[];
}

function makeContext(initialSecrets: Record<string, string> = {}): FakeContext {
	const secretStore: Record<string, string> = { ...initialSecrets };
	const secrets: FakeSecretStorage = {
		get: async (key: string) => secretStore[key],
		store: async (key: string, value: string) => {
			secretStore[key] = value;
		},
		delete: async (key: string) => {
			delete secretStore[key];
		},
		onDidChange: { event: () => ({ dispose: () => undefined }) },
	};
	return {
		secrets,
		globalState: {
			get: () => undefined,
			update: async () => undefined,
		},
		extension: { packageJSON: { version: '2.3.1' } },
		subscriptions: [],
	};
}

function makeAuth(context: FakeContext, _key?: string) {
	// Reuse the production AuthManager so the provider exercises the
	// same code path as the running extension. Seed the SecretStorage
	// on the context directly — see the `seedSecret` helper below.
	const { AuthManager } = require('../src/auth.js');
	const { KeyManager } = require('../src/keyManager.js');
	const keyManager = new KeyManager(context as never);
	return new AuthManager(context as never, keyManager);
}

/** Configure the mock workspace to return `value` for
 *  `minimax.apiBaseUrl`. Mirrors the real `vscode.workspace
 *  .getConfiguration('minimax').get('apiBaseUrl')` chain. */
function setApiBaseUrl(value: string | undefined): void {
	if (value === undefined) {
		delete mockConfig['minimax.apiBaseUrl'];
		return;
	}
	mockConfig['minimax.apiBaseUrl'] = value;
}

function clearMockConfig(): void {
	for (const key of Object.keys(mockConfig)) {
		delete mockConfig[key];
	}
}

describe('pickMcpApiHost', () => {
	it('maps the China Anthropic-compatible base URL to api.minimaxi.com', () => {
		const result = pickMcpApiHost('https://api.minimaxi.com/anthropic');
		assert.deepEqual(result, {
			host: 'https://api.minimaxi.com',
			fromProxy: false,
		});
	});

	it('maps the international Anthropic-compatible base URL to api.minimax.io', () => {
		const result = pickMcpApiHost('https://api.minimax.io/anthropic');
		assert.deepEqual(result, {
			host: 'https://api.minimax.io',
			fromProxy: false,
		});
	});

	it('rejects unrecognised hosts without falling back to China', () => {
		const result = pickMcpApiHost('https://my-proxy.example.com/v1');
		assert.equal(result.host, null);
		assert.equal(result.fromProxy, true);
	});

	it('rejects spoofed userinfo URLs', () => {
		// `api.minimax.io` as userinfo, real host `evil.example.com` —
		// must NOT match the international platform.
		const result = pickMcpApiHost('https://api.minimax.io@evil.example.com/v1');
		assert.equal(result.host, null);
		assert.equal(result.fromProxy, true);
	});

	it('returns null for malformed URLs', () => {
		const result = pickMcpApiHost('not-a-url');
		assert.equal(result.host, null);
	});
});

describe('buildMiniMaxMcpDefinition', () => {
	it('injects the API key + host into env, defaults command to uvx', () => {
		const def = buildMiniMaxMcpDefinition({
			host: 'https://api.minimaxi.com',
			apiKey: 'sk-test-1234',
		});
		assert.equal(def.label, MCP_PROVIDER_LABEL);
		assert.equal(def.command, 'uvx');
		assert.deepEqual(def.args, ['minimax-coding-plan-mcp']);
		assert.equal(def.env['MINIMAX_API_KEY'], 'sk-test-1234');
		assert.equal(def.env['MINIMAX_API_HOST'], 'https://api.minimaxi.com');
		assert.equal(def.host, 'https://api.minimaxi.com');
		assert.equal(def.hostFromProxy, false);
	});

	it('honours a custom launch command (for tests / future settings)', () => {
		const def = buildMiniMaxMcpDefinition({
			host: 'https://api.minimax.io',
			apiKey: 'sk-x',
			command: '/usr/local/bin/uvx',
		});
		assert.equal(def.command, '/usr/local/bin/uvx');
	});
});

describe('buildMcpStatus', () => {
	it('is ready when both api key and host are present', () => {
		const status = buildMcpStatus({
			apiBaseUrl: 'https://api.minimaxi.com/anthropic',
			hasApiKey: true,
			providerRegistered: true,
			reason: '',
		});
		assert.equal(status.ready, true);
		assert.equal(status.hasApiKey, true);
		assert.equal(status.host, 'https://api.minimaxi.com');
		assert.equal(status.hostFromProxy, false);
		assert.equal(status.providerRegistered, true);
		assert.equal(status.providerId, MCP_PROVIDER_ID);
		assert.equal(status.command, 'uvx');
		assert.equal(status.reason, '');
	});

	it('is not ready when the API key is missing', () => {
		const status = buildMcpStatus({
			apiBaseUrl: 'https://api.minimaxi.com/anthropic',
			hasApiKey: false,
			providerRegistered: true,
			reason: 'missing-key',
		});
		assert.equal(status.ready, false);
		assert.equal(status.hasApiKey, false);
		assert.equal(status.reason, 'missing-key');
	});

	it('is not ready on a third-party proxy base URL', () => {
		const status = buildMcpStatus({
			apiBaseUrl: 'https://my-proxy.example.com/v1',
			hasApiKey: true,
			providerRegistered: true,
			reason: 'unsupported-host',
		});
		assert.equal(status.ready, false);
		assert.equal(status.hostFromProxy, true);
		assert.equal(status.reason, 'unsupported-host');
	});

	it('clears the reason when ready, even if a reason was supplied', () => {
		const status = buildMcpStatus({
			apiBaseUrl: 'https://api.minimax.io/anthropic',
			hasApiKey: true,
			providerRegistered: true,
			reason: 'should-not-leak',
		});
		assert.equal(status.ready, true);
		assert.equal(status.reason, '');
	});

	it('reports providerRegistered=false when the provider is not registered', () => {
		// The "ready" flag only reflects the config (key + host). The
		// "providerRegistered" flag reflects whether the extension
		// actually called `vscode.lm.registerMcpServerDefinitionProvider`
		// for this process. Dashboard renders them as two separate
		// signals: "registered with VS Code" / "configuration would
		// yield a working definition".
		const status = buildMcpStatus({
			apiBaseUrl: 'https://api.minimaxi.com/anthropic',
			hasApiKey: true,
			providerRegistered: false,
			reason: 'lifecycle-not-ready',
		});
		assert.equal(status.ready, true);
		assert.equal(status.providerRegistered, false);
		assert.equal(status.reason, '');
	});
});

describe('provideMiniMaxMcpServers', () => {
	beforeEach(() => {
		mockState.reset();
		clearMockConfig();
	});

	it('returns not-ready when the auth manager has no key', async () => {
		const ctx = makeContext();
		const auth = makeAuth(ctx, undefined);
		const result = await provideMiniMaxMcpServers(
			auth,
			'https://api.minimaxi.com/anthropic',
		);
		assert.equal(result.ready, false);
		assert.ok(result.reason.length > 0);
		assert.equal(result.definition, undefined);
	});

	it('returns the resolved definition when the host is recognised', async () => {
		const ctx = makeContext({ 'minimax-vscode.apiKey': 'sk-from-secret' });
		const auth = makeAuth(ctx);
		const result = await provideMiniMaxMcpServers(
			auth,
			'https://api.minimax.io/anthropic',
		);
		assert.equal(result.ready, true, `expected ready, reason=${result.reason}`);
		assert.ok(result.definition);
		assert.equal(
			result.definition?.env['MINIMAX_API_HOST'],
			'https://api.minimax.io',
		);
		assert.equal(result.definition?.env['MINIMAX_API_KEY'], 'sk-from-secret');
	});

	it('returns not-ready when the host is unrecognised (proxy)', async () => {
		const ctx = makeContext({ 'minimax-vscode.apiKey': 'sk-from-secret' });
		const auth = makeAuth(ctx);
		const result = await provideMiniMaxMcpServers(
			auth,
			'https://proxy.example.com/v1',
		);
		assert.equal(result.ready, false);
		assert.ok(result.reason.length > 0);
	});
});

describe('registerMiniMaxMcpProvider', () => {
	beforeEach(() => {
		mockState.reset();
		clearMockConfig();
		resetRecordedMcpProviders();
	});

	it('registers with VS Code and reports ready when both key + host are valid', async () => {
		const ctx = makeContext({ 'minimax-vscode.apiKey': 'sk-test' });
		setApiBaseUrl('https://api.minimaxi.com/anthropic');
		const auth = makeAuth(ctx);
		const disposable = registerMiniMaxMcpProvider(
			ctx as never,
			auth,
		);
		ctx.subscriptions.push(disposable);
		const recorded = getRecordedMcpProviders();
		assert.equal(recorded.length, 1);
		assert.equal(recorded[0].id, MCP_PROVIDER_ID);

		const defs = await recorded[0].provider.provideMcpServerDefinitions({});
		assert.ok(Array.isArray(defs));
		assert.equal((defs as unknown[]).length, 1);
		const def = (defs as unknown[])[0] as {
			env: Record<string, string>;
			host: string;
			command: string;
		};
		assert.equal(def.host, 'https://api.minimaxi.com');
		assert.equal(def.env['MINIMAX_API_KEY'], 'sk-test');
		assert.equal(def.command, 'uvx');
	});

	it('returns no definitions when the API key is missing', async () => {
		const ctx = makeContext();
		setApiBaseUrl('https://api.minimaxi.com/anthropic');
		const auth = makeAuth(ctx);
		const disposable = registerMiniMaxMcpProvider(
			ctx as never,
			auth,
		);
		ctx.subscriptions.push(disposable);
		const recorded = getRecordedMcpProviders();
		const defs = await recorded[0].provider.provideMcpServerDefinitions({});
		assert.deepEqual(defs, []);
	});

	// Regression: the auto provider used to read `minimax.apiBaseUrl`
	// directly, which split-brained the MCP spawn env from the chat
	// request host when the active key was on a different endpoint
	// than the deprecated setting. Production now passes the active
	// key's `getActiveApiBaseUrl()` resolver; this test pins the
	// contract by feeding a custom resolver and asserting it wins
	// over both the seeded setting AND a freshly-added named pool
	// entry that disagrees with the setting.
	it('uses the injected active-key resolver (not the deprecated apiBaseUrl setting)', async () => {
		const ctx = makeContext({ 'minimax-vscode.apiKey': 'sk-test' });
		// Seed the deprecated setting to the China endpoint, but the
		// resolver says the active key points at the international
		// host. The MCP definition MUST follow the resolver.
		setApiBaseUrl('https://api.minimaxi.com/anthropic');
		const auth = makeAuth(ctx);
		const handle = registerMiniMaxMcpProvider(ctx as never, auth, {
			getApiBaseUrl: async () => 'https://api.minimax.io/anthropic',
		});
		ctx.subscriptions.push(handle);
		const recorded = getRecordedMcpProviders();
		const defs = (await recorded[0].provider.provideMcpServerDefinitions(
			{},
		)) as Array<{ host: string; env: Record<string, string> }>;
		assert.equal(defs.length, 1);
		assert.equal(defs[0]!.host, 'https://api.minimax.io');
		assert.equal(defs[0]!.env['MINIMAX_API_HOST'], 'https://api.minimax.io');
		handle.dispose();
	});

	// Regression: even when the deprecated setting disagrees, a
	// named pool entry pointing at a third-party proxy wins via
	// the resolver. This is the custom-proxy contract — the MCP
	// spawn env must not silently swap to the China default just
	// because the deprecated setting still points there.
	it('honors the resolver on a third-party proxy (custom-proxy contract)', async () => {
		const ctx = makeContext({ 'minimax-vscode.apiKey': 'sk-test' });
		setApiBaseUrl('https://api.minimaxi.com/anthropic');
		const auth = makeAuth(ctx);
		const handle = registerMiniMaxMcpProvider(ctx as never, auth, {
			getApiBaseUrl: async () => 'https://my-proxy.example.com/v1',
		});
		ctx.subscriptions.push(handle);
		const recorded = getRecordedMcpProviders();
		const defs = (await recorded[0].provider.provideMcpServerDefinitions(
			{},
		)) as Array<{ host: string }>;
		// Proxy host doesn't map to a recognised platform — the
		// provider must refuse to publish a definition (rather than
		// publishing one that leaks the key to the China default).
		assert.deepEqual(defs, []);
		handle.dispose();
	});

	it('handle.refreshDefinitions() fires onDidChangeMcpServerDefinitions', () => {
		// The manual "Refresh MCP" command and the dashboard's Refresh
		// button rely on this: VS Code re-resolves the provider on the
		// next MCP call because the change event fired. Regression
		// coverage for the gap where `minimax.refreshMcp` only did a
		// `provideMcpServerDefinitions` round-trip and never signalled
		// VS Code.
		const ctx = makeContext({ 'minimax-vscode.apiKey': 'sk-test' });
		setApiBaseUrl('https://api.minimaxi.com/anthropic');
		const auth = makeAuth(ctx);
		const handle = registerMiniMaxMcpProvider(ctx as never, auth);
		ctx.subscriptions.push(handle);
		const recorded = getRecordedMcpProviders();
		assert.equal(recorded.length, 1);
		assert.equal(handle.isRegistered(), true);
		let eventCount = 0;
		recorded[0].provider.onDidChangeMcpServerDefinitions(() => {
			eventCount += 1;
		});
		handle.refreshDefinitions();
		handle.refreshDefinitions();
		assert.equal(eventCount, 2);
		handle.dispose();
		assert.equal(handle.isRegistered(), false);
	});

	it('handle.refreshDefinitions() is a no-op after dispose()', () => {
		// Disposing the handle tears down the change emitter; calling
		// refreshDefinitions() afterwards must NOT throw, and must
		// not re-fire an event on a disposed listener chain. The
		// dashboard's Refresh button can fire concurrently with
		// extension deactivation (e.g. a user clicks Refresh then
		// disables the extension from another window) and we
		// promise a safe no-op, not a crash.
		const ctx = makeContext({ 'minimax-vscode.apiKey': 'sk-test' });
		setApiBaseUrl('https://api.minimaxi.com/anthropic');
		const auth = makeAuth(ctx);
		const handle = registerMiniMaxMcpProvider(ctx as never, auth);
		ctx.subscriptions.push(handle);
		const recorded = getRecordedMcpProviders();
		let eventCount = 0;
		recorded[0].provider.onDidChangeMcpServerDefinitions(() => {
			eventCount += 1;
		});
		handle.dispose();
		// Second dispose() must also be safe.
		handle.dispose();
		assert.doesNotThrow(() => handle.refreshDefinitions());
		assert.equal(eventCount, 0, 'no events should fire on a disposed handle');
	});
});