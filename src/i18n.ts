import * as vscode from 'vscode';

/**
 * Lightweight i18n module — zero dependencies, follows VS Code display language.
 *
 *  - en / en-US / en-*      → English (default)
 *  - zh-cn                  → Simplified Chinese
 *  - all other locales      → English until translated
 */

function isZh(): boolean {
	const lang = vscode.env.language.toLowerCase();
	return lang === 'zh-cn' || lang === 'zh';
}

// ---- Translation dictionaries ----

type Translations = Record<string, string>;

const zh: Translations = {
	// Model descriptions
	'model.M3.detail': '原生多模态、1M 上下文 Frontier Coding 模型',
	'model.M2.7.detail': '开启模型的自我迭代（输出速度约 60 TPS）',
	'model.M2.7-highspeed.detail': 'M2.7 极速版：效果不变，更快更敏捷（输出速度约 100 TPS）',
	// Thinking mode — dropdown labels (rendered in Copilot Chat model picker)
	'thinking.on': '开启',
	'thinking.off': '关闭',
	'thinking.on.desc': '模型输出 typed thinking 推理轨迹（默认）。temperature 强制为 1、禁 top_p。',
	'thinking.off.desc': '关闭 typed thinking 内容块（仅 M3 受控）。temperature / topP 可用用户设置的采样值。',

	// M3 1M context — toggle / warning copy
	'm31m.toggledOn': 'M3 上下文已开启至 1M（`minimax.enableM31MContext = true`）——超过 512K 的请求按 2 倍费率计费。',
	'm31m.toggledOff': 'M3 上下文已恢复为安全默认值 512K（`minimax.enableM31MContext = false`）。',
	'm31m.warning.title': '开启 M3 1M 上下文窗口',
	'm31m.warning.body':
		'将把模型选择器中 **MiniMax-M3** 的上下文窗口从安全默认值 512K 抬升至官方规格 1,000,000。\n\n请确认以下条件均已满足：\n• 你的 MiniMax 账号已通过销售开通了 **>512K 输入层**——未开通时 API 会直接返回 HTTP 400。\n• 你清楚 >512K 部分按 **2 倍费率** 计费（官方定价页 ¥4.20/M 输入、¥16.80/M 输出，是 512K 以内档位的两倍）。\n• Token Plan 套餐内额度也按 2 倍价格扣减。\n\n若不确定，可以先保持关闭；后续随时可调。',
	'm31m.warning.confirm': '我已了解，启用 1M',
	'm31m.warning.cancel': '取消',
	'm31m.error.alreadyOn': 'M3 已经处于 1M 上下文模式。',
	'm31m.error.alreadyOff': 'M3 已经处于默认 512K 上下文模式。',

	// API Key
	'auth.apiKeyRequiredDetail': '请先配置 API Key',
	'auth.prompt': '请输入 MiniMax Token Plan API Key（从 platform.minimaxi.com 获取）。',
	'auth.placeholder': 'eyJ... 或 sk-...',
	'auth.emptyValidation': 'API Key 不能为空',
	'auth.saved': 'API Key 已安全保存。',
	'auth.removed': 'API Key 已移除。',
	'auth.notConfigured': 'API Key 未配置，请在命令面板运行 "MiniMax: 设置 API Key"。',

	// Vision
	'vision.vendorLabel': '提供商：{0}',
	'vision.noModel': '当前环境中没有可用的非 MiniMax 视觉代理模型。',
	'vision.pickPlaceholder': '选择用于描述图片的模型',
	'vision.current': '当前',
	'vision.proxyUsing': '视觉代理：{0}',
	'vision.notFound': '未找到视觉模型 "{0}"',
	'vision.unavailable': '无可用视觉模型，图片已忽略。',
	'vision.proxyError': '视觉代理异常：',

	// Request
	'request.toolsLimitExceeded':
		'MiniMax 单次 tools 请求最多支持 {0} 个 functions，当前请求包含 {1} 个。请先用 VS Code 的 Configure Tools 关闭不常用的工具。',
	'request.preflightRoundLimitExceeded':
		'实验性稳定工具列表设置已尝试 {0} 轮，仍无法得到稳定的已启用工具列表。请关闭该实验性设置，或先用 VS Code 的 Configure Tools 关闭不常用的工具。',
	'request.bodyTooLarge':
		'估算请求体 {0} MB，已超过 {1} 官方上限 {2} MB。请减小附件 / 上下文长度；大视频可走 Files API 上传后用 mm_file:// 引用。',
	'request.imageTooLarge':
		'附件图片约 {0} MB，超过 Anthropic 兼容接口单图内联上限 {1} MB。请压缩图片或改为外链。',
	'request.videoTooLarge':
		'附件视频约 {0} MB，超过 Anthropic 兼容接口单视频内联上限 {1} MB。请压缩视频，或先用 Files API 上传 (mm_file://) 后再用引用形式。',
	'notice.toolDrift':
		'⚠️ 工具列表不稳定，缓存命中率可能下降。',

	// Errors
	'error.http.400': '[{0}] 请求体格式错误。请根据错误信息提示修改请求体。',
	'error.http.401': '[{0}] API Key 被拒绝。请确认 Key 与当前配置的端点（{1}）匹配，且未被吊销。',
	'error.http.402': '[{0}] 当前端点余额不足。若使用 Token Plan Key，请确认 Key 是在当前配置端点（{1}）下签发的。',
	'error.http.upstreamSuffix': '上游：{0}',
	'error.http.403': '[{0}] 权限被拒绝。请检查 API Key 的权限范围。',
	'error.http.408': '[{0}] 请求超时。请稍后重试。',
	'error.http.413': '[{0}] 请求体过大。请减小 max_tokens / 上下文长度后重试。',
	'error.http.422': '[{0}] 请求体参数错误。请根据错误信息提示修改相关参数。',
	'error.http.429': '[{0}] 请求速率达到上限。请合理规划您的请求速率。',
	'error.http.500': '[{0}] 服务器内部故障。请等待后重试。',
	'error.http.503': '[{0}] 服务器负载过高。请稍后重试您的请求。',
	'error.http.529': '[{0}] 上游服务过载（Anthropic overload）。请稍后重试。',
	'error.http.generic': '[{0}] 服务返回错误响应。',
	'error.action.setApiKey': '设置 API Key',
	'error.action.createApiKey': '创建 API Key',
	'error.action.viewDetails': '错误详情',
	'error.network.dns': '[{0}] DNS 解析失败。请检查网络连接、防火墙或代理设置，以及自定义 baseUrl。',
	'error.network.unreachable':
		'[{0}] 目标不可达或拒绝连接。请检查自定义 baseUrl、代理服务、网络连接或防火墙设置。',
	'error.network.interrupted': '[{0}] 连接被中断。请检查网络连接、防火墙或代理设置，或稍后重试。',
	'error.network.timeout': '[{0}] 连接超时。请稍后重试，或检查网络连接、防火墙或代理设置。',
	'error.network.tls': '[{0}] TLS/证书校验失败。请检查代理、证书配置或自定义 baseUrl。',
	'error.network.aborted': '[{0}] 请求已中止。如果不是主动取消，请检查网络连接或代理设置。',
	'error.network.protocol': '[{0}] HTTP 连接或响应解析失败。请检查代理设置或自定义 baseUrl。',
	'error.network.configuration': '[{0}] 请求配置无效。请检查自定义 baseUrl 或扩展设置。',
	'error.network.generic': '[{0}] 网络请求失败。请检查网络连接、防火墙或代理设置。',
	'error.unknown': 'MiniMax 请求失败：{0}',

	// Pricing (per million tokens, ¥)
	'pricing.title': 'MiniMax 模型价格（每百万 token，人民币）',
	'pricing.header.model': '模型',
	'pricing.header.input': '输入',
	'pricing.header.output': '输出',
	'pricing.header.cacheRead': '缓存读取',
	'pricing.header.cacheWrite': '缓存写入',
	'pricing.unlisted': '见官方',
	'pricing.note': '价格取自 platform.minimaxi.com/docs/guides/pricing-paygo。Token Plan 订阅另计。',
	'pricing.providers': '使用 Anthropic 兼容协议 ({0})，通过 {1} 接入。',

	// Extension
	'extension.activateFailed': 'MiniMax 激活失败，请运行 "MiniMax: 显示日志" 查看详情。',
	'extension.deactivateFailed': 'MiniMax 停用异常',
	'extension.welcomeFailed': '欢迎引导加载异常',
	'extension.openRequestDumpsFolderFailed': '打开请求 dump 目录失败，请运行 "MiniMax: 显示日志" 查看详情。',

	// Commit message generator
	'commit.noApiKey': '生成提交信息前请先配置 API Key。',
	'commit.gitUnavailable': 'VS Code 内置 Git 扩展不可用或被禁用。请在扩展侧边栏启用内置 Git，或检查 `git.enabled` 是否为 true。',
	'commit.noRepository': '当前工作区没有可用的 Git 仓库。',
	'commit.noChanges': '暂存区与工作区都没有改动，无需生成提交信息。',
	'commit.modelUnknown': 'commitModel 配置项指向了未注册的模型 "{0}"，请在设置里改成 M3、M2.7 或 M2.7-highspeed。',
	'commit.generating': '正在用 {0} 生成提交信息。',
	'commit.progressReading': '读取暂存区改动。',
	'commit.emptyResult': '模型没有返回任何内容，请重试。',
	'commit.pickModelTitle': '选择用于生成提交信息的模型。',
	'commit.pickModelPlaceholder': '请选择模型（默认：{0}）',
	'commit.modelDefault': '默认',
	'commit.modelLastUsed': '最近使用',

	// Usage / status
	'usage.title': 'MiniMax 用量统计',
	'usage.empty': '暂未产生任何请求。打开 Copilot Chat，选用一个 MiniMax 模型并发送消息即可。',
	'usage.line.total': '总输入 {0} · 总输出 {1} · 请求数 {2}',
	'usage.line.cache': '缓存读取 {0} · 缓存写入 {1}',
	'usage.line.startedAt': '开始时间：{0}',
	'usage.line.updatedAt': '更新时间：{0}',
	'usage.line.model': '· {0}：输入 {1} / 输出 {2} / 请求 {3}',
	'usage.resetDone': '已清空用量统计。',
	'usage.modelEmpty': '暂无模型分项用量。',
	'status.title': 'MiniMax 状态',
	'status.active': '扩展已激活：{0}（{1}）',
	'status.thinking': '思考模式',
	'status.inactive': '扩展已停用。',
	'status.apiKeySet': 'API Key 已配置。',
	'status.apiKeyMissing': '未配置 API Key。运行 "MiniMax: Set API Key"。',
	'status.visibleModels': '可见模型 {0} 个。',
	'status.lastUsage': '最近一次请求输入 {0} token、输出 {1} token。',
	'status.usageEmpty': '尚未发起任何请求。',

	// mmx-cli — the extension only copies the official install
	// prompt to the clipboard. The user decides what to do next.
	'mmx.promptCopied': '官方安装指令已复制到剪贴板。',
	'mmx.copyFailed': '写入剪贴板失败。',

	// Claude Code (JSONL log ingest)
	'claudeCode.folderMissing': '找不到 Claude Code 日志目录：{0}',
	'claudeCode.showUsageEmpty': '暂无 Claude Code 用量记录。请运行 Claude Code CLI 或 Claude Code VSCode 扩展产生一些会话。',
};

const en: Translations = {
	// Model descriptions
	'model.M3.detail': 'Native multimodal, 1M context frontier coding model',
	'model.M2.7.detail': 'Self-iterating model (~60 TPS)',
	'model.M2.7-highspeed.detail': 'M2.7 high-speed: same quality, faster',
	// Thinking mode — toggle / status labels
	'thinking.on': 'On',
	'thinking.off': 'Off',
	'thinking.on.desc':
		'Model emits a typed thinking block (default). Forces temperature=1, drops top_p per Anthropic constraint.',
	'thinking.off.desc':
		'Turns off the typed thinking block (M3 only — M2.x ignores this). User sampling temperature/topP take effect.',

	// M3 1M context — toggle / warning copy
	'm31m.toggledOn': 'M3 context window lifted to 1M (`minimax.enableM31MContext = true`) — requests above 512K are billed at 2× the per-token rate.',
	'm31m.toggledOff': 'M3 context window restored to the safe 512K default (`minimax.enableM31MContext = false`).',
	'm31m.warning.title': 'Lift MiniMax-M3 context window to 1M',
	'm31m.warning.body':
		'This raises the **MiniMax-M3** entry in the model picker from the safe 512K default up to the official 1,000,000-token cap.\n\nMake sure all of the following apply:\n• Your MiniMax account has been granted the **>512K input tier** by sales — without it the upstream API will return HTTP 400 for requests above 512K.\n• You understand that the >512K portion is billed at **2× the per-token rate** (see the [pricing page](https://platform.minimaxi.com/docs/guides/pricing-paygo)).\n• Token Plan quota also deducts at the 2× rate.\n\nIf unsure, leave it off — you can flip it on later at any time.',
	'm31m.warning.confirm': 'I understand, enable 1M',
	'm31m.warning.cancel': 'Cancel',
	'm31m.error.alreadyOn': 'M3 is already in 1M context mode.',
	'm31m.error.alreadyOff': 'M3 is already in the default 512K context mode.',

	// API Key
	'auth.apiKeyRequiredDetail': 'Set an API key first',
	'auth.prompt': 'Enter your MiniMax Token Plan API key (from platform.minimax.io).',
	'auth.placeholder': 'eyJ... or sk-...',
	'auth.emptyValidation': 'API key cannot be empty',
	'auth.saved': 'API key saved securely.',
	'auth.removed': 'API key removed.',
	'auth.notConfigured':
		'API key not configured. Run "MiniMax: Set API Key" from the command palette.',


	// Vision
	'vision.vendorLabel': 'Vendor: {0}',
	'vision.noModel': 'No non-MiniMax vision proxy model is available.',
	'vision.pickPlaceholder': 'Choose a model to describe images',
	'vision.current': 'current',
	'vision.proxyUsing': 'Vision proxy: {0}',
	'vision.notFound': 'Vision model "{0}" not found',
	'vision.unavailable': 'No vision model available, images ignored.',
	'vision.proxyError': 'Vision proxy error:',

	// Request
	'request.toolsLimitExceeded':
		'MiniMax supports at most {0} functions per tools request, but {1} were provided. Disable unused tools via VS Code Configure Tools.',
	'request.preflightRoundLimitExceeded':
		'The experimental stabilize-tool-list setting has hit the {0}-round limit without a stable enabled tool list. Disable the experimental setting or trim tools via VS Code Configure Tools.',
	'request.bodyTooLarge':
		'Estimated request body is {0} MB, over the {2} MB limit for {1}. Trim attachments / context, or upload large videos via the Files API and reference them as mm_file://.',
	'request.imageTooLarge':
		'Attached image is ~{0} MB, over the {1} MB inline image cap on the Anthropic-compatible endpoint. Compress the image or upload it as a URL.',
	'request.videoTooLarge':
		'Attached video is ~{0} MB, over the {1} MB inline video cap on the Anthropic-compatible endpoint. Compress the video or upload it via the Files API (mm_file://) and reference it that way.',
	'notice.toolDrift':
		'⚠️ Tool list is unstable, cache hit rate may drop.',

	// Errors
	'error.http.400': '[{0}] Bad request. Please review the error message and adjust the request body.',
	'error.http.401': '[{0}] API key rejected. Confirm the key matches the configured endpoint ({1}) and has not been revoked.',
	'error.http.402': '[{0}] Insufficient balance on this surface. If you are using a Token Plan key, confirm it was issued for the configured endpoint ({1}).',
	'error.http.upstreamSuffix': 'Upstream: {0}',
	'error.http.403': '[{0}] Permission denied. Please check the API key scope.',
	'error.http.408': '[{0}] Request timeout. Please retry later.',
	'error.http.413': '[{0}] Request payload too large. Reduce max_tokens / context size and retry.',
	'error.http.422': '[{0}] Request parameter error. Please adjust the relevant parameters.',
	'error.http.429': '[{0}] Rate limit reached. Please slow down your request rate.',
	'error.http.500': '[{0}] Internal server error. Please retry later.',
	'error.http.503': '[{0}] Server overloaded. Please retry later.',
	'error.http.529': '[{0}] Upstream overloaded (Anthropic overload). Please retry later.',
	'error.http.generic': '[{0}] Service returned an error response.',
	'error.action.setApiKey': 'Set API Key',
	'error.action.createApiKey': 'Create API Key',
	'error.action.viewDetails': 'View error details',
	'error.network.dns': '[{0}] DNS resolution failed. Check network, firewall, proxy, and custom baseUrl.',
	'error.network.unreachable':
		'[{0}] Host unreachable or refused connection. Check custom baseUrl, proxy, and network.',
	'error.network.interrupted': '[{0}] Connection interrupted. Check network, firewall, proxy, or retry later.',
	'error.network.timeout': '[{0}] Connection timed out. Check network, firewall, proxy, or retry later.',
	'error.network.tls': '[{0}] TLS/certificate validation failed. Check proxy and certificate settings.',
	'error.network.aborted': '[{0}] Request aborted. If not intentional, check network or proxy settings.',
	'error.network.protocol': '[{0}] HTTP connection or response parsing failed. Check proxy and custom baseUrl.',
	'error.network.configuration': '[{0}] Invalid request configuration. Check custom baseUrl or extension settings.',
	'error.network.generic': '[{0}] Network request failed. Check network, firewall, and proxy settings.',
	'error.unknown': 'MiniMax request failed: {0}',

	// Pricing (per million tokens, currency follows the user's apiBaseUrl)
	'pricing.title': 'MiniMax model pricing (per million tokens, USD)',
	'pricing.header.model': 'Model',
	'pricing.header.input': 'Input',
	'pricing.header.output': 'Output',
	'pricing.header.cacheRead': 'Cache read',
	'pricing.header.cacheWrite': 'Cache write',
	'pricing.unlisted': 'see official',
	'pricing.note':
		'Prices scraped from platform.minimax.io/docs/guides/pricing-paygo. Token Plan subscription is billed separately.',
	'pricing.providers': 'Uses the Anthropic-compatible protocol ({0}) via {1}.',

	// Extension
	'extension.activateFailed': 'MiniMax activation failed. Run "MiniMax: Show Logs" for details.',
	'extension.deactivateFailed': 'MiniMax deactivation failed',
	'extension.welcomeFailed': 'Welcome flow failed to load',
	'extension.openRequestDumpsFolderFailed': 'Failed to open request dumps folder. Run "MiniMax: Show Logs" for details.',

	// Commit message generator
	'commit.noApiKey': 'Configure an API key before generating commit messages.',
	'commit.gitUnavailable': 'VS Code built-in Git extension is unavailable or disabled. Enable the built-in Git extension in the Extensions view or set `git.enabled` to true.',
	'commit.noRepository': 'No Git repository is open in the current workspace.',
	'commit.noChanges': 'No staged or working-tree changes — nothing to commit.',
	'commit.modelUnknown': 'commitModel points to an unregistered model "{0}". Use M3, M2.7, or M2.7-highspeed in settings.',
	'commit.generating': 'Generating commit message with {0}…',
	'commit.progressReading': 'Reading staged changes…',
	'commit.emptyResult': 'The model returned an empty result. Please try again.',
	'commit.pickModelTitle': 'Generate commit message with…',
	'commit.pickModelPlaceholder': 'Pick a model (default: {0})',
	'commit.modelDefault': 'Default',
	'commit.modelLastUsed': 'Last used',

	// Usage / status
	'usage.title': 'MiniMax usage',
	'usage.empty': 'No requests have been made yet. Open Copilot Chat, pick a MiniMax model, and send a message.',
	'usage.line.total': 'Total input {0} · output {1} · requests {2}',
	'usage.line.cache': 'Cache read {0} · cache write {1}',
	'usage.line.startedAt': 'Since: {0}',
	'usage.line.updatedAt': 'Updated: {0}',
	'usage.line.model': '· {0}: input {1} / output {2} / requests {3}',
	'usage.resetDone': 'Usage statistics have been reset.',
	'usage.modelEmpty': 'No per-model usage recorded yet.',
	'status.title': 'MiniMax status',
	'status.active': 'Extension active: {0} ({1})',
	'status.thinking': 'Thinking Mode',
	'status.inactive': 'Extension is deactivated.',
	'status.apiKeySet': 'API key configured.',
	'status.apiKeyMissing': 'No API key. Run "MiniMax: Set API Key".',
	'status.visibleModels': '{0} models exposed in the picker.',
	'status.lastUsage': 'Last request used input {0} tokens, output {1} tokens.',
	'status.usageEmpty': 'No requests have been made yet.',

	// mmx-cli — the extension only copies the official install
	// prompt to the clipboard. The user decides what to do next.
	'mmx.promptCopied': 'Official install prompt copied to clipboard.',
	'mmx.copyFailed': 'Could not write to clipboard.',

	// Claude Code (JSONL log ingest)
	'claudeCode.folderMissing': 'Could not find the Claude Code log directory: {0}',
	'claudeCode.showUsageEmpty': 'No Claude Code usage recorded yet. Run the Claude Code CLI or the Claude Code VSCode extension to generate some sessions.',
};

const dictionaries: Record<'en' | 'zh', Translations> = { en, zh };

/**
 * Translate a key to the current display language.
 * Falls back to the key itself when no translation is available, so missing
 * entries are obvious in the UI instead of silently returning blanks.
 */
export function t(key: string, ...args: unknown[]): string {
	const dict = dictionaries[isZh() ? 'zh' : 'en'];
	const template = dict[key] ?? key;
	return formatTemplate(template, args);
}

function formatTemplate(template: string, args: unknown[]): string {
	if (args.length === 0) {
		return template;
	}
	return template.replace(/\{(\d+)\}/g, (_match, index: string) => {
		const value = args[Number(index)];
		return value === undefined ? '' : String(value);
	});
}
