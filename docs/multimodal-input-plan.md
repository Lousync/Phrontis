# 多模态输入（对话图片）实现方案

> **状态**：统一助手（v3.41.0）与 AI 教学（v3.42.0）均已落码
> **版本**：`v3.41.0`（统一助手）/ `v3.42.0`（AI 教学）
> **关联**：`docs/agent-harness-alignment-plan.md` §9 P2；`resources/help/AI助手.md`；原型 `tmp/assistant-multimodal-proto/index.html`

---

## 1. 已确认的需求

- 图片来源：粘贴（Ctrl+V）、拖入、附件按钮选文件。
- 当前模型策略：**只认当前模型**，只有视觉模型且协议受支持时才允许发图；不自动切换、不偷偷换模型。
- 历史：图片随消息保留，后续轮次仍可追问；每次请求最多回带最近 8 张。
- 生效面：统一助手 + AI 教学（同一套 hook / 组件 / 提示口径）。

---

## 2. 数据设计

- 图片文件：`<vault>/.knowbase/agent/images/<sessionId>/<id>.<ext>`（随仓库走、不进索引）。
- 消息行：`images?: AgentImageRef[]`（`relPath / mime / name / w / h / bytes`），**不存 base64**。
- 发送请求：`AgentChatRequest.images?: ChatImageInput[]`（data URL，主进程先校验模型能力再落盘）。
- 历史请求：`buildHistoryWithImages()` 把用户消息转成 OpenAI 多模态 content 数组；最多 8 张，新→旧。
- 删除：删消息 / 删会话时清理对应图片文件。

---

## 3. 协议支持

| 协议族 | 图片线格式 | 落点 |
|---|---|---|
| chat（OpenAI 兼容） | `content: [{type:'text'},{type:'image_url'}]` | 原样透传 |
| messages（Anthropic） | `{type:'image', source:{type:'base64',...}}` | `buildAnthropicBody` 转换 |
| responses（OpenAI） | `content: [{type:'input_text'},{type:'input_image',image_url}]` | `buildResponsesInput` 转换 |

Ollama 暂不支持（无协议族）。视觉能力判定：模型名命中 `VISION_MODEL_RE` + 供应商可用 + 协议族受支持；**不做自动挑选**。

---

## 4. 渲染层

- `src/lib/useComposerImages.ts`：粘贴 / 拖入 / 选文件，压缩到最长边 2048px、JPEG、≤2MB，最多 4 张。
- `ComposerImageStrip`：输入区图片胶囊 + 移除。
- `ChatImageThumbs`：用户消息缩略图；乐观消息用 dataUrl，落库消息按 relPath 走既有图片通道。
- 模型能力：`llmVisionChatCapable(spec)` 异步检测；不支持时图片区出现提示、发送禁用。
- 统一助手：`ChatBody` 接入按钮 / 粘贴 / 拖入 / 胶囊 / 提示；`useAssistantChat.send` 发送图片并在乐观消息中回显。

---

## 5. 主进程

- `assistantChatImagesPure.ts`：data URL 校验、数量 / 大小上限、OpenAI 内容块、文本/图片 token 估算。
- `assistantChatImages.ts`：落盘、读回 data URL、历史组装 / 8 张裁剪、删消息 / 删会话清理。
- `agentService`：发送前 `visionChatCapable` 校验；`saveChatImages` 后 append 用户消息；历史装配带图片；删除消息 / 会话时清图。
- `llmService`：`ChatMessage.content` 支持数组；Anthropic 图片块转换；`visionChatCapable` + IPC。
- `llmProtocolPure`：Responses `input_image` 转换。
- `agentContextBudget`：多模态内容 token 估算（图片按 1200 固定值）。

---

## 6. 契约与验收

- `.AGENT/scripts/ai-harness/verify-multimodal-input.mjs`（56 项）：data URL / 上限 / 内容块 / 历史裁剪 / 协议转换 / 主进程接线 / 渲染层接线。
- 手工验收：
  1. 当前模型为视觉模型时粘贴图片 → 输入区出现缩略图；发送后用户气泡显示图片。
  2. 当前模型为文本模型时粘贴 → 出现「当前模型不支持图片」提示，发送禁用。
  3. 后续追问「图里是什么」→ 模型仍能看到历史图片。
  4. 删除该条消息 / 整个会话 → `.knowbase/agent/images/<会话>/` 下文件被清理。
  5. 切到 Anthropic / Responses 视觉模型 → 图片仍可发送。

---

## 7. 接入记录（AI 教学面，v3.42.0）

- 统一助手先落码（v3.41.0）；AI 教学面因同文件被并行工作占用，顺延到 v3.42.0，接入方式与既定方案一致：复用 `useComposerImages` + `ComposerImageStrip` + `ChatImageThumbs`，在 `sendText` / 乐观消息 / `agentChat` 三个点补 `images`，模型能力用 `llmVisionChatCapable(convoModel || '')` 判定。
- 差异点：教学面带图时不走斜杠指令通道（图片只能是普通对话消息）；只读段（`courseReadonly`）仍可发图，因为课程助手对话本身不关闭。
- 契约脚本 `verify-multimodal-input.mjs` 补 9 项教学面接线断言（合计 65 项）。
