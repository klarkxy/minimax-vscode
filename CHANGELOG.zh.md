# 更新日志

> 英文版见 [CHANGELOG.md](./CHANGELOG.md)。

## 2.0.0 — 改名为 MiniMax Copilot + 移除思考强度选择器

这一版把市场化的改名和一轮行为修复打包发布。其中一部分对用户可见（UI 元素没了、Copilot 状态栏的上下文统计数字变正确了）；大部分是底层加固。

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
