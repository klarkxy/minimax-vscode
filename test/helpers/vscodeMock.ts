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
	},
};

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
};
Uri.parse = ((input: string) => {
	const url = new URL(input);
	return new UriInstance(url.protocol.replace(':', ''), decodeURIComponent(url.pathname), url.pathname);
}) as never;
Uri.file = ((p: string) => new UriInstance('file', p, p)) as never;
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
			if (key === 'commitModel') {
				return 'MiniMax-M2.7' as unknown as T;
			}
			return defaultValue;
		},
	}),
	tabGroups: {
		activeTabGroup: undefined,
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
};

export const env = {
	language: 'en',
	languages: ['en'],
	sessionId: 'test-session',
	appName: 'Visual Studio Code Test',
	appRoot: process.cwd(),
	openExternal: () => Promise.resolve(true),
	clipboard: {
		readText: () => Promise.resolve(''),
		writeText: () => Promise.resolve(),
	},
};

export const Event = EventEmitter;

export { makeUri, type UriLike };
