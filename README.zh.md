# MiniMax Copilot

> English version: [README.md](./README.md)

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=klarkxy.minimax-vscode-copilot"><img src="https://img.shields.io/badge/VS%20Code%20Marketplace-安装-007ACC?logo=visualstudiocode&logoColor=white&style=for-the-badge" alt="从 VS Code 市场安装"></a>
</p>

<p align="center">
  在 Copilot Chat 模型选择器里选 <b>MiniMax M3 / M2.7</b>。
</p>

## 功能

- **M3 / M2.7 / M2.7-highspeed 进 Copilot Chat 模型选择器**，tooltip 里直接给价。M3 原生支持图片和视频；M2.7 系列在 Anthropic 兼容 API 上只支持文本和工具调用块。
- **M3 原生视频输入** — 直接发 `type: "video"` part，硬限 64 MB 请求体上限。
- **思考模式开关** — Anthropic 兼容端点只暴露二值 `disabled` / `adaptive` 开关，挂在 M3 picker 下拉菜单里。
- **驱动 Source Control ✨ 提交按钮** — 通过 `chat.utilitySmallModel` 把 Copilot 内置的 commit 信息生成路由到 MiniMax。
- **按模型调采样** — `temperature` / `topK` / `topP` / `frequencyPenalty` 按 model 独立覆盖。
- **累计用量追踪** — 跨会话累加每个模型的输入 / 输出 / 缓存 token。
- **用量面板** — 今日 / 7 日 / 30 日卡片，30 日柱状图，按模型拆分，平台 `coding_plan/remains`，外加 Claude Code JSONL 接入。
- **mmx-cli 状态检测** — 面板显示官方 MiniMax CLI / auth / SKILL 是否就绪；可一键复制安装 prompt 到剪贴板。
- **诊断能力** — 每请求分类、缓存命中统计、verbose 模式把每条请求 dump 到磁盘。

## 快速开始

### 环境要求

- **VS Code 1.111.0+**
- 已装并登录 **GitHub Copilot Chat**
- 一份 MiniMax [Token Plan](https://platform.minimaxi.com/user-center/payment/token-plan) 订阅 + API Key
- **VS Code Insiders** 才能用 proposed `languageModelThinkingPart` API 渲染 M3 思考折叠块

### 安装

1. 从 [VS Code 市场](https://marketplace.visualstudio.com/items?itemName=klarkxy.minimax-vscode-copilot) 安装（或 `npm run package` 从源码打 `.vsix`）。
2. 命令面板跑 **MiniMax: 添加 API Key**，给 Key 起个名字，再粘贴 Token Plan Key。扩展会自动识别 China / Global 区域并存到 SecretStorage。需要继续添加、切换、重命名或删除时，跑 **MiniMax: 管理 API Key**。
3. 打开 Copilot Chat，选 **MiniMax M3**（或 M2.7 / M2.7-highspeed）。
4. （可选）跑 **MiniMax: 设置 Copilot 工具模型**，把 Source Control ✨ 按钮路由到 MiniMax。

### 端点

激活时如果没设置端点，扩展会按 VS Code 显示语言自动选 `https://api.minimaxi.com/anthropic`。手动设过 URL 或跑过切换命令后，自动选择不再生效。

## 模型

| Model | 上下文（官方 / 生效） | 原生媒体输入 | 备注 |
| --- | ---: | --- | --- |
| **MiniMax M3** | 1,000,000 / 512,000 | ✅ 图片 + 视频 | 顶级编码；原生视频输入（MP4 / AVI / MOV / MKV）。生效值 512K 是因为 >512K 输入层还在限量发布。 |
| **MiniMax M2.7** | 204,800 | — | 自迭代，~60 TPS；只支持文本和工具调用内容块。 |
| **MiniMax M2.7-highspeed** | 204,800 | — | 同质量，~100 TPS；只支持文本和工具调用内容块。 |

拿到 >512K 权限的用户可以跑 **MiniMax: 切换 M3 1M 上下文** 把 cap 抬到 1M（开之前会弹模态警告说明 2× 计费）。完整规格见 [Supported models 页](https://platform.minimaxi.com/docs/guides/text-generation)。

**历史模型：** M2.5 / M2.1 / M2 不在默认 picker 里。

## 价格

价格以 **人民币（¥）** 计价。Picker tooltip 按当前 `minimax.apiBaseUrl` 渲染对应表格。最新数据见[定价页](https://platform.minimaxi.com/docs/guides/pricing-paygo)。

### 按量计费（每百万 token）

| Model | 输入 | 输出 | 缓存读取 | 缓存写入 |
| --- | ---: | ---: | ---: | ---: |
| **MiniMax M3 (≤512K 输入)** | ¥2.10 | ¥8.40 | ¥0.42 | — |
| **MiniMax M3 (>512K 输入，限量)** | ¥4.20 | ¥16.80 | ¥0.84 | — |
| **MiniMax M2.7** | ¥2.10 | ¥8.40 | ¥0.42 | ¥2.625 |
| **MiniMax M2.7-highspeed** | ¥4.20 | ¥16.80 | ¥0.42 | ¥2.625 |

>512K 输入层限量发布；最新进度见[定价页](https://platform.minimaxi.com/docs/guides/pricing-paygo)。Token Plan 订阅另外计费，见下节。

### Token Plan 订阅

一个 Subscription Key 覆盖 LLM + 语音 / 视频 / 音乐 / 图像，走共享额度池。按各端点的按量价从额度池里扣；购买的 Credits 兜底超出的部分。

| 档位 | 价格 | 配额窗口 | Agent 容量 |
| --- | ---: | --- | ---: |
| Starter / 轻量版 | ¥49 / 月 | 5 小时滚动 + 每周 | 3-4 agents |
| Pro / 高频版 | ¥119 / 月 | 5 小时滚动 + 每周 | 4-5 agents |
| Max / 重度版 | ¥469 / 月 | 5 小时滚动 + 每周 | 6-7 agents |

## 设置项

| 设置 | 默认 | 用途 |
| --- | --- | --- |
| `minimax.apiBaseUrl` | _auto-picked_ | Anthropic 兼容基础 URL。激活时若未设置会自动按语言选，默认 `https://api.minimaxi.com/anthropic`。 |
| `minimax.visibleModels` | _所有 M 档_ | 限制 picker 里出现的模型。 |
| `minimax.maxOutputTokens` | `0` | 输出上限。`0` 让模型自己决定。上下文窗口看 `minimax.enableM31MContext`。 |
| `minimax.enableM31MContext` | `false` | 把 M3 从 512K 抬到 1M 上下文。默认关闭；切换命令会先弹计费警告。 |
| `minimax.sampling` | `{}` | 按模型覆盖 `temperature` / `topP` / `topK` / `frequencyPenalty`。 |
| `minimax.experimental.modelDefPresets` | `{}` | 按模型逃生口，往请求体里塞自定义字段。 |
| `minimax.debugMode` | `minimal` | `minimal` / `metadata` / `verbose`。 |
| `minimax.modelIdOverrides` | `{}` | picker id → API id 映射（代理场景用）。 |
| `minimax.dashboard.includeClaudeCode` | `true` | 用量面板里 Claude Code JSONL section 的总开关。 |
| `minimax.claudeCode.logPath` | `~/.claude/projects` | Claude Code JSONL 日志的根目录。 |
| `minimax.claudeCode.pollIntervalMs` | `30000` | 扫描间隔（毫秒）。夹在 `[5000, 600000]` 之间。 |
| `minimax.experimental.stabilizeToolList` | `false` | 合成 preflight tool call 让上游 prompt cache 保持热。**Experimental.** |
| `minimax.claudeCode.allowedModels` | `MiniMax-M3 / M2.7 / M2.7-highspeed / M2.5 / M2.1 / M2` | Claude Code JSONL 接入的模型白名单。Claude Code 可能跟其他 Anthropic 兼容 provider 通信，这里只统计 MiniMax 相关行。 |

## 命令

| 命令 | 用途 |
| --- | --- |
| **MiniMax: 添加 API Key** | 起名新 Key，自动识别区域（China / Global / 未识别），存到 SecretStorage，并设为当前 |
| **MiniMax: 移除 API Key** | 移除当前已命名 Key（若池为空则回退到旧单 Key 槽） |
| **MiniMax: 管理 API Key** | 打开子菜单：添加 / 切换 / 重命名 / 删除 |
| **MiniMax: 切换 API Key** | 选一把已命名 Key 设为当前（同步其端点） |
| **MiniMax: 重命名 API Key** | 修改已命名 Key 的显示名 |
| **MiniMax: 删除 API Key** | 选择一把已命名 Key 删除（带二次确认） |
| **MiniMax: 设置 Copilot 工具模型** | 选一个 chat model 写到 `chat.utilitySmallModel`（可选 `chat.utilityModel`） |
| **MiniMax: 切换 M3 1M 上下文** | 把 M3 的 picker 抬到 1M（开之前弹计费警告） |
| **MiniMax: 切换到国际版 API (`minimax.io/anthropic`)** | 切换到国际版 Anthropic 端点 |
| **MiniMax: 切换到国内版 API (`minimaxi.com/anthropic`)** | 切换到国内版 Anthropic 端点 |
| **MiniMax: 显示日志** | 聚焦 MiniMax Output 通道 |
| **MiniMax: 打开请求 Dump 目录** | 打开 verbose 请求 dump 目录 |
| **MiniMax: 打开用量面板** | 打开用量面板 |
| **MiniMax: 重新扫描 Claude Code 日志** | 强制重读 Claude Code JSONL 日志目录 |
| **MiniMax: 打开 Claude Code 日志目录** | 在 OS 文件管理器里打开 Claude Code 日志目录 |
| **MiniMax: 复制 mmx-cli 官方安装指令** | 把官方安装 prompt 复制到剪贴板 |
| **MiniMax: 刷新 MiniMax Web Search MCP** | 重新解析 MCP provider，让 VS Code 在下次 spawn 时拿到最新的 API key / host |

## 故障排查

- **Picker 里没有模型** —— 跑 **MiniMax: 打开用量面板** 看 API Key 是否设置、可见模型列表。
- **网关返回 HTTP 404** —— 确认 `minimax.apiBaseUrl` 是 `https://api.minimaxi.com/anthropic`，不是期望 OpenAI 协议的第三方代理。
- **面板里出现 "密钥丢失" 警告** —— VS Code SecretStorage 里这条 Key 的存储被清掉了（设置重置 / 工作区迁移等）。跑 **MiniMax: 添加 API Key** 重新添加，或 **MiniMax: 删除 API Key** 把孤儿元数据清掉。面板会在对应条目旁显示 `secret missing` 标签。
- **提示「未配置 API Key」** —— 跑 **MiniMax: 添加 API Key**；Key 存在 SecretStorage 里，不在 `settings.json`。
- **Source Control 标题栏的 ✨ 没有走 MiniMax** —— 跑 **MiniMax: 设置 Copilot 工具模型** 选一个 MiniMax 模型写入 `chat.utilitySmallModel`，然后重启 Copilot Chat。
- **M3 picker 切到 1M 后还是显示 512K** —— 切一次模型，部分 Copilot Chat 版本会缓存到下一次消息。
