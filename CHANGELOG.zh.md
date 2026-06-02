# 更新日志

> 英文版见 [CHANGELOG.md](./CHANGELOG.md)。

## 2.1.2 — 状态栏瘦身、Dashboard 重排、CI 修复

三条线：状态栏只留两项平台额度；Dashboard 的 Token Plan 区重排后
进度条和重置时间对齐；release-please workflow 修好后 CI 重新能跑。

### 变更

- **状态栏去掉了“今日 token”项。** 原来 `$(graph) MiniMax 1.2k`
  这个槽位没了。今日 token 总量去 Dashboard（**MiniMax: Open Usage Dashboard**）
  和 **MiniMax: Show Usage** 命令里看。
- **状态栏改为显示“已用%”。** `5h 54%` / `Week 88%` 表示“已用 54%
  / 88%”，色阶阈值（≥85% 红、60-85% 黄、<60% 绿）跟 Dashboard
  进度条一致，数字颜色和直觉对得上。Tooltip 里仍保留
  `已用 X / Y`、`剩余 Z%` 完整对账信息。
- **额度状态栏颜色改为纯文字色。** `$(bolt) 5h …` 和
  `$(calendar) Week …` 现在只换文字色，不再染底色，跟状态栏
  整体融为一体。
- **Dashboard Token Plan 区重排。** 5h / 周两窗口各一张卡：
  进度条上显示百分比，重置时间挪到标题右端成小药丸。原来的
  孤儿周限额进度条、重复的 “Used: X / Y” 数据卡、按模型明细表
  全部移除。卡片标题统一为 `GENERAL · 5h` / `周额度`，
  配对阅读自然。
- **清理了不再使用的 i18n key**（原本只服务于被删的状态栏项）：
  `status.tooltip`、`status.tooltipEmpty`、`status.tooltipActive`、
  以及重复的 `status.tooltipActive_zh`。
- **修复 release-please workflow**。`.github/workflows/release.yml`
  之前在 step `if:` 里引用了 `secrets.*`，被 GitHub Actions 表达式
  语法拒绝，整条 workflow 一直 validate 失败。改成只用 `vars.*`
  判定，secret 是否存在移到 step 内部的 bash 守卫里。
- **从 `release.yml` 里移除了市场推送步骤。** 之前 `Publish to
  VS Code Marketplace` 和 `Publish to Open VSX` 两个 step 是用
  `vars.PUBLISH_*` 开关守着的，但开关从来没被设过，纯死代码。
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
里 4 个分项独立显示，缓存占了多少一眼就能看到。

## 2.1.1 — 双币种价格表 + token 环形图

价格表按 `minimax.apiBaseUrl` 与 `vscode.env.language` 自动在 USD /
CNY 之间切换，用量面板的「local」卡片也重画成了带百分比的环形图。

### 新增功能

- **USD / CNY 双币种价格支持。** 原来单一的 CNY 价表拆成
  `PRICING_CNY` 和 `PRICING_USD`，新增的 `pickPricingTable()` helper 在
  运行时按下面的规则选表：
  - `apiBaseUrl` 里包含 `minimaxi.com` → 强制 CNY (¥)，无视语言环境。
  - 否则，中文 locale（`zh`、`zh-*`、`zh_*`）→ CNY (¥)。
  - 其它全部 → USD ($)。
  - `MODELS` 改名 `MODEL_TEMPLATES`，新增 `getModels(baseUrl)` 在运行时
    把 `pricing` 字段从选中的表里展开。所有展示价格的 UI 入口
    （模型选择器 tooltip、**MiniMax: Show Pricing** 命令、commit model
    选择器、replay marker）都改成走 `getModels()`，保证币种符号与用户的
    实际结算币种一致。
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
  - `$(bolt) 5h 73%` — 5h 窗口的**剩余**百分比。
  - `$(calendar) Week 11%` — 周限额的**剩余**百分比（平台报“无限”
    时显示 `∞`）。
  - 颜色走内置的 `statusBarItem.remoteBackground` /
    `warningBackground` / `errorBackground` 三个主题 token
    （剩得多则绿、少则红），亮色 / 暗色主题都跟得上。
  - hover 显示 `X / Y · 重置 Hh Mm` 简报，跟 Dashboard 的卡片一致
    （平台未报 total 时不显示 `X / Y`，跟下面那条修复同源）。
    点击直接打开 Dashboard。
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
     自身带 30 秒最小间隔，所以用户连续发 10 轮对话也最多只触发
     一次平台拉取。
  5. Dashboard 打开 / Refresh / 切到可见（原有路径，**也**改成走共享
     cache，所以 Dashboard 与状态栏一定渲染同一份快照）。
  完全不装 `setInterval`，空闲时零后台网络流量。
  `DashboardPanel.refresh()` 也从直接调 `fetchPlanUsage` 改成走
  `planCache.refresh()`，两个消费者看到的快照永远一致。

### 修复

- **用量面板的 local 卡片重画为环形图。** 原来一排 key-value 列表
  （input / cache read / cache write / output）现在改为 `conic-gradient`
  渲染的环形图 + 带配色的 legend，同时显示每种 token 的数量与占比。
  配色复用了面板里已经在用的 `var(--accent)` / `var(--good)` /
  `var(--warn)` / `var(--bad)` 四个 token，所以颜色会跟随主题自动适配。
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
  多算一次。1M 系统 prompt + 一天 50 轮对话经常被记成 50M 幻影 token。
  `totalTokens()` 现在只算 `input + output`；另增 `totalBilledTokens()`
  helper 返回 `input + cacheWrite + cacheRead + output` 这个"全口径"
  数字，给需要乘价格表的场景用。Dashboard 圆环中心显示净额，legend
  里仍把 cache 拆开显示（这样用户能看出这一天有多少流量走了缓存）。
- **状态栏的今日 token 项被删了。** 原来 `$(graph) MiniMax 43.66M`
  那一项去掉，原因是：（1）这个数字其实是 cache 重复统计 bug 的副
  作用，会误导人；（2）跟 5h / 周限额挤一起太占空间。今日 token
  总数现在住在 Dashboard（**MiniMax: Open Usage Dashboard**）和
  **MiniMax: Show Usage** 命令里，状态栏只保留 2 个平台额度项。
- **额度状态栏颜色改为纯文字色。** `$(bolt) 5h …` 和
  `$(calendar) Week …` 这两个项现在只换文字色（绿/黄/红），不再染
  底色，跟状态栏整体融为一体。
## 2.0.0 — 改名为 MiniMax Copilot + 移除思考强度选择器

这一版把市场化的改名和一轮行为修复打包发布。其中一部分对用户可见（UI 元素没了、Copilot 状态栏的上下文统计数字变正确了）；大部分是底层加固。

### 新增功能

- **用量面板（Usage Dashboard）** —— 新增命令 **`MiniMax: Open Usage Dashboard`**，并在状态栏增加可点击入口，展示今日 / 近 7 日 / 近 30 日的 token 用量（输入、缓存读取、缓存写入、输出、请求数），数据来源是本地累计计数器。配置了 API Key 时，仪表盘还会顺带从平台 `coding_plan/remains` 拉取 5h 重置 / 周限额 / 套餐到期时间，未配置时优雅降级。用量计数器现在会正确累加 `requests`（之前没有），并按日分桶，让仪表盘的 30 日柱状图能跨过零点正确累加。

### 破坏性变更

- **Marketplace 展示名改为 MiniMax Copilot**，让「为 GitHub Copilot 提供 MiniMax 模型」这层意图一眼可读。扩展 ID（`klarkxy.minimax-vscode`）、publisher、命令名、配置项、walkthrough、SecretStorage key **均不变**——已安装用户原地升级，所有配置原封不动。
- **移除模型选择器里的四档「思考模式」下拉菜单。** MiniMax 的 Anthropic 兼容端点只接受一个二值开关
  `thinking: { type: "disabled" | "adaptive" }`（详见
  [OpenAPI 规范](https://platform.minimaxi.com/docs/api-reference/text/api/openapi-chat-anthropic.json)），根本没有
  `budget_tokens` 字段、没有 `reasoning_effort` URL 参数、Anthropic 兼容通道上也没有 `reasoning_split` 字段。官方的 `Mini-Agent` 参考实现也印证了这一点：写死
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
  `minimax.experimental.modelDefPresets` 对象，把任意键合并进 Anthropic 请求体——
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
  `git --no-pager diff HEAD --diff-filter=d`），并有 16 MiB / 10 秒的硬上限。
  spawn 错误优雅退化，prompt 至少还能给出文件列表。

### 备注

- 1.6.0 → 2.0.0 的版本号提升**部分是表面改动**（改名）**部分是实质改动**（以上所有项）。如果你在 settings sync、DevOps 脚本里硬编码了 `klarkxy.minimax-vscode`，ID 不变，放心用。
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
- **端点自动选择**：首次激活时，若 `minimax.apiBaseUrl` 仍是出厂默认，扩展会按 `vscode.env.language` 自动选择端点（`zh*` → 国内，其它 → 国际）。该选择会持久化，任何后续的手动修改都将永久覆盖。

## 1.5.0 — 用 deepseek-v4-for-copilot 架构重构

（沿用之前的描述，详见 README 和 git 历史）
