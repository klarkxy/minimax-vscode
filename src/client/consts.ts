/**
 * Network error category lookup. Maps well-known Node fetch / undici error
 * codes to the user-facing category that drives localized messages.
 */
import type { NetworkErrorCategory } from './types';

export const NETWORK_ERROR_CATEGORY_BY_CODE: Record<string, NetworkErrorCategory> = {
	ENOTFOUND: 'dns',
	EAI_AGAIN: 'dns',
	ECONNREFUSED: 'unreachable',
	ECONNRESET: 'interrupted',
	ETIMEDOUT: 'timeout',
	EPIPE: 'interrupted',
	EHOSTUNREACH: 'unreachable',
	ENETUNREACH: 'unreachable',
	ENETRESET: 'interrupted',
	ERR_TLS_CERT_ALTNAME_INVALID: 'tls',
	UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'tls',
	DEPTH_ZERO_SELF_SIGNED_CERT: 'tls',
	SELF_SIGNED_CERT_IN_CHAIN: 'tls',
	CERT_HAS_EXPIRED: 'tls',
};

export const MAX_DIAGNOSTIC_FIELD_LENGTH = 500;
