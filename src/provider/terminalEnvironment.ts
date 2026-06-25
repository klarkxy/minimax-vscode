import * as vscode from 'vscode';

const TERMINAL_GUIDANCE_PREFIX = 'The user\'s terminal environment is';

export function getTerminalEnvironmentDescription(): string | undefined {
	const activeTerminalName = getActiveTerminalName();
	if (activeTerminalName) {
		return activeTerminalName;
	}

	const platformSuffixes = getPlatformSuffixes();
	const defaultProfile = readFirstConfigurationString(
		platformSuffixes.map((suffix) => `terminal.integrated.defaultProfile.${suffix}`),
	);
	if (defaultProfile) {
		return defaultProfile;
	}

	const automationShell = readFirstConfigurationString(
		platformSuffixes.map((suffix) => `terminal.integrated.automationShell.${suffix}`),
	);
	if (automationShell) {
		return automationShell;
	}

	return undefined;
}

export function buildTerminalGuidance(): string | undefined {
	const terminalDescription = getTerminalEnvironmentDescription();
	if (!terminalDescription) {
		return undefined;
	}

	return `${TERMINAL_GUIDANCE_PREFIX} ${terminalDescription}. For terminal commands, use syntax that is valid for this shell. Do not use Bash-only syntax unless explicitly launching Bash.`;
}

export function appendTerminalGuidanceToSystemPrompt(
	systemPrompt: string | undefined,
	terminalGuidance: string | undefined,
): string | undefined {
	if (!terminalGuidance) {
		return systemPrompt;
	}
	if (!systemPrompt) {
		return terminalGuidance;
	}
	if (systemPrompt.includes(TERMINAL_GUIDANCE_PREFIX)) {
		return systemPrompt;
	}
	return `${systemPrompt}\n\n${terminalGuidance}`;
}

export function appendTerminalGuidanceToToolDescription(
	description: string | undefined,
	terminalGuidance: string | undefined,
): string | undefined {
	if (!terminalGuidance) {
		return description;
	}
	if (!description) {
		return terminalGuidance;
	}
	if (description.includes(TERMINAL_GUIDANCE_PREFIX)) {
		return description;
	}
	return `${description}\n\n${terminalGuidance}`;
}

function getActiveTerminalName(): string | undefined {
	const activeTerminal = (vscode.window as { activeTerminal?: { name?: unknown; shellPath?: unknown } }).activeTerminal;
	if (!activeTerminal) {
		return undefined;
	}
	return normalizeTerminalDescription(activeTerminal.shellPath) ?? normalizeTerminalDescription(activeTerminal.name);
}

function readConfigurationString(key: string): string | undefined {
	const parts = key.split('.');
	if (parts.length < 2) {
		return undefined;
	}
	const section = parts.slice(0, 2).join('.');
	const name = parts.slice(2).join('.');
	return normalizeTerminalDescription(vscode.workspace.getConfiguration(section).get(name));
}

function readFirstConfigurationString(keys: string[]): string | undefined {
	for (const key of keys) {
		const value = readConfigurationString(key);
		if (value) {
			return value;
		}
	}
	return undefined;
}

function getPlatformSuffixes(): string[] {
	switch (process.platform) {
		case 'win32':
			return ['windows', 'linux', 'osx'];
		case 'darwin':
			return ['osx', 'linux', 'windows'];
		default:
			return ['linux', 'windows', 'osx'];
	}
}

function normalizeTerminalDescription(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return undefined;
	}

	const shellName = extractShellName(trimmed);
	return toKnownShellLabel(shellName) ?? shellName;
}

function extractShellName(value: string): string {
	const withoutQuotes = value.replace(/^['"]|['"]$/g, '');
	const parts = withoutQuotes.split(/[\\/]/);
	const lastPart = parts[parts.length - 1] ?? withoutQuotes;
	return lastPart.replace(/\.(exe|cmd|bat|ps1)$/i, '');
}

function toKnownShellLabel(value: string): string | undefined {
	const normalized = value.toLowerCase();
	if (normalized === 'powershell' || normalized === 'windowspowershell') {
		return 'Windows PowerShell';
	}
	if (normalized === 'pwsh') {
		return 'PowerShell';
	}
	if (normalized === 'cmd') {
		return 'Command Prompt';
	}
	if (normalized === 'bash' || normalized === 'zsh' || normalized === 'fish') {
		return value;
	}
	return undefined;
}
