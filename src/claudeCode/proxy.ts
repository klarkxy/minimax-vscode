import * as http from 'node:http';
import * as https from 'node:https';

/**
 * Local Anthropic-compatible router for Claude Code.
 *
 * Claude Code is pointed at this server via `ANTHROPIC_BASE_URL`. Every
 * request whose JSON body names a MiniMax model (e.g. the
 * `ANTHROPIC_DEFAULT_HAIKU_MODEL=MiniMax-M3` override) is forwarded to
 * the MiniMax Anthropic-compatible endpoint with the extension's API
 * key; everything else is passed through byte-for-byte to the real
 * Anthropic API with the caller's own credentials (API key or
 * subscription OAuth token), so the non-overridden models keep working
 * exactly as before.
 *
 * Pure Node — no `vscode` import — so it can be unit-tested and run
 * standalone.
 */

/** Path answered by the proxy itself; used to detect an instance owned
 *  by another VS Code window before trying to bind the same port. */
export const PROXY_HEALTH_PATH = '/__minimax/health';
export const PROXY_ID = 'minimax-claude-code-proxy';

export interface MiniMaxTarget {
	apiKey: string;
	/** Anthropic-compatible base, e.g. `https://api.minimax.io/anthropic`. */
	baseUrl: string;
}

export interface ProxyLogger {
	info(message: string): void;
	warn(message: string, error?: unknown): void;
}

export interface ClaudeCodeProxyOptions {
	port: number;
	host?: string;
	/** Where non-MiniMax traffic goes, e.g. `https://api.anthropic.com`. */
	passthroughBaseUrl: string;
	/** Resolved per request so key / region switches apply immediately. */
	resolveMiniMax: () => Promise<MiniMaxTarget | undefined>;
	/** Message returned to Claude Code when no MiniMax key is configured. */
	missingKeyMessage?: string;
	isMiniMaxModel?: (model: string) => boolean;
	logger?: ProxyLogger;
}

export interface RunningProxy {
	readonly port: number;
	readonly url: string;
	close(): Promise<void>;
}

export function isMiniMaxModelId(model: string): boolean {
	return /^minimax/i.test(model.trim());
}

/** RFC 7230 hop-by-hop headers plus the ones we recompute. */
const HOP_BY_HOP = new Set([
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'proxy-connection',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
	'host',
	'content-length',
]);

/** Caller credentials / Anthropic-only headers that must never reach MiniMax. */
const STRIP_FOR_MINIMAX = new Set(['authorization', 'x-api-key', 'cookie', 'anthropic-beta']);

export function joinUrl(base: string, pathAndQuery: string): URL {
	return new URL(base.replace(/\/+$/, '') + pathAndQuery);
}

function filterHeaders(
	headers: http.IncomingHttpHeaders,
	extraStrip?: Set<string>,
): http.OutgoingHttpHeaders {
	const out: http.OutgoingHttpHeaders = {};
	for (const [name, value] of Object.entries(headers)) {
		const lower = name.toLowerCase();
		if (value === undefined || HOP_BY_HOP.has(lower) || extraStrip?.has(lower)) {
			continue;
		}
		out[lower] = value;
	}
	return out;
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on('data', (chunk: Buffer) => chunks.push(chunk));
		req.on('end', () => resolve(Buffer.concat(chunks)));
		req.on('error', reject);
	});
}

/** Extract `model` from a JSON request body; `undefined` for anything else. */
export function extractModel(body: Buffer): string | undefined {
	if (body.length === 0) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(body.toString('utf8')) as { model?: unknown };
		return typeof parsed?.model === 'string' ? parsed.model : undefined;
	} catch {
		return undefined;
	}
}

function sendError(res: http.ServerResponse, status: number, type: string, message: string): void {
	if (res.headersSent) {
		res.destroy();
		return;
	}
	const payload = JSON.stringify({ type: 'error', error: { type, message } });
	res.writeHead(status, {
		'content-type': 'application/json',
		'content-length': Buffer.byteLength(payload),
	});
	res.end(payload);
}

function forward(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	target: URL,
	headers: http.OutgoingHttpHeaders,
	body: Buffer,
	logger: ProxyLogger | undefined,
): void {
	const transport = target.protocol === 'http:' ? http : https;
	if (body.length > 0) {
		headers['content-length'] = body.length;
	}
	const upstream = transport.request(
		target,
		{ method: req.method, headers },
		(upRes) => {
			res.writeHead(upRes.statusCode ?? 502, filterHeaders(upRes.headers));
			upRes.pipe(res);
		},
	);
	upstream.on('error', (error) => {
		logger?.warn(`[ClaudeCode] Upstream ${target.host} failed`, error);
		sendError(res, 502, 'api_error', `MiniMax Claude Code proxy: upstream ${target.host} unreachable (${error.message})`);
	});
	// Claude Code aborts streams on Esc / cancel — propagate so the
	// upstream generation stops instead of running to completion.
	res.on('close', () => {
		if (!res.writableFinished) {
			upstream.destroy();
		}
	});
	upstream.end(body);
}

export function createProxyHandler(
	options: ClaudeCodeProxyOptions,
): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
	const isMiniMax = options.isMiniMaxModel ?? isMiniMaxModelId;
	const logger = options.logger;

	return async (req, res) => {
		const pathAndQuery = req.url ?? '/';
		if (req.method === 'GET' && pathAndQuery.split('?')[0] === PROXY_HEALTH_PATH) {
			const payload = JSON.stringify({ id: PROXY_ID, pid: process.pid });
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(payload);
			return;
		}

		let body: Buffer;
		try {
			body = await readBody(req);
		} catch (error) {
			logger?.warn('[ClaudeCode] Failed to read request body', error);
			sendError(res, 400, 'invalid_request_error', 'Failed to read request body');
			return;
		}

		const model = extractModel(body);
		if (model && isMiniMax(model)) {
			let target: MiniMaxTarget | undefined;
			try {
				target = await options.resolveMiniMax();
			} catch (error) {
				logger?.warn('[ClaudeCode] Failed to resolve MiniMax key', error);
			}
			if (!target) {
				sendError(
					res,
					401,
					'authentication_error',
					options.missingKeyMessage ?? 'MiniMax API key is not configured.',
				);
				return;
			}
			const headers = filterHeaders(req.headers, STRIP_FOR_MINIMAX);
			headers['x-api-key'] = target.apiKey;
			logger?.info(`[ClaudeCode] ${req.method} ${pathAndQuery} model=${model} → MiniMax`);
			forward(req, res, joinUrl(target.baseUrl, pathAndQuery), headers, body, logger);
			return;
		}

		forward(
			req,
			res,
			joinUrl(options.passthroughBaseUrl, pathAndQuery),
			filterHeaders(req.headers),
			body,
			logger,
		);
	};
}

/** Bind the proxy. Rejects with the raw `listen` error (e.g. `EADDRINUSE`). */
export function startProxy(options: ClaudeCodeProxyOptions): Promise<RunningProxy> {
	const host = options.host ?? '127.0.0.1';
	const handler = createProxyHandler(options);
	const server = http.createServer((req, res) => {
		void handler(req, res).catch((error) => {
			options.logger?.warn('[ClaudeCode] Proxy handler crashed', error);
			sendError(res, 500, 'api_error', 'MiniMax Claude Code proxy internal error');
		});
	});
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(options.port, host, () => {
			server.off('error', reject);
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : options.port;
			resolve({
				port,
				url: `http://${host}:${port}`,
				close: () =>
					new Promise<void>((done) => {
						server.close(() => done());
						server.closeAllConnections();
					}),
			});
		});
	});
}

/** True when `port` is served by a MiniMax proxy (possibly another window's). */
export function probeExistingProxy(port: number, host = '127.0.0.1', timeoutMs = 1500): Promise<boolean> {
	return new Promise((resolve) => {
		const req = http.get({ host, port, path: PROXY_HEALTH_PATH, timeout: timeoutMs }, (res) => {
			const chunks: Buffer[] = [];
			res.on('data', (c: Buffer) => chunks.push(c));
			res.on('end', () => {
				try {
					resolve((JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: string }).id === PROXY_ID);
				} catch {
					resolve(false);
				}
			});
		});
		req.on('timeout', () => req.destroy());
		req.on('error', () => resolve(false));
	});
}
