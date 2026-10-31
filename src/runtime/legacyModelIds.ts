import * as vscode from 'vscode';
import { CONFIG_SECTION } from '../consts';
import { logger } from '../logger';

/**
 * Picker ids that were replaced by a newer id, mapped to that id.
 * `MiniMax-M3.1-Flash-Preview` became the GA `MiniMax-M3.1-Flash`.
 */
export const LEGACY_MODEL_ID_REPLACEMENTS: Readonly<Record<string, string>> = {
	'MiniMax-M3.1-Flash-Preview': 'MiniMax-M3.1-Flash',
};

/** How each setting refers to model ids. */
type SettingShape = 'idArray' | 'idKeyedObject' | 'idString' | 'allowlist';

const MODEL_ID_SETTINGS: ReadonlyArray<[key: string, shape: SettingShape]> = [
	['visibleModels', 'idArray'],
	['sampling', 'idKeyedObject'],
	['modelIdOverrides', 'idKeyedObject'],
	['experimental.modelDefPresets', 'idKeyedObject'],
	['claudeCode.routing.haikuModel', 'idString'],
	['claudeCode.routing.sonnetModel', 'idString'],
	['claudeCode.routing.opusModel', 'idString'],
	// The allowlist also filters historical Claude Code logs, so the
	// old id stays and the new one is added next to it.
	['claudeCode.allowedModels', 'allowlist'],
];

/**
 * Rewrite one setting value so it names current model ids. Returns
 * `undefined` when nothing changes. Pure; exported for unit tests.
 */
export function migrateModelIdValue(shape: SettingShape, value: unknown): unknown {
	const replace = (id: string) => LEGACY_MODEL_ID_REPLACEMENTS[id] ?? id;
	switch (shape) {
		case 'idArray': {
			if (!Array.isArray(value) || !value.some((v) => typeof v === 'string' && v in LEGACY_MODEL_ID_REPLACEMENTS)) {
				return undefined;
			}
			const next: unknown[] = [];
			for (const v of value) {
				const id = typeof v === 'string' ? replace(v) : v;
				if (!next.includes(id)) next.push(id);
			}
			return next;
		}
		case 'allowlist': {
			if (!Array.isArray(value)) return undefined;
			const additions = value
				.filter((v): v is string => typeof v === 'string' && v in LEGACY_MODEL_ID_REPLACEMENTS)
				.map(replace)
				.filter((id) => !value.includes(id));
			return additions.length > 0 ? [...value, ...new Set(additions)] : undefined;
		}
		case 'idKeyedObject': {
			if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
			const entries = Object.entries(value as Record<string, unknown>);
			if (!entries.some(([k]) => k in LEGACY_MODEL_ID_REPLACEMENTS)) return undefined;
			const next: Record<string, unknown> = {};
			// Entries already written for the new id win over migrated ones.
			for (const [k, v] of entries) {
				if (!(k in LEGACY_MODEL_ID_REPLACEMENTS)) next[k] = v;
			}
			for (const [k, v] of entries) {
				const id = LEGACY_MODEL_ID_REPLACEMENTS[k];
				if (id && !(id in next)) next[id] = v;
			}
			return next;
		}
		case 'idString':
			return typeof value === 'string' && value in LEGACY_MODEL_ID_REPLACEMENTS ? replace(value) : undefined;
	}
}

/**
 * Rewrite retired model ids in the user and workspace settings, so a
 * picker selection, sampling override or Claude Code tier keeps
 * pointing at the model that replaced it. Idempotent; runs on every
 * activation and only writes when a retired id is present.
 */
export async function migrateLegacyModelIds(): Promise<void> {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const scopes = [
		['globalValue', vscode.ConfigurationTarget.Global],
		['workspaceValue', vscode.ConfigurationTarget.Workspace],
	] as const;
	for (const [key, shape] of MODEL_ID_SETTINGS) {
		const inspected = config.inspect<unknown>(key) as Record<string, unknown> | undefined;
		for (const [field, target] of scopes) {
			const next = migrateModelIdValue(shape, inspected?.[field]);
			if (next === undefined) continue;
			try {
				await config.update(key, next, target);
				logger.info(`[MiniMax] Migrated retired model ids in minimax.${key}.`);
			} catch (error) {
				logger.warn(`[MiniMax] Migrating retired model ids in minimax.${key} failed`, error);
			}
		}
	}
}
