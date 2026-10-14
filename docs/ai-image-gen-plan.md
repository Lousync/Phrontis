# 对话内生图（`/生图`）· 实现方案

> **状态**：**阶段一（普通对话面）与阶段二（AI 教学面）均已落码**（v3.6.0，见 §12 落码记录；两阶段各 9 条 / 7 条偏差已逐条记录）
> **版本归属**：**v3.6.0**（新功能抬 minor；若决定并入 3.5.0 线内，只需改 CHANGELOG 段名与 package.json）
> **落地顺序**：阶段一 = **普通对话面**（`surface: 'assistant'`）✅ → 阶段二 = **AI 教学面**（工件栏 / 会话夹 / 文件树）✅
> 原型与体验对照（本方案的全部界面口径都从它来）：`E:\Projects\KnowledgeRecorder\tmp\image-gen-proto\decide.html`（探针 60 项全绿）

---

## §1 一句话

输入框敲 **`/生图 <描述>`**（斜杠指令，**不是大按钮**）→ 模型把描述润色成生图 prompt 并调用新工具 `image` → 主进程走新加的 **OpenAI 兼容生图适配器** → 图落仓库、对话里出一张**生图卡**（生成中 / 成品 / 失败三态 + 改图 + 版本切换），产物路径进上下文，所以跨轮能接着改、也能被插进知识页。

---

## §2 冻结口径（逐条可核对）

| # | 决策 | 值 |
|---|---|---|
| C1 | 卡面观感 | **简约**（图就是卡：无外框、元信息一行、动作悬停才出） |
| C2 | 「插入知识页」放哪 | **收进 ⋯**（仅 D3=按钮档适用；本方案 D3=提示词驱动 ⇒ 该行不适用） |
| C3 | 停止钮 | **生成期常显**（图上右上角小圆钮） |
| D6 | 放大 | **对话内灯箱**（暗底浮层，Esc 关） |
| A5 | 生成中说什么 | **阶段文字轮播**（正文报进度；★ 是**假进度**，文案不得暗示真实进度百分比之外的信息） |
| A6 | 给不给停止 | **给**（前端断开 + 不落盘；提示「服务端可能已计费」） |
| A7 | 生成前确认 | **直接生成**（不弹确认卡；靠 `requires:'write'` + 免费标记控成本） |
| A4 | 张数 | **1 张**（工具**不提供** `count` 参数） |
| A2 | 模型槽 | **两个**（文生图 + 改图重绘） |
| A3 | 画幅 | **AI 自动定**；要指定就在**提示词里说**（输入框旁无画幅控件） |
| A8 | 失败呈现 | **一行字 + 重试** |
| B1 | AI 教学产物落哪 | **会话夹 `{会话夹}/outputs/`**（与 `visuals/`、`mindmaps/` 并列） |
| B3 | 落盘时机 | **生成完就落**（不留「未保存」态） |
| B2 | 普通对话产物落哪 | **`.attachments/<年-月>/`**（隐藏目录，不进知识库索引 —— 已拍板接受） |
| D5 | 工件栏 | **图进页签**（阶段二；`ArtTab.kind` 新增 `image`） |
| D1 | 插图引用写法 | **仓库相对路径**（`![](../…)`；不做 `attachment://vault` 登记，避免同图两份） |
| D2 | 插到哪 | **指定小节后**（位置也由提示词给：「插到『核心思路』小节后面」） |
| D3 | 插图入口 | **提示词驱动**：卡上**没有**插入按钮，入口就是对话；因此改动卡**不打**「AI 发起」标 |
| D7 | 改图 | **原图喂给模型**（走改图槽 + `/images/edits`；★ 需要编辑类模型） |
| E1 | AIGC 标识 | **右下角水印**「AI 生成」（★ 渲染层叠加，**不改写落盘字节**，见 §8-6） |
| — | 入口形态 | **斜杠指令 `/生图`**（去掉大按钮；输入区只剩 输入框 + 发送） |
| — | 模型在环 | **要**（`/生图 描述` 原样发给模型 → 模型调 `image` 工具） |
| — | 跨轮插入 | **支持**（产物路径进上下文 + 会话内「最近生成的图」薄索引，见 §5.4） |

---

## §3 数据流

### 3.1 一次生成（普通对话面）

```
用户: /生图 画一张动态规划填表过程的示意图，要 1:1 的
  └─ chatCommands.handleChatCommand() 命中「放行清单」→ return false（不拦截、不 toast）
  └─ 原样作为 user 消息发出（含斜杠原文）
模型: 读 system 注入的 image 规则 → 调 image({ prompt:'…', aspect:'1:1' })
  └─ agentService 工具执行 → builtinTools 的 image handler
      ├─ 选槽：无 ref → aiImageModel（文生图）
      ├─ llmService.imageGenerate(provider, model, { prompt, size })
      ├─ 拿 b64 → 落盘 .attachments/<年-月>/<slug>.png（重名 -v2 递增）
      └─ 返回 { relPath, bytes, w, h, model, elapsedMs }
  └─ agentService 组装 toolStep.artifact（kind:'image'）→ 随 trace 落库
渲染: 生图卡（生成中由 agent:step 的 image 跑动事件驱动；完成后由 artifact 驱动）
模型: 一句话交代（不把 prompt 写进正文）
```

### 3.2 改图（D7 = 原图喂给模型）

- 用户「这张太暗了，改成浅灰背景」→ 模型需要**上一张的 `relPath`**（工具结果里就有；跨轮见 §5.4）→ 调 `image({ prompt, ref: '<relPath>' })`。
- 有 `ref` ⇒ 走**改图槽** + `POST /images/edits`（multipart：`image` 字节 + `prompt`）。
- 产物命名 `<slug>-v2.png`、`-v3…`；卡上出现「版本 v1 / v2」切换（读同一 trace 里的多条 artifact，或同 slug 的磁盘文件）。
- **若改图槽留空** ⇒ 退化成「按描述重画」（原型里 A2=一个槽 那档已演示该警告），并在卡上标注，不静默降级。

### 3.3 插图（D3 = 提示词驱动 + D1 相对路径 + D2 指定小节后）

- 与生图**分离成第二次写入**：模型在用户明确要求插入时，先拿到产物 `relPath`，再调既有的 `builtin.vault.edit`（或 write）把 `![](…)` 追加到目标小节后。
- 相对路径**必须从目标页所在目录算起**（页在 `算法/` 下 → 前缀 `../`）；算错的表现是「仓库里图明明在、页面里是破图」，属最难查的一类错 ⇒ 契约锁这条（§9）。
- 改动卡沿用既有「本次改动」范式（可撤销），**不加**「AI 发起」标（触发权在用户）。
- 位置由模型从用户句子里解析（「插到『核心思路』小节后面」）；**不做**行内小面板（D3=按钮档才需要）。

---

## §4 主进程改造

### 4.1 生图适配器（`electron/lib/llmService.ts`）

- **不新增 `ProviderType`**：复用现有供应商（`baseUrl` + 加密 Key + `authHeaders(p)` + `httpJson` + `net.fetch` 全部现成），只是打不同端点。
- 新增两个导出函数（照 `visionChat`（`llmService.ts:1896`）的写法与错误口径；`httpJson`（:376）/ `authHeaders`（:400）直接复用）：

| 函数 | 端点 | 请求 | 说明 |
|---|---|---|---|
| `imageGenerate(p, model, { prompt, size })` | `POST {baseUrl}/images/generations` | JSON `{ model, prompt, size, n:1, response_format:'b64_json' }` | 文生图 |
| `imageEdit(p, model, { prompt, image, size })` | `POST {baseUrl}/images/edits` | multipart（`image` 字节 + `prompt`） | 改图，`image` 从 `ref` 读字节 |

- 响应解析：OpenAI 形状 `{ data: [{ b64_json }] }`；兼容 `{ data: [{ url }] }`（`net.fetch` 二次下载，**上限 30MB**，与 `MAX_STAGE_IMAGE`（`workspaceManager.ts:601`）同口径）。
- `size` 由 `aspect` 映射（16:9 → `1536x864` 一类；**具体取值落码时按目标模型文档定**，映射表放一个常量）。
- 错误面 → A8 的一行字文案：401/403 = Key 无该模型权限；429/余额 = 额度不足；400 且含 policy = 内容策略拦下；超时 = 超时（重试按钮复用同一次调用）。
- 取消（A6）：请求挂 `AbortSignal`，前端断开即 abort，**不落盘**；文案注明服务端可能已计费。

### 4.2 工具 `image`（`electron/lib/builtinTools.ts`）

照 `visual.html`（:1928）/ `mindmap`（:1956）的形状注册：

```ts
registerTool({
  name: 'image',
  title: '生成 / 改图',
  description: '…',            // ≤800 字符：只写「什么时候用」+ 参数含义，★ 不罗列返回字段（铁律 16）
  inputSchema: { type:'object', properties: {
    prompt: { type:'string' },                       // 生图/改图描述（中文原样；保留中文标注诉求）
    aspect: { type:'string', enum:['16:9','1:1','9:16'] },   // 不填 = 按内容定
    ref:    { type:'string' },                       // 有则改图（仓库相对路径或 attachment://vault/…）
  }, required:['prompt'] },
  source:'builtin', enabled:true, readOnly:false,
  requires:'write', tier:'ondemand',
})
```

- **一个工具同时覆盖文生图与改图**（靠 `ref` 有无切链路）——省一份 schema 常驻成本，也让模型少一次选择。
- 产物落盘：阶段一 = `.attachments/<年-月>/`（`stageImageBytes` 同目录语义）；阶段二 = `{会话夹}/outputs/`。
- **不提供** `count`（A4=1 张）、**不提供** `insert`（插图是第二次写入，见 §3.3）。

### 4.3 落盘命名（一处口径）

- 现有 `stageImageBytes`（`workspaceManager.ts:623`）去重是 `-<Date.now()>`（时间戳）；生图产物要可读的版本名 ⇒ **抽 `uniqueVersionedName()`**：`<slug>.png` → `-v2` → `-v3`，与 `visual.html` / `mindmap` 的「重名不覆盖」同口径。
- slug 由模型给（kebab-case，同 visual.html/mindmap 约定），过 `sanitizeFileName()`（:609）净化。
- 落盘后按铁律 1 广播 `windowBus.broadcastDataChanged(scope)`：阶段一 `.attachments/` 不进知识库索引 ⇒ **不需要** knowledge scope（但「本次改动」清单要刷新 ⇒ 沿用 agent 那条通道）；阶段二会话夹属 AI 教学面 ⇒ 广播 aiTeaching/knowledge（落码时按现有 `writeVisual` 的做法对齐）。

### 4.4 `trace.artifact` 扩 `kind:'image'`

- 类型（`src/types/index.ts:1177` + `electron/lib/agentService.ts:207` 两处镜像）：`kind?: 'html' | 'mindmap' | 'image'`，并加 `w?/h?/bytes?/prompt?/ref?/model?/elapsedMs?`。
- 组装点：`electron/lib/agentService.ts:1300`（现有 visual.html/mindmap 分支）加 `image` 一支。
- 「本次改动」清单：`CHANGE_LABELS`（:1315 附近）+ `vaultPath` 取 `relPath` 的分支（:1325）纳入 `image` ⇒ 改动清单里可点回产物。
- 落库通道不变（`trace_json` 随消息进 `.knowbase/agent/messages/<id>.jsonl`）⇒ **刷新 / 重启后卡片还在**（这是选 artifact 而不是「正文里塞 markdown 图」的根本理由）。

### 4.5 系统提示词注入

- 注入点：`electron/lib/agentService.ts:984` 那一串「按面注入」的规则块，照 `mindmap` 的写法加 `image` 一条，内容要点：
  1. 用户用 `/生图`、或明确说「画一张 / 配图 / 示意图」时调用 `image`；
  2. **不要**擅自为讲解配图（不做自动配图）；
  3. 描述**保持用户语言**（中文标注诉求别翻成英文）；
  4. 要改图 → 先拿到目标图的 `relPath`，再带 `ref` 调用；
  5. 生成后用一句话交代，**绝不把 prompt / JSON 写进回答正文**；插图另行调用写工具。
- **只对支持的聊天面注入**（阶段一 `assistant`；阶段二加 `aiTeaching`）。

### 4.6 权限面（刻意）

- `requires:'write'`（与 `visual.html`/`mindmap` 同口径）⇒ **AI 权限为「只读」时 `/生图` 不可用**：工具被预过滤出模型视野（铁律 3），表象是「模型像没听懂」。这是想要的：生图既写文件又花钱。
- 可能的表现还有 `/生图` 指令发出后模型不调工具 ⇒ **落码时验证提示词是否够明确**，必要时在指令文本里补一句「（请调用 image 工具）」。
- 帮助文档必须写清这条耦合（§9 收尾）。

---

## §5 渲染层改造（阶段一 = 普通对话面）

### 5.1 斜杠指令（顺带把 /mindmap 收成一处真源）

- `src/lib/chatCommands.ts` 新增 **`PASSTHROUGH_COMMANDS`**（`name` / `desc` / `surfaces`，语义 = 「不拦截，原样交给模型」），`/生图` 入表 `surfaces:['assistant','aiTeaching']`。
- `handleChatCommand`（:113）里现在那行硬编码白名单（:119 `if (name === 'mindmap' && …) return false`）**改为查这张表**；并把现在住在 `src/modules/ai-teaching/index.tsx:36` 的 `MINDMAP_SLASH_ITEM` 搬进该表 —— 消掉「一个指令一处硬编码」。
- 两个面的弹层：`src/components/shared/AssistantPanel/ChatBody.tsx:266` 与 `src/modules/ai-teaching/index.tsx:1113` 的 `buildSlashItems(skills, extra, surface)`，`extra` 由 `PASSTHROUGH_COMMANDS` 生成（`/生图` 两面都有，`/mindmap` 仍仅教学面）。
- 输入区：**删掉大按钮**（阶段一 = 助手输入卡；阶段二同改教学面），placeholder 提一句「要画图就敲 `/生图` 后面跟描述」。
- 契约：`verify-slash-commands.mjs`、`verify-input-bubble.mjs` 必须同步（现断言依赖旧文案）。

### 5.2 生图卡（新组件 `src/components/shared/AssistantPanel/ImageCard.tsx`）

- **数据源两条**：① 落库的 `trace.artifact`（历史/刷新后，静态成品态）；② `agent:step` 里 `name === 'image'` 的跑动事件（实时「生成中」态）。渲染落点：`MessageList.tsx`（现有 `traceRows` / `AgentLiveSteps` 旁）与 `StreamBubble.tsx` 的 `ProcessItem` 序列。
- **三态**（照原型简约档）：
  - 生成中：占位框（与成品同 `aspect-ratio`，不跳版）+ 一层光晕呼吸 + 一条斜向扫光 + **阶段文字轮播**（A5）+ 图上右上角**停止钮常显**（C3）+ 底部进度条（`scaleX`）。
  - 成品：显影式进场（`opacity + scale(.985→1) + translateY(5→0)`，320ms）+ 右下角「AI 生成」水印（E1，**渲染层叠加**）。
  - 失败（A8）：图位留空 + 一行小字 + 「重试」/「复制提示词」。
- **动作行**（悬停才出）：`改图` · `⋯`（复制路径 / 放大 / 删除产物 / 版本 vN）。**没有**「插入知识页」（D3=提示词驱动）。
- **元信息行**：文件名 + 耗时；完整路径 hover 浮层（只动 `opacity`，不用 `max-width` 过渡）。
- **动效纪律（铁律 13）**：只用 `.kb-pop` / `.kb-view-in` / `.kb-item-in` 等既有令牌，缺的**先补 `src/styles/index.css` 并更新 `docs/ui-animation-plan.md` 再落码**；全部带 `prefers-reduced-motion` 兜底；进度条只动 `transform`。
- **放大（D6）**：对话内暗底灯箱（自绘 `<div class="ov">` 同级，不复用批 3 图片查看器）；Esc 关闭；打开期间 `pointer-events` 拦在浮层内。

### 5.3 图片取回通道

- 直接用现成的 `src/lib/attachmentImage.ts`：`normalizeVaultRel()` / `loadVaultImage(rel)`（已有缓存与归一化）。
- `.attachments/<年-月>/x.png` 命中 `ws:readImage`（白名单就是「附件区」，`workspaceManager.ts:825`）。
- ★ **阶段二的会话夹 `outputs/` 走「范围通道」**：`RANGE_EXT_WHITELIST`（`workspaceManager.ts:243`）**已含 png/jpg/jpeg/webp/gif/bmp/svg**，且批 3 已定「图片取回统一走本通道，不走 `ws:readImage`」⇒ **零安全面变更**。
- 渲染侧还有两道守卫（`src/lib/imageFormats.ts`：32MB / 1 亿像素），生图基本碰不到。

### 5.4 跨轮引用（用户答「支持」）

- 模型调用 `image` 后，`relPath` 已在**工具结果**里（最近 3 条工具结果不被摘要，铁律 17）⇒ **同一轮 / 紧邻一轮**的「改这张」「插到某页」天然可用。
- 更早的产物会被压缩掉 ⇒ 补一条**薄索引注入**：system 注入里加「本会话最近生成的图：`<relPath>`（标题）…」最多 5 条，数据源 = 本会话消息 trace 里的 `artifact`（与 §4.4 同一份数据，不新增存储）。
- **明确不做**：不为更老的产物做召回（超 5 张的最老图不索引）；用户要点名「最早那张」时由模型反问。

---

## §6 阶段二（AI 教学面）

1. **落盘**：`electron/lib/aiTeachingSources.ts` 加 `writeImage(sessionId, …)`，形状照 `writeVisual`（:559 一带）/ `writeMindmap`（:581 一带）→ 落 `{会话夹}/outputs/`，重名 `-v2` 递增，会话夹不存在则拒绝。
2. **工件栏页签**：`src/modules/ai-teaching/artifacts.ts` 的 `ArtTab.kind` 加 `'image'`；`ArtifactsPane.tsx` 加渲染分支（缩略图 + 文件名 + 尺寸）与「生成中」占位（照 `visual.html` 的 `gen:<slug>` 占位时序，`index.tsx:985-991`），成功原地转正式。
3. **文件树**：`AiTeachFileTree.tsx:119` 现在「其余走外部」⇒ 把 png 接进**批 3 的图片查看器**（`src/components/shared/image/*`）。
4. **工具可用面**：`image` 的 sessionId 归属校验（无会话即拒绝，同 visual.html）；系统提示词注入加 `aiTeaching` 面。
5. **不做**：D5 的「只在对话流」不做成设置开关（拍板值直接实现，少一个维护面）。

---

## §7 设置项（`src/lib/settings.ts`）

照 `aiTeachVisionModel`（:273）的写法加两行，并进 `src/modules/settings/views/AiModelsTab.tsx` 的 `SCENES` 表（:273-278）：

| key | label | 说明 |
|---|---|---|
| `aiImageModel` | 文生图模型 | `providerId:modelId`；anchor `aiTools.imageModel`；`ui:true`、`aiTab:'models'` |
| `aiImageEditModel` | 改图重绘模型 | 同上；**留空 = 改图退化成按描述重画**（并在结果里标注，不静默） |

- 两者**留空 = 报错**「未配置生图模型」——**不做自动挑选**（图像模型没法像 `VISION_MODEL_RE` 那样靠正则猜，猜错就是花钱）。
- 成本可见：复用现有 `aiFreeModelIds` 免费标记 + `aiUsage` 记账（不改机制）。

---

## §8 取舍与明确不做

1. **工具 schema ≤800 字符**，description 只写「何时用 + 参数含义」；落码后跑 `measure-tool-schema.mjs` 更新基线（`.AGENT/scripts/ai-tools-audit/out-schema-baseline.txt`）。
2. **不做一次 4 张**（A4=1）⇒ 工具不提供 `count`，少一个花钱旋钮。
3. **不做图片编辑**（裁剪 / 标注 / 旋转后落盘）——批 3 已定「只看，不改图」。
4. **不做自动配图**：模型不得自发调用 `image`（只在用户 `/生图` 或明确要求画图时）。
5. **不做图像模型自动挑选 / 额度探测 / 并发池**。
6. **水印是渲染层叠加，不写进文件字节**：落盘 = 模型原始字节（改文件要重编码，成本与失真都不划算）。将来若需合规硬标识（EXIF / 文件名后缀），单独立项。
7. 产物**不进知识库索引**（`.attachments/` 是隐藏目录，`knowledgeIndex.ts:196` 的 dot 分支）——已拍板接受；找回入口 = 对话卡 + 「本次改动」清单 + 后续「最近生成」入口（本期不做）。
8. **不做 `attachment://vault` 登记**（D1=相对路径）⇒ 目标页挪目录会断链；牺牲的是移动健壮性，换来的是仓库里只有一份图。危险点写进帮助文档。
9. 生图**不落 `.knowbase`**、不进图谱、不参与语义检索。

---

## §9 验证计划

**新契约脚本** `.AGENT/scripts/ai-tools-audit/verify-image-tool.mjs`（静态源码断言，ASCII 输出）：

- 工具 `image` 存在；`tier === 'ondemand'`；`requires === 'write'`；schema 字符数 ≤800；**不在** core 常驻清单里；
- 适配器端点字符串 `/images/generations` 与 `/images/edits` 各命中一次；响应兼容 `b64_json` 与 `url` 两形状；
- 命名去重是版本式（`-v2`）而**不是**时间戳；
- `agentService` 的 artifact 分支含 `kind: 'image'`；`AgentTraceStep.artifact.kind` 两处镜像都含 `'image'`；
- 水印在渲染层（源码里 `AI 生成` 只出现在 `src/` 侧，`electron/` 侧不得有）；
- 相对路径前缀计算在渲染/主进程只有一处（负向断言：不得出现第二处手写 `'../'` 拼接）。

**改既有契约**：`verify-slash-commands.mjs`（`/生图` 入表 + 两面可见性 + `/mindmap` 迁表后仍只在教学面）、`verify-input-bubble.mjs`（输入区无大按钮）、`verify-ai-teaching-tools.mjs`（阶段二工具面）。

**运行期探针**（照 `tmp/probe-*.mjs` 的写法：隔离实例 + seed vault + **cdp**，★ 必须 mock 端点——真调生图 API 既花钱又不可重复）：

- 本地起一个 OpenAI 兼容 mock（`node:http`，`/images/generations` 与 `/images/edits` 各返回一张 1×1 PNG 的 `b64_json`）；
- 断言链：敲 `/` 出候选含 `/生图` → 选中补全 → 发出 → 出现「生成中」卡（阶段文字在变、停止钮可见）→ 完成出图 → 磁盘 `.attachments/<年-月>/<slug>.png` 存在 → **刷新后卡片仍在**（读 trace）→ 再发一次改图 → `-v2` 落盘 + 版本可切 → 放大开灯箱 → Esc 关 → 停止档不落盘 → 失败档文案 → 未配模型时报错文案；
- 页面 `console.error` 与 `exceptionThrown` 必须为 0。

**门禁**：`npx tsc --noEmit -p tsconfig.node.json`、`-p tsconfig.web.json` 双 0 错；`npm run build` 通过。

**收尾（必做）**：
- `CHANGELOG.md` 加段 + 重跑 `.AGENT/scripts/release-notes/build-release-notes.mjs`（铁律 24，忘跑 = 应用内更新说明停上一版且无报错）；
- 帮助文档同步（`resources/help/`）：阶段一改 **《AI 权限与工具边界》**（新工具 + `requires:'write'` 耦合）、**《快速上手》/《常见问题》**（`/生图` 怎么用、产物在哪、挪目录会断链）；阶段二加 **《AI 教学素材与代码》** 与 **《模块一览》**。改完跑 `.AGENT/scripts/help-kb/verify-help-retrieval.mjs`。

---

## §10 实施顺序（阶段一）

| # | 内容 | 主要文件 | 估时 |
|---|---|---|---|
| 1 | 生图适配器 + 两个设置槽 | `llmService.ts`、`settings.ts`、`AiModelsTab.tsx` | 0.5d |
| 2 | 工具 `image` + 落盘命名 + artifact 扩类 + 提示词注入 | `builtinTools.ts`、`workspaceManager.ts`、`agentService.ts`、`types/index.ts` | 1d |
| 3 | 斜杠指令收口（`PASSTHROUGH_COMMANDS`）+ 两面接线 + 去掉大按钮 | `chatCommands.ts`、`ChatBody.tsx`、`SlashCommandMenu.tsx`、`ai-teaching/index.tsx` | 0.5d |
| 4 | 生图卡（三态 / 动作行 / 版本 / 失败 / 灯箱 / 水印） | 新 `ImageCard.tsx`、`MessageList.tsx`、`StreamBubble.tsx`、`index.css` | 1.5d |
| 5 | 跨轮薄索引注入 | `agentService.ts` | 0.5d |
| 6 | 契约 + 探针 + CHANGELOG/帮助 | `.AGENT/scripts/**`、`tmp/probe-image-gen.mjs`、`resources/help/**` | 1d |

阶段二另算：工件栏页签 + 会话夹落盘 + 文件树/查看器接线 ≈ 1d。

---

## §11 未决与风险

| # | 风险 | 处理 |
|---|---|---|
| 1 | **生图模型的确切 ID 未定**，且返回形状可能不是 OpenAI 标准（有的只回 `url`、有的要 `response_format` 别的值） | 设置里填；适配器里把形状分支写全并在错误文案里回显原始错误码 |
| 2 | **改图需要编辑类模型**（SeedEdit / image-edit 类）；若控制台没有，D7 落不了地 | 留空即降级为「按描述重画」并**在卡上标注**，不静默 |
| 3 | **花钱面**：`requires:'write'` + 免费标记 + A7=直接生成 ⇒ 模型可以自己决定花钱 | 工具描述里明确「仅用户要图时调用」+ 不做自动配图；必要时二期补「单会话生图次数上限」（现有 `MAX_SESSION_WRITES` 同款机制，`agentService.ts:1373`） |
| 4 | 「阶段文字轮播」是**假进度**（接口无流式事件） | 文案只描述阶段（理解 / 构图 / 采样 / 细化），不得出现具体百分比承诺 |
| 5 | 图片体积/像素超渲染侧守卫（32MB / 1 亿像素） | 生图基本碰不到；超限时按失败档给一行字（必要时二期做落盘前压采样） |
| 6 | 压缩会把早期产物挤出上下文 | 已用「最近 5 张」薄索引兜住；更老的靠用户点名 |

---

## §12 落码记录

> 开工后在此记录与方案的偏差（新增字段 / 去掉的步骤 / 实测数值），格式照 `docs/ai-outline-inline-plan.md` §8。

### 2026-10-14 · 阶段一（普通对话面）落码

**已按方案实现**：§4.1 适配器（`imageGenerate` / `imageEdit`）、§4.2 工具 `image`、§4.3 版本式落盘命名、
§4.4 `trace.artifact` 扩 `kind:'image'`（两处镜像）、§4.5 系统提示词注入、§5.1 斜杠指令收口、
§5.2 生图卡、§5.3 取回通道、§5.4 跨轮薄索引、§7 两个设置槽。

**与方案的偏差（逐条，都在下面给了理由）**

| # | 方案原文 | 落码做法 | 理由 |
|---|---|---|---|
| D1 | §5.4「system 注入里加『本会话最近生成的图』最多 5 条」 | 改注入**首条 user 消息层**（`requestInjection`） | system + tools 是 prompt cache 前缀，必须逐字稳定；这段随「又生成了一张」而变，进 system 等于每生成一张就把整段前缀作废一次（仓库既有铁律，`agentService.ts` 里 B1→B2 那次踩坑的注释就是写这条的） |
| D2 | §4.5「只对支持的聊天面注入（阶段一 `assistant`）」 | 注入面 = **除日程助手以外的全部聊天面**（含 undefined 的助手三宿主、`aiLearn`、`aiTeaching`） | ① 助手三宿主与全屏学堂的 `sessionSource` 是 `undefined`，按 `=== 'assistant'` 会漏掉最主力那个面；② §5.1 已定 `/生图` 要在 assistant 与 aiTeaching **两个面**的弹层可见 —— 弹层里有、system 里没有 = 敲了没反应。日程助手不注入（它的工具面被刻意收窄） |
| D3 | §4.2 schema 只有 `prompt` / `aspect` / `ref`（无 `slug`） | schema 增**可选** `slug` | §4.3 明写「slug 由模型给（kebab-case，同 visual.html/mindmap 约定）」，与 §4.2 的 schema 自相矛盾。取 §4.3：有 slug 才有可读的版本名（`dp-fill-v2.png`）。不填时回落 `image.png` / `image-v2.png`，版本切换照常工作 |
| D4 | §4.2 未提停止信号 | `ToolInvokeCtx` 增 `signal?: AbortSignal`，agentService 两处调用透传 | A6 要求「前端断开 + 不落盘」。工具上下文此前拿不到中断信号 → 只让渲染层不再等待、主进程照跑照落盘，就是"点了停止，图还是出现在仓库里"。其余工具都是毫秒级本地动作，不受影响 |
| D5 | §5.2「渲染落点：`MessageList.tsx` 与 `StreamBubble.tsx` 的 ProcessItem 序列」 | 只在 `MessageList.tsx` 渲染（生成中态由 `liveSteps` 驱动），**未改 `StreamBubble`** | `ProcessItem`（`agentStreamCore`）只带 name/label/state，拿不到 `aspect`/`prompt`，而占位框要靠 aspect 与成品同比例、靠 prompt 说明"在画什么"。硬塞进 ProcessItem 就得给它扩字段，代价大于收益 |
| D6 | §5.2「版本切换读同一 trace 里的多条 artifact」 | 同 trace 内按**基名**归并（`imageGroupsOf`），跨消息不并 | 跨消息并会把两次独立生成误并成"同一张图的版本"（回落名 `image` 时尤其容易撞）。同一条消息里连续生成/改图仍能出 v1/v2/v3 切换 |
| D7 | §4.4「失败呈现：一行字 + 重试」 | 失败步骤**额外带 `args`（prompt/aspect/ref）落库** | 不出这一条，"重试"就没有可重试的东西 —— 失败步骤原本只存 `summary`。其余工具的失败步骤仍不带 args（它们的失败只给一行字） |
| D8 | §5.3「阶段二会话夹 outputs/ 走范围通道」 | 阶段一落 `.attachments/<年-月>/`，走既有 `ws:readRangeBytes`（`normalizeVaultRel` + `loadVaultImage`） | 与方案一致，记录仅为说明**零安全面变更**：`RANGE_EXT_WHITELIST` 已含 png/jpg/jpeg/webp/gif/bmp/svg，未动任何白名单 |
| D9 | §6.2 工件栏页签（阶段二） | 教学面 `onAgentStep` 遇 `kind:'image'` **直接返回**，不开占位/正式页签 | 阶段一产物落 `.attachments/`，工件栏拿不到渲染分支；不返回就会塞一个打不开的"0 行示意图"页签。对话流里的生图卡照常渲染（两面共用 `ImageCard`） |

**实测数值**

- 单工具 `inputSchema` 字符数：见 `.AGENT/scripts/ai-tools-audit/out-schema-baseline.txt`（红线 ≤800）。
- 落盘命名：`.attachments/<年-月>/<slug>.png` → `<slug>-v2.png`（**版本式**，非时间戳式；
  `uniqueAttachmentName` 的时间戳式保留给"选图/粘贴"那条路，两者语义不同故并存）。
- 画幅映射（`IMAGE_SIZE_MAP`，方案 §4.1 留的"落码时按目标模型文档定"）：`16:9→1536x864`、
  `1:1→1024x1024`、`9:16→864x1536`；缺省**不传 size**（服务端默认，对应 A3「AI 自动定」）。
- 生图超时 180s（独立于 `TOTAL_TIMEOUT_MS` 的 300s）；只回 `url` 的网关走二次下载，上限 30MB
  （与 `MAX_STAGE_IMAGE` 同口径）。

**阶段二待办（未动）**：`writeImage` 落 `{会话夹}/outputs/`、`ArtTab.kind:'image'` 页签与渲染分支、
`AiTeachFileTree` 接批 3 图片查看器、`image` 工具的 sessionId 归属校验。

### 2026-10-14 · 阶段二（AI 教学面）落码

**已按方案实现**：§6.1 `writeImage` 落 `{会话夹}/outputs/`、§6.2 `ArtTab.kind:'image'` + `ArtifactsPane`
渲染分支与「生成中」占位时序、§6.3 文件树接批 3 图片查看器、§6.4 工具可用面（sessionId 归属 + 提示词注入）。

**与方案的偏差（逐条）**

| # | 方案原文 | 落码做法 | 理由 |
|---|---|---|---|
| D10 | §6.1「会话夹不存在则**拒绝**」 | 会话夹不存在时**懒建**（`ensureWriteOwnerFolder`，与 `writeVisual`/`writeMindmap` 完全一致） | 方案自己写的是"形状照 writeVisual / writeMindmap"，而这两个函数就是懒建。真拒绝会让**新会话的第一张图**直接失败（新会话时常还没落过任何文件）——那正是用户第一次试生图的时刻 |
| D11 | §6.4「`image` 的 sessionId 归属校验（无会话即拒绝，同 visual.html）」 | 归属校验**按调用面分流**：`ctx.source === 'aiTeaching'` 才要求会话夹归属；普通对话面照旧落 `.attachments/` | 助手面的 `ctx.sessionId` **也是非空的**（那是 agent 会话 id，不是教学会话）——按"空值判"既拦不住错，又会把普通对话的图往一个并不存在的会话夹里塞 |
| D12 | §6 未提教学面注入文案 | `imageHint` 的插图示例**按面分叉**（教学面给 outputs/ 口径，助手面保留 `.attachments/` 那句），并给教学面补一句 ⑥ 产物落点 | 阶段一那句示例写死了 `.attachments/2026-10/x.png`；教学面产物根本不在那儿，留着会让模型去仓库隐藏目录里找图 / 算出错误的相对路径 |
| D13 | §6.2「缩略图 + 文件名 + 尺寸」（未说页签名取什么） | 页签名取**文件名**（`<slug>-vN.png`），prompt 留作 `title` 悬浮提示；工具条补 `W × H` | 页签条单页上限 170px，prompt 进去会被截成一串省略号；而 `title` 悬浮是现成的展示位 |
| D14 | §6.2 未提「编辑 / ⟳」按钮 | 图片页签**不给**「编辑」与「⟳」（html/md 照旧） | png 在编辑器里没有可编辑语义（点开只会是一堆乱码）；重读本来就有更准的入口——批 3 查看器异常态卡上的「重试」 |
| D15 | §6.3「把 png 接进批 3 的图片查看器」 | 接的是**工件栏图片页签**（页签正文就是 `ImmersiveImageView`），不是跳到知识库模块 | 教学面"左聊右看"是既定口径（工件栏方案 §2：对话固定左主区永不替换）；跳模块会把对话弄丢。同一个查看器组件，两处共用 |
| D16 | §6.2「工件卡（对话流）+ 工件栏页签」 | 对话流**仍不出图片工件卡**（只有 `ImageCard`），页签由生成事件流自动开 | 图的"卡"就是图本身，`ImageCard` 已经把它画出来了；再叠一个「在工件栏打开 →」是同一件事说两遍 |

**实测数值**

- 落盘：`{会话夹}/outputs/<slug>.png` → `<slug>-v2.png`（版本式，与 `.attachments/` 一条口径，
  复用同一个 `uniqueVersionedName`）；字节上限 30MB。
- 大小写/回落：`slug` 缺省回落 `image`（方案 §12 D3）——**占位页签与完成事件必须用同一条回落规则**，
  否则空 slug 时占位页签匹配不上，屏幕上留一个禁关的「生成中…」（落码时按 `slug || 'image'` 两处对齐）。
- 契约：`verify-ai-teaching-tools.mjs` 共 43 条（新增阶段二 22 条）；`verify-image-tool.mjs` 新增 §11
  「产物落点分流」9 条。

**仍未做（阶段二之外，刻意）**：运行期探针（§9 的 mock 端点 + CDP 全链路断言）——静态契约与构建门禁已全绿，
真机观感与 IPC 全链路仍需那一跑；生图模型的确切 ID 与返回形状（§11 风险 1/2）同样只能真机验证。

