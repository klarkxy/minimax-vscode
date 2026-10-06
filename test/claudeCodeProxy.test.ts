// Unit tests for the Claude Code routing proxy in src/claudeCode/proxy.ts.

import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'node:http';

import {
	MINIMAX_ALIAS_OVERRIDES,
	PROXY_HEALTH_PATH,
	applyAliasOverride,
	extractModel,
	isMiniMaxModelId,
	joinUrl,
	probeExistingProxy,
	startProxy,
	type RunningProxy,
} from '../src/claudeCode/proxy';

interface Seen {
	path: string;
	headers: http.IncomingHttpHeaders;
	body: string;
}

function fakeUpstream(name: string, seen: Seen[]): Promise<{ url: string; server: http.Server }> {
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (c: Buffer) => chunks.push(c));
		req.on('end', () => {
			seen.push({ path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
			res.writeHead(200, { 'content-type': 'text/event-stream', 'x-upstream': name });
			res.write('event: ping\ndata: {}\n\n');
			res.end(`data: ${name}\n\n`);
		});
	});
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => {
			const addr = server.address() as { port: number };
			resolve({ url: `http://127.0.0.1:${addr.port}`, server });
		});
	});
}

function post(
	proxy: RunningProxy,
	path: string,
	body: unknown,
	headers: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
	return new Promise((resolve, reject) => {
		const payload = JSON.stringify(body);
		const req = http.request(
			`${proxy.url}${path}`,
			{ method: 'POST', headers: { 'content-type': 'application/json', ...headers } },
			(res) => {
				const chunks: Buffer[] = [];
				res.on('data', (c: Buffer) => chunks.push(c));
				res.on('end', () =>
					resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
				);
			},
		);
		req.on('error', reject);
		req.end(payload);
	});
}

describe('proxy helpers', () => {
	it('recognises MiniMax model ids case-insensitively', () => {
		assert.equal(isMiniMaxModelId('MiniMax-M3'), true);
		assert.equal(isMiniMaxModelId('minimax-m2.7-highspeed'), true);
		assert.equal(isMiniMaxModelId('claude-haiku-4-5'), false);
	});

	it('extracts model only from JSON bodies', () => {
		assert.equal(extractModel(Buffer.from('{"model":"MiniMax-M3"}')), 'MiniMax-M3');
		assert.equal(extractModel(Buffer.from('not json')), undefined);
		assert.equal(extractModel(Buffer.alloc(0)), undefined);
		assert.equal(extractModel(Buffer.from('{"model":42}')), undefined);
	});

	it('joins base URLs that carry a path prefix', () => {
		assert.equal(
			joinUrl('https://api.minimax.io/anthropic/', '/v1/messages?beta=true').href,
			'https://api.minimax.io/anthropic/v1/messages?beta=true',
		);
	});

	it('rewrites MiniMax-M3-Priority alias to upstream id and injects service_tier', () => {
		const body: Record<string, unknown> = { model: 'MiniMax-M3-Priority', messages: [] };
		applyAliasOverride(body, 'MiniMax-M3-Priority');
		assert.deepEqual(body, { model: 'MiniMax-M3', messages: [], service_tier: 'priority' });
	});

	it('does not overwrite a caller-provided service_tier', () => {
		const body: Record<string, unknown> = { model: 'MiniMax-M3-Priority', service_tier: 'standard' };
		applyAliasOverride(body, 'MiniMax-M3-Priority');
		assert.equal(body.service_tier, 'standard');
	});

	it('leaves non-aliased MiniMax models untouched', () => {
		const body: Record<string, unknown> = { model: 'MiniMax-M3', messages: [] };
		applyAliasOverride(body, 'MiniMax-M3');
		assert.deepEqual(body, { model: 'MiniMax-M3', messages: [] });
	});

	it('exposes the alias override table', () => {
		assert.equal(MINIMAX_ALIAS_OVERRIDES['MiniMax-M3-Priority']?.apiModelId, 'MiniMax-M3');
	});
});

describe('routing proxy', () => {
	const anthropicSeen: Seen[] = [];
	const minimaxSeen: Seen[] = [];
	let anthropic: { url: string; server: http.Server };
	let minimax: { url: string; server: http.Server };
	let proxy: RunningProxy;
	let apiKey: string | undefined = 'mm-secret';

	before(async () => {
		anthropic = await fakeUpstream('anthropic', anthropicSeen);
		minimax = await fakeUpstream('minimax', minimaxSeen);
		proxy = await startProxy({
			port: 0,
			passthroughBaseUrl: anthropic.url,
			resolveMiniMax: async () => (apiKey ? { apiKey, baseUrl: `${minimax.url}/anthropic` } : undefined),
			missingKeyMessage: 'no key',
		});
	});

	after(async () => {
		await proxy.close();
		anthropic.server.close();
		minimax.server.close();
	});

	it('routes MiniMax models to MiniMax with the extension key and no caller credentials', async () => {
		const res = await post(
			proxy,
			'/v1/messages?beta=true',
			{ model: 'MiniMax-M3', messages: [] },
			{ authorization: 'Bearer sk-ant-oat-user', 'anthropic-beta': 'oauth-2025-04-20', 'anthropic-version': '2023-06-01' },
		);
		assert.equal(res.status, 200);
		assert.equal(res.headers['x-upstream'], 'minimax');
		assert.match(res.body, /data: minimax/);
		const seen = minimaxSeen.at(-1)!;
		assert.equal(seen.path, '/anthropic/v1/messages?beta=true');
		assert.equal(seen.headers['x-api-key'], 'mm-secret');
		assert.equal(seen.headers.authorization, undefined);
		assert.equal(seen.headers['anthropic-beta'], undefined);
		assert.equal(seen.headers['anthropic-version'], '2023-06-01');
		assert.deepEqual(JSON.parse(seen.body), { model: 'MiniMax-M3', messages: [] });
	});

	it('rewrites MiniMax-M3-Priority alias to upstream id and injects service_tier', async () => {
		const res = await post(proxy, '/v1/messages', { model: 'MiniMax-M3-Priority', messages: [] });
		assert.equal(res.status, 200);
		assert.equal(res.headers['x-upstream'], 'minimax');
		const seen = minimaxSeen.at(-1)!;
		assert.deepEqual(JSON.parse(seen.body), { model: 'MiniMax-M3', messages: [], service_tier: 'priority' });
	});

	it('passes other models through untouched, credentials included', async () => {
		const res = await post(
			proxy,
			'/v1/messages',
			{ model: 'claude-opus-4-1', messages: [] },
			{ authorization: 'Bearer sk-ant-oat-user', 'anthropic-beta': 'oauth-2025-04-20' },
		);
		assert.equal(res.headers['x-upstream'], 'anthropic');
		const seen = anthropicSeen.at(-1)!;
		assert.equal(seen.path, '/v1/messages');
		assert.equal(seen.headers.authorization, 'Bearer sk-ant-oat-user');
		assert.equal(seen.headers['anthropic-beta'], 'oauth-2025-04-20');
		assert.equal(seen.headers['x-api-key'], undefined);
	});

	it('passes non-JSON / bodiless requests through', async () => {
		const status = await new Promise<number>((resolve) => {
			http.get(`${proxy.url}/api/oauth/usage`, (res) => {
				res.resume();
				resolve(res.statusCode ?? 0);
			});
		});
		assert.equal(status, 200);
		assert.equal(anthropicSeen.at(-1)!.path, '/api/oauth/usage');
	});

	it('answers MiniMax requests with an Anthropic error envelope when no key is set', async () => {
		apiKey = undefined;
		try {
			const res = await post(proxy, '/v1/messages', { model: 'MiniMax-M3' });
			assert.equal(res.status, 401);
			assert.deepEqual(JSON.parse(res.body), {
				type: 'error',
				error: { type: 'authentication_error', message: 'no key' },
			});
		} finally {
			apiKey = 'mm-secret';
		}
	});

	it('serves the health endpoint and is detectable by probeExistingProxy', async () => {
		assert.equal(await probeExistingProxy(proxy.port), true);
		assert.equal(await probeExistingProxy(Number(new URL(anthropic.url).port)), false);
		assert.equal(minimaxSeen.some((s) => s.path.includes(PROXY_HEALTH_PATH)), false);
	});

	it('returns 502 when the upstream is unreachable', async () => {
		const dead = await startProxy({
			port: 0,
			passthroughBaseUrl: 'http://127.0.0.1:1',
			resolveMiniMax: async () => undefined,
		});
		try {
			const res = await post(dead, '/v1/messages', { model: 'claude-x' });
			assert.equal(res.status, 502);
			assert.equal(JSON.parse(res.body).error.type, 'api_error');
		} finally {
			await dead.close();
		}
	});
});
