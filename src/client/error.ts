import { t } from '../i18n';
import { resolvePlatformHost } from '../consts';
import {
	MAX_DIAGNOSTIC_FIELD_LENGTH,
	NETWORK_ERROR_CATEGORY_BY_CODE,
} from './consts';
import type {
	ErrorActionLink,
	ErrorActionUrls,
	HttpErrorLinkStatusKey,
	MiniMaxRequestErrorKind,
	NetworkErrorCategory,
} from './types';

export type { MiniMaxRequestErrorKind, ErrorActionUrls } from './types';

const errorActionUrlStore = (() => {
	let current: ErrorActionUrls = {};

	return {
		get: () => current,
		set: (key: keyof ErrorActionUrls, url: string) => {
			current = { ...current, [key]: url };
		},
		/**
		 * Reset the store to an empty state. Test-only escape hatch —
		 * the module-level singleton would otherwise leak between
		 * tests that touch the action URL config.
		 */
		reset: () => {
			current = {};
		},
	};
})();

export function setErrorActionUrl(key: keyof ErrorActionUrls, url: string): void {
	errorActionUrlStore.set(key, url);
}

/**
 * Reset the action URL store to its empty default. Used by tests
 * to clear state between runs; production code never calls this.
 */
export function resetErrorActionUrls(): void {
	errorActionUrlStore.reset();
}

export class MiniMaxRequestError extends Error {
	readonly kind: MiniMaxRequestErrorKind;
	readonly userSummary: string;
	readonly diagnosticMessage: string;
	readonly baseUrl?: string;
	readonly status?: number;
	readonly code?: string;
	/**
	 * The structured `error.type` from the upstream Anthropic-compatible
	 * envelope (e.g. `insufficient_balance_error`, `authentication_error`).
	 * Surfaces in the diagnostic channel so the "MiniMax: Show Logs"
	 * output preserves the upstream's signal — the high-level toast
	 * still uses the localised summary, but anyone investigating via
	 * the request-dump writer or the log file sees the original type.
	 */
	readonly serverErrorType?: string;
	/**
	 * The upstream's `request_id` (e.g. `06747ff086b4d8dbe7fdb3f4539c41b3`
	 * from issue #2). MiniMax support asks for this when triaging a
	 * rejected request; without it, the user can only report "the
	 * request failed" with no thread to pull on.
	 */
	readonly serverRequestId?: string;

	constructor(options: {
		message: string;
		userSummary?: string;
		kind: MiniMaxRequestErrorKind;
		diagnosticMessage?: string;
		baseUrl?: string;
		status?: number;
		code?: string;
		serverErrorType?: string;
		serverRequestId?: string;
		cause?: unknown;
	}) {
		super(options.message, { cause: options.cause });
		this.name = 'MiniMaxRequestError';
		this.kind = options.kind;
		this.userSummary = options.userSummary ?? options.message;
		this.diagnosticMessage = options.diagnosticMessage ?? options.message;
		this.baseUrl = options.baseUrl;
		this.status = options.status;
		this.code = options.code;
		this.serverErrorType = options.serverErrorType;
		this.serverRequestId = options.serverRequestId;
	}
}

export async function createHttpError(
	response: Response,
	baseUrl: string,
): Promise<MiniMaxRequestError> {
	const responseText = await response.text();
	const server = extractServerError(responseText);
	const userSummary = getHttpErrorMessage(response.status, {
		host: resolvePlatformHost(baseUrl),
		upstream: formatUpstreamDetail(server),
	});
	const diagnosticMessage = joinDiagnosticParts(
		`kind=http`,
		`status=${response.status}`,
		`baseUrl=${truncateSingleLine(baseUrl)}`,
		`statusText=${response.statusText || 'unknown'}`,
		server.message ? `serverMessage=${server.message}` : undefined,
		server.errorType ? `serverErrorType=${server.errorType}` : undefined,
		server.requestId ? `serverRequestId=${server.requestId}` : undefined,
		responseText && responseText !== server.message
			? `body=${truncateSingleLine(responseText)}`
			: undefined,
	);

	return new MiniMaxRequestError({
		message: `MiniMax API request failed with HTTP ${response.status}`,
		userSummary,
		kind: 'http',
		baseUrl,
		status: response.status,
		code: `HTTP_${response.status}`,
		serverErrorType: server.errorType,
		serverRequestId: server.requestId,
		diagnosticMessage,
	});
}

export function normalizeRequestError(error: unknown): Error {
	if (error instanceof MiniMaxRequestError) {
		return error;
	}

	if (!(error instanceof Error)) {
		const value = truncateSingleLine(String(error));
		return new MiniMaxRequestError({
			message: `MiniMax request failed with a non-Error value: ${value}`,
			userSummary: t('error.unknown', value),
			kind: 'unknown',
			diagnosticMessage: `kind=unknown error=${value}`,
		});
	}

	const causeInfo = getCauseInfo(error);
	if (!causeInfo) {
		return error;
	}

	const code = causeInfo.code ?? causeInfo.name;
	const userSummary = getNetworkErrorMessage(code);
	const enhanced = new MiniMaxRequestError({
		message: code
			? `MiniMax request failed due to network error ${code}`
			: 'MiniMax request failed due to a network error',
		userSummary,
		kind: 'network',
		code,
		cause: error,
		diagnosticMessage: joinDiagnosticParts(
			`kind=network`,
			code ? `code=${code}` : undefined,
			causeInfo.name ? `name=${causeInfo.name}` : undefined,
			`message=${truncateSingleLine(error.message)}`,
			causeInfo.message ? `cause=${causeInfo.message}` : undefined,
		),
	});
	enhanced.stack = error.stack;
	return enhanced;
}

export function createUserFacingError(error: Error): Error {
	const message =
		error instanceof MiniMaxRequestError
			? formatMarkdownMessage(error.userSummary, getErrorActions(error, errorActionUrlStore.get()))
			: error.message;
	const displayError = new Error(message);
	displayError.stack = undefined;
	return displayError;
}

function getHttpErrorMessage(
	status: number,
	context?: { host?: string; upstream?: string },
): string {
	const base = (key: string) => {
		const message = t(key, status, context?.host);
		// Append the upstream detail (error.type / message / request_id)
		// when available. Done here rather than inside the i18n template
		// so the "Upstream: " prefix naturally disappears when the
		// upstream payload doesn't carry the structured fields — which
		// is the case for non-JSON HTML error pages, e.g. an nginx
		// 502 in front of the gateway.
		if (context?.upstream) {
			return `${message} ${t('error.http.upstreamSuffix', context.upstream)}`;
		}
		return message;
	};
	switch (status) {
		case 400:
			return t('error.http.400', status);
		case 401:
			return base('error.http.401');
		case 402:
			return base('error.http.402');
		case 403:
			return t('error.http.403', status);
		case 408:
			return t('error.http.408', status);
		case 413:
			return t('error.http.413', status);
		case 422:
			return t('error.http.422', status);
		case 429:
			return t('error.http.429', status);
		case 500:
			return t('error.http.500', status);
		case 503:
			return t('error.http.503', status);
		case 529:
			return t('error.http.529', status);
		default:
			return t('error.http.generic', status);
	}
}

function getNetworkErrorMessage(code: string | undefined): string {
	const errorCode = code ?? 'UNKNOWN';
	const category = getNetworkErrorCategory(code);

	switch (category) {
		case 'dns':
			return t('error.network.dns', errorCode);
		case 'unreachable':
			return t('error.network.unreachable', errorCode);
		case 'interrupted':
			return t('error.network.interrupted', errorCode);
		case 'timeout':
			return t('error.network.timeout', errorCode);
		case 'tls':
			return t('error.network.tls', errorCode);
		case 'aborted':
			return t('error.network.aborted', errorCode);
		case 'protocol':
			return t('error.network.protocol', errorCode);
		case 'configuration':
			return t('error.network.configuration', errorCode);
		case 'generic':
			return t('error.network.generic', errorCode);
		default: {
			// Compile-time exhaustiveness check: if a new variant is
			// added to `NetworkErrorCategory` and this switch is not
			// updated, the assignment to `_exhaustive` will fail to
			// type-check. The runtime throw is a safety net for the
			// rare case where the cast slips through.
			const _exhaustive: never = category;
			void _exhaustive;
			return t('error.network.generic', errorCode);
		}
	}
}

function getNetworkErrorCategory(code: string | undefined): NetworkErrorCategory {
	if (!code) {
		return 'generic';
	}

	const knownCategories = NETWORK_ERROR_CATEGORY_BY_CODE as Record<string, NetworkErrorCategory>;
	if (Object.hasOwn(knownCategories, code)) {
		return knownCategories[code] as NetworkErrorCategory;
	}

	if (code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_')) {
		return 'tls';
	}

	return code.startsWith('HPE_') ? 'protocol' : 'generic';
}

function extractServerError(responseText: string): {
	message?: string;
	errorType?: string;
	requestId?: string;
} {
	const trimmed = responseText.trim();
	if (!trimmed) {
		return {};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return { message: truncateSingleLine(trimmed) };
	}

	// Anthropic errors: { type: "error", error: { type, message }, request_id }
	const error = getObjectProperty(parsed, 'error');
	const message =
		getStringProperty(error, 'message') ??
		getStringProperty(parsed, 'message') ??
		(typeof error === 'string' ? error : undefined);
	const errorType =
		getStringProperty(error, 'type') ?? getStringProperty(parsed, 'type');
	// Some MiniMax surfaces nest the request id under different keys
	// (Anthropic uses `request_id`, the platform quota API uses
	// `request_id` too, but downstream proxies occasionally rename it
	// to `id` or `requestId`). We accept all three so we don't lose
	// the value during normalisation.
	const requestId =
		getStringProperty(parsed, 'request_id') ??
		getStringProperty(parsed, 'requestId') ??
		getStringProperty(error, 'request_id') ??
		getStringProperty(parsed, 'id');
	return {
		message: message ? truncateSingleLine(message) : undefined,
		errorType: errorType ? truncateSingleLine(errorType) : undefined,
		requestId: requestId ? truncateSingleLine(requestId) : undefined,
	};
}

/**
 * Format the upstream envelope fields into a single short string for
 * the toast detail line. The output is rendered inside an i18n
 * template so we keep it terse — typically
 * `insufficient_balance_error: insufficient balance (1008) (request_id=06747ff0…)`.
 * Returns `undefined` when no upstream fields are available so the
 * i18n template can drop the "Upstream: …" segment cleanly.
 */
function formatUpstreamDetail(
	server: { message?: string; errorType?: string; requestId?: string },
): string | undefined {
	const parts: string[] = [];
	if (server.errorType && server.message) {
		parts.push(`${server.errorType}: ${server.message}`);
	} else if (server.errorType) {
		parts.push(server.errorType);
	} else if (server.message) {
		parts.push(server.message);
	}
	if (server.requestId) {
		parts.push(`request_id=${server.requestId}`);
	}
	return parts.length > 0 ? parts.join(' (') + (parts.length > 1 ? ')' : '') : undefined;
}

function getCauseInfo(
	error: Error,
): { code?: string; name?: string; message?: string } | undefined {
	const cause = (error as Error & { cause?: unknown }).cause;
	if (!cause) {
		return undefined;
	}

	if (cause instanceof Error) {
		return {
			code: getStringProperty(cause, 'code'),
			name: cause.name,
			message:
				cause.message && cause.message !== error.message
					? truncateSingleLine(cause.message)
					: undefined,
		};
	}

	if (typeof cause === 'object') {
		return {
			code: getStringProperty(cause, 'code'),
			name: getStringProperty(cause, 'name'),
			message: truncateOptional(getStringProperty(cause, 'message')),
		};
	}

	return { message: truncateSingleLine(String(cause)) };
}

function getObjectProperty(value: unknown, key: string): unknown {
	return typeof value === 'object' && value !== null
		? (value as Record<string, unknown>)[key]
		: undefined;
}

function getStringProperty(value: unknown, key: string): string | undefined {
	const property = getObjectProperty(value, key);
	return typeof property === 'string' && property.length > 0 ? property : undefined;
}

function formatMarkdownMessage(
	summary: string,
	actions: readonly ErrorActionLink[] | undefined = undefined,
): string {
	const formattedSummary = `**${escapeBoldText(summary)}**`;
	const actionLinks = actions?.map(formatActionLink).join(' · ');
	return actionLinks
		? `${formattedSummary}\n\n**${actionLinks}**`
		: formattedSummary;
}

function formatActionLink(action: ErrorActionLink): string {
	return `[${t(action.labelKey)}](${action.url})`;
}

function getErrorActions(
	error: MiniMaxRequestError,
	actionUrls: ErrorActionUrls,
): readonly ErrorActionLink[] {
	if (error.kind === 'http' && error.status !== undefined && error.baseUrl) {
		return getHttpErrorActions(error.status, error.baseUrl, actionUrls);
	}

	return getDiagnosticErrorActions(actionUrls);
}

function getHttpErrorActions(
	status: number,
	baseUrl: string,
	actionUrls: ErrorActionUrls,
): readonly ErrorActionLink[] {
	const key = getHttpErrorLinkKey(status);
	if (!key) {
		return getDiagnosticErrorActions(actionUrls);
	}
	const link = getHttpErrorLink(key, baseUrl);
	if (!link) {
		return getDiagnosticErrorActions(actionUrls);
	}
	return [link, ...getDiagnosticErrorActions(actionUrls)];
}

function getHttpErrorLinkKey(status: number): HttpErrorLinkStatusKey | undefined {
	if (status === 401 || status === 402) {
		return status;
	}
	if (status >= 500) {
		return '5xx';
	}
	return undefined;
}

function getHttpErrorLink(
	key: HttpErrorLinkStatusKey,
	baseUrl: string,
): ErrorActionLink | undefined {
	// Resolve the platform host from the configured base URL. Falls
	// back to the China host when the base URL is empty or unrecognised,
	// which matches the `minimax.apiBaseUrl` default in `package.json`.
	// The previous implementation hard-coded `api.minimaxi.com`, so an
	// international user with a 401/402 landed on the China platform
	// (issue #2).
	const host = resolvePlatformHost(baseUrl);
	if (key === 401) {
		return {
			labelKey: 'error.action.setApiKey',
			url: `https://platform.${host}/user-center/payment/token-plan`,
		};
	}
	if (key === 402) {
		return {
			labelKey: 'error.action.createApiKey',
			url: `https://${host}`,
		};
	}
	return undefined;
}

function getDiagnosticErrorActions(
	actionUrls: ErrorActionUrls,
): readonly ErrorActionLink[] {
	const actions: ErrorActionLink[] = [];
	if (actionUrls.configureApiKey) {
		actions.push({ labelKey: 'error.action.setApiKey', url: actionUrls.configureApiKey });
	}
	if (actionUrls.showLogs) {
		actions.push({ labelKey: 'error.action.viewDetails', url: actionUrls.showLogs });
	}
	return actions;
}

function escapeBoldText(text: string): string {
	// Escape any literal `*` in the i18n summary so it can't form
	// unintended bold/italic markers in the surrounding `**...**`.
	// The standard Markdown escape for a literal asterisk is `\*`;
	// we apply it to every `*` (not just `**`) for safety.
	return text.replace(/\*/g, '\\*');
}

function joinDiagnosticParts(...parts: (string | undefined)[]): string {
	return parts.filter((part): part is string => Boolean(part)).join(' | ');
}

function truncateSingleLine(value: string, maxLength = MAX_DIAGNOSTIC_FIELD_LENGTH): string {
	const singleLine = value.replace(/\s+/g, ' ').trim();
	if (singleLine.length <= maxLength) {
		return singleLine;
	}
	return `${singleLine.slice(0, maxLength)}…`;
}

function truncateOptional(value: string | undefined): string | undefined {
	return value ? truncateSingleLine(value) : undefined;
}
