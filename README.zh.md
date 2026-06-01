# MiniMax (coding) for VS Code

> 🇨🇳 简体中文 | [🇬🇧 English documentation](./README.md)

为 GitHub Copilot 提供 MiniMax M 系列语言模型的 VS Code Chat Provider，使用 Token Plan API Key。本扩展只走 **Anthropic 兼容** 协议 —— 这是 MiniMax 官方推荐的新接入方式。

> 架构借鉴自 [`deepseek-v4-for-copilot`](https://github.com/Vizards/deepseek-v4-for-copilot)（MIT 协议），并针对 MiniMax Anthropic 兼容 API 进行了适配。

## 特性

- **Token Plan API Key** 来自 [platform.minimax.io](https://platform.minimax.io)，使用 VS Code SecretStorage 存储。
- **Anthropic 兼容协议** 直连 `https://api.minimaxi.com/anthropic`（国内）或 `https://api.minimax.io/anthropic`（国际），基于官方 [`@anthropic-ai/sdk`](https://www.npmjs.com/package/@anthropic-ai/sdk)。激活时**自动**根据 VS Code 显示语言（`zh*` 走国内端点，否则走国际端点）选择默认端点，已配置过的端点不会被覆盖。
- **覆盖官方推荐的 MiniMax 编程模型**：
  - **MiniMax M3** — 1M 上下文（>512K 输入层级当前限量供应，**实际可用 512K**），原生多模态，输出上限 512K，通过 `budget_tokens` 控制思考深度。
  - **MiniMax M2.7 / M2.7-highspeed** — 200K 上下文，纯文本，原生 Anthropic thinking。
- **工具调用** 支持实验性的 `stabilizeToolList` 开关 —— 合成 preflight 调用以保持上游 prompt cache 命中。
- **自适应 token 计数**，每次 API usage 上报都会校准。
- **丰富的诊断能力**：请求分类器、缓存命中统计、verbose 模式下的完整请求 dump、本地化错误消息 + 可点击的动作链接。
- **模型选择器里直接展示价格**：每个模型的每百万 token 成本（输入 / 输出 / 缓存读取 / 缓存写入）都会显示在 tooltip 里。运行 **MiniMax: Show Pricing** 打开完整价格表。
- **Replay markers** 用于跨会话的推理上下文。
- **双语 UI**（英文 + 简体中文），自动跟随 VS Code 显示语言。

## 环境要求

- VS Code 1.111.0+
- MiniMax Token Plan 订阅与 API Key
- 需要 VS Code Insiders 才能通过 proposed `languageModelThinkingPart` API 渲染思考折叠块

## 快速开始

1. 在 [Account / Token Plan](https://platform.minimax.io/user-center/payment/token-plan) 获取 Token Plan API Key。
2. 在命令面板运行 **MiniMax: Set API Key**。
3. 在 Copilot 模型选择器里选一个模型。运行 **MiniMax: Show Pricing** 查看价格对比。

## 配置项

| 设置项 | 默认值 | 用途 |
| --- | --- | --- |
| `minimax.apiBaseUrl` | `https://api.minimaxi.com/anthropic` | Anthropic 兼容 base URL。国际用户改用 `https://api.minimax.io/anthropic`。SDK 会自动追加 `/v1/messages`。激活时若用户尚未配置，会按 VS Code 显示语言自动选择。 |
| `minimax.visibleModels` | _全部 M 系列_ | 限制模型选择器中出现的模型。 |
| `minimax.maxTokens` | `0` | 输出 token 上限，`0` 表示由模型自行决定。硬上限：M2.7 系列是 131072，M3 是 512000。 |
| `minimax.debugMode` | `minimal` | `minimal` / `metadata` / `verbose`（verbose 把每次请求 dump 到磁盘）。 |
| `minimax.modelIdOverrides` | _恒等映射_ | 把 picker ID 映射到 API ID（用于第三方代理）。 |
| `minimax.visionModel` | _自动_ | 非 M3 模型使用的视觉代理。对 M3 无效。 |
| `minimax.visionPrompt` | _见 package.json_ | 视觉代理 prompt。 |
| `minimax.experimental.stabilizeToolList` | `false` | 合成 preflight 工具调用。**实验性。** |

## 命令

| 命令 | 用途 |
| --- | --- |
| `MiniMax: Set API Key` | 把 Token Plan Key 存到 SecretStorage |
| `MiniMax: Clear API Key` | 删除已存储的 Key |
| `MiniMax: Switch to Global API (minimax.io/anthropic)` | 切换到国际版 Anthropic 端点 |
| `MiniMax: Switch to Chinese API (minimaxi.com/anthropic)` | 切换到国内版 Anthropic 端点 |
| `MiniMax: Set Vision Proxy Model` | 选择用于图片描述的非 MiniMax 模型 |
| `MiniMax: Show Pricing` | 在 Markdown 预览里打开价格表 |
| `MiniMax: Show Logs` | 聚焦 MiniMax 输出通道 |
| `MiniMax: Open Request Dumps Folder` | 在文件管理器中打开请求 dump 目录 |

## 模型

| 模型 | 上下文 | 实际输入上限 | 输出上限 | 说明 |
| --- | ---: | ---: | ---: | --- |
| MiniMax M3 | 1,000,000 | 512,000 | 512,000 | 原生多模态 frontier 编程模型 |
| MiniMax M2.7 | 204,800 | 196,608 | 131,072 | 自我迭代模型 |
| MiniMax M2.7-highspeed | 204,800 | 196,608 | 131,072 | M2.7 高速版 |

> **M3 1M 上下文说明**：官方规格是 1M，但 >512K 输入层级当前处于「限时限量供应」状态，且 API 会拒绝 `max_tokens > 512_000` 的请求。因此实际可用输入上限为 512K，待官方完全开放后会自动放宽。
>
> **历史模型**：M2.5 / M2.1 / M2 已被 MiniMax 官方下线，本扩展不再收录。若仍有需求，可把对应 ID 加到 `minimax.modelIdOverrides` 与 `minimax.visibleModels` 后手工启用。

## 价格（每百万 token，人民币）

| 模型 | 输入 | 输出 | 缓存读取 | 缓存写入 |
| --- | ---: | ---: | ---: | ---: |
| MiniMax M3 (≤512K 输入) | 4.20 | 16.80 | 0.84 | — |
| MiniMax M3 (>512K 输入，限量) | 8.40 | 33.60 | 1.68 | — |
| MiniMax M2.7 | 2.10 | 8.40 | 0.42 | 2.625 |
| MiniMax M2.7-highspeed | 4.20 | 16.80 | 0.42 | 2.625 |

> M3 当前处于 7 天限时五折：输入 ¥2.10 / 输出 ¥8.40 / 缓存读取 ¥0.42。
> 价格数据来自 [platform.minimaxi.com/docs/guides/pricing-paygo](https://platform.minimaxi.com/docs/guides/pricing-paygo)。
> Token Plan 订阅另计。

## 思考模式

所有 M 系列模型都支持推理。模型选择器提供**思考模式**下拉菜单，共 4 档。在 Anthropic 兼容通道上对应：

| 档位 | M3 | M2.7 / M2.7-highspeed |
| --- | --- | --- |
| 关闭 | `thinking.type=disabled` | （不传 `thinking` 字段，走默认行为） |
| 轻量 | `thinking.type=enabled, budget_tokens=1024` | （默认） |
| 标准（默认） | `thinking.type=enabled, budget_tokens=8192` | （默认） |
| 深度 | `thinking.type=enabled, budget_tokens=32768` | （默认） |

## 端点自动选择

激活时如果 `minimax.apiBaseUrl` 仍是出厂默认，扩展会按 VS Code 显示语言自动选择端点：

- `zh*`（含 `zh-cn` / `zh-tw` / `zh-hk` / `zh-sg` 等）→ 国内端点 `https://api.minimaxi.com/anthropic`。
- 其他语言 → 国际端点 `https://api.minimax.io/anthropic`。

一旦你手动改过 `minimax.apiBaseUrl` 或运行过 `switchToGlobal` / `switchToChina` 命令，自动选择就**不再覆盖**你的选择。

## 许可证

SATA 2.0（Star And Thank Author License）。中文译本见 [`LICENSE_zh`](./LICENSE_zh)。
