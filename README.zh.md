# MiniMax Copilot

> English version: [README.md](./README.md)

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=klarkxy.minimax-vscode-copilot"><img src="https://img.shields.io/badge/VS%20Code%20Marketplace-安装-007ACC?logo=visualstudiocode&logoColor=white&style=for-the-badge" alt="从 VS Code 市场安装"></a>
</p>

<p align="center">
  在 Copilot Chat 模型选择器里选 <b>MiniMax M3 / M2.7</b> —— Copilot 给你的一切照旧。
</p>

## 为什么需要这个扩展？

既想用 MiniMax 的性价比，又舍不得 Copilot 的 agent 模式、tool calling 和打磨过的 UI？本扩展把 **MiniMax M3 / M2.7** 直接塞进 Copilot Chat 的模型下拉框 —— 自带 **vision**、**思考模式**、**用量面板**，以及你的 Token Plan API key。

- **不替换 Copilot，只是给它加 buff。** 没有新侧边栏、没有新聊天界面要学，只是给模型选择器加几条新条目。
- **Agent 模式、tool calling、MCP 全部继续工作。** Copilot 整套栈都跑在 MiniMax 上。
- **BYOK，直接付给 MiniMax。** Token Plan API key 走你的、账单走你的、配额走你的。存在 OS 钥匙串里，不写盘。
- **双语 UI**，跟随 VS Code 显示语言。

## 功能

- **[模型选择器里的 M3 / M2.7 / M2.7-highspeed](#模型)** — 和 GPT、Claude 排在一起，tooltip 里直接给价。M3 原生支持图片 + 视频；M2.x 自动走透明的 vision proxy。
- **[M3 原生视频输入](#视频输入m3-专属)** — 直接发 `type: "video"` part，硬限 64 MB 请求体上限，再也不会看到莫名其妙的 HTTP 413。
- **[思考模式开关](#思考模式)** — Anthropic 兼容端点只暴露二值 `disabled / adaptive` 开关。仅 M3 可切，M2.x 永远保持 `adaptive`。
- **[用 MiniMax 驱动 Copilot 内置的提交信息 ✨](#git-提交信息生成)** — 通过 `chat.utilitySmallModel` 把 Source Control 标题栏的 ✨ 路由到 MiniMax。一个 QuickPick 搞定，不用手改 settings.json。
- **[按模型微调采样参数](#按模型调参)** — 每个 model 独立覆盖 `temperature` / `topK` / `topP` / `frequencyPenalty`，外加请求体逃生口。
- **[累计用量追踪](#用量面板)** — 输入 / 输出 / 缓存读取按模型累计，跨会话累加。Markdown 报告 + 状态栏数字。
- **[用量面板](#用量面板)** — 今日 / 7 日 / 30 日卡片，30 日柱状图，按模型拆分，平台 `coding_plan/remains` 数据，附加 Claude Code JSONL 数据源。
- **[诊断能力](#诊断能力)** — 每请求分类、缓存命中统计、verbose 模式把每条请求 dump 到磁盘。

## 快速开始

### 环境要求

- **VS Code 1.111.0+**
- **GitHub Copilot Chat** 已装并登录（本扩展以模型供应商身份注册）
- 一份 MiniMax [Token Plan](https://platform.minimax.io/user-center/payment/token-plan) 订阅 + API Key
- **VS Code Insiders** 才能用 proposed `languageModelThinkingPart` API 渲染思考折叠块
- 想用 MiniMax 生成 commit message 需要装 **GitHub Copilot Chat**（VS Code 内置 ✨ 按钮依赖它）

### 安装

1. 从 [VS Code 市场](https://marketplace.visualstudio.com/items?itemName=klarkxy.minimax-vscode-copilot) 安装（或 `npm run package` 从源码打 `.vsix`）。
2. 在命令面板运行 **MiniMax: Set API Key**，粘贴 Token Plan Key。
3. 打开 Copilot Chat，点模型选择器，选 **MiniMax M3**（或 M2.7 / M2.7-highspeed）。想比价可以跑 **MiniMax: Show Pricing**。
4. （可选）跑 **MiniMax: Set Copilot's Utility Models** 把 Source Control 标题栏 ✨ 按钮和标题/摘要路由到 MiniMax。
5. 直接在 Copilot Chat 里跟模型对话；点 Source Control 标题栏的 ✨ 用 MiniMax 起草 commit 信息。

### 端点自动选择

激活时如果 `minimax.apiBaseUrl` 仍是默认值，扩展会按 VS Code 显示语言自动选择端点：

- `zh*`（`zh-cn`、`zh-tw`、`zh-hk`、`zh-sg`、...）→ 国内，`https://api.minimaxi.com/anthropic`。
- 其它 → 国际，`https://api.minimax.io/anthropic`。

设置过 `minimax.apiBaseUrl` 或跑过 **MiniMax: 切换到国际版/国内版 API** 后，自动选择永远关闭。

## 模型

| Model | 上下文（官方 / 生效） | 图片输入 | 备注 |
| --- | ---: | --- | --- |
| **MiniMax M3** | 1,000,000 / 512,000 | ✅ 原生 | 当前顶级编码模型；原生视频输入（MP4 / AVI / MOV / MKV）。生效值 512K 是因为 >512K 输入层还在限量发布。 |
| **MiniMax M2.7** | 204,800 | ✅ vision proxy | 自迭代，~60 TPS |
| **MiniMax M2.7-highspeed** | 204,800 | ✅ vision proxy | 同质量，~100 TPS |

**Context** 列第一个数字是 [Supported models](https://platform.minimaxi.com/docs/guides/text-generation) 页上的官方规格；第二个（如果有）是 Copilot 模型选择器实际报出的生效上限。显示小的那一个，保证 VS Code 状态栏的「上下文窗口: N / M」读数对普通用户是诚实的。

### M3 1M 上下文（高级）

拿到 >512K 权限的用户可以走 **MiniMax: Toggle M3 1M Context** 命令把 `minimax.enableM31MContext` 翻到 `true` —— 切换前会弹模态警告，说明 2× 计费、需要销售开通 >512K 等。chat-info emitter 监听设置变化后会重建 picker 条目，编辑器无需 reload，指示数字实时更新。

**历史模型：** M2.5 / M2.1 / M2 已不再被 MiniMax 推荐，扩展不内置。高级用户可以通过 `minimax.modelIdOverrides` + `minimax.visibleModels` 加回来。

## 价格

国内端点（`api.minimaxi.com`，CNY 计价）和国际端点（`api.minimax.io`，USD 计价）价格不同。Picker tooltip 和 **MiniMax: Show Pricing** 都按当前 `minimax.apiBaseUrl` 渲染对应表格。

### 按量计费（LLM，每百万 token）

> 国内表格用 **CNY**，国际表格用 **USD**。完整定价页覆盖所有模态；这里只列扩展实际用的 LLM 部分。

| Model | 输入 | 输出 | 缓存读取 | 缓存写入 |
| --- | ---: | ---: | ---: | ---: |
| **MiniMax M3 (≤512K 输入)** | $0.30 / ¥2.10 | $1.20 / ¥8.40 | $0.06 / ¥0.42 | — |
| **MiniMax M3 (>512K 输入，限量)** | $0.60 / ¥4.20 | $2.40 / ¥16.80 | $0.12 / ¥0.84 | — |
| **MiniMax M2.7** | $0.30 / ¥2.10 | $1.20 / ¥8.40 | $0.06 / ¥0.42 | $0.375 / ¥2.625 |
| **MiniMax M2.7-highspeed** | $0.60 / ¥4.20 | $2.40 / ¥16.80 | $0.06 / ¥0.42 | $0.375 / ¥2.625 |

M3 两个输入层都长期 5 折。>512K 输入层限量发布；最新进度见[定价页脚注](https://platform.minimaxi.com/docs/guides/pricing-paygo)。Token Plan 订阅另外计费，见下节。

### Token Plan 订阅

订阅价格（独立于上面按量计费）。一个 Subscription Key 走共享额度池，覆盖 LLM + 语音 / 视频 / 音乐 / 图像。

| 档位 | 价格（CNY） | 适合 | 配额窗口 | Agent 容量 |
| --- | --- | --- | --- | ---: |
| Starter / 轻量版 | ¥49 / 月 | 个人项目、原型 | 5 小时滚动 + 每周 | 3-4 agents |
| Pro / 高频版 | ¥119 / 月 | 日常编码 + agent + 多模态 | 5 小时滚动 + 每周 | 4-5 agents |
| Max / 重度版 | ¥469 / 月 | 重度 Agent 流程 + 长会话 | 5 小时滚动 + 每周 | 6-7 agents |

Token Plan 配额按各端点的按量价从额度池里扣。配额耗尽时，可以走购买的 Credits 兜底、把 Subscription Key 换成按量 API Key，或等下一个窗口重置（未用额度不滚存）。

## 功能详解

本节是每个特性的深读。[功能](#功能) 总览链到对应小节。

### 思考模式

MiniMax 的 Anthropic 兼容端点只接受一个二值开关 `thinking: { type: "disabled" | "adaptive" }`——**没有**任何「思考强度」旋钮（`budget_tokens` / `reasoning_effort` / `reasoning_split` 全部不支持）。本扩展为 **MiniMax-M3** 暴露了两种开关途径：

- **`minimax.thinking.enabled`** boolean 设置（默认 `true`）。
- **MiniMax: Toggle M3 Thinking Mode** 命令 —— 翻转设置，并弹本地化 toast 让新状态无歧义。

M2.x 永远 `adaptive` —— 官方文档说 M2 系列的 `disabled` 是 no-op，所以这个切换对 M2.7 / M2.7-highspeed 无效。

开启思考时强制 `temperature: 1` 且丢弃 `top_p` 是 Anthropic 的约束，不是我们加的限制。M3 专属的逃生口：把开关关掉，`minimax.sampling` 里的 `temperature` / `topP` 才能真正生效。M2.x 的推理在文本内容里以 `<think>…</think>` 形式呈现，不会走 typed `thinking` 块。

### 视频输入（M3 专属）

M3 在 Anthropic 兼容端点上原生接受视频 part。支持的容器是 **MP4**、**AVI**、**MOV (QuickTime)**、**MKV**。内联 base64 上限 **50 MB**；更大的视频走官方 Files API，用 `mm_file://{file_id}` 引用（Files API 上限 512 MB）。整个请求体上限 **64 MB**；扩展在 API 返回 413 之前先抛本地化错误。

M2.x 静默丢弃视频附件（带 log warning）—— 它们没有 `videoInput` capability。

### Git 提交信息生成

本扩展**不**自带提交信息按钮——MiniMax 以标准 VS Code 语言模型供应商（vendor `minimax`）身份注册，VS Code 的 `chat.utilitySmallModel` 设置会自动把提交信息生成路由到这个 vendor。运行 **MiniMax: 设置 Copilot 工具模型** 命令进入两段式 QuickPick：先选 model（任何 provider — MiniMax、Copilot 自带、或任何其它扩展注册的），再勾选要覆盖哪些 `chat.*` 设置（默认 `chat.utilitySmallModel`，可选 `chat.utilityModel`），写到用户设置里。重启 Copilot Chat 后点 Source Control 标题栏的 ✨ 即可。格式 / 语言定制走 Copilot 自己的设置：

- `github.copilot.chat.commitMessageGeneration.instructions` — `{ "text": "..." }` 字符串数组（靠后的条目权重更高），也可以用 `{ "file": ".github/commit-instructions.md" }` 引用团队规则文件。
- `github.copilot.chat.localeOverride` — 强制输出语言（`"Japanese"`、`"zh-CN"` 等）。

切换模型再跑一次命令即可（也可以直接编辑 `chat.utilitySmallModel`）。MiniMax 的 3 档：`minimax/MiniMax-M3`（前沿）、`minimax/MiniMax-M2.7`（均衡）、`minimax/MiniMax-M2.7-highspeed`（最快）。commit 文本短、延迟敏感，所以 M2.7-highspeed 是最自然的选择——但 QuickPick 只是入口，最终选哪个由你。

#### 逐任务模型覆盖（Copilot 内部 routing）

`chat.utilitySmallModel` 和 `chat.utilityModel` 是 VS Code 暴露的**唯二** family 级覆盖入口——它们重定向整个 routing family（`copilot-utility-small` / `copilot-utility`）。想要更细粒度的逐任务覆盖，Copilot 在自己的 `github.copilot.chat.*` 命名空间下注册了这些：

| Setting | 控制什么 | 默认 | 备注 |
| --- | --- | --- | --- |
| `github.copilot.chat.askAgent.model` | ask agent | `""`（auto） | experimental — 接**裸 model id**，不接受 `<vendor>/<id>` 格式。设成 `minimax/MiniMax-M3` 大概率不工作；除非 Copilot 文档明确说可以，否则留空。 |
| `github.copilot.chat.conversationCompaction.model` | 长上下文压缩 | `""`（auto） | experimental, onExp — 同上。 |
| `github.copilot.chat.instantApply.shortContextModelName` | instant-apply 短上下文模型 | `"gpt-4o-instant-apply-full-ft-v66-short"` | advanced, experimental — Copilot 内部。 |

这三个**故意不**接进 **MiniMax: 设置 Copilot 工具模型** 命令——值格式和 routing 语义都和 `chat.utility*` family 不一样，混进同一个 picker 会误导用户。如确有需求，直接在 `settings.json` 里手写。

### 按模型调参

两个配置旋钮让你不用改代码就能按 model 调整采样参数和请求体：

```jsonc
// settings.json
"minimax.sampling": {
  "MiniMax-M2.7": { "temperature": 0.2, "topK": 40 },
  "MiniMax-M3":   { "topK": 80 }
},
"minimax.experimental.modelDefPresets": {
  "MiniMax-M3": { "service_tier": "auto" }
}
```

- 模型处于 `thinking: adaptive` 模式时，`temperature` 和 `topP` 会被忽略（Anthropic 约束，不是我们加的限制）。
- `topK` 和 `frequencyPenalty` 永远生效。
- `modelDefPresets` 是逃生口——你塞的任意键都会原样合进请求体（标准字段之后）。11 个 reserved 键会被拒绝覆盖；`tools` 与现有工具数组合并而非替换。

### 用量面板

点 VS Code 状态栏的 `$(graph) MiniMax …`，或者跑 **MiniMax: Open Usage Dashboard**，会开一个侧边 webview 面板，融合 3 个数据源：

- **本地 token 统计**：扩展每次发请求都会写入持久计数器。面板把它聚合成 3 个窗口（**今日**、**近 7 日**、**近 30 日**），每窗口带 `Input` / `Cache read` / `Cache write` / `Output` / `Requests` 五列。下方是 30 日柱状图和按模型拆分表。
- **Claude Code JSONL 接入**（兄弟 section，左侧强调色边区分）：消费 [Claude Code CLI](https://docs.claude.com/en/docs/claude-code/overview) 和 [Claude Code VSCode 扩展](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code) 的 token。后台轮询器每 30 秒扫一遍 `~/.claude/projects/**/*.jsonl`，解析每条 `type: "assistant"` 行的 `message.usage`，用同样的 model / day / window 形状喂入面板。游标持久化在 memento，关掉再开不会重读历史数据。用 section 上的「立即重新扫描」按钮强制刷新，或命令面板跑 **MiniMax: Rescan Claude Code Logs**。
- **平台 Token Plan**：配了 API Key 的话，面板还会调 `GET /v1/api/openplatform/coding_plan/remains`，渲染 5 小时重置窗口、每周上限、每模型配额表和订阅到期时间。

daily-token 计数器右侧还有两条状态栏：`$(bolt) 5h 73%`（5 小时剩余百分比）和 `$(calendar) Week 11%`（周剩余百分比）。颜色跟 `statusBarItem.remoteBackground` / `warningBackground` / `errorBackground` 主题 token。没配 API Key 的话两条都渲染成 em-dash 占位，tooltip 提示用户跑 **MiniMax: Set API Key**。

### mmx-cli（多模态伴生 CLI）

用量面板最底下一节是 [`mmx`](https://github.com/MiniMax-AI/cli) 官方 CLI 的状态，作为 Token Plan 流的可选伴生。装上之后，agent（Copilot Chat、Claude Code、Cursor、...）就能用**同一个** API Key 驱动图像 / 视频 / 音乐 / 语音 / vision / web search。

扩展只**检测**三件事，绝不替你装、登、跑：

- **CLI 二进制**在 `PATH` 上（`mmx --version`）
- **`mmx auth`** 已登录（`mmx auth status`）
- **Agent SKILL** 已装（在 `~/.claude/skills/minimax-cli/`、`~/.copilot/skills/minimax-cli/` 或 `~/.mmx/skills/minimax-cli/` 下的 `SKILL.md`）

「Copy official install prompt」按钮（和 **MiniMax: Copy mmx-cli install prompt** 命令）把官方文档的逐字三步 prompt 写到剪贴板，语言跟随当前端点。prompt 里只含字面量 `sk-xxxxx` 占位符；你把真实的 Token Plan Key 填好再贴到 chat 里。装完之后点「Re-check」，面板的 status badge 就会变绿。

### 诊断能力

扩展把日志统一写到 **MiniMax** Output 通道（**MiniMax: Show Logs**）。`minimax.debugMode` 是诊断详细度旋钮：

- `minimal`（默认）—— 只记激活行和请求用量汇总。
- `metadata` —— 每请求一行，含 model id、输入 / 输出 / 缓存 token 数、延迟、缓存命中分类。
- `verbose` —— 每条请求额外 dump 成 JSON 文件到 `<globalStorage>/request-dumps/<segmentId>/`。**MiniMax: Open Request Dumps Folder** 在 OS 文件管理器里打开这个目录。

上游 prompt cache 的命中统计在 `metadata` 和 `verbose` 两个等级都会写日志，方便在同一个 chat 会话里迭代时确认缓存是不是在暖。

## 设置项

| 设置 | 默认 | 用途 |
| --- | --- | --- |
| `minimax.apiBaseUrl` | `https://api.minimaxi.com/anthropic` | Anthropic 兼容基础 URL。国际用户用 `https://api.minimax.io/anthropic`。SDK 自动补 `/v1/messages`。激活时若未设置会自动按语言选。 |
| `minimax.visibleModels` | _所有 M 档_ | 限制 picker 里出现的模型。 |
| `minimax.maxTokens` | `0` | 输出上限。`0` 让模型自己决定。设正整数则硬切；请求层不客户端 clamp，upstream 4xx 原样抛回。 |
| `minimax.enableM31MContext` | `false` | 把 **MiniMax-M3** picker 从安全默认 512K 抬到官方 1M。**默认关闭。** 开启需要账号已通过销售开通 >512K，且 >512K 部分按 **2 倍费率** 计费（见[定价页](https://platform.minimaxi.com/docs/guides/pricing-paygo)）。建议用 **MiniMax: Toggle M3 1M Context** 命令——开之前会弹模态警告。 |
| `minimax.sampling` | `{}` | 按模型覆盖 `temperature` / `topP` / `topK` / `frequencyPenalty`。详见[按模型调参](#按模型调参)。 |
| `minimax.experimental.modelDefPresets` | `{}` | 按模型逃生口，往请求体里塞自定义字段。详见[按模型调参](#按模型调参)。 |
| `minimax.debugMode` | `minimal` | `minimal` / `metadata` / `verbose`（verbose 把每条请求 dump 到磁盘）。 |
| `minimax.modelIdOverrides` | _恒等_ | picker id → API id 映射（代理场景用）。 |
| `minimax.visionModel` | _auto_ | 非 M3 模型的 vision proxy。 |
| `minimax.visionPrompt` | _见 package.json_ | vision proxy 自定义 prompt。 |
| `minimax.dashboard.includeClaudeCode` | `true` | 用量面板里 Claude Code JSONL section 的总开关。设为 `false` 时 section 变成「在设置中已关闭」横幅 + 「打开设置」按钮。游标持久化；关掉再开不重读历史。 |
| `minimax.claudeCode.logPath` | `~/.claude/projects` | Claude Code 写 JSONL 会话日志的根目录。支持 `~` 展开（POSIX 和 Windows 都生效）。改完重启 / 点「Re-scan」生效。 |
| `minimax.claudeCode.pollIntervalMs` | `30000` | 扫描间隔（毫秒）。夹在 `[5000, 600000]` 之间，即使你写 `settings.json` 改了范围外值也会被 clamp。 |
| `minimax.experimental.stabilizeToolList` | `false` | 合成 preflight tool call 让上游 prompt cache 保持热。**Experimental.** |

## 命令

| 命令 | 用途 |
| --- | --- |
| **MiniMax: Set API Key** | 把 Token Plan Key 存到 SecretStorage |
| **MiniMax: Clear API Key** | 删除已存的 Key |
| **MiniMax: Show Provider Status** | 一屏显示当前配置 + 上次请求用量 |
| **MiniMax: Show Usage** | 扩展激活以来的每模型累计 token 用量 |
| **MiniMax: Reset Usage** | 清零累计用量计数器 |
| **MiniMax: Show Pricing** | 在 Markdown 预览里打开价格表 |
| **MiniMax: Set Vision Proxy Model** | 选一个非 MiniMax 模型用作图片描述 |
| **MiniMax: 设置 Copilot 工具模型** | 两段式 QuickPick：先选 chat model，再勾选要覆盖的 `chat.*` 设置（`chat.utilitySmallModel` 给 Source Control 标题栏 ✨，`chat.utilityModel` 给标题/摘要） |
| **MiniMax: 切换 M3 思考模式** | 翻转 `minimax.thinking.enabled` 设置（仅 M3）。M2.x 永远保持开启。 |
| **MiniMax: 切换 M3 1M 上下文** | 把 M3 的 picker 窗口从安全默认值 512K 抬升到官方规格 1M。开启前会弹模态警告，说明 2 倍计费、需要销售开通 >512K 等事项；关闭则无确认。 |
| **MiniMax: 切换到国际版 API (`minimax.io/anthropic`)** | 切换到国际版 Anthropic 端点 |
| **MiniMax: 切换到国内版 API (`minimaxi.com/anthropic`)** | 切换到国内版 Anthropic 端点 |
| **MiniMax: Show Logs** | 聚焦 MiniMax Output 通道 |
| **MiniMax: Open Request Dumps Folder** | 打开 verbose 请求 dump 目录 |
| **MiniMax: 打开用量面板** | 打开用量面板（今日 / 7 日 / 30 日 token，按模型拆分，30 日柱状图，平台 `coding_plan/remains` 数据） |
| **MiniMax: 重新扫描 Claude Code 日志** | 强制重读配置的 Claude Code JSONL 日志目录。和面板的「立即重新扫描」按钮是同一路径。 |
| **MiniMax: 打开 Claude Code 日志目录** | 在 OS 文件管理器里打开解析后的 Claude Code 日志目录（默认 `~/.claude/projects`）。目录不存在会弹警告。 |
| **MiniMax: 复制 mmx-cli 官方安装指令** | 把[官方文档](https://platform.minimaxi.com/docs/token-plan/minimax-cli)的逐字三步安装指令复制到剪贴板。语言跟随当前端点（国内 → 简体中文，其它 → English）。扩展不替你跑任何安装 / 登录 / SKILL 命令。 |

## 故障排查

- **Picker 里没有模型** —— 跑 **MiniMax: Show Provider Status** 看 API Key 是否设置、可见模型列表是什么。
- **网关返回 HTTP 404** —— 确认 `minimax.apiBaseUrl` 指向 MiniMax 的 Anthropic 兼容主机（`api.minimaxi.com/anthropic` 或 `api.minimax.io/anthropic`），不是期望 OpenAI 协议的第三方代理。
- **提示「未配置 API Key」** —— 跑 **MiniMax: Set API Key**；Key 存在 SecretStorage 里，不在 `settings.json`。
- **Source Control 标题栏的 ✨ 没有走 MiniMax** —— 跑 **MiniMax: 设置 Copilot 工具模型** 选一个 MiniMax 模型写入 `chat.utilitySmallModel`，然后重启 Copilot Chat（或 reload 整个 VS Code）让新值生效。
- **M3 picker 切到 1M 后还是显示 512K** —— chat-info emitter 监听设置变化后会重建 picker 条目，但部分 Copilot Chat 版本会缓存到下一次消息。切一次模型，新窗口值就会生效。

## 许可证

SATA 2.0（Star And Thank Author License）。中文翻译见 [`LICENSE_zh`](./LICENSE_zh)。
