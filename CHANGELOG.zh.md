# 更新日志

> 英文版见 [CHANGELOG.md](./CHANGELOG.md)。

## 2.3.0 — 砍掉自研 commit 流水线，改走 Copilot 工具模型路由

> **注意：** 本版删除了一个原本公开的命令和设置。
> 之前给 `MiniMax: Generate Commit Message` 绑过快捷键、或在
> `settings.json` 里设过 `minimax.commitModel` 的用户，需要迁移到新路径。

### 移除

- **`MiniMax: Generate Commit Message` 命令和 `minimax.commitModel` 设置被删除。** 想用 MiniMax（或其它 provider）生成 commit message，在用户设置里写 `chat.utilitySmallModel: <vendor>/<id>`，或者跑新增的 **MiniMax: 设置 Copilot 工具模型** 命令——两段式 QuickPick 先选 model，再勾选要覆盖的 `chat.*` 设置（默认 `chat.utilitySmallModel` 对应 ✨ 按钮 family，可选 `chat.utilityModel` 对应标题/摘要 family）。新路径走 VS Code 内置的 ✨ 按钮（Source Control 标题栏），自动尊重 Copilot 的 `commitMessageGeneration.instructions` 和 `localeOverride`。
- `src/git/commitMessage.ts` 和 `src/git/scm.ts` 模块（以及它们的 `test/git.test.ts`）删除。`enabledApiProposals: contribSourceControlInputBoxMenu` 声明也删了——不再占用 input-box 菜单槽位。
- `commit.*` i18n 键从 12 个压缩到 1 个（`commit.setupComplete`）。

### 原因

VS Code 的 `ILanguageModelsService` 已经会把 `chat.utilitySmallModel` 路由到扩展注册的 provider（包括我们）——见 [utilityModelContribution 源码](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/chat/browser/utilityModelContribution.ts)。我们另开炉灶的 commit pipeline 是重复造轮子，且和 Copilot UX 越来越割裂。新路径反而更强：自动支持 `github.copilot.chat.commitMessageGeneration.instructions`（项目级格式）、`github.copilot.chat.localeOverride`（输出语言）、`.github/commit-message-instructions.md`（团队规则文件），这些我们老 pipeline 一直没读。

### 修复

- **移除了四个与「用量面板」重复的命令（`Show Provider Status`、`Show Usage`、`Reset Usage`、`Show Pricing`）。** 价格表改为直接写在 README 中（CNY 和 USD 双表并排），不再通过 `Show Pricing` 命令即时渲染。移除 `src/i18n.ts` 中不再使用的 `status.*`、`usage.*`、`pricing.*` i18n key（保留仍在用的 `status.thinking`、`usage.resetDone`、`pricing.unlisted`）。 把 `package.nls.zh-cn.json` 改名为 `package.nls.zh.json`。VS Code 的 NLS 查找是按 `-` 从右往左逐段剥掉再匹配的，所以 `zh-Hans-CN`（Windows 10/11 报告的简体中文 BCP 47 标签）会沿着 `zh-hans-cn` → `zh-hans` → `zh` 一直试到底，因为找不到文件最终回退到英文 fallback——结果就是中文用户命令面板里看到的是英文。新名字在第二跳就落到 `zh` 段，所有中文 locale 变体（`zh-cn` / `zh-hans-cn` / `zh-hans` / `zh` …）都能命中。非中文 locale 的行为完全不变。
- **端点分类在所有代码路径上都不再被伪造。** `isChinaBaseUrl()`（`pickPricingTable()` 用来选 CNY 还是 USD 价表，也用于 Show Pricing 的国旗标记）和 `showPricing()` 里 inline 的 `baseUrl.includes('minimaxi.com')` 都是在原始 URL 上做子串匹配——这正是 LRN-20260611-005 标记的可伪造模式。如果有人把 `minimax.apiBaseUrl` 设成 `https://api.minimax.io@my-proxy.example.com/v1`，请求其实发到 proxy 主机，但代码会按"国际"分类。两个调用点都改成走加固过的 `resolvePlatformHost()`（用 `new URL().hostname` 严格相等）。401/402 按钮也顺便简化成共用新的 `resolvePlatformUrl()` / `displayPlatformUrl()` helper。对合法的 `api.minimaxi.com` / `api.minimax.io` URL 行为完全不变。
- **`auth.prompt` 和 `pricing.note` 不再把"对方平台"的链接发给"己方用户"。** 这两个字符串之前是**按 locale 锁定**的（`zh-cn` → `platform.minimaxi.com`，`en` → `platform.minimax.io`），结果是中文 locale 用户配国际端点时拿到 `platform.minimaxi.com`（没有账号登不上去），反之亦然。两个字符串都加 `{0}` 占位符，由 caller（`auth.ts:promptForApiKey`）根据 `minimax.apiBaseUrl` 通过 `displayPlatformUrl()` 解析后传入。第三方代理用户拿到的是自己配的原始 URL，不再是被硬编码到某一半的平台链接。
- **`minimax.maxTokens` 重命名为 `minimax.maxOutputTokens`** —— 之前的名字跟 `minimax.enableM31MContext`（控制**输入**上下文窗口，而不是输出上限）容易混。代码读新 key，旧 `minimax.maxTokens` 留作 deprecated fallback，老 `settings.json` 条目继续生效；旧 key 在 JSON schema 里加了 `deprecationMessage`，3.0 时彻底删除。

## 2.2.0 — README 重排、配置统一、用量看板接入 Claude Code JSONL

### 界面

- **用量看板改为页签形式。** 原来平铺堆叠的「MiniMax 用量面板」和「Claude Code 用量」两块，现在统一在 `<nav class="tabs" role="tablist">` 下，按 `总 / copilot / claude / codex / opencode` 顺序排列。**没有数据源的页签直接隐藏**，防止用户点进空白页签产生误解。当前激活的页签记到 webview state 里，刷新或关掉再开都会回到上次停留的位置。仅 `总` 有数据时不画页签栏，回退到原来的单 section 布局。
- **「总」页签改为所有来源的逐项求和。** 原先「本地 token 统计」改名为「copilot」页签，单独显示 Copilot Chat 的用量；「总」页签改读一个新增的 `view.total` 聚合字段，对 `copilot` + `claudeCode`（以及未来的 `codex` / `opencode`）做逐项求和，按模型按日期合并 `perModel` 与 `dailySeries`。只有单一来源时 `total === 该来源`（数值完全一致），所以单源场景视觉上没变化。
- **数字用 K / M / B 单位显示。** 之前饼图图例和按模型表里 `18,234,290 3.3%` 这种数字会撑爆一行，现在显示成 `18.23M 3.3%`。柱状图悬浮提示里的「按日总量」仍保留完整数字（`fmtFull`），那里的精度更有用。

### 文档

- 重排版 README 增强可读性：新增命令参考表、按模型分节、定价可视化、思考模式描述。
- 厘清 M3 上下文处理说明，重写"高级设置"入门文案，统一中英文命令名。

### 新增

- **用量看板：Claude Code JSONL 接入。** 用量看板现在和**本扩展自己的 token 统计**一起，**额外显示 Claude Code CLI 和 Claude Code VSCode 扩展**产生的 token 用量。之前这两个客户端的 API 请求直接打到服务端，绕过了本扩展的网络层，看板自然抓不到——这次给补上。
  - **后台轮询器读 `~/.claude/projects/**/*.jsonl`**，默认 30 秒扫一遍日志目录，解析每条 `type: "assistant"` 行的 `message.usage`，把每模型 / 每日 / 每月累计写进一个独立的 Memento store（新模块 `src/dashboard/claudeCodeIngest.ts`）。游标状态同样存进 memento——重启从上次字节继续，**绝不重读历史数据**。1000 项 uuid LRU 防止 Claude Code 写到一半时被重复计数。文件被截断 / 轮转时游标自动归零。
  - **用量看板新增「Claude Code 用量」section。** 紧挨在「本地 token 统计」卡片下方，左侧加了一道**强调色边**便于一眼区分。展示今日 / 近 7 日 / 近 30 日卡片、按模型拆分表、近 30 日柱状图、最近同步时间、解析后的日志路径、追踪的文件数、以及解析失败的行数。订阅 ingester 的 store，每次轮询拿到新数据就重新渲染。
  - **三个新设置（都在原 `minimax.*` 命名空间下）**：
    - `minimax.dashboard.includeClaudeCode`（boolean，默认 `true`）—— 总开关。关掉后，看板**保留 section**，显示「在设置中已关闭」的提示横幅加「打开设置」按钮。
    - `minimax.claudeCode.logPath`（string，默认 `~/.claude/projects`）—— Claude Code 写 JSONL 会话日志的根目录。支持 `~` 展开（POSIX 和 Windows 都生效）。
    - `minimax.claudeCode.pollIntervalMs`（integer，默认 `30000`，夹在 `[5000, 600000]` 之间）—— 扫描间隔。
  - **两个新命令：** `MiniMax: 重新扫描 Claude Code 日志` 和 `MiniMax: 打开 Claude Code 日志目录`。看板的 section 上也有一个「立即重新扫描」按钮，底层调用同一个 handler。
  - **`MiniMax: 查看用量` 命令扩展。** Markdown 报告底部现在多了一节清晰的「## Claude Code（独立数据源）」，包含今日合计、按模型拆分、以及解析后的日志路径。和本地 store 的数据**完全独立、视觉上分开**。
  - **独立生命周期。** Ingester 在 `runtime/lifecycle.ts` 的 provider 注册之后构造并启动。运行时改任意一个 Claude Code 设置都会把现有 ingester 拆掉、下一个 tick 重建，秒级生效。

### 迁移

- 新增的两个 Memento key（`minimax-vscode.claudeCodeUsageStats`、`minimax-vscode.claudeCodeIngestCursor`）都是**纯增量**的。原有的 `USAGE_STATS_KEY` 数据完全不受影响。
- **不需要数据回填**——首次运行时游标是空的，第一次轮询从字节 0 开始读全量。
- 卸载扩展后这两个新 key 是惰性的，会被 VS Code 定期回收。
- **`minimax.thinking.enabled` 设置和 `MiniMax: 切换 M3 思考模式` 命令被移除。** 思考开关现在是 **Copilot Chat 模型选择器**里 M3 的下拉菜单（per-model configuration），选中的值原样作为 `thinking: { type: "disabled" | "adaptive" }` 送到 Anthropic 兼容端点。从 2.1.9 升级上来的用户如果 `settings.json` 里还有 `minimax.thinking.enabled: false`，可以删掉那一行——2.2.0+ 已经完全不读这个 key 了。

### 修复

- `minimax.experimental.modelDefPresets` 的 `tools` 键现在真正与主工具列表合并（之前被保留键守卫静默忽略）。

## 2.1.9 — M3 原生视频输入 + 思考开关

对齐官方 [platform.minimaxi.com 文档](https://platform.minimaxi.com/docs/api-reference/text-anthropic-api)。

### 新增

- **M3 原生视频输入。** 对齐官方 MiniMax Anthropic 兼容 API 文档：M3 现在接受内联 `type: "video"` 内容块（MP4 / AVI / MOV / MKV），以及通过 Files API 上传后用 `mm_file://{file_id}` 引用。早期版本对视频附件会**静默丢弃**——和早期图片输入 bug 同一类病，现在一并修掉。convert 层对不支持的容器会打 warning 后丢弃；request 层加了 64 MB 整请求体预检，在 API 返回 413 之前用本地化错误拦下。
- **`minimax.thinking.enabled`（仅 M3 生效）+ 配套命令 `MiniMax: 切换 M3 思考模式`。** 官方文档只暴露二值开关 `thinking: { type: "disabled" | "adaptive" }`——没有「思考强度」「预算」「分步」一类旋钮可以转。本扩展通过两种方式提供开关：
  - `minimax.thinking.enabled` boolean 设置（默认 `true`）
  - 命令面板里的「切换 M3 思考模式」命令——一键翻转设置并弹本地化提示

  M2.x 永远 `adaptive`，因为官方说 `disabled` 对 M2 系列是 no-op，所以开关对 M2.7 / M2.7-highspeed 是 no-op。M3 把它关掉之后，`minimax.sampling` 里的 `temperature` / `topP` 终于能真正生效——`temperature=1`、禁 `top_p` 这条 Anthropic 约束只在 thinking 开启时生效。
  - **移除了 Copilot Chat 模型选择器里的每模型下拉菜单。** 早期版本照着 DeepSeek-for-Copilot 的样子用 `configurationSchema` 渲染下拉，但宿主每次重新渲染都会把 schema 的 `default` 重新应用：用户第一次点「关闭」被悄悄吞掉，第二次点就跳回「开启」。改成「设置 + 命令」组合后行为稳定。

### 测试

- `test/convertVideo.test.ts` 覆盖视频转换（base64 块、MOV 容器、不支持容器丢弃、M2.x 丢弃）和 thinking 开关（M2.x 永远 adaptive、M3 默认值 + 覆盖）。`test/helpers/vscodeMock.ts` 的 vscode mock 现在也导出 `LanguageModelChatMessageRole`，让 convert 层可以端到端跑测试。

## 2.1.8 — 修复：不再硬依赖 VS Code 内置 Git 扩展

- **移除对 `vscode.git` 的硬扩展依赖。** 现在即使内置 Git
  扩展加载失败——例如远端 UI 模式未装 `git`、`git.enabled`
  被关闭，或 Git 扩展自身无法 activate——本扩展也能正常
  激活。修复 [#1](https://github.com/klarkxy/minimax-vscode/issues/1)。
- **主体功能完全不受影响。** 语言模型 provider、Copilot chat、
  面板、视觉、工具调用、mmx-cli 这些模块本来就与 Git 无关。
- **`Generate Commit Message` 在 Git 不可用时优雅降级。**
  `getGitApi()` 在那种场景下原本就会返回 `undefined`，本命令
  捕获后弹中英文的 `commit.gitUnavailable` 提示并退出——
  不会崩溃。SCM 输入框菜单项也用 `when: scmProvider == git`
  守卫了，没 Git provider 时自动灰显。

## 2.1.7 — mmx-cli 状态持久化、面板秒开、auth 检测更准

- **mmx-cli 状态现在跨 VS Code 重启保留。** 新增 `MmxCliCache`
  （Memento 持久化，shape 与现有的 `PlanCache` 对齐）保存最近一次
  探测结果。面板打开的第一帧直接渲染缓存状态，后台异步重探——
  重启后不再看到"未知 → 变绿"的闪烁。
- **面板不再被平台请求阻塞。** `refresh()` 现在先同步画出本地计数
  + 缓存的平台 quota 快照，再后台触发 `planCache.refresh()`，新数据
  到达后再次重绘。新增 `plan: 'loading'` 源状态，in-flight 期间用
  "正在加载 Token Plan 数据..." 横幅占位。
- **mmx auth 默认不再 shell out。** 快路径直接读 `~/.mmx/config.json`
  （0 subprocess、0 网络），既快又准：mmx ≥ 1.0 把 key 显示成
  `sk-c…4fB4`（中间是真 `…`），并且 `mmx auth status` 每次还会顺带
  跑一遍 quota 抓取。config 文件不存在时仍走 CLI fallback。
- **点"重新检测"会写盘。** 走 `MmxCliCache.refresh()` 写 memento，
  下次开面板同样秒出。
- **mmx 步骤仅显示未完成项。** 状态卡下面那三行"完成 X"绿条现在
  只在对应步骤未完成时才出现——三项都绿时整块折叠，只剩 3 个状态
  卡 + "Agent 已就绪"注脚 + 2 个按钮。
- **跨日 usage 回归测试。** `test/usage.test.ts` 新增 cross-day
  测试：直接把昨天的 bucket 写进 memento，验证 `record()` 不会
  覆盖昨天的数据，`readRange(7)` 也能正确合并两天。

### 验证

- TypeScript clean (`tsc -p ./ --noEmit`)
- 单元测试：**99/99 pass**（原 78；mmx config auth 快路径 +13，
  新增 `MmxCliCache` +6，跨日回归 +1，新 `platform: 'loading'`
  plumbing 检查 +1）

## 2.1.6 — mmx-cli：只探测 + 端点对应的官方指令

Dashboard 退回最小可用形态：本扩展**只**探测 mmx-cli 的三个状态
（PATH 上的可执行文件、`mmx auth` 是否登录、Agent SKILL 是否安装），
**不**替用户执行 `npm install -g` / `mmx auth login` / `npx skills add`
中的任何一步——所有装包操作由用户（或用户的 AI Agent）在扩展之外完成。

mmx-cli 板块唯一保留的动作是"复制官方三步安装指令到剪贴板"，**语言
随端点配置自动选择**（`minimaxi.com` → 简体中文，否则 → English）。
prompt 里只含 `sk-xxxxx` 占位符，粘贴前用户自己把 Token Plan Key
填进去（或直接在终端里跑这三条命令）。

这一版同时删掉了扩展内的 `npm install -g` / `mmx auth login` /
`npx skills add` 路径——这些调用在 Windows 上一直踩"command not
found"类型的坑（npm `PATHEXT`、PATH 没刷新、扩展无法响应的 UAC
弹窗），既然用户已经是安装的实际执行者，扩展就不必再绕这一圈了。

### 验证

- TypeScript clean (`tsc -p ./ --noEmit`)
- 单元测试：**78/78 pass**（重写后的测试断言：locale-aware 的
  prompt 按 `china` / `global` 返回中文/英文，且 prompt 里不含任何
  真实 key token）
- 冒烟：`mmxInstallPrompt('china')` 和 `mmxInstallPrompt('global')`
  返回的字符串与官方文档原版一致

## 2.1.5 — mmx-cli 安装：把 `npm install -g` 交给 Copilot Chat

把扩展内"代跑 `npm install -g mmx-cli`"换成"复制官方指令到剪贴板 +
打开 Copilot chat"。Agent 拥有扩展所没有的包管理器访问能力（能响应
交互式 UAC 弹窗、装构建工具、在 npm 临时错误时重试），所以让用户
把官方三步 prompt 粘到 chat 里发出去，比我们默默跑更稳。

### 变更

- **Dashboard "Install mmx-cli" 按钮** 与
  **`MiniMax: Install mmx-cli`** 命令现在都把官方 prompt 复制到
  剪贴板并打开新 Copilot chat，让用户粘过去发。扩展不再调用 shell。
- **API key 仍然安全**：prompt 里 key 只以字面 `sk-xxxxx` 占位符出现。
  第 2 步（`mmx auth login`）**仍然**由扩展来跑——key 从 SecretStorage
  拿出来走 argv 传，**不**进 chat 文本、**不**进磁盘上的会话历史、
  **不**进 agent 视野。
- 第 2、3 步（登录 + 安装 SKILL）作为独立按钮保留在 Dashboard，agent
  跑完第 1 步后用户一路点过去即可。
- 新增 dashboard 文案 + 新增 `mmxInstallPrompt()` /
  `copyMmxInstallPromptToChat()` 导出（便于测试）。

### 验证

- TypeScript clean (`tsc -p ./ --noEmit`)
- 单元测试：**84/84 pass**（新增 2 个：prompt 含三步、prompt 不含
  真实 key）

## 2.1.4 — 修 mmx-cli 安装在 Windows 上 `npm not found on PATH` 的问题

修复 **MiniMax: 安装 mmx-cli** 命令在 Windows 上报
`npm not found on PATH` 的问题——明明 PowerShell 里 `npm --version`
跑得好好的。

### Bug

原 `installMmxCli` 直接 `execFile('npm', …)`，传的是裸二进制名。
Windows 上 `execFile` **不**走 `PATHEXT` 解析，文件名叫 `npm` 就
按字面找，npm 真正装的是 `npm.cmd`，于是 `ENOENT`（Node 18+ 还
会直接 `EINVAL` 拦截 `.cmd` / `.bat` 的直接 spawn，作为一项安全
加固）。任何 PATH 上没有字面 `npm.exe` 的 Windows 机器都中招。

### 修复

- 新增 `mmxCli.resolveNpmBin()`：先跑 `where npm`，**优先选 `.cmd`**
  那一行；找不到时按 Windows 常见安装位置挨个查
  （`%ProgramFiles%\nodejs`、`%APPDATA%\npm`、nvm-windows、fnm、
  Volta），结果带缓存。
- `run()` 内部对任何 `.cmd` / `.bat` 目标自动包一层 `cmd.exe /c …`，
  绕开 Node 18+ 的 `EINVAL` 拦截。传给 `mmx auth login
  --api-key <key>` 的 API Key 仍然走 Node 的 argv 转义路径，**不**
  经过 shell，"不在进程列表里露 Key" 的原有保证不变。
- **MiniMax: 安装 mmx-cli** 失败时如果错误信息是 npm 缺失，多弹
  一个 **重新加载窗口** 按钮——那些"装完 Node 之后才开 VS Code"
  的用户点一下就能拿到新 PATH，不用手动重启。

### 验证

- TypeScript clean (`tsc -p ./ --noEmit`)
- 单元测试：**82/82 pass**（新增 2 个针对 `resolveNpmBin` /
  `resolveNpmEnv` 的测试）
- Windows 实测：`cmd.exe /c C:\Program Files\nodejs\npm.cmd
  --version` → `11.6.2` ✅

## 2.1.3 — 集成 mmx-cli

把官方多模态命令行 `mmx` 作为 Token Plan 的可选伴生工具集成进来。
安装后，Agent（Copilot Chat、Claude Code、Cursor 等）就能用同一个
Token Plan API Key 调用图像、视频、音乐、语音、视觉理解与网络检索
等全部多模态能力。

### 新增

- **Dashboard 底部新增 mmx-cli 板块。** 展示三个状态徽标
  （CLI 已安装、`mmx auth` 已登录、Agent skill 已安装），
  以及一份三步清单和一个"重新检测"按钮。清单对照官方入门文档
  (`platform.minimaxi.com/docs/token-plan/minimax-cli`)：
  1. `npm install -g mmx-cli`
  2. `mmx auth login --api-key <key>`（复用 SecretStorage 里
     已存的 Key；若没有则提示用户去设置）
  3. `npx skills add MiniMax-AI/cli -y -g`
  三步全部完成后会显示绿色"Agent 就绪"提示，告诉用户 Agent
  现在可以在提示词里直接调用 mmx。
- **新增命令 `MiniMax: 安装 mmx-cli`。** 按顺序引导完成以上三步，
  并在最后打开 Dashboard。SKILL 步骤在 `npx` 不可用或拉取失败
  时会回退到把内置 `SKILL.md`（在 `skills/minimax-cli/` 下）
  拷贝到 `~/.{claude,copilot,mmx}/skills/minimax-cli/SKILL.md`。
- **内置 `SKILL.md`**（位于 `skills/minimax-cli/`）。作为
  `npx skills` 无法访问官方仓库时的离线回退方案，内容与官方
  `MiniMax-AI/cli` slug 一致。

## 2.1.2 — 状态栏瘦身、Dashboard 重排、CI 修复

三条线：状态栏只留两项平台额度；Dashboard 的 Token Plan 区重排后
进度条和重置时间对齐；release-please workflow 修好后 CI 重新能跑。

### 变更

- **状态栏去掉了“今日 token”项。** `$(graph) MiniMax 1.2k` 这个
  槽位没了。今日 token 总量去 Dashboard（**MiniMax: Open Usage Dashboard**）
  和 **MiniMax: Show Usage** 命令里看。
- **状态栏改为显示“已用%”。** `5h 54%` / `Week 88%` 表示“已用 54%
  / 88%”。色阶阈值（≥85% 红、60-85% 黄、<60% 绿）跟 Dashboard
  进度条一致。Tooltip 里仍保留 `已用 X / Y`、`剩余 Z%` 完整对账信息。
- **额度状态栏颜色改为纯文字色。** `$(bolt) 5h …` 和
  `$(calendar) Week …` 现在只换文字色，不再染底色，跟状态栏
  整体融为一体。
- **Dashboard Token Plan 区重排。** 5h / 周两窗口各一张卡：
  进度条上显示百分比，重置时间挪到标题右端成小药丸。原来的
  孤儿周限额进度条、重复的 “Used: X / Y” 数据卡、按模型明细表
  全部移除。卡片标题统一为 `GENERAL · 5h` / `周额度`。
- **清理了不再使用的 i18n key**（原本只服务于被删的状态栏项）：
  `status.tooltip`、`status.tooltipEmpty`、`status.tooltipActive`、
  以及重复的 `status.tooltipActive_zh`。
- **修复 release-please workflow**。`.github/workflows/release.yml`
  之前在 step `if:` 里引用了 `secrets.*`，被 GitHub Actions 表达式
  语法拒绝，整条 workflow 一直 validate 失败。改成只用 `vars.*`
  判定，secret 是否存在移到 step 内部的 bash 守卫里。
- **从 `release.yml` 里移除了市场推送步骤。** 之前 `Publish to
  VS Code Marketplace` 和 `Publish to Open VSX` 两个 step 是用
  `vars.PUBLISH_*` 开关守着的，但开关从来没被设过，是死代码。
  整体删除。等以后要推市场时，改用 `rescue.yml` 手动跑；它的
  三个推送开关现在默认全部 `false`，避免“token 为空还去推”的
  silent failure。
- **三个 workflow 全部切换到 Node.js 24**。GitHub 将在
  2026-06-16 弃用第三方 Action 的 Node 20 runtime，
  `release-please-action@v4` 现在每次跑都会 warn。我们
  三个 workflow（CI / Release / Rescue）都在 job 级设了
  `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: 'true'` 提前切。
  以后 `googleapis/*` 和 `actions/*` 发布 Node-24 版本后
  可以删掉这个 env。

Dashboard 环形图中心仍显示 all-in token 总量（input + cacheWrite +
cacheRead + output），这个数字乘上价格表就是估算的账单。legend
里 4 个分项独立显示，缓存占了多少一眼能看到。

## 2.1.1 — 双币种价格表 + token 环形图

价格表按 `minimax.apiBaseUrl` 与 `vscode.env.language` 自动在 USD /
CNY 之间切换，用量面板的「local」卡片也重画成了带百分比的环形图。

### 新增功能

- **USD / CNY 双币种价格支持。** 之前单一的 CNY 价表拆成
  `PRICING_CNY` 和 `PRICING_USD`，新增的 `pickPricingTable()` helper 在
  运行时按下面的规则选表：
  - `apiBaseUrl` 里包含 `minimaxi.com` → 强制 CNY (¥)，无视语言环境。
  - 否则，中文 locale（`zh`、`zh-*`、`zh_*`）→ CNY (¥)。
  - 其它全部 → USD ($)。
  - `MODELS` 改名 `MODEL_TEMPLATES`，新增 `getModels(baseUrl)` 在运行时
    把 `pricing` 字段从选中的表里展开。所有展示价格的 UI 入口
    （模型选择器 tooltip、**MiniMax: Show Pricing** 命令、commit model
    选择器、replay marker）都改成走 `getModels()`，币种符号与用户
    实际结算币种保持一致。
  - `README.md` 现在以 USD 为主表，`README.zh.md` 以 CNY 为主表，两份
    README 都新增了一段提示，说明国内/国际价格站点之间的差异，并指出
    模型选择器与 **Show Pricing** 命令会按当前 `minimax.apiBaseUrl`
    自动渲染对应的那张表。
  - `isChineseLocale()` 与 `isChinaBaseUrl()` 两个 helper 从
    `src/models/registry.ts` 导出，方便以后其它代码复用同一套路由逻辑。
  - `ModelPricing.currency` 字段类型从硬编码的 `'CNY'` 放宽为
    `'CNY' | 'USD'`。
- **状态栏额度项（`5h 73%` / `Week 11%`）。** 在现有
  `$(graph) MiniMax 1.2k` 计数器的右边新增两个 `StatusBarItem`，
  一眼看到平台的 5h / 周额度：
    时显示 `∞`）。
  - 颜色走内置的 `statusBarItem.remoteBackground` /
    `warningBackground` / `errorBackground` 三个主题 token
    （剩得多则绿、少则红），亮色 / 暗色主题都跟得上。
  - hover 显示 `X / Y · 重置 Hh Mm` 简报，跟 Dashboard 的卡片一致
  （平台未报 total 时不显示 `X / Y`，跟下面那条修复同源）。点击
  直接打开 Dashboard。
  - 未配 API Key 时两项都是灰色破折号，hover 提示运行
    **MiniMax: Set API Key**。
- **Dashboard 与状态栏共享 `PlanCache`。** `src/dashboard/aggregator.ts`
  里新增 `createPlanCache()`，把 `coding_plan/remains` 的最近一次成功
  响应缓存在一个 in-process 仓库里，广播给所有订阅者（Dashboard 面板、
  状态栏额度项、以及将来可能的新表面）。并发 `refresh()` 会合并到
  同一个 HTTP 请求上，底层 `fetchPlanUsage` 的 8 秒 TTL 仍负责节流。
  扩展在 `AuthManager.onDidChangeApiKey` 触发时主动 `invalidate()`，
  切换 API Key 后额度会立刻按新 Key 重新拉取。
- **事件驱动的 plan 刷新——不装后台定时器。** 计划缓存在以下五个
  原有事件上主动 pulse（这些都是扩展关键路径上已有的信号，不是额外
  装的轮询）：
  1. 扩展激活 / 首次注册命令（VS Code 打开几秒后状态栏就有真实数字，
     不用等用户开 Dashboard）。
  2. `AuthManager.onDidChangeApiKey`（设 Key / 清 Key / 换 Key）。
  3. `vscode.workspace.onDidChangeConfiguration` 监听
     `minimax.apiBaseUrl`（**MiniMax: Switch to Global / Chinese API**
     走的是改配置不改 auth 状态，必须额外接上）。
  4. `ChatTurnNotifier.onTurnEnd`——新增的事件源，由
     `MiniMaxChatProvider.provideLanguageModelChatResponse` 在
     `streamChatCompletion` resolve / throw 之后（**finally** 里）发
     射，**每轮 Copilot 对话一次**（不是每条内部 API 请求）。notifier
     自身带 30 秒最小间隔，用户连续发 10 轮对话也最多只触发
     一次平台拉取。
  5. Dashboard 打开 / Refresh / 切到可见（原有路径，**也**改成走共享
     cache，Dashboard 与状态栏一定渲染同一份快照）。
  完全不装 `setInterval`，空闲时零后台网络流量。
  `DashboardPanel.refresh()` 也从直接调 `fetchPlanUsage` 改成走
  `planCache.refresh()`，两个消费者看到的快照永远一致。

### 修复

- **用量面板的 local 卡片重画为环形图。** 之前一排 key-value 列表
  （input / cache read / cache write / output）现在改为 `conic-gradient`
  渲染的环形图 + 带配色的 legend，同时显示每种 token 的数量与占比。
  配色复用了面板里已经在用的 `var(--accent)` / `var(--good)` /
  `var(--warn)` / `var(--bad)` 四个 token，颜色跟随主题自动适配。
  `requests` 计数保留在环形图下方的独立一行；视口 ≤480 px 时环形图与
  legend 自动改为纵向堆叠，保证小屏可读。
- **Token Plan 面板不再显示无意义的 "0 / 0"。** 部分平台配额模型
  （最典型的是 `general`）会返回 `current_interval_remaining_percent`
  却**不**返回 `current_interval_total_count`，导致进度条明明有真实
  百分比，下面的 `已用 / 合计` 却永远显示 `0 / 0`。参考
  [minimax-status](https://github.com/JochenYang/minimax-status) 的做法，
  渲染器现在按下面的规则处理：
  - 进度条：当 `total === 0` 时，不渲染 "X / Y" 这一段，只剩进度条 +
    百分比。
  - 5h / 周限额卡片：当没有 total 时，整行 `Used` 直接隐藏，卡片退化为
    只剩"重置倒计时"那一行，跟 minimax-status 的
    "title · reset-time" 布局一致。
  - 按模型拆分的明细表：当某个模型没有 total 时，把 used / 合计两列
    渲染成破折号 `—`，让表格的对齐保持稳定。
  平台在 total 缺失时确实没办法算出真实的"已用"次数——
  `current_interval_usage_count` 字段在配额模型上不可信（详见
  [minimax-status/.../api.js](https://github.com/JochenYang/minimax-status)
  的注释），与其硬塞一个 `0 / 0`，不如直接隐掉。
- **token 计数器不再重复统计 Anthropic cache 字段。** Anthropic
  Messages API 的 `input_tokens` 是**增量、未缓存**的那部分输入，
  `cache_creation_input_tokens` / `cache_read_input_tokens` 是
  **在它之上**额外报告的（同样包含已缓存前缀）。老版 `totalTokens()`
  把四个字段全加起来，结果每个 cache 写入轮次都把整段 prompt prefix
  多算一次——1M 系统 prompt + 一天 50 轮对话经常被记成 50M 幻影 token。
  `totalTokens()` 现在只算 `input + output`；另增 `totalBilledTokens()`
  helper 返回 `input + cacheWrite + cacheRead + output` 这个"全口径"
  数字，给需要乘价格表的场景用。Dashboard 圆环中心显示净额，legend
  里仍把 cache 拆开显示（这样用户能看出这一天有多少流量走了缓存）。
- **状态栏的今日 token 项被删了。** `$(graph) MiniMax 43.66M`
  那一项去掉，原因是：（1）这个数字其实是 cache 重复统计 bug 的副
  作用，会误导人；（2）跟 5h / 周限额挤一起太占空间。今日 token
  总数现在去 Dashboard（**MiniMax: Open Usage Dashboard**）和
  **MiniMax: Show Usage** 命令里看，状态栏只保留 2 个平台额度项。
- **额度状态栏颜色改为纯文字色。** `$(bolt) 5h …` 和
  `$(calendar) Week …` 这两个项现在只换文字色（绿/黄/红），不再染
  底色，跟状态栏整体融为一体。
## 2.0.0 — 改名为 MiniMax Copilot + 移除思考强度选择器

这一版把市场化的改名和一轮行为修复打包发布。其中一部分对用户可见（UI 元素没了、Copilot 状态栏的上下文统计数字变正确了）；大部分是底层加固。

### 新增功能

- **用量面板（Usage Dashboard）** —— 新增命令 **`MiniMax: Open Usage Dashboard`**，并在状态栏增加可点击入口，展示今日 / 近 7 日 / 近 30 日的 token 用量（输入、缓存读取、缓存写入、输出、请求数），数据来源是本地累计计数器。配置了 API Key 时，仪表盘还会顺带从平台 `coding_plan/remains` 拉取 5h 重置 / 周限额 / 套餐到期时间，未配置时优雅降级。用量计数器现在会正确累加 `requests`（之前没有），并按日分桶，让仪表盘的 30 日柱状图能跨过零点正确累加。

### 破坏性变更

- **Marketplace 展示名改为 MiniMax Copilot**，让「为 GitHub Copilot 提供 MiniMax 模型」这层意图一眼可读。扩展 ID（`klarkxy.minimax-vscode`）、publisher、命令名、配置项、walkthrough、SecretStorage key **均不变**——已安装用户原地升级，所有配置保留。
- **移除模型选择器里的四档「思考模式」下拉菜单。** MiniMax 的 Anthropic 兼容端点只接受一个二值开关
  `thinking: { type: "disabled" | "adaptive" }`（详见
  [OpenAPI 规范](https://platform.minimaxi.com/docs/api-reference/text/api/openapi-chat-anthropic.json)），根本没有
  `budget_tokens` 字段、没有 `reasoning_effort` URL 参数、Anthropic 兼容通道上也没有 `reasoning_split` 字段。官方的 `Mini-Agent` 参考实现印证了这一点：写死
  `extra_body={"reasoning_split": true}`，根本没有 UI / 配置项 / 环境变量可调。发这些字段直接触发 HTTP 404。
  - 对所有支持 thinking 的模型，**永远**只发
    `thinking: { type: "adaptive" }`，并强制 `temperature: 1`、去掉 `top_p`，遵守 Anthropic 约束。
  - 将来若 MiniMax 真的发布档位参数，把下拉菜单加回来只需要改 `src/provider/models.ts` 一个文件。

### 新增功能

- **per-model sampling 覆盖。** 新增顶层
  `minimax.sampling` 配置对象，按 model ID 单独设置
  `temperature` / `topP` / `topK` / `frequencyPenalty`，免改代码。
  当模型处于 `thinking: adaptive` 模式时 `temperature` / `topP` 被忽略（Anthropic 约束），
  `topK` / `frequencyPenalty` 永远生效。示例：
  `{ "MiniMax-M2.7": { "temperature": 0.2, "topK": 40 } }`。
- **per-model `extra` 转义舱。** 新增实验性
  `minimax.experimental.modelDefPresets` 对象，把任意键合并进 Anthropic 请求体。
  `stop_sequences` / `service_tier` / `metadata` 或将来 MiniMax 加的任何字段都能用。
  11 个 reserved keys（Anthropic 必需的字段以及被约束的
  `temperature` / `top_p` / `top_k` / `frequency_penalty`）会被拒绝覆盖；
  `tools` 与现有工具数组合并而非替换。
- **Anthropic `cache_control` 断点（system + 最后一个 tool）。**
  系统提示词和最后一个工具定义现在都挂上
  `cache_control: { type: "ephemeral" }`，让它们计入后续轮次的缓存前缀。
  新增的 `enforceCacheControlBudget()` helper 把总数控制在 Anthropic 的 4 断点上限以内；
  主机（Copilot）自己也会发断点，超出 4 时会先砍 in-message 的那批，避免 400。

### 修复

- **Copilot 状态栏的上下文统计现在能正确显示 cache 写入成本。**
  `reportCopilotContextUsage` 之前只把 `usage.input_tokens` 当成 `prompt_tokens` 上报，
  这会在 cache 写入轮次严重低估真实计算开销（Anthropic 对写 cache 的输入前缀按完整输入价收费）。
  现在 data part 把 `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` 三者聚合，
  与 oai-compatible-copilot 上游一致；零用量轮次直接跳过，不再闪 `0+0=0`。
- **Git commit message 生成器现在能真正拿到 diff。**
  `buildScmContext` 之前从 VS Code Git 扩展的 typed `state.diff` 字段读 diff，
  但现代 VS Code 里这个字段总是空的，导致 prompt 里只有文件列表、模型只能凭文件名瞎编。
  新增的 `extractDiffViaGitCli` 兜底层用 `child_process.spawn` 跑
  `git --no-pager diff --staged --diff-filter=d`（拿不到 staged 时退到
  `git --no-pager diff HEAD --diff-filter=d`），并设了 16 MiB / 10 秒的硬上限。
  spawn 错误优雅退化，prompt 至少还能给出文件列表。

### 备注

- 1.6.0 → 2.0.0 的版本号提升**部分是表面改动**（改名）**部分是实质改动**（以上所有项）。在 settings sync、DevOps 脚本里硬编码 `klarkxy.minimax-vscode` 的不用动，ID 不变。
- `MiniMax*` chat info 上的 `configurationSchema` 字段现在永远是 undefined。自定义自动化如果之前 introspection 这个选择器 schema 找 `reasoningEffort` 字段，需要适配。

## 1.6.0 — 仅 Anthropic 协议、M3 锁 512K、模型选择器内显示价格、端点自动选择、Git 提交信息生成

这是一个**破坏性更新**。扩展现在**只**走 MiniMax 的 Anthropic 兼容端点，原有的 OpenAI 兼容传输已被彻底移除。

### 为什么要切到 Anthropic？

MiniMax 官方在新接入时**只推荐**走 Anthropic 兼容通道：它原生支持 thinking 块、image 内容块、工具调用以及 Anthropic 自带的 `signature_delta` 签名校验。OpenAI 兼容传输仅保留给那些**尚未**在 Anthropic 端点上线的老模型 —— 但 M 系列编程模型早已不在这个名单里。

### 模型能力升级

- **MiniMax M3 现在是头牌模型**：
  - 原生支持 Anthropic `thinking` 参数，通过 `budget_tokens` 控制思考深度（轻量 1024 / 标准 8192 / 深度 32768）。
  - 原生支持 `image` 内容块；之前针对 M3 设置的 `imageInput: false` 已解除。
  - **实际可用上下文锁定 512K。** 官方规格是 1M，但 >512K 输入层级当前处于「限时限量供应」状态，且 API 会直接拒绝 `max_tokens > 512_000` 的请求。展示上我们仍以 1M 作为头部数字（让 VS Code 显示模型的真实目标），但**实际生效的输入 + 输出都锁在 512K**，等官方全量放开后再放宽。

### 价格展示进 UI

- 每个模型新增 `pricing` 字段，结构为 `{ input, output, cacheRead, cacheWrite, currency, note }`。
- 模型选择器在 `detail` 行里直接显示 `¥X.XX 入 / ¥Y.YY 出 /M tokens`；完整的明细（含缓存读写与备注）放进 tooltip。
- 新增命令 **MiniMax: Show Pricing**，在 Markdown 预览中打开完整价格表，包括 M3 的「7 天限时五折」提示以及 >512K 层级的限量警告。

价格数据采集自
[platform.minimaxi.com/docs/guides/pricing-paygo](https://platform.minimaxi.com/docs/guides/pricing-paygo)
以及
[Token Plan 页](https://platform.minimaxi.com/subscribe/token-plan?tab=api-enterprise)。
M2.5 / M2.1 / M2 这些历史模型 MiniMax 已不再推荐，本版本也不再随扩展发布；如有需要可由用户自行通过 `minimax.modelIdOverrides` 与 `minimax.visibleModels` 重新加回来。

### 新增 / 变更的配置

| 配置项 | 变更 | 默认值 |
| --- | --- | --- |
| `minimax.apiBaseUrl` | 改为 Anthropic 端点 | `https://api.minimaxi.com/anthropic` |
| `minimax.maxTokens` | 硬上限生效 | `0` |
| `minimax.commitModel` | 新增 | `MiniMax-M2.7` |
| 新增命令 `MiniMax: Show Pricing` | — | — |
| 新增命令 `MiniMax: Generate Commit Message` | — | — |

`switchToGlobal` / `switchToChina` 命令现在也直接指向 Anthropic 兼容端点。

### Git 提交信息生成

- 新增命令 **MiniMax: Generate Commit Message**，同时挂到 `scm/inputBox/title` 菜单上，与 Copilot 自带的 sparkle 按钮并排显示。
- 通过 VS Code 自带的 Git 扩展读取**已暂存**的改动（暂存区为空时退回到工作区改动），diff 上限 32 KB，文件列表最多 80 条；若输入框里已有草稿会把它当作「待润色」输入。
- 输出按 Conventional Commits 风格（`<type>(<scope>)<!>: <subject>` + 可选 bullet body），`temperature: 0.2`、`max_tokens: 256`，保证稳定可复现。
- 模型由 `minimax.commitModel` 决定，默认 `MiniMax-M2.7`；复杂重构可手动切到 `MiniMax-M3`。

### 架构变更

- 依赖：`openai` → `@anthropic-ai/sdk`（Apache 2.0）。
- 新增 `MiniMaxClient.completeChat()` 非流式 helper，给提交信息生成器（以及将来任何一次性工具调用）使用，省去流式回调的繁琐。
- `src/types.ts` 改为镜像 Anthropic Messages API 的结构：`messages[].content` 现在是内容块数组；`system` 升级为顶层字段；`thinking.type ∈ {enabled, disabled}`；`tool_use.id` / `tool_result.tool_use_id` 等都按 Anthropic 习惯命名。
- `src/provider/replay` 中的 marker 现在携带 `thinkingBlocks`（含 `signature` 字段），替代旧的 `reasoningDetails`，让模型在跨会话拼接思考时能完成签名校验。
- `src/provider/convert.ts` 把 system 消息提取到顶层 `system` 字段，输出 `tool_use` / `tool_result` 内容块，并把图片部分直接转成 Anthropic `image` 块（支持 base64 与 data-URI）。
- `src/provider/stream.ts` 消费 Anthropic 流事件：`message_start` / `content_block_start` / `content_block_delta`（含 `text_delta` / `thinking_delta` / `input_json_delta` / `signature_delta`）/ `content_block_stop` / `message_delta` / `message_stop`。
- 用量统计沿用 Anthropic `usage` 形状：`input_tokens` / `output_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens`。
- 错误映射补全 403、408、413、529（Anthropic 过载）。

### 构建

- `npm run compile`（tsc）与 `npm run build`（esbuild）均通过。
- 产物：`out/extension.js` 226 KB（比之前 161 KB 略大，主要来自 Anthropic SDK；后续可以做一次 tree-shaking 优化）。

### 迁移提示

- 包名、vendor ID、命令 ID、walkthrough ID、SecretStorage key 以及大部分配置 key 保持不变。
- `minimax.apiBaseUrl` 默认值变更：旧的 `https://api.minimax.io/v1` / `https://api.minimaxi.com/v1` 仍然可用（我们原样读取），新默认是 Anthropic 端点。
- 模型从默认选择器中**移除**：M2.5、M2.5-highspeed、M2.1、M2.1-highspeed、M2。MiniMax 已不再推荐这批模型；如有需要，可自行通过 `minimax.modelIdOverrides` 与 `minimax.visibleModels` 重新加回。
- **端点自动选择**：首次激活时，若 `minimax.apiBaseUrl` 仍是出厂默认，扩展会按 `vscode.env.language` 自动选择端点（`zh*` → 国内，其它 → 国际）。该选择会持久化，后续手动修改会永久覆盖。

## 1.5.0 — 用 deepseek-v4-for-copilot 架构重构

（沿用之前的描述，详见 README 和 git 历史）
