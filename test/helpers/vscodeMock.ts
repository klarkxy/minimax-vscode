// Minimal in-process mock of the `vscode` namespace used by the unit tests.
//
// esbuild aliases `vscode` to this file via the `alias` option in
// `esbuild.tests.mjs`, so any `import * as vscode from 'vscode'` in the
// production source resolves to the namespace created here. We export
// each member as a named export to match that pattern.

type UriLike = {
	scheme: string;
	path: string;
	fsPath: string;
	external?: string;
};

function makeUri(value: string | UriLike): UriLike {
	if (typeof value === 'string') {
		// Wrap in UriInstance so the production code's `instanceof vscode.Uri`
		// check (and reference equality) works.
		return new UriInstance('file', value, value) as unknown as UriLike;
	}
	return value;
}

const outputChannels: Array<{ name: string; log: unknown[] }> = [];
const quickPicks: unknown[] = [];
const informationMessages: string[] = [];
const errorMessages: string[] = [];
const warningMessages: string[] = [];
/**
 * Records every URI passed to `vscode.env.openExternal` so tests can
 * assert on the scheme (e.g. that an "open the dump folder" command
 * hands `file://` to the shell, not a `vscode-userdata://` URI that
 * Windows would reject with a "open with what app?" dialog). The
 * previous hard-coded `() => Promise.resolve(true)` made it impossible
 * to assert on the URI scheme — the bug where `Uri.joinPath` produced
 * a non-`file://` URI shipped to production unnoticed.
 */
const openExternalCalls: Array<{ uri: UriLike; scheme: string }> = [];
/**
 * Records every command registered via `vscode.commands.registerCommand`
 * so tests can invoke the callback directly. The default behaviour
 * mirrors the real VS Code API: the returned `Disposable` has a no-op
 * `dispose()`. Production code never reads the return value, so the
 * dummy disposable is fine.
 */
const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();

export const mockState = {
	outputChannels,
	quickPicks,
	informationMessages,
	errorMessages,
	warningMessages,
	reset() {
		outputChannels.length = 0;
		quickPicks.length = 0;
		informationMessages.length = 0;
		errorMessages.length = 0;
		warningMessages.length = 0;
		openExternalCalls.length = 0;
		registeredCommands.clear();
	},
};

/** Test-only accessor for the openExternal call log. */
export function getOpenExternalCalls(): ReadonlyArray<{ uri: UriLike; scheme: string }> {
	return openExternalCalls;
}

/** Test-only accessor for the registerCommand log. */
export function getRegisteredCommand(
	id: string,
): ((...args: unknown[]) => unknown) | undefined {
	return registeredCommands.get(id);
}

export class UriInstance {
	constructor(public scheme: string, public fsPath: string, public path: string) {}
}

export class LanguageModelTextPart {
	constructor(public value: string) {}
	static is(value: unknown): value is LanguageModelTextPart {
		return value instanceof LanguageModelTextPart;
	}
}

export class LanguageModelToolCallPart {
	constructor(public callId: string, public name: string, public input: unknown) {}
}

export class LanguageModelToolResultPart {
	constructor(
		public callId: string,
		public content: Array<unknown>,
	) {}
}

export class LanguageModelDataPart {
	constructor(public data: unknown, public mimeType: string) {}
}

export class CancellationTokenSource {
	token = {
		isCancellationRequested: false,
		onCancellationRequested: () => ({ dispose: () => {} }),
	};
	cancel() {
		this.token.isCancellationRequested = true;
	}
	dispose() {}
}

export class TabInputText {
	language: string = 'plaintext';
	constructor(public uri: UriLike) {}
}

export class EventEmitter {
	private listeners: Array<(e: unknown) => void> = [];
	fire(data: unknown) {
		for (const l of this.listeners) l(data);
	}
	dispose() {
		this.listeners = [];
	}
	event = (listener: (e: unknown) => void) => {
		this.listeners.push(listener);
		return new Disposable(() => {
			const idx = this.listeners.indexOf(listener);
			if (idx >= 0) this.listeners.splice(idx, 1);
		});
	};
}

export class Disposable {
	constructor(private readonly cleanup: () => void) {}
	dispose(): void {
		this.cleanup();
	}
	static from(...disposables: { dispose(): unknown }[]): Disposable {
		return new Disposable(() => {
			for (const d of disposables) {
				try {
					d.dispose();
				} catch {
					// ignore
				}
			}
		});
	}
}

/**
 * Minimal `ThemeIcon` mock. Production code constructs
 * `new vscode.ThemeIcon('lightbulb')` etc. to attach a status icon to
 * a model picker row. Tests only assert that *some* icon is present
 * for the "thinking off" case and `undefined` for the default case,
 * so the class itself doesn't need to carry real SVG data.
 */
export class ThemeIcon {
	constructor(public id: string) {}
}

// `vscode.Uri` in production is both a class and a namespace with
// `parse`/`file` helpers. We expose it as a callable function (the
// `parse` binding) that also carries the `parse` / `file` static
// helpers. `instanceof vscode.Uri` matches `UriInstance` because we
// install `Symbol.hasInstance` below.
export const Uri = ((input: string) => {
	const url = new URL(input);
	return new UriInstance(url.protocol.replace(':', ''), decodeURIComponent(url.pathname), url.pathname);
}) as unknown as {
	(input: string): UriInstance;
	parse: (input: string) => UriInstance;
	file: (path: string) => UriInstance;
	joinPath: (base: UriLike, ...paths: string[]) => UriInstance;
};
Uri.parse = ((input: string) => {
	const url = new URL(input);
	return new UriInstance(url.protocol.replace(':', ''), decodeURIComponent(url.pathname), url.pathname);
}) as never;
Uri.file = ((p: string) => new UriInstance('file', p, p)) as never;
// `Uri.joinPath` in real VS Code returns a `vscode-userdata://…` URI
// (NOT a `file://` URI) when the base is the globalStorageUri. This is
// the exact property the production fix in `openRequestDumpsFolder`
// relies on: the `fsPath` it pulls off the joinPath result is what it
// feeds into `Uri.file()` to get back a `file://` URI. If we make
// joinPath return a `file://` URI directly, the test would silently
// agree with the buggy old code; if we make it return a `file://` URI
// with a mangled path, the fix's `fsPath`-then-`Uri.file` round-trip
// would still produce a different result than the old code. We model
// real VS Code behaviour: `vscode-userdata://` scheme, `fsPath` is the
// platform-native path of the joined segments.
Uri.joinPath = ((base: UriLike, ...paths: string[]) => {
	const joinedFsPath = [base.fsPath, ...paths].join('/').replace(/\/+/g, '/');
	return new UriInstance('vscode-userdata', joinedFsPath, joinedFsPath);
}) as never;
Object.defineProperty(Uri, Symbol.hasInstance, {
	value: (value: unknown) => value instanceof UriInstance,
});

export const ProgressLocation = {
	Notification: 15,
};

export const workspace = {
	getConfiguration: (_section: string) => ({
		get: <T>(key: string, defaultValue?: T): T | undefined => {
			if (key === 'enabled') {
				return true as unknown as T;
			}
			return defaultValue;
		},
		update: async (_key: string, _value: unknown, _target?: unknown): Promise<void> => {
			// No-op default. Tests that need to assert configuration writes
			// should stub `vscode.workspace.getConfiguration` locally.
		},
	}),
	tabGroups: {
		activeTabGroup: undefined,
	},
	/**
	 * `workspace.fs` is a thin async filesystem facade in real VS Code.
	 * Production code only calls `createDirectory` here (for the
	 * "ensure dump folder exists" pre-flight in
	 * `openRequestDumpsFolder`). Tests don't need a real filesystem —
	 * a no-op stub is enough; if a test wants to assert that
	 * `createDirectory` was called, it can stub this directly.
	 */
	fs: {
		createDirectory: (_uri: UriLike) => Promise.resolve(),
		stat: (_uri: UriLike) => Promise.resolve({ type: 2 satisfies 2 }),
	},
};

export const window = {
	tabGroups: {
		activeTabGroup: undefined,
	},
	showInformationMessage: (msg: string) => {
		informationMessages.push(msg);
		return Promise.resolve(undefined);
	},
	showErrorMessage: (msg: string) => {
		errorMessages.push(msg);
		return Promise.resolve(undefined);
	},
	showWarningMessage: (msg: string) => {
		warningMessages.push(msg);
		return Promise.resolve(undefined);
	},
	showQuickPick: (items: unknown[]) => {
		quickPicks.push(items);
		return Promise.resolve(items[0]);
	},
	createOutputChannel: (name: string) => {
		const entry = { name, log: [] as unknown[] };
		outputChannels.push(entry);
		return {
			name,
			append: (line: string) => entry.log.push(line),
			appendLine: (line: string) => entry.log.push(line),
			show: () => {},
			dispose: () => {},
			info: (line: string) => entry.log.push(line),
			warn: (line: string) => entry.log.push(line),
			error: (line: string) => entry.log.push(line),
			debug: (line: string) => entry.log.push(line),
			clear: () => {
				entry.log.length = 0;
			},
		};
	},
};

export const extensions = {
	getExtension: () => undefined,
};

export const scm = {
	sourceControls: [] as Array<{
		readonly id: string;
		readonly label: string;
		readonly rootUri?: UriLike;
		readonly resourceGroups: Array<{
			readonly id: string;
			readonly label: string;
			readonly resourceStates: Array<{ readonly resourceUri: UriLike }>;
		}>;
	}>,
	createSourceControl: (_id: string, _label: string, _root?: UriLike) => {
		throw new Error('scm.createSourceControl is not supported in the test mock');
	},
};

export const commands = {
	executeCommand: () => Promise.resolve(),
	registerCommand: (id: string, callback: (...args: unknown[]) => unknown) => {
		registeredCommands.set(id, callback);
		return new Disposable(() => {});
	},
};

/**
 * `ConfigurationTarget` enum mirrored from vscode. Values are the
 * stable ones from the VS Code 1.x API:
 *   - 1 = Global
 *   - 2 = Workspace
 *   - 3 = WorkspaceFolder
 */
export const ConfigurationTarget = {
	Global: 1,
	Workspace: 2,
	WorkspaceFolder: 3,
} as const;

export const env = {
	language: 'en',
	languages: ['en'],
	sessionId: 'test-session',
	appName: 'Visual Studio Code Test',
	appRoot: process.cwd(),
	openExternal: (uri: UriLike) => {
		openExternalCalls.push({ uri, scheme: uri.scheme });
		return Promise.resolve(true);
	},
	clipboard: {
		readText: () => Promise.resolve(''),
		writeText: () => Promise.resolve(),
	},
};

export const Event = EventEmitter;

/**
 * Role enum mirrored from vscode's `LanguageModelChatMessageRole`.
 * The values have been stable since 1.84:
 *   - 1 = User
 *   - 2 = Assistant
 *   - 3 = System (not surfaced in @types/vscode; used in production
 *     by the converter via the raw numeric value)
 */
export const LanguageModelChatMessageRole = {
	User: 1,
	Assistant: 2,
	System: 3,
} as const;

export { makeUri, type UriLike };
