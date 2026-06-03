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
	perModelTitle: string;
	dailyChartTitle: string;
	noLocalData: string;
	platformUnavailable: string;
	platformUnconfigured: string;
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
	// ---- mmx-cli ----
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
	mmxInstallBtn: string;
	mmxOpenChatBtn: string;
	mmxLoginBtn: string;
	mmxInstallSkillBtn: string;
	mmxRecheckBtn: string;
	mmxAgentReady: string;
	mmxAgentNotReady: string;
	mmxCommandLabel: string;
	mmxViewDocs: string;
	mmxStep1Hint: string;
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
	perModelTitle: 'Per-model breakdown',
	dailyChartTitle: 'Last 30 days',
	noLocalData: 'No requests have been recorded yet. Send a message from Copilot Chat using a MiniMax model and the counters will fill in.',
	platformUnavailable: 'Token Plan data is unavailable right now. The local counters above are still accurate.',
	platformUnconfigured: 'Token Plan data is hidden because the API key is missing or invalid. Set a key from the command palette to enable it.',
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
		'Optional companion CLI that gives your agent full multimodal capabilities: image, video, music, speech, vision, and web search — all billed against the same Token Plan API key.',
	mmxInstalled: 'Installed',
	mmxMissing: 'Not installed',
	mmxVersion: 'Version',
	mmxAuthLoggedIn: 'Logged in',
	mmxAuthLoggedOut: 'Not logged in',
	mmxAuthUnknown: 'Auth unknown',
	mmxSkillInstalled: 'Agent skill ready',
	mmxSkillMissing: 'Agent skill not installed',
	mmxInstallBtn: 'Install mmx-cli',
	mmxOpenChatBtn: 'Open install prompt in Copilot',
	mmxLoginBtn: 'Login with API key',
	mmxInstallSkillBtn: 'Install agent skill',
	mmxRecheckBtn: 'Re-check',
	mmxAgentReady: 'Your agent can use mmx-cli capabilities (image / video / music / speech / vision / search).',
	mmxAgentNotReady: 'Finish the steps below to enable multimodal capabilities for your agent.',
	mmxCommandLabel: 'CLI',
	mmxViewDocs: 'Docs',
	mmxStep1Hint: 'We delegate this step to your AI agent — agents have richer package-manager access than an extension does. Click the button to copy the official prompt and open a new Copilot chat.',
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
	perModelTitle: '按模型拆分',
	dailyChartTitle: '近 30 日',
	noLocalData: '暂无请求记录。在 Copilot Chat 中选用 MiniMax 模型并发送消息，计数器会自动累计。',
	platformUnavailable: 'Token Plan 数据暂时无法获取。上面的本地统计仍然准确。',
	platformUnconfigured: 'Token Plan 数据未显示：API Key 未配置或无效。请在命令面板中设置 Key。',
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
		'可选的官方命令行工具，让你的 Agent 直接使用图像、视频、音乐、语音、视觉理解与网络检索等全部多模态能力——共用同一个 Token Plan API Key。',
	mmxInstalled: '已安装',
	mmxMissing: '未安装',
	mmxVersion: '版本',
	mmxAuthLoggedIn: '已登录',
	mmxAuthLoggedOut: '未登录',
	mmxAuthUnknown: '登录状态未知',
	mmxSkillInstalled: 'Agent skill 已就绪',
	mmxSkillMissing: 'Agent skill 未安装',
	mmxInstallBtn: '安装 mmx-cli',
	mmxOpenChatBtn: '在 Copilot 中打开安装指令',
	mmxLoginBtn: '使用 API Key 登录',
	mmxInstallSkillBtn: '安装 Agent skill',
	mmxRecheckBtn: '重新检测',
	mmxAgentReady: '你的 Agent 已可使用 mmx-cli 的多模态能力（图、视频、音乐、语音、视觉、搜索）。',
	mmxAgentNotReady: '完成下方步骤后，Agent 即可调用多模态能力。',
	mmxCommandLabel: '命令行',
	mmxViewDocs: '官方文档',
	mmxStep1Hint: '我们把这步交给你的 AI Agent——它拥有比扩展更完整的包管理器访问能力。点击按钮即可复制官方指令，并打开一个新的 Copilot chat。',
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
