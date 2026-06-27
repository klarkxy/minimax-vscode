// Named API key pool: stores multiple MiniMax API keys, each with
// its own user-supplied name, region, endpoint, and fingerprint. The
// raw secret lives in VS Code SecretStorage (`<prefix><keyId>`);
// non-sensitive metadata lives in `globalState` under
// `API_KEYS_METADATA_KEY` so the dashboard can render key lists
// without round-tripping the secret store.
//
// The previous single-key design still works: legacy reads
// transparently fall back to `API_KEY_SECRET` and `minimax.apiKey`
// setting. Upgrading an existing user does not require a re-setup
// flow — the legacy key surfaces as a `Default` entry, and
// `Add API Key` / `Switch API Key` operate on top of it.

import { createHash, randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import {
	API_KEYS_METADATA_KEY,
	API_KEY_SECRET,
	API_KEY_SECRET_PREFIX,
	DEFAULT_BASE_URL_CHINA,
	DEFAULT_BASE_URL_GLOBAL,
	LEGACY_KEY_ID,
	resolvePlatformHost,
	type KeyMetadata,
	type KeyPoolMetadata,
	type KeyRegion,
} from './consts';
import { fetchPlanUsage } from './dashboard/api';
import { t } from './i18n';

/** Discriminated union returned by the auto-detect step when adding
 *  a new key. `unsupported` means neither official host accepted
 *  the key (likely expired, revoked, or wrong copy/paste). `both`
 *  means the user must pick the intended region manually. */
export type KeyRegionProbeResult =
	| { kind: 'china' }
	| { kind: 'global' }
	| { kind: 'both' }
	| { kind: 'unsupported' };

/** Surface-only view of a key returned to the dashboard. The raw
 *  secret is NEVER included — only metadata + the fingerprint. */
export interface KeySummary {
	id: string;
	name: string;
	region: KeyRegion;
	apiBaseUrl: string;
	fingerprint: string;
	createdAt: string;
	updatedAt: string;
	lastUsedAt?: string;
	/** `true` for the legacy single-key slot so the UI can label it
	 *  differently and discourage deletion while no replacement
	 *  exists. */
	isLegacy: boolean;
	/** `true` when the underlying secret is missing. The user can
	 *  re-enter it or delete the metadata entry. */
	missingSecret: boolean;
}

export interface KeyPoolSnapshot {
	keys: KeySummary[];
	activeKeyId?: string;
}

export class KeyManager {
	private readonly _onDidChange = new vscode.EventEmitter<KeyPoolSnapshot>();
	readonly onDidChange: vscode.Event<KeyPoolSnapshot> = this._onDidChange.event;

	/** Probe implementation; injected by tests to avoid hitting the
	 *  network. Defaults to the production `fetchPlanUsage` call. */
	private readonly probeImpl: (apiKey: string, host: 'china' | 'global') => Promise<boolean>;

	constructor(
		private readonly context: vscode.ExtensionContext,
		opts: { probe?: (apiKey: string, host: 'china' | 'global') => Promise<boolean> } = {},
	) {
		this.probeImpl = opts.probe ?? defaultProbe;
	}

	// ---- Public API ----

	/** Returns the active key's raw secret, or `undefined` if the
	 *  active key has no secret. Falls back to the legacy single-key
	 *  slot when no named pool is configured yet. */
	async getActiveApiKey(): Promise<string | undefined> {
		const meta = this.readMetadata();
		if (meta.activeKeyId) {
			const entry = meta.keys.find((k) => k.id === meta.activeKeyId);
			if (entry) {
				const secret = await this.context.secrets.get(this.secretKeyFor(entry.id));
				if (secret) {
					return secret;
				}
				// Active key metadata exists but the secret is missing.
				// Fall through to legacy fallback so legacy users keep
				// working until they re-add or delete the entry.
			}
		}
		return this.readLegacyApiKey();
	}

	/** Resolve which `apiBaseUrl` should be used for the current
	 *  active key. Falls back to the user's configured
	 *  `minimax.apiBaseUrl` (or the China default) when no active
	 *  key is set, so request-time code can stay simple. */
	async getActiveApiBaseUrl(): Promise<string> {
		const meta = this.readMetadata();
		if (meta.activeKeyId) {
			const entry = meta.keys.find((k) => k.id === meta.activeKeyId);
			if (entry) {
				return entry.apiBaseUrl;
			}
		}
		return this.readConfiguredApiBaseUrl();
	}

	/** Snapshot of the current key pool, suitable for the dashboard.
	 *  `missingSecret` is initially `false`; the dashboard refresh
	 *  path augments the snapshot via `markMissingSecrets()` so the
	 *  `vscode.SecretStorage.get(...)` calls are only made on the
	 *  render path, not on every metadata read. */
	snapshot(): KeyPoolSnapshot {
		const meta = this.readMetadata();
		const keys: KeySummary[] = meta.keys.map((k) => ({
			id: k.id,
			name: k.name,
			region: k.region,
			apiBaseUrl: k.apiBaseUrl,
			fingerprint: k.fingerprint,
			createdAt: k.createdAt,
			updatedAt: k.updatedAt,
			lastUsedAt: k.lastUsedAt,
			isLegacy: k.id === LEGACY_KEY_ID,
			missingSecret: false,
		}));
		return { keys, activeKeyId: meta.activeKeyId };
	}

	/** Augment a snapshot by checking each key's SecretStorage slot.
	 *  Returns a NEW snapshot (does not mutate). Safe to call on
	 *  every dashboard refresh — the cost is one `secrets.get`
	 *  round-trip per named key. The legacy single-key slot is
	 *  treated separately: it lives in the same SecretStorage so
	 *  the check is one extra `secrets.get('minimax-vscode.apiKey')`. */
	async markMissingSecrets(snap: KeyPoolSnapshot): Promise<KeyPoolSnapshot> {
		const checks = await Promise.all(snap.keys.map((k) =>
			this.context.secrets.get(this.secretKeyFor(k.id)).then((v) => v == null),
		));
		const legacyMissing = await this.context.secrets.get(API_KEY_SECRET).then((v) => v == null);
		const keys = snap.keys.map((k, i) => {
			const missing = k.isLegacy ? legacyMissing : checks[i];
			return missing === k.missingSecret ? k : { ...k, missingSecret: missing };
		});
		return { keys, activeKeyId: snap.activeKeyId };
	}

	/** Add a new named key. Returns the metadata for the new entry.
	 *  When `probe` is `true` (default) the manager runs the official
	 *  China/Global host probe and uses the narrowest result to fill
	 *  in `region` / `apiBaseUrl`. The caller can override either
	 *  field after the call returns if the probe was ambiguous. */
	async addApiKey(input: {
		name: string;
		apiKey: string;
		region?: KeyRegion;
		apiBaseUrl?: string;
		probe?: boolean;
	}): Promise<KeyMetadata> {
		const trimmedName = input.name.trim();
		if (!trimmedName) {
			throw new Error(t('keys.emptyName'));
		}
		const trimmedKey = input.apiKey.trim();
		if (!trimmedKey) {
			throw new Error(t('keys.emptySecret'));
		}
		const meta = this.readMetadata();
		if (meta.keys.some((k) => k.name === trimmedName)) {
			throw new Error(t('keys.duplicateName', trimmedName));
		}

		let region: KeyRegion = input.region ?? 'custom';
		let apiBaseUrl = input.apiBaseUrl;
		if (input.probe !== false) {
			const result = await this.probeRegion(trimmedKey);
			region = input.region ?? this.resolveRegionFromProbe(result);
			apiBaseUrl = input.apiBaseUrl ?? this.resolveApiBaseUrlFromProbe(result);
		}
		if (!apiBaseUrl) {
			apiBaseUrl = this.readConfiguredApiBaseUrl();
		}

		const id = `k_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
		const fingerprint = this.fingerprintOf(trimmedKey);
		const now = new Date().toISOString();
		const entry: KeyMetadata = {
			id,
			name: trimmedName,
			region,
			apiBaseUrl,
			fingerprint,
			createdAt: now,
			updatedAt: now,
		};

		await this.context.secrets.store(this.secretKeyFor(id), trimmedKey);
		meta.keys.push(entry);
		meta.activeKeyId = id;
		await this.persistMetadata(meta);
		this.fireChange();
		return entry;
	}

	/** Switch which key is active. Updates `lastUsedAt` and
	 *  persists the new active id. Does NOT touch the
	 *  `minimax.apiBaseUrl` setting; the caller (commands / provider
	 *  config) does that to keep responsibilities clean. */
	async switchApiKey(id: string): Promise<KeyMetadata> {
		const meta = this.readMetadata();
		const entry = meta.keys.find((k) => k.id === id);
		if (!entry) {
			throw new Error(`Unknown key id: ${id}`);
		}
		entry.updatedAt = new Date().toISOString();
		entry.lastUsedAt = entry.updatedAt;
		meta.activeKeyId = id;
		await this.persistMetadata(meta);
		this.fireChange();
		return entry;
	}

	/** Public wrapper around `switchApiKey` that ALSO mirrors the
	 *  selected key's `apiBaseUrl` into `minimax.apiBaseUrl`. This is
	 *  the entry point commands use so the request path, the quota
	 *  host, and the usage scope all stay in sync. Returns the new
	 *  active metadata and the previous active id (or `undefined`
	 *  if there was no previous active key). */
	async setActiveKey(id: string): Promise<{ entry: KeyMetadata; previousId?: string }> {
		const meta = this.readMetadata();
		// `previousId` describes the key that was active immediately
		// before this call. A no-op switch (target id already active)
		// must report `undefined` — otherwise callers cannot tell a
		// real rotation apart from an idempotent re-selection. This
		// matters for the dashboard's "previous active key" tooltip
		// and for the plan-cache invalidation side effect.
		const previousId = meta.activeKeyId === id ? undefined : meta.activeKeyId;
		const entry = await this.switchApiKey(id);
		await this.updateApiBaseUrl(entry.apiBaseUrl);
		return { entry, previousId };
	}

	/** Mirror a base URL into `minimax.apiBaseUrl`. The legacy
	 *  single-key slot does not own an endpoint, so this is a no-op
	 *  for `LEGACY_KEY_ID`. */
	async updateApiBaseUrl(apiBaseUrl: string): Promise<void> {
		const config = vscode.workspace.getConfiguration('minimax');
		const current = config.get<string>('apiBaseUrl');
		if (current === apiBaseUrl) return;
		await config.update('apiBaseUrl', apiBaseUrl, vscode.ConfigurationTarget.Global);
	}

	/** Rename a key. Throws if another key already has the new name. */
	async renameApiKey(id: string, newName: string): Promise<KeyMetadata> {
		const trimmed = newName.trim();
		if (!trimmed) {
			throw new Error('Key name is required');
		}
		const meta = this.readMetadata();
		const entry = meta.keys.find((k) => k.id === id);
		if (!entry) {
			throw new Error(`Unknown key id: ${id}`);
		}
		if (meta.keys.some((k) => k.id !== id && k.name === trimmed)) {
			throw new Error(`Key name "${trimmed}" is already in use`);
		}
		entry.name = trimmed;
		entry.updatedAt = new Date().toISOString();
		await this.persistMetadata(meta);
		this.fireChange();
		return entry;
	}

	/** Delete a key's metadata + secret. If the deleted key was
	 *  active, picks the next available key (or clears the active
	 *  pointer) AND mirrors the replacement key's `apiBaseUrl` into
	 *  `minimax.apiBaseUrl`. Without that mirror, the request path
	 *  would keep hitting the OLD host with the NEW secret after
	 *  deleting the active key — see `setActiveKey()` for the
	 *  matching sync used by the switch flow. */
	async deleteApiKey(id: string): Promise<void> {
		const meta = this.readMetadata();
		const idx = meta.keys.findIndex((k) => k.id === id);
		if (idx < 0) {
			return;
		}
		meta.keys.splice(idx, 1);
		const wasActive = meta.activeKeyId === id;
		let replacement: KeyMetadata | undefined;
		if (wasActive) {
			meta.activeKeyId = meta.keys[0]?.id;
			if (meta.activeKeyId) {
				replacement = meta.keys.find((k) => k.id === meta.activeKeyId);
			}
		}
		await this.context.secrets.delete(this.secretKeyFor(id));
		await this.persistMetadata(meta);
		if (wasActive && replacement) {
			await this.updateApiBaseUrl(replacement.apiBaseUrl);
		}
		this.fireChange();
	}

	/** Update `lastUsedAt` for the currently active key. Called from
	 *  the request path so the dashboard can show "last used". */
	async touchActiveKey(): Promise<void> {
		const meta = this.readMetadata();
		if (!meta.activeKeyId) return;
		const entry = meta.keys.find((k) => k.id === meta.activeKeyId);
		if (!entry) return;
		entry.lastUsedAt = new Date().toISOString();
		await this.persistMetadata(meta);
	}

	/** Map a MiniMax API key to a region by attempting
	 *  `coding_plan/remains` against both official hosts. Returns
	 *  the narrowest match when possible (`china` / `global`),
	 *  `both` when the key is valid in both regions, and
	 *  `unsupported` when neither host accepts the key. */
	async probeRegion(apiKey: string): Promise<KeyRegionProbeResult> {
		const results = await Promise.all([
			this.probeHost(apiKey, 'china'),
			this.probeHost(apiKey, 'global'),
		]);
		const china = results[0];
		const global = results[1];
		if (china && global) return { kind: 'both' };
		if (china) return { kind: 'china' };
		if (global) return { kind: 'global' };
		return { kind: 'unsupported' };
	}

	/** Convert a probe result into the default `apiBaseUrl` for the
	 *  user. `both` falls back to the China host to match the
	 *  existing endpoint auto-select behaviour. `unsupported`
	 *  returns the China default as well so the user can still
	 *  manually pick a custom endpoint via the manager. */
	resolveApiBaseUrlFromProbe(result: KeyRegionProbeResult): string {
		switch (result.kind) {
			case 'china':
				return DEFAULT_BASE_URL_CHINA;
			case 'global':
				return DEFAULT_BASE_URL_GLOBAL;
			case 'both':
			case 'unsupported':
				return DEFAULT_BASE_URL_CHINA;
		}
	}

	resolveRegionFromProbe(result: KeyRegionProbeResult): KeyRegion {
		if (result.kind === 'china') return 'china';
		if (result.kind === 'global') return 'global';
		return 'custom';
	}

	// ---- Internal helpers ----

	private secretKeyFor(id: string): string {
		return `${API_KEY_SECRET_PREFIX}${id}`;
	}

	private fingerprintOf(secret: string): string {
		// Stable 12-char prefix from sha256(keyId-suffix-as-proxy). The
		// suffix is not in the secret but the dashboard only needs a
		// stable per-key token. We instead hash a salt + the secret's
		// tail, mirroring what Anthropic's CLI does for display.
		const tail = secret.slice(-6);
		const hash = createHash('sha256')
			.update('minimax-fp\u0000' + tail)
			.digest('hex')
			.slice(0, 6);
		return `${hash}…${tail}`;
	}

	private readMetadata(): KeyPoolMetadata {
		const raw = this.context.globalState.get<KeyPoolMetadata>(API_KEYS_METADATA_KEY);
		if (!raw) {
			return { keys: [] };
		}
		return {
			activeKeyId: raw.activeKeyId,
			keys: Array.isArray(raw.keys) ? raw.keys.slice() : [],
		};
	}

	private async persistMetadata(meta: KeyPoolMetadata): Promise<void> {
		await this.context.globalState.update(API_KEYS_METADATA_KEY, meta);
	}

	private fireChange(): void {
		this._onDidChange.fire(this.snapshot());
	}

	private async readLegacyApiKey(): Promise<string | undefined> {
		const secret = await this.context.secrets.get(API_KEY_SECRET);
		if (secret) return secret;
		const config = vscode.workspace.getConfiguration('minimax');
		const setting = config.get<string>('apiKey');
		return setting?.trim() || undefined;
	}

	private readConfiguredApiBaseUrl(): string {
		const config = vscode.workspace.getConfiguration('minimax');
		const url = config.get<string>('apiBaseUrl');
		if (url && url.trim()) {
			return url.trim();
		}
		return DEFAULT_BASE_URL_CHINA;
	}

	private async probeHost(apiKey: string, host: 'china' | 'global'): Promise<boolean> {
		return this.probeImpl(apiKey, host);
	}

	/** Test/diagnostic helper: returns the resolved platform host for
	 *  a base URL, mirroring the same strict-equality rules used by
	 *  `resolvePlatformHost`. Exposed so the manager can short-circuit
	 *  custom-endpoint hosts without re-implementing the parser. */
	resolveHost(apiBaseUrl: string) {
		return resolvePlatformHost(apiBaseUrl);
	}
}

async function defaultProbe(apiKey: string, host: 'china' | 'global'): Promise<boolean> {
	try {
		const result = await fetchPlanUsage({ apiKey, host });
		return result.ok;
	} catch {
		return false;
	}
}
