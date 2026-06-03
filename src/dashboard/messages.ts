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
