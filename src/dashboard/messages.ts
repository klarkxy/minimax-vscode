// Localised strings for the dashboard webview. Mirrors the pattern
// used by src/i18n.ts (one dictionary per language, lookup by key)
// but is intentionally self-contained: the webview is rendered as a
// string of HTML and receives every label up-front in the initial
// payload, so we never have to round-trip text through VS Code's
// `vscode.env.language` from inside the iframe.

export type DashboardLocale = 'en' | 'zh';

export interface DashboardMessages {
	pageTitle: string;
	subtitle: string;
	refresh: string;
	close: string;
	reset: string;
	resetConfirm: string;
	resetDone: string;
	planSectionTitle: string;
	localSectionTitle: string;
	/** Section title for the aggregate "总" tab — sum of every
	 *  available token source. */
	totalSectionTitle: string;
	/** Section title for the "copilot" tab — the extension's own
	 *  Copilot-Chat token accounting. */
	copilotSectionTitle: string;
	perModelTitle: string;
	dailyChartTitle: string;
	noLocalData: string;
	platformUnavailable: string;
	platformUnconfigured: string;
	platformLoading: string;
	fieldInput: string;
	fieldOutput: string;
	fieldCacheRead: string;
	fieldCacheWrite: string;
	fieldRequests: string;
	fieldTotal: string;
	fieldUsed: string;
	fieldRemaining: string;
	fieldResetsIn: string;
	fieldWeeklyReset: string;
	fieldWeekly: string;
	fieldExpiry: string;
	fieldExpiryDays: (days: number) => string;
	/** Em-dash placeholder for quota numbers the platform did not report. */
	fieldUnlisted: string;
	fieldStarted: string;
	fieldUpdated: string;
	windowToday: string;
	window7d: string;
	window30d: string;
	platformModelHeader: string;
	// ---- mmx-cli (detection only) ----
	mmxSectionTitle: string;
	mmxSubtitle: string;
	mmxInstalled: string;
	mmxMissing: string;
	mmxVersion: string;
	mmxAuthLoggedIn: string;
	mmxAuthLoggedOut: string;
	mmxAuthUnknown: string;
	mmxSkillInstalled: string;
	mmxSkillMissing: string;
	mmxCopyPromptBtn: string;
	mmxRecheckBtn: string;
	mmxAgentReady: string;
	mmxAgentNotReady: string;
	mmxCommandLabel: string;
	mmxAuthLabel: string;
	mmxSkillLabel: string;
	/** Pending-step labels — only shown for steps that aren't done yet. */
	mmxInstallBtn: string;
	mmxLoginBtn: string;
	mmxInstallSkillBtn: string;
	// ---- MiniMax Web Search MCP (status card) ----
	mcpSectionTitle: string;
	mcpSubtitle: string;
	mcpProviderLabel: string;
	mcpProviderReady: string;
	mcpProviderNotReady: string;
	mcpKeyLabel: string;
	mcpKeyReady: string;
	mcpKeyMissing: string;
	mcpHostLabel: string;
	mcpHostUnrecognised: string;
	mcpCommandLabel: string;
	mcpRefreshBtn: string;
	// ---- Claude Code (JSONL log ingest) ----
	claudeCodeSectionTitle: string;
	claudeCodeSubtitle: string;
	claudeCodeEmpty: string;
	claudeCodeDisabled: string;
	claudeCodeErrorBanner: string;
	claudeCodeLastSync: string;
	claudeCodeRecheckBtn: string;
	claudeCodeOpenFolderBtn: string;
	claudeCodeOpenSettingsBtn: string;
	claudeCodeLogPath: string;
	claudeCodeFilesTracked: string;
	claudeCodeParseErrors: string;
	claudeCodeSkippedModels: string;
	claudeCodeNeverSynced: string;
	claudeCodeNoData: string;
	// ---- Tab bar ----
	/** Tabs without a backing data source are hidden entirely; only the
	 *  labels for the always-on "总" tab and any visible source tabs are
	 *  rendered. Labels stay lowercase English for product names in both
	 *  locales to match the source identifiers. */
	tabsTotal: string;
	tabsCopilot: string;
	tabsClaude: string;
}

const en: DashboardMessages = {
	pageTitle: 'MiniMax Usage Dashboard',
	subtitle: 'Today, last 7 days, and last 30 days — sourced from your local token accounting and the MiniMax platform.',
	refresh: 'Refresh',
	close: 'Close',
	reset: 'Reset counters',
	resetConfirm: 'Reset all locally recorded token counters? This cannot be undone.',
	resetDone: 'Local token counters have been reset.',
	planSectionTitle: 'Token Plan (platform)',
	localSectionTitle: 'Local token usage',
	totalSectionTitle: 'Total token usage',
	copilotSectionTitle: 'Copilot Chat usage',
	perModelTitle: 'Per-model breakdown',
	dailyChartTitle: 'Last 30 days',
	noLocalData: 'No requests have been recorded yet. Send a message from Copilot Chat using a MiniMax model and the counters will fill in.',
	platformUnavailable: 'Token Plan data is unavailable right now. The local counters above are still accurate.',
	platformUnconfigured: 'Token Plan data is hidden because the API key is missing or invalid. Set a key from the command palette to enable it.',
	platformLoading: 'Loading Token Plan data... The local counters above are still available while we refresh.',
	fieldInput: 'Input',
	fieldOutput: 'Output',
	fieldCacheRead: 'Cache read',
	fieldCacheWrite: 'Cache write',
	fieldRequests: 'Requests',
	fieldTotal: 'Total',
	fieldUsed: 'Used',
	fieldRemaining: 'Remaining',
	fieldResetsIn: 'Resets in',
	fieldWeeklyReset: 'Resets in',
	fieldWeekly: 'Weekly',
	fieldExpiry: 'Subscription expires',
	fieldUnlisted: '—',
	fieldExpiryDays: (days) => {
		if (days < 0) return `expired ${Math.abs(days)}d ago`;
		if (days === 0) return 'expires today';
		return `${days} day${days === 1 ? '' : 's'} remaining`;
	},
	fieldStarted: 'Tracking since',
	fieldUpdated: 'Updated',
	windowToday: 'Today',
	window7d: 'Last 7 days',
	window30d: 'Last 30 days',
	platformModelHeader: 'Model',

	// mmx-cli
	mmxSectionTitle: 'mmx-cli (multimodal Token Plan)',
	mmxSubtitle:
		'Status of the official mmx CLI and its agent SKILL. The extension only reports these; the user (or their AI agent) drives the install themselves. The "Copy prompt" button puts the verbatim three-step prompt from the official docs on the clipboard.',
	mmxInstalled: 'Installed',
	mmxMissing: 'Not installed',
	mmxVersion: 'Version',
	mmxAuthLoggedIn: 'Logged in',
	mmxAuthLoggedOut: 'Not logged in',
	mmxAuthUnknown: 'Auth unknown',
	mmxSkillInstalled: 'Agent skill ready',
	mmxSkillMissing: 'Agent skill not installed',
	mmxCopyPromptBtn: 'Copy official install prompt',
	mmxRecheckBtn: 'Re-check',
	mmxAgentReady: 'Your agent can use mmx-cli capabilities (image / video / music / speech / vision / search).',
	mmxAgentNotReady: 'mmx-cli is installed but the agent skill is not — your agent can call mmx once the skill is in place.',
	mmxCommandLabel: 'CLI',
	mmxAuthLabel: 'mmx auth',
	mmxSkillLabel: 'agent skill',
	mmxInstallBtn: 'Install the CLI',
	mmxLoginBtn: 'Log in',
	mmxInstallSkillBtn: 'Install the agent skill',

	// MiniMax Web Search MCP — status card on the dashboard.
	mcpSectionTitle: 'MiniMax Web Search MCP (Agent Mode)',
	mcpSubtitle:
		'VS Code spawns uvx minimax-coding-plan-mcp on demand and injects the configured API key + host. Toggle web_search from the Configure Tools picker in Agent Mode.',
	mcpProviderLabel: 'MCP provider',
	mcpProviderReady: 'Registered',
	mcpProviderNotReady: 'Not registered',
	mcpKeyLabel: 'API key',
	mcpKeyReady: 'Configured',
	mcpKeyMissing: 'Missing',
	mcpHostLabel: 'API host',
	mcpHostUnrecognised: 'Unrecognised',
	mcpCommandLabel: 'Launch command',
	mcpRefreshBtn: 'Refresh MCP',

	// Claude Code
	claudeCodeSectionTitle: 'Claude Code usage',
	claudeCodeSubtitle: 'Tokens consumed by the Claude Code CLI and the Claude Code VSCode extension, parsed from their local JSONL session logs. Not from the MiniMax API.',
	claudeCodeEmpty: 'No Claude Code JSONL logs were found in the configured directory. Run the Claude Code CLI or the Claude Code VSCode extension to generate some, or check the path in Settings.',
	claudeCodeDisabled: 'Claude Code log ingestion is disabled in Settings. Enable "MiniMax › Dashboard › Include Claude Code" to track tokens from the Claude Code CLI and the Claude Code VSCode extension here.',
	claudeCodeErrorBanner: 'Claude Code log ingestion failed. The local counters above are still accurate.',
	claudeCodeLastSync: 'Last sync',
	claudeCodeRecheckBtn: 'Re-scan now',
	claudeCodeOpenFolderBtn: 'Open log folder',
	claudeCodeOpenSettingsBtn: 'Open Settings',
	claudeCodeLogPath: 'Log path',
	claudeCodeFilesTracked: 'Tracking {0} file(s)',
	claudeCodeParseErrors: '{0} unparseable line(s) skipped',
	claudeCodeSkippedModels: '{0} non-MiniMax line(s) skipped',
	claudeCodeNeverSynced: 'never',
	claudeCodeNoData: 'No Claude Code usage recorded yet.',

	// Tab bar
	tabsTotal: 'Total',
	tabsCopilot: 'copilot',
	tabsClaude: 'claude',
};

const zh: DashboardMessages = {
	pageTitle: 'MiniMax 用量面板',
	subtitle: '今日、近 7 日、近 30 日 —— 数据来自本地统计与 MiniMax 开放平台。',
	refresh: '刷新',
	close: '关闭',
	reset: '清空计数器',
	resetConfirm: '确定要清空本地累计的 token 计数器吗？此操作不可撤销。',
	resetDone: '本地 token 计数器已清空。',
	planSectionTitle: 'Token Plan（平台）',
	localSectionTitle: '本地 token 统计',
	totalSectionTitle: '总用量（所有来源）',
	copilotSectionTitle: 'Copilot Chat 用量',
	perModelTitle: '按模型拆分',
	dailyChartTitle: '近 30 日',
	noLocalData: '暂无请求记录。在 Copilot Chat 中选用 MiniMax 模型并发送消息，计数器会自动累计。',
	platformUnavailable: 'Token Plan 数据暂时无法获取。上面的本地统计仍然准确。',
	platformUnconfigured: 'Token Plan 数据未显示：API Key 未配置或无效。请在命令面板中设置 Key。',
	platformLoading: '正在加载 Token Plan 数据... 本地统计仍然可用。',
	fieldInput: '输入',
	fieldOutput: '输出',
	fieldCacheRead: '缓存读取',
	fieldCacheWrite: '缓存写入',
	fieldRequests: '请求数',
	fieldTotal: '合计',
	fieldUsed: '已用',
	fieldRemaining: '剩余',
	fieldResetsIn: '距下次重置',
	fieldWeeklyReset: '距下次重置',
	fieldWeekly: '周额度',
	fieldExpiry: '套餐到期',
	fieldUnlisted: '—',
	fieldExpiryDays: (days) => {
		if (days < 0) return `已过期 ${Math.abs(days)} 天`;
		if (days === 0) return '今天到期';
		return `还剩 ${days} 天`;
	},
	fieldStarted: '开始追踪',
	fieldUpdated: '更新时间',
	windowToday: '今日',
	window7d: '近 7 日',
	window30d: '近 30 日',
	platformModelHeader: '模型',

	// mmx-cli
	mmxSectionTitle: 'mmx-cli（多模态 Token Plan）',
	mmxSubtitle:
		'官方 mmx CLI 和其 Agent SKILL 的状态。本扩展只负责显示状态——安装操作由用户（或用户的 AI Agent）自己完成。点击"复制官方安装指令"即可把官方文档原版三步指令复制到剪贴板。',
	mmxInstalled: '已安装',
	mmxMissing: '未安装',
	mmxVersion: '版本',
	mmxAuthLoggedIn: '已登录',
	mmxAuthLoggedOut: '未登录',
	mmxAuthUnknown: '登录状态未知',
	mmxSkillInstalled: 'Agent skill 已就绪',
	mmxSkillMissing: 'Agent skill 未安装',
	mmxCopyPromptBtn: '复制官方安装指令',
	mmxRecheckBtn: '重新检测',
	mmxAgentReady: '你的 Agent 已可使用 mmx-cli 的多模态能力（图、视频、音乐、语音、视觉、搜索）。',
	mmxAgentNotReady: 'mmx-cli 已装但 Agent skill 还没装——装好之后 Agent 就能直接调用 mmx。',
	mmxCommandLabel: '命令行',
	mmxAuthLabel: 'mmx 登录',
	mmxSkillLabel: 'Agent skill',
	mmxInstallBtn: '安装命令行',
	mmxLoginBtn: '登录',
	mmxInstallSkillBtn: '安装 Agent skill',

	// MiniMax Web Search MCP —— 用量看板上的状态卡片
	mcpSectionTitle: 'MiniMax Web Search MCP（Agent Mode）',
	mcpSubtitle:
		'由 VS Code 启动 uvx minimax-coding-plan-mcp，并把已配置的 API Key / host 注入子进程环境。在 Agent Mode 的 Configure Tools 中勾选 web_search 即可使用。',
	mcpProviderLabel: 'MCP provider',
	mcpProviderReady: '已注册',
	mcpProviderNotReady: '未注册',
	mcpKeyLabel: 'API Key',
	mcpKeyReady: '已配置',
	mcpKeyMissing: '未配置',
	mcpHostLabel: 'API host',
	mcpHostUnrecognised: '未识别',
	mcpCommandLabel: '启动命令',
	mcpRefreshBtn: '刷新 MCP',

	// Claude Code
	claudeCodeSectionTitle: 'Claude Code 用量',
	claudeCodeSubtitle: '来自 Claude Code CLI 与 Claude Code VSCode 扩展的 token 用量，解析自它们本地的 JSONL 会话日志，并非来自 MiniMax API。',
	claudeCodeEmpty: '在配置的目录中没有找到 Claude Code JSONL 日志。请运行 Claude Code CLI 或 Claude Code VSCode 扩展产生一些会话，或在设置中检查日志路径。',
	claudeCodeDisabled: 'Claude Code 日志读取在设置中已关闭。请在「MiniMax › 用量看板 › 包含 Claude Code」中启用，即可在此处跟踪 Claude Code CLI 与 Claude Code VSCode 扩展产生的 token 用量。',
	claudeCodeErrorBanner: 'Claude Code 日志解析失败。上面的本地统计仍然准确。',
	claudeCodeLastSync: '最近同步',
	claudeCodeRecheckBtn: '立即重新扫描',
	claudeCodeOpenFolderBtn: '打开日志目录',
	claudeCodeOpenSettingsBtn: '打开设置',
	claudeCodeLogPath: '日志路径',
	claudeCodeFilesTracked: '正在追踪 {0} 个文件',
	claudeCodeParseErrors: '已跳过 {0} 行无法解析的内容',
	claudeCodeSkippedModels: '已跳过 {0} 行非 MiniMax 模型',
	claudeCodeNeverSynced: '尚未同步',
	claudeCodeNoData: '暂无 Claude Code 用量记录。',

	// Tab bar — 产品名保留英文小写，与截图和 source 标识符一致
	tabsTotal: '总',
	tabsCopilot: 'copilot',
	tabsClaude: 'claude',
};

const dictionaries: Record<DashboardLocale, DashboardMessages> = { en, zh };

export function pickDashboardLocale(value: string | undefined): DashboardLocale {
	if (!value) {
		return 'en';
	}
	const lower = value.toLowerCase();
	if (lower === 'zh-cn' || lower === 'zh' || lower.startsWith('zh-')) {
		return 'zh';
	}
	return 'en';
}

export function dashboardMessages(locale: DashboardLocale): DashboardMessages {
	return dictionaries[locale];
}

export const DASHBOARD_LOCALE_CHANGE = 'minimax.dashboard.locale';
