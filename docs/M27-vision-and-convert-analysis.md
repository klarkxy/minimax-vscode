# M2.7 视觉能力误报 & convert 层协议转换差异 — 分析报告

**日期**: 2026-06-26
**作者**: 由会话内多轮分析整理
**影响范围**: `src/models/registry.ts` · `src/provider/convert.ts` · `src/provider/request.ts` · README · CHANGELOG

---

## 一、问题背景

本仓库 (`minimax-vscode`) 是 VS Code 扩展,把 **MiniMax M3 / M2.7 / M2.7-highspeed** 注册为 GitHub Copilot Chat 模型,通过 `vscode.LanguageModelChatProvider` 接口提供。

**官方 M2.7 文档**明确写:

> "The M2.7, M2.5, M2.1, and M2 series support text and tool-call content blocks only; **they do not support image or video input**."

来源:[MiniMax Anthropic-API 文档](https://platform.minimax.io/docs/api-reference/text-anthropic-api)

但本仓库的模型注册表在 M2.7 / M2.7-highspeed 模板上声明了 `imageInput: true`,与官方能力不符,导致 M2.7 用户贴图时出现"图片直达 convert 层被转成 Anthropic `image` 块 → 网关 400 拒绝"。

本报告同时对比了本仓库的 convert 层与微软官方 `vscode-copilot-chat` BYOK 实现的差异,梳理出**已知的协议转换盲点**。

---

## 二、报告主题 A: M2.7 注册表 `imageInput` 误报

### 当前事实

`src/models/registry.ts:194-198` 与 `src/models/registry.ts:215-218`:

```ts
// M2.7
capabilities: {
  toolCalling: MINIMAX_TOOLS_LIMIT,
  imageInput: true,    // ← 与官方文档冲突
  thinking: true,
},

// M2.7-highspeed:同上
```

### 影响链

1. **picker 层**:Copilot Chat 选模型器看到 `imageInput: true` → 允许用户贴图 → 把 `LanguageModelDataPart(image/...)` 直接投给我们的 `provideLanguageModelChatResponse`。
2. **convert 层** (`src/provider/convert.ts:84-86` 与 `convert.ts:223-224`):读到 `imageInput: true` → `supportsImages = true` → 走 `buildImageBlock` → 拼成 Anthropic `{ type: "image", source: { ... } }` 块。
3. **MiniMax 网关**:M2.7 不接受 `image` 块 → **400 拒绝**。
4. **MCP fallback 路径不触发**:`convert.ts:251-254` 注释说"MCP image-understanding tool to have already replaced it",但这条路径只在 `supportsImages === false` 时才进 `continue`,因为注册表填了 true,M2.7 永远走不到。
5. **用户体验**:M2.7 / M2.7-highspeed 用户贴图 → 模型装作没看见 → 日志没线索 → 难定位。

### 修复方案 (A + C)

**A. 代码改动**:`src/models/registry.ts` 一行级 diff,删除两个 M2.7 模板的 `imageInput: true`:

```ts
capabilities: {
  toolCalling: MINIMAX_TOOLS_LIMIT,
  thinking: true,
  // imageInput 故意省略:见 registry.ts 注释,M2.x 不支持 image/video
},
```

**C. 文档与 UI 提示**:在 README / CHANGELOG / picker tooltip 写明:

- **M3**:原生 vision,贴图直接看。
- **M2.7 / M2.7-highspeed**:**Chat 模式下不渲染图片附件**;**Agent Mode 下用户需手动勾选 `understand_image` MCP 工具**,Copilot 会自动把图转文字描述再发给模型。

**`minimax-coding-plan-mcp` 包**实际暴露两个 tool:`web_search` + `understand_image`(图片理解)。来源:[PyPI `minimax-coding-plan-mcp`](https://pypi.org/project/minimax-coding-plan-mcp/)。当前 UI/文档只提 `web_search`(`src/runtime/mcp.ts:45-47`,`src/dashboard/messages.ts:208`),修复 M2.7 后需在 MCP 状态卡和 README 增加 `understand_image` 的提示语。

**附加**:补一个 unit test `test/models.test.ts`(若不存在):断言 `findModelById('MiniMax-M2.7').capabilities.imageInput === false`,防止回归。

### 决策点(待验证)

- **MCP `understand_image` 在非 Agent Mode / 未勾选时是否会被 Copilot 自动调用?** 待用户场景验证。若不会,A 方案会导致 M2.7 用户的图片附件**完全丢失**(比现状更差)。
- **缓解办法**:在 `src/provider/convert.ts` 的非多模态 `continue` 分支加一条 `logger.warn`,提示用户"切换 Agent Mode 并勾选 `understand_image`"。

---

## 三、报告主题 B: convert 层协议转换 vs. 微软官方 BYOK

### 共同点

| 维度 | 微软官方 `anthropicMessageConverter.ts` | 本仓库 `src/provider/convert.ts` |
|---|---|---|
| system 抽到顶层 | ✅ | ✅(多个用 `\n\n` 拼) |
| text 块 | ✅ | ✅ |
| tool_use / tool_result 块 | ✅ | ✅ |
| image 块(base64) | ✅ | ✅ |
| name 字段忽略 | ✅ | ✅ |
| 空文本跳过 | ✅ | ✅ |

### 关键差异

| 维度 | 微软官方 | 本仓库 | 影响 |
|---|---|---|---|
| **cache_control 透传** | ✅ 识别 `CacheControl` MIME,把前一个 content block 贴 `cache_control: { type: "ephemeral" }`;system 也能带 cache_control | ❌ **完全没处理**,遇到 `LanguageModelDataPart(CacheControl)` 静默吞掉 | **MiniMax 上游 prompt cache 命中率受损**;M3 / M2.7 都支持 5min/1h 缓存 |
| **thinking signature** | ✅ 透传 `metadata.signature`,跨轮 thinking 可验签"我自己的思路" | ❌ 只取 `value`,丢弃 `id` 和 `metadata.signature` | 跨轮 thinking 复用率下降 |
| **redacted_thinking** | ✅ 支持 | ❌ 不支持 | 加密 thinking 块被吞(场景罕见) |
| **同角色消息合并** | ✅ 显式 merge 步骤,避免连续 user-user | ❌ **无合并**,相邻同 role 直接转 4 条 → Anthropic 可能 400 | 隐患,目前 Copilot 多保证不连续,但缺防护 |
| **tool_result 结构化** | ✅ 递归保留嵌套图片 / cache_control 子项为 `ContentBlockParam[]` | ❌ **一律字符串化**:`TextPart` 拼接 + `DataPart` → `{ mime, data: "[binary]" }` | MCP 工具返回带图(如浏览器截图)的场景被压成占位符 |
| **媒体能力感知** | 不过滤,由 Copilot 用 `capabilities` 控制 picker | ✅ 按 `modelDef` 过滤(白名单 + `logger.warn`) | 功能差异,非冗余 |
| **request 阶段附加逻辑** | 无,纯协议转换 | ✅ `request.ts` 拼 thinking 开关 / 强制 `temperature=1` / `top_p` 丢弃 / `modelDefPresets` 合并 / cache diagnostics / request-dump | 业务功能,非冗余 |
| **tool description 注入** | 无 | ✅ `appendTerminalGuidanceToToolDescription` | 业务功能(向工具描述注入终端环境提示) |
| **架构分段** | 一段(`apiMessageToAnthropicMessage` → SDK 调用) | 三段(`convert.ts` → `request.ts` → `stream.ts`) | 服务于 dashboard / debug / token calibration 等功能 |

### 来源

- 官方:[vscode-copilot-chat `anthropicMessageConverter.ts`](https://raw.githubusercontent.com/microsoft/vscode-copilot-chat/main/src/extension/byok/common/anthropicMessageConverter.ts)
- 官方:[vscode-copilot-chat `anthropicProvider.ts`](https://raw.githubusercontent.com/microsoft/vscode-copilot-chat/main/src/extension/byok/vscode-node/anthropicProvider.ts)
- 本仓库:[src/provider/convert.ts](../src/provider/convert.ts)
- 本仓库:[src/provider/request.ts](../src/provider/request.ts)

### 结论:convert 层不是冗余,是接口契约

VS Code 的 `vscode.lm` API 给 BYOK provider 的输入是 `LanguageModelChatRequestMessage[]`(带 `role + parts[]` 的中立抽象),**不是 OpenAI 的 `messages + tools`,也不是 Anthropic 的 `system` + `messages`**。所有 BYOK provider —— 无论是微软自己的 Anthropic provider,还是我们的 MiniMax,还是 `deepseek-v4-for-copilot` —— 都得写这一层。

### 可优化的点(非本次任务,但值得后续追踪)

1. **cache_control 透传**:参照官方 converter 的 `apiContentToAnthropicContent` 行 38-50 实现。这是 prompt cache 命中率的根因之一 —— CLAUDE.md 反复强调 `minimax.experimental.stabilizeToolList` 保持工具列表稳定,但 cache_control 标记不通传等于"列表稳了但 marker 没贴",缓存依然不命中。
2. **thinking signature 透传**:同根问题。
3. **同角色消息合并**:补一个 merge pass,跟官方对齐,作为防御性兜底。

---

## 四、关联事实:其他未决项

1. **CLAUDE.md 与代码不一致**:CLAUDE.md "Provider layer" 段说"there is no `src/provider/vision/` module",但 `convert.ts` 行 240、254、259 的注释反复引用 `provider/vision` / `runtime/mcp.ts` 的视觉 fallback —— 这些引用都基于"注册表如实标记能力"这个前提。一旦按 A 方案修复,这些注释的语境才完整成立。

2. **MCP 包实际暴露 2 个 tool**:`web_search` + `understand_image`。当前 UI/文档只提 `web_search`(`src/runtime/mcp.ts:45-47`,`src/dashboard/messages.ts:208`)。修复 M2.7 后,需在 MCP 状态卡和 README 增加 `understand_image` 的提示语,告知 M2.7 用户在哪里启用它。

3. **`minimax-coding-plan-mcp` 是面向 Token Plan 用户的包**:跟本扩展用户群完全一致 —— 但 Copilot 是否会在 Agent Mode 自动发现并启用该 tool,取决于 VS Code 的 MCP UI 与 Copilot Chat 的工具调用策略,需在真实环境验证。

---

## 五、推荐行动项

| 优先级 | 任务 | 工作量 |
|---|---|---|
| P0 | `src/models/registry.ts`:删除 M2.7 / M2.7-highspeed 的 `imageInput: true`,加注释说明 | < 5 分钟 |
| P0 | `test/`:新增(或更新)`models.test.ts`,断言两个 M2.7 模型的 `imageInput === false` | 10 分钟 |
| P1 | `src/provider/convert.ts:255-260`:在非多模态分支的 `continue` 前加 `logger.warn`,提示 M2.x 用户切 Agent Mode + 勾 `understand_image` | 5 分钟 |
| P1 | README + CHANGELOG:说明 M3 / M2.x 的 vision 差异;MCP 状态卡加 `understand_image` 工具说明 | 30 分钟 |
| P2 | `src/provider/convert.ts`:补 cache_control 透传(参考官方 converter 行 38-50) | 1-2 小时,需单测 |
| P2 | `src/provider/convert.ts`:补同角色消息合并(参考官方 converter 行 107-122) | 30 分钟,需单测 |
| P3 | `src/provider/convert.ts`:补 thinking signature 透传 | 1 小时,需研究 MiniMax 网关是否消费 signature |

---

## 六、相关来源

- VS Code 官方 d.ts:`https://raw.githubusercontent.com/microsoft/vscode/main/src/vscode-dts/vscode.d.ts`
- VS Code 官方 proposed `languageModelThinkingPart.d.ts`:`https://raw.githubusercontent.com/microsoft/vscode/main/src/vscode-dts/vscode.proposed.languageModelThinkingPart.d.ts`
- MiniMax Anthropic-API 文档:`https://platform.minimax.io/docs/api-reference/text-anthropic-api`
- `minimax-coding-plan-mcp` PyPI:`https://pypi.org/project/minimax-coding-plan-mcp/`
- vscode-copilot-chat `anthropicProvider.ts`:`https://raw.githubusercontent.com/microsoft/vscode-copilot-chat/main/src/extension/byok/vscode-node/anthropicProvider.ts`
- vscode-copilot-chat `anthropicMessageConverter.ts`:`https://raw.githubusercontent.com/microsoft/vscode-copilot-chat/main/src/extension/byok/common/anthropicMessageConverter.ts`
