# MiniMax Copilot

<!-- marketplace-readme:remove-start -->
> 🇨🇳 简体中文 | [🇬🇧 English documentation](./README.md)
<!-- marketplace-readme:remove-end -->

为 [GitHub Copilot Chat](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot-chat)
增加 **MiniMax M3 / M2.7** 模型供应方的 VS Code 扩展。用 [Token Plan](https://platform.minimax.io/user-center/payment/token-plan)
API Key 就能直接用。

> 架构借鉴自 [`deepseek-v4-for-copilot`](https://github.com/Vizards/deepseek-v4-for-copilot)（MIT 协议），并针对 MiniMax Anthropic 兼容 API 进行了适配。

## 能做什么

- **M3 / M2.7 / M2.7-highspeed** 出现在 Copilot 模型选择器里，每个模型都显示上下文、输出上限和价格。
- **M3 原生多模态**（图片直传）；M2.x 系列走视觉代理 fallback，图片附件在所有模型上都能用。
- **工具调用**，可选实验性 `stabilizeToolList` 开关来稳住上游 prompt cache。
- **Git commit message 生成**，挂在 SCM 输入框上。默认 Conventional Commits + gitmoji 风格，会把已有草稿当作「待润色」输入。
- **按模型微调采样参数**（`temperature` / `topK` 等），不用改代码。
- **累计用量统计**（输入 / 输出 / 缓存读取 token 跨会话累加），有专门的状态命令查看。
- **用量面板**：状态栏新增可点击入口 + 命令面板 `MiniMax: 打开用量面板`，一屏看完今日 / 近 7 日 / 近 30 日 token 用量、30 日柱状图、按模型拆分明细，以及平台 `coding_plan/remains` 提供的 5h 重置 / 周限额 / 套餐到期（未配置 API Key 时降级为仅本地数据）。
- **诊断能力**：每个请求自动分类、缓存命中统计；verbose 模式下把完整请求 dump 到磁盘。
- **双语 UI**（英文 + 简体中文），跟随 VS Code 显示语言自动切换。

## 环境要求

- VS Code 1.111.0+
- MiniMax [Token Plan](https://platform.minimax.io/user-center/payment/token-plan) 订阅与 API Key
- 需要 VS Code Insiders 才能通过 proposed `languageModelThinkingPart` API 渲染思考折叠块
- 提交信息生成依赖 VS Code 自带的 Git 扩展，请保持启用

## 快速开始

1. 在 [Account / Token Plan](https://platform.minimax.io/user-center/payment/token-plan) 拿到 Token Plan API Key。
2. 在命令面板运行 **MiniMax: Set API Key**。
3. 在 Copilot 模型选择器里选一个模型。运行 **MiniMax: Show Pricing** 查看价格对比。
4. 完成——直接在 Copilot Chat 里跟模型对话，或者在 SCM 输入框里用 **MiniMax: Generate Commit Message**。

## 模型

| 模型 | 上下文 | 实际输入上限 | 输出上限 | 图片输入 | 说明 |
| --- | ---: | ---: | ---: | --- | --- |
| MiniMax M3 | 1,000,000 | 512,000 | 512,000 | ✅ 原生 | Frontier 编程模型 |
| MiniMax M2.7 | 204,800 | 196,608 | 131,072 | ✅ 视觉代理 | 自我迭代模型，约 60 TPS |
| MiniMax M2.7-highspeed | 204,800 | 196,608 | 131,072 | ✅ 视觉代理 | 效果不变，约 100 TPS |

> **M3 1M 上下文说明**：官方规格是 1M，但 >512K 输入层级目前限量供应，且 API 会拒绝 `max_tokens > 512_000` 的请求。实际可用输入上限锁定 512K，待官方全量开放后会自动放宽。
>
> **历史模型**：M2.5 / M2.1 / M2 已被 MiniMax 官方下线，本扩展不再收录。如有需求可自行通过 `minimax.modelIdOverrides` + `minimax.visibleModels` 加回来。

## 价格（每百万 token，人民币）

| 模型 | 输入 | 输出 | 缓存读取 | 缓存写入 |
| --- | ---: | ---: | ---: | ---: |
| MiniMax M3 (≤512K 输入) | 4.20 | 16.80 | 0.84 | — |
| MiniMax M3 (>512K 输入，限量) | 8.40 | 33.60 | 1.68 | — |
| MiniMax M2.7 | 2.10 | 8.40 | 0.42 | 2.625 |
| MiniMax M2.7-highspeed | 4.20 | 16.80 | 0.42 | 2.625 |

> M3 当前处于 7 天限时五折：输入 ¥2.10 / 输出 ¥8.40 / 缓存读取 ¥0.42。价格数据来自
> [platform.minimaxi.com/docs/guides/pricing-paygo](https://platform.minimaxi.com/docs/guides/pricing-paygo)。
> Token Plan 订阅另计。

## 配置项

| 设置项 | 默认值 | 用途 |
| --- | --- | --- |
| `minimax.apiBaseUrl` | `https://api.minimaxi.com/anthropic` | Anthropic 兼容 base URL。国际用户改用 `https://api.minimax.io/anthropic`。SDK 自动追加 `/v1/messages`。激活时若用户尚未配置，会按 VS Code 显示语言自动选择。 |
| `minimax.visibleModels` | _全部 M 系列_ | 限制模型选择器中出现的模型。 |
| `minimax.maxTokens` | `0` | 输出 token 上限，`0` 表示由模型自行决定。硬上限：M2.7 系列 131072，M3 是 512000。 |
| `minimax.commitModel` | `MiniMax-M2.7` | **MiniMax: Generate Commit Message** 使用的模型。 |
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
| **MiniMax: Switch to Global API (`minimax.io/anthropic`)** | 切换到国际版 Anthropic 端点 |
| **MiniMax: Switch to Chinese API (`minimaxi.com/anthropic`)** | 切换到国内版 Anthropic 端点 |
| **MiniMax: Show Logs** | 聚焦 MiniMax 输出通道 |
| **MiniMax: Open Request Dumps Folder** | 在文件管理器中打开请求 dump 目录 |
| **MiniMax: 打开用量面板** | 打开用量 Dashboard（今日 / 7 日 / 30 日 token、模型拆分、30 日柱状图、平台 `coding_plan/remains` 数据） |

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

- 模型处于 `thinking: adaptive` 模式时，`temperature` 和 `topP` 会被忽略（Anthropic 约束）。
- `topK` 和 `frequencyPenalty` 永远生效。
- `modelDefPresets` 是逃生口——你塞的任意键都会原样合进请求体（标准字段之后）。11 个 reserved 键会被拒绝覆盖；`tools` 是与现有工具数组合并而非替换。

## Git 提交信息生成

运行 **MiniMax: Generate Commit Message**（也在 SCM 输入框右上角的 **⋯** 菜单里）即可让 MiniMax 按暂存区内容自动起草提交信息。行为如下：

- 通过 VS Code 自带的 Git 扩展读取**已暂存**的改动；如果暂存区为空，就退回到工作区的未暂存改动。
- diff 上限 32 KB，文件列表最多 80 条，确保在 M2.7 的 200K 上下文里仍有余量。
- 如果输入框里已有草稿，会把它当作「待润色」输入，让模型在原意基础上优化，**不会**另起炉灶。
- 输出按 Conventional Commits 风格：`<type>(<scope>)<!>: <subject>`，可附带换行 + `- ` 项目符号的 body。`type` 只能从 `feat` / `fix` / `refactor` / `perf` / `docs` / `test` / `build` / `ci` / `chore` / `style` / `revert` 里选。
- 请求使用 `temperature: 0.2` 保证稳定可复现；`max_tokens` 锁定 256，避免一个 512K 模型误把输出预算烧光。

模型由 `minimax.commitModel` 决定（默认 `MiniMax-M2.7`）。当 diff 涉及复杂迁移或重构时，可手动切到 `MiniMax-M3` 获取更强的推理。

## 思考模式

MiniMax 的 Anthropic 兼容端点只接受一个二值开关
`thinking: { type: "disabled" | "adaptive" }`——**没有**任何「思考强度」旋钮。本扩展对支持 thinking 的模型永远发 `adaptive`、M2.x 系列不发送该字段（它们的推理过程以 `<think>…</think>` 形式直接出现在 `text` 内容块里）。`thinking` 开启时强制 `temperature: 1` 并去掉 `top_p` 是 Anthropic 协议本身的约束，不是我们加的限制。

## 用量面板

点击 VS Code 底部状态栏的 `$(graph) MiniMax …` 按钮，或在命令面板运行 **MiniMax: 打开用量面板**，即可在侧边栏打开一个 Webview 面板，数据来自两个源头：

- **本地 token 统计** —— 扩展发起的每一次请求都会写入持久化计数器，仪表盘把数据按时间窗口聚合：今日 / 近 7 日 / 近 30 日三组卡片，分别列出输入、缓存读取、缓存写入、输出、请求数；下方是一张 30 日柱状图和按模型拆分的明细表。计数器是**实时**的：每次新的 chat 请求结束后，仪表盘会自动重渲染，不需要手动刷新。
- **平台 Token Plan** —— 配置了 API Key 时，仪表盘额外调用 `GET /v1/api/openplatform/coding_plan/remains`，展示 5 小时重置窗口、周限额、各模型额度表以及套餐到期日。调用失败（401 / 网络异常 / 响应格式异常）会显示一个黄色提示条，但**不会**影响上方本地数据的准确性。Host（`minimaxi.com` vs `minimax.io`）会按 `minimax.apiBaseUrl` 自动选择。

面板里有 **清空计数器** 按钮，会弹确认框后清空本地 Memento；平台侧数据无法在扩展里清零。

## 端点自动选择

激活时如果 `minimax.apiBaseUrl` 仍是出厂默认，扩展会按 VS Code 显示语言自动选择端点：

- `zh*`（含 `zh-cn` / `zh-tw` / `zh-hk` / `zh-sg` 等）→ 国内端点 `https://api.minimaxi.com/anthropic`。
- 其他语言 → 国际端点 `https://api.minimax.io/anthropic`。

一旦你手动改过 `minimax.apiBaseUrl` 或运行过 `MiniMax: Switch to Global/Chinese API` 命令，自动选择就**不再覆盖**你的选择。

## 故障排查

- **模型选择器里没有模型** —— 运行 **MiniMax: Show Provider Status** 检查 API Key 是否配置、`visibleModels` 是否过滤掉了。
- **HTTP 404 from the gateway** —— 确认 `minimax.apiBaseUrl` 指向 MiniMax 的 Anthropic 兼容地址（`api.minimaxi.com/anthropic` 或 `api.minimax.io/anthropic`），不是走 OpenAI 协议的第三方代理。
- **「未配置 API Key」** —— 运行 **MiniMax: Set API Key**；Key 存在 SecretStorage 里，不在 `settings.json`。
- **生成的 commit message 是空的** —— diff 可能超过 32 KB。运行 **MiniMax: Show Logs** 看生成器实际拿到了什么。

## 许可证

SATA 2.0（Star And Thank Author License）。中文译本见 [`LICENSE_zh`](./LICENSE_zh)。
