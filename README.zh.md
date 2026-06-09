<p align="center">
  <img src="icon/icon.png" alt="MiniMax Copilot" width="120">
</p>

<h1 align="center">MiniMax Copilot</h1>

<p align="center">
  <!-- marketplace-readme:remove-start -->
  <a href="https://marketplace.visualstudio.com/items?itemName=klarkxy.minimax-vscode-copilot"><img src="https://img.shields.io/badge/VS%20Code%20Marketplace-Install-007ACC?logo=visualstudiocode&logoColor=white&style=for-the-badge" alt="从 VS Code 市场安装"></a>
  <br/>
  <!-- marketplace-readme:remove-end -->
</p>

<p align="center">
  <a href="./README.md">English</a>
  ·
  <a href="./README.zh.md"><b>简体中文</b></a>
</p>

<p align="center">
  在 Copilot Chat 模型选择器里直接选 <b>MiniMax M3 / M2.7</b>——其余 Copilot 已经提供的一切都不变。
</p>

## 为什么需要这个扩展？

喜欢 MiniMax 的性价比，但又不想放弃 GitHub Copilot 的 Agent 模式、工具调用、精致的 UI？这个扩展把 **MiniMax M3 / M2.7** 接到 Copilot Chat 的模型选择器里——同时支持**视觉**、**思考模式**、**用量面板**，使用你自己的 Token Plan API Key。

- **不替换 Copilot，只是给它加血。** 没有新的侧边栏、没有要学的聊天界面——只是模型选择器里多了几行。
- **Agent 模式、工具调用、MCP 全部继续能用。** Copilot 整条流水线原样跑在 MiniMax 上。
- **BYOK，直接付给 MiniMax。** Token Plan Key 自己拿，账单、限速都是自己的。Key 存在 OS 钥匙串里，不落盘。
- **双语 UI**，跟着 VS Code 显示语言自动切换。

## 功能

### 模型选择器里的 M3 / M2.7 / M2.7-highspeed

三款模型与 GPT、Claude 等一起出现在 Copilot Chat 的模型选择器里。每一行的 tooltip 都带上下文窗口、输出上限、每百万 token 的价格。M3 原生支持图片 + 视频输入；M2.x 走透明的视觉代理，所以图片附件在所有模型上都能用。

### M3 原生视频输入

M3 接受内联 `type: "video"` 内容块（MP4 / AVI / MOV / MKV），以及通过 Files API 上传后用 `mm_file://{file_id}` 引用。请求层在请求体超过官方 64 MB 上限时，会用本地化错误拦下——你永远不会看到含糊的 HTTP 413。

### 思考模式开关

MiniMax 的 Anthropic 兼容端点只暴露二值开关 `thinking: { type: "disabled" | "adaptive" }`——没有任何「思考强度」旋钮。**MiniMax: 切换 M3 思考模式** 命令可以翻转 M3 的开关（M2.x 永远保持 adaptive，因为官方文档明确说 `disabled` 对 M2 系列是 no-op）。M3 关掉之后，`minimax.sampling` 里的 `temperature` / `topP` 才能真正生效。

### Git 提交信息生成

用暂存区 diff 自动起草 Conventional Commits + gitmoji 风格的提交信息。已有草稿会当作「待润色」输入让模型优化——不会另起炉灶。

### 累计用量追踪

按模型统计输入 / 输出 / 缓存读取的累计 token 数（跨会话累加），配 **MiniMax: Show Usage** 状态命令快速查看。

### 用量面板

一键 Webview 面板，显示今日 / 近 7 日 / 近 30 日的 token、30 日柱状图、按模型拆分，以及平台 `coding_plan/remains` 给的 5h 重置 / 周限额 / 套餐到期（需配 API Key）。面板底部有一个 **mmx-cli** 板块，仅显示官方 [`mmx`](https://github.com/MiniMax-AI/cli) 多模态命令行的探测状态——装包、登录、装 SKILL 全部交由用户（或用户的 AI Agent）自己完成。

### 按模型微调采样参数

按模型设置 `temperature` / `topK` 等，不用改代码。详见[设置项](#设置项)。

### 诊断能力

每个请求自动分类、缓存命中统计；verbose 模式下把完整请求 dump 到磁盘。

## 快速开始

### 环境要求

- **VS Code 1.111.0+**
- 安装并登录 **GitHub Copilot Chat**（本扩展以模型供应方身份注册）
- 一份 MiniMax [Token Plan](https://platform.minimax.io/user-center/payment/token-plan) 订阅 + API Key
- **VS Code Insiders** 才能用 proposed `languageModelThinkingPart` API 渲染思考折叠块
- 提交信息生成依赖 VS Code 自带的 Git 扩展，请保持启用

### 安装

1. 从 [VS Code 市场](https://marketplace.visualstudio.com/items?itemName=klarkxy.minimax-vscode-copilot) 安装（或 `npm run package` 从源码打 `.vsix`）。
2. 在命令面板运行 **MiniMax: Set API Key**，粘贴 Token Plan Key。
3. 打开 Copilot Chat，点模型选择器，选 **MiniMax M3**（或 M2.7 / M2.7-highspeed）。想比价可以跑 **MiniMax: Show Pricing**。
4. 直接在 Copilot Chat 里跟模型对话，或在 SCM 输入框里跑 **MiniMax: Generate Commit Message** 自动起草提交信息。

### 端点自动选择

激活时如果 `minimax.apiBaseUrl` 仍是默认值，扩展会按 VS Code 显示语言自动选择端点：

- `zh*`（含 `zh-cn` / `zh-tw` / `zh-hk` / `zh-sg` 等）→ 国内端点 `https://api.minimaxi.com/anthropic`。
- 其他语言 → 国际端点 `https://api.minimax.io/anthropic`。

手动改过 `minimax.apiBaseUrl` 或跑过 **MiniMax: Switch to Global/Chinese API** 之后，自动选择就**不再生效**。

## 模型

| 模型 | 上下文（规格 / 实际） | 图片输入 | 说明 |
| --- | ---: | --- | --- |
| **MiniMax M3** | 1,000,000 / 512,000 | ✅ 原生 | 当前主力编程模型；原生视频输入（MP4 / AVI / MOV / MKV）。实际窗口为 512K，因为 >512K 输入层仍在限量供应中。 |
| **MiniMax M2.7** | 204,800 | ✅ 视觉代理 | 自我迭代模型，约 60 TPS |
| **MiniMax M2.7-highspeed** | 204,800 | ✅ 视觉代理 | 效果不变，约 100 TPS |

"上下文"列第一个数是 MiniMax 官方文档 [支持模型](https://platform.minimaxi.com/docs/guides/text-generation) 的规格值；第二个数（如果有）是扩展在 Copilot 模型选择器里报告的**实际**窗口。两个数不一致时，UI 指示器按"实际"那个渲染——这样 VS Code 的"上下文窗口: N / M"指示器跟用户真实能塞进去的量保持一致。>512K 输入层限量供应的原因见 [定价页脚注](https://platform.minimaxi.com/docs/guides/pricing-paygo)。

已经获得 >512K 访问权限的用户可以通过 **MiniMax: 切换 M3 1M 上下文** 命令把 `minimax.enableM31MContext` 翻成 `true`——命令会先弹模态警告说明 2 倍计费、需要销售开通 >512K 等事项，然后才改设置。设置一改，picker 的窗口指示器会跟着刷新（不需要重启编辑器）。

**历史模型**：M2.5 / M2.1 / M2 已被 MiniMax 官方下线，本扩展不再收录。要用的话自行通过 `minimax.modelIdOverrides` + `minimax.visibleModels` 加回来。

## 价格

国内端点（`api.minimaxi.com`，人民币结算）和国际端点（`api.minimax.io`，美元结算）的费率不同。模型选择器 tooltip 和 **MiniMax: Show Pricing** 会按当前 `minimax.apiBaseUrl` 自动渲染对应的价格表。

### 按量计费（LLM，每百万 token）

> 国内表为 **CNY**，国际表为 **USD**。官方定价页覆盖所有模态；这里只列本扩展实际用到的 LLM 部分。

| 模型 | 输入 | 输出 | 缓存读取 | 缓存写入 |
| --- | ---: | ---: | ---: | ---: |
| **MiniMax M3 (≤512K 输入)** | $0.30 / ¥2.10 | $1.20 / ¥8.40 | $0.06 / ¥0.42 | — |
| **MiniMax M3 (>512K 输入，限量)** | $0.60 / ¥4.20 | $2.40 / ¥16.80 | $0.12 / ¥0.84 | — |
| **MiniMax M2.7** | $0.30 / ¥2.10 | $1.20 / ¥8.40 | $0.06 / ¥0.42 | $0.375 / ¥2.625 |
| **MiniMax M2.7-highspeed** | $0.60 / ¥4.20 | $2.40 / ¥16.80 | $0.06 / ¥0.42 | $0.375 / ¥2.625 |

M3 在所有输入层永久五折。>512K 输入层仍在限量供应，最新状态见 [定价页脚注](https://platform.minimaxi.com/docs/guides/pricing-paygo)。Token Plan 订阅另计，详见下方。

### Token Plan 订阅

Token Plan 订阅 Key 的价格（与上方按量计费分开计费）。一把订阅 Key 通过统一的用量进度条覆盖语言模型以外的语音 / 视频 / 音乐 / 图像端点。

| 套餐 | 价格 | 适合场景 | 额度窗口 | Agent 用量 |
| --- | ---: | --- | --- | ---: |
| Starter / 轻量版 | $20 / ¥49 每月 | Personal projects and prototyping | 5 小时滚动 + 周窗口 | 3-4 个 |
| Pro / 高频版 | $50 / ¥119 每月 | Daily coding with agents and multimodal work | 5 小时滚动 + 周窗口 | 4-5 个 |
| Max / 重度版 | $120 / ¥469 每月 | Heavy Agent workflows and extended sessions | 5 小时滚动 + 周窗口 | 6-7 个 |

套餐内 Token Plan 用量按对应按量计费价格扣减额度。额度耗尽后可：由已购积分自动补足、把订阅 Key 换成按量计费 API Key、或等待额度窗口重置（未用完的额度不结转到下一周期）。

## 设置项

| 设置项 | 默认值 | 用途 |
| --- | --- | --- |
| `minimax.apiBaseUrl` | `https://api.minimaxi.com/anthropic` | Anthropic 兼容 base URL。国际用户改用 `https://api.minimax.io/anthropic`。SDK 自动追加 `/v1/messages`。激活时若用户尚未配置，会按 VS Code 显示语言自动选择。 |
| `minimax.visibleModels` | _全部 M 系列_ | 限制模型选择器中出现的模型。 |
| `minimax.maxTokens` | `0` | 输出 token 上限，`0` 表示由模型自行决定。设正整数自行截断；请求层不再做客户端截断，上游 4xx 会原样冒泡。 |
| `minimax.enableM31MContext` | `false` | 把 **MiniMax-M3** 的 picker 窗口从安全默认值 512K 抬升到官方规格 1M。**默认关闭**。开启的前提是账号已通过销售开通 >512K 输入层，且 >512K 部分按 **2 倍费率** 计费（见[定价页](https://platform.minimaxi.com/docs/guides/pricing-paygo)）。建议用 **MiniMax: 切换 M3 1M 上下文** 命令——开之前会弹模态警告。 |
| `minimax.commitModel` | `MiniMax-M3` | **MiniMax: Generate Commit Message** 使用的模型。M3 和 M2.7 现在每 token 价格一致，所以默认走 M3 的前沿编码质量；想要更快草稿就改用 `MiniMax-M2.7-highspeed`。 |
| `minimax.sampling` | `{}` | 按模型设置 `temperature` / `topP` / `topK` / `frequencyPenalty`。详见[按模型调参](#按模型调参)。 |
| `minimax.experimental.modelDefPresets` | `{}` | 按模型往请求体里塞额外字段的逃生口。详见[按模型调参](#按模型调参)。 |
| `minimax.debugMode` | `minimal` | `minimal` / `metadata` / `verbose`（verbose 把每次请求 dump 到磁盘）。 |
| `minimax.modelIdOverrides` | _恒等映射_ | 把 picker ID 映射到 API ID（用于第三方代理）。 |
| `minimax.visionModel` | _自动_ | 非 M3 模型使用的视觉代理。对 M3 无效。 |
| `minimax.visionPrompt` | _见 package.json_ | 视觉代理 prompt。 |
| `minimax.experimental.stabilizeToolList` | `false` | 合成 preflight 工具调用以稳住上游 prompt cache。**实验性。** |

## 命令

| 命令 | 用途 |
| --- | --- |
| **MiniMax: Set API Key** | 把 Token Plan Key 存到 SecretStorage |
| **MiniMax: Clear API Key** | 删除已存储的 Key |
| **MiniMax: Show Provider Status** | 一屏看完当前配置和上一次请求的用量 |
| **MiniMax: Show Usage** | 各模型累计 token 用量（自扩展激活以来） |
| **MiniMax: Reset Usage** | 清空累计用量计数器 |
| **MiniMax: Show Pricing** | 在 Markdown 预览里打开价格表 |
| **MiniMax: Set Vision Proxy Model** | 选择用于图片描述的非 MiniMax 模型 |
| **MiniMax: Generate Commit Message** | 按暂存区 diff 自动生成 Conventional Commits 风格的提交信息 |
| **MiniMax: Set Commit Model** | 切换 **Generate Commit Message** 使用的模型 |
| **MiniMax: 切换 M3 思考模式** | 翻转 `minimax.thinking.enabled` 设置（仅 M3）。M2.x 永远保持开启。 |
| **MiniMax: 切换 M3 1M 上下文** | 把 M3 的 picker 窗口从安全默认值 512K 抬升到官方规格 1M。开启前会弹模态警告，说明 2 倍计费、需要销售开通 >512K 等事项；关闭则无确认。 |
| **MiniMax: Switch to Global API (`minimax.io/anthropic`)** | 切换到国际版 Anthropic 端点 |
| **MiniMax: Switch to Chinese API (`minimaxi.com/anthropic`)** | 切换到国内版 Anthropic 端点 |
| **MiniMax: Show Logs** | 聚焦 MiniMax 输出通道 |
| **MiniMax: Open Request Dumps Folder** | 在文件管理器中打开请求 dump 目录 |
| **MiniMax: 打开用量面板** | 打开用量 Dashboard（今日 / 7 日 / 30 日 token、模型拆分、30 日柱状图、平台 `coding_plan/remains` 数据） |
| **MiniMax: 复制 mmx-cli 官方安装指令** | 把 [官方入门文档](https://platform.minimaxi.com/docs/token-plan/minimax-cli) 原版的三步安装指令复制到剪贴板。语言随配置的端点（国内 → 简体中文，国际 → English）。本扩展**不**替你执行任何安装 / 登录 / SKILL 命令。 |

## 按模型调参

两个配置键让你不用改代码就能按模型 ID 微调采样参数和请求体：

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

## Git 提交信息生成

运行 **MiniMax: Generate Commit Message**（也在 SCM 输入框右上角的 **⋯** 菜单里）即可让 MiniMax 按暂存区内容起草提交信息。行为如下：

- 通过 VS Code 自带的 Git 扩展读取**已暂存**的改动；暂存区为空时退到工作区的未暂存改动。
- diff 上限 32 KB，文件列表最多 80 条，确保在 M2.7 / M3 的上下文里仍有余量。
- 输入框里已有草稿时，会把它当作「待润色」输入让模型优化，**不**会另起炉灶。
- 输出按 Conventional Commits 风格：`<type>(<scope>)<!>: <subject>`，可附带换行 + `- ` 项目符号的 body。`type` 只能从 `feat` / `fix` / `refactor` / `perf` / `docs` / `test` / `build` / `ci` / `chore` / `style` / `revert` 里选。
- 请求使用 `temperature: 0.2` 保证稳定可复现；`max_tokens` 锁定 256，避免 M3 的输出预算一下被烧光。

模型由 `minimax.commitModel` 决定（默认 `MiniMax-M3`）。M3 和 M2.7 现在每 token 价格一致，所以默认走 M3 的前沿编码质量；想要更快草稿就改用 `MiniMax-M2.7-highspeed`。

## 思考模式

MiniMax 的 Anthropic 兼容端点只接受一个二值开关 `thinking: { type: "disabled" | "adaptive" }`——**没有**任何「思考强度」旋钮（`budget_tokens` / `reasoning_effort` / `reasoning_split` 全部不支持）。本扩展为 **MiniMax-M3** 暴露了两种开关途径：

- **`minimax.thinking.enabled`** boolean 设置（默认 `true`）。
- **MiniMax: 切换 M3 思考模式** 命令——一键翻转设置并弹本地化提示，新状态一目了然。

M2.x 永远 `adaptive`——官方文档明确说 `disabled` 对 M2 系列是 no-op，所以开关对 M2.7 / M2.7-highspeed 是 no-op。

`thinking` 开启时强制 `temperature: 1` 并去掉 `top_p` 是 Anthropic 协议本身的约束。M3 专属的解锁方法：关掉开关，`minimax.sampling` 里的 `temperature` / `topP` 就会真正生效。M2.x 的推理过程仍以 `<think>…</think>` 形式出现在 `text` 内容块里，而不是 typed `thinking` block。

## 视频输入（M3 专属）

M3 在 Anthropic 兼容端点上原生支持视频内容块。支持的容器为 **MP4 / AVI / MOV(QuickTime) / MKV**。直接内联 base64 上限 **50 MB**；更大的视频请走官方 Files API 上传后用 `mm_file://{file_id}` 引用（Files API 上限 512 MB）。整请求体上限 **64 MB**，扩展会在 API 返回 413 之前用本地化错误拦下。

M2.x 没有 `videoInput` 能力，视频附件会被静默丢弃（带 warning 日志）。

## 用量面板

点击 VS Code 底部状态栏的 `$(graph) MiniMax …` 按钮，或在命令面板运行 **MiniMax: 打开用量面板**，即可在侧边栏打开一个 Webview 面板，数据来自两个源头：

- **本地 token 统计**：扩展发起的每一次请求都会写入持久化计数器，仪表盘按时间窗口聚合：今日 / 近 7 日 / 近 30 日三组卡片，分别列出输入、缓存读取、缓存写入、输出、请求数；下方是一张 30 日柱状图和按模型拆分的明细表。
- **平台 Token Plan**：配置了 API Key 时，仪表盘额外调用 `GET /v1/api/openplatform/coding_plan/remains`，展示 5 小时重置窗口、周限额、各模型额度表以及套餐到期日。

日常 token 计数器的右边还有两个状态栏项，不用打开 Dashboard 就能一眼看到额度：`$(bolt) 5h 73%`（5 小时窗口的剩余百分比）和 `$(calendar) Week 11%`（周限额的剩余百分比）。颜色直接走 `statusBarItem.remoteBackground` / `warningBackground` / `errorBackground` 这三个主题 token。未配置 API Key 时两项都是灰色破折号，hover 提示运行 **MiniMax: Set API Key**。

## mmx-cli（多模态伴生 CLI）

Dashboard 底部有一个板块，仅负责**显示**官方 [`mmx`](https://github.com/MiniMax-AI/cli) 命令行的探测状态。装好之后，Agent（Copilot Chat、Claude Code、Cursor …）就能用**同一把** Token Plan API Key 调用图像 / 视频 / 音乐 / 语音 / 视觉理解 / 网络检索。

扩展**只**检测下面三件事，**不**会替你执行任何装包 / 登录 / 装 SKILL 的命令：

- **可执行文件** 在 PATH 上（`mmx --version`）
- **`mmx auth`** 已登录（`mmx auth status`）
- **Agent SKILL** 已安装（在 `~/.claude/skills/minimax-cli/`、`~/.copilot/skills/minimax-cli/` 或 `~/.mmx/skills/minimax-cli/` 任意一个下面能找到 `SKILL.md`）

底部"复制官方安装指令"按钮（或命令面板的 `MiniMax: 复制 mmx-cli 官方安装指令`）把 [官方入门文档](https://platform.minimaxi.com/docs/token-plan/minimax-cli) 原版三步指令复制到剪贴板，**语言随端点配置自动选择**（`minimaxi.com` → 简体中文，否则 → English）。prompt 里只含 `sk-xxxxx` 占位符，请粘贴前手动把 Token Plan Key 填进去。装完后点"重新检测"，状态徽标会变绿。

## 故障排查

- **模型选择器里没有模型**：跑 **MiniMax: Show Provider Status** 检查 API Key 是否配好、`visibleModels` 是否过滤掉了。
- **网关返回 HTTP 404**：确认 `minimax.apiBaseUrl` 指向 MiniMax 的 Anthropic 兼容地址（`api.minimaxi.com/anthropic` 或 `api.minimax.io/anthropic`），不是走 OpenAI 协议的第三方代理。
- **提示「未配置 API Key」**：跑 **MiniMax: Set API Key**；Key 存在 SecretStorage 里，不在 `settings.json`。
- **生成的 commit message 是空的**：diff 可能超过 32 KB。跑 **MiniMax: Show Logs** 看生成器实际拿到了什么。
- **M3 picker 切到 1M 后还是显示 512K**：chat-info emitter 监听设置变化后会重建 picker 条目，但部分 Copilot Chat 版本会缓存到下一次消息。切一次模型，新窗口值就会生效。

## 许可证

SATA 2.0（Star And Thank Author License）。中文译本见 [`LICENSE_zh`](./LICENSE_zh)。