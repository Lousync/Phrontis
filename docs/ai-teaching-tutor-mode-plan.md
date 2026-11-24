# AI 教学「对话」模式落码方案（普通对话 / 不建课）

- 日期：2026-11-24
- 状态：待落码（第一批 + 第二批并行）
- 设计输入：`docs/deeptutor-teaching-modes-research.md`、`tmp/ai-teach-tutor-mode/index.html`（已定稿原型）
- 前置：右侧查看器统一（v3.58.0）、导图工具条 / 相机（v3.59–3.60）

> 本文件只定「接口 + 落点 + 分批」，不重复调研结论。
> 跨代理协作以 §2「冻结接口」为准；任何单边改名必须同步改本节与契约脚本。

---

## 一、范围

### 本批做

1. 「选择工作区」页新增 **对话** 入口（原型 A：搜索框右侧、`+ 新建工作区` 旁）。
2. 对话容器：左会话列表（约 248px）+ 中聊天 + 右查看器（复用 `RightViewer`，可开关 / 全屏）。
3. 会话文件夹：`{AI教学根}/对话/{MM-DD 标题}/`；一个会话一个夹，`.session.json` 带 `kind: 'tutor'`。
4. 会话列表：新建 / 切换 / 重命名 / 删除 / 搜索 / 今天·昨天·更早分组。
5. 四形态（Chat / Ask / Solve / Reading）在同一会话里按轮切换。
6. 方式 chip 五档：自动 / 对话 / 讲解 / 解题 / 先问我；默认自动，发送后回到自动。
7. 自动路由（关键词 + 上下文兜底），路由结果不弹提示。
8. 单枚资料 chip：当前资料（图片 / PDF / EPUB / TXT / MD）+ 页码或章节；点击聚焦右侧页签，`×` 移除。
9. 解题动作行只挂**最新一条**解题回复：加入题单 / 加入错题 / 再来两道变式。
10. 每个会话各自记忆右侧页签（跨重启恢复）。
11. 当前页文本注入（≤3000 字）+ 引用页码 / 小节；没读到原文必须明说。
12. 帮助手册、`docs/ui-updates.md`、契约脚本同步。

### 本批不做（第三批）

- `[p.N]` 点击跳转并高亮、划词「问这段」、持久化标注。
- 「以此建课」预填课程助手（先留入口，点击走现有建课页）。
- 会话默认方式 / 提示优先偏好记忆。
- 诊断小测（5–8 题 → 弱项 → 建议起点）。
- 课程统计、`SOURCES` 登记、大纲 / 章节 / 开段预检 / 结课流程（对话模式一律没有）。

---

## 二、冻结接口（跨代理共同遵守）

### 2.1 会话标记

```ts
// electron/lib/agentSessionRepo.ts + src/types/index.ts（同构声明）
type AiTeachMode = 'tutor'                 // 新增
interface AgentSessionRow { aiTeachMode?: AiTeachMode }
interface AgentSessionInfo { aiTeachMode?: AiTeachMode }
```

- 仍用 `source: 'aiTeaching'`；**不写** `sessionWs`（不归任何工作区）。
- 旧行无此字段 = 课程会话，行为不变。
- 侧栏 / 支线过滤规则不变：`parentSessionId && lane === 'side'` 仍不进主列表。

### 2.2 每轮方式

```ts
// src/lib/tutorModePure.ts（新，纯函数，零运行时依赖）
type TutorUiMode = 'auto' | 'chat' | 'read' | 'solve' | 'ask'
type TutorTurnMode = Exclude<TutorUiMode, 'auto'>

interface TutorRouteInput {
  text: string
  hasImages: boolean
  hasMaterial: boolean          // 右侧查看器有当前资料
  readingQuestion: boolean      // 文案指向「这页 / 这段 / 这份资料」
}
function resolveTutorMode(input: TutorRouteInput): TutorTurnMode
```

- `auto` 只在渲染层存在；发送前解析成四种之一。
- 关键词兜底（不调用模型）：
  - `solve`：`求…` / `证明…` / `这道题` / `怎么算` / 有图片；
  - `read`：`这页` / `这段` / `这份资料` / `原文` / `讲解` 且存在当前资料；
  - `ask`：`帮我弄一下` / `随便` / `你看着办` 等低信息量短语；
  - 其余 `chat`。
- 路由结果写入本轮用户消息（见 2.3），不写全局设置。

### 2.3 消息标记

```ts
// electron/lib/agentMessageStore.ts（JSONL 可选字段 teach_mode）
// 渲染层 AgentStoredMessage 暴露为 teachMode
interface AgentMessageRow { teach_mode?: TutorTurnMode }
interface AgentStoredMessage { teachMode?: TutorTurnMode }
```

- 只给 assistant 消息写；用于「解题动作行只挂最新一条」与消息头方式徽标。
- 旧消息无字段 = 不显示方式徽标，不参与解题动作行。

### 2.4 IPC

| 通道 | 方向 | 形状 | 说明 |
|---|---|---|---|
| `aiTeach:tutor:create` | 渲染 → 主 | `(title?: string) => { ok, sessionId?, relPath?, error? }` | 新建 tutor 会话 + 建夹；标题空则「新对话」 |
| `agent:chat` | 渲染 → 主 | 请求新增 `teachMode?: TutorTurnMode`、`reading?: ReadingContext` | 只对 tutor 会话生效 |
| `agent:sessions` | 复用 | `AgentSessionInfo[]` 带 `aiTeachMode` | 不新增列表通道 |

```ts
interface ReadingContext {
  relPath: string
  kind: 'pdf' | 'epub' | 'txt' | 'md'
  page?: number          // PDF 页码（1-based）
  label?: string         // 章节 / 小节名
  text: string           // 渲染层已截到 ≤3000 字
}
```

> 跨线各声明一次是仓规（渲染层 `src/lib/readingContext.ts`、跨层 `src/types/index.ts` 两份同构声明），
> 不互相 import，避免并行落码时抢同一文件。

### 2.5 文件落点

- 会话夹：`{rootDir}/对话/{MM-DD 标题}`；`folderBaseName(created_at, title)` 复用现有命名与去重。
- 锚点：`.session.json` 增 `kind: 'tutor'`（旧锚点无此字段 = 课程）。
- 会话内产物：沿用会话夹根 / `产物/`；不登记 `SOURCES`。
- 删除会话：沿用 `aiTeachDeleteSessionFolder` 设置（ask / keep / delete）。
- 重命名：复用现有 `agentRename` + 会话夹同步改名链路（tutor 夹一并改）。

### 2.6 提示词

```ts
// electron/lib/aiTeachingTutorPrompt.ts（新，纯函数）
function buildTutorProtocolHint(mode: TutorTurnMode): string
```

- `agentService` 在 `source === 'aiTeaching'` 且 `isTutorSession(sessionId)` 时追加。
- 追加位置：并入现有 `teachStyleHint` 分区（不改 `AiTeachInjectionStats` 的 7 段结构，避免双端纯函数与契约大改）。
- 协议正文按调研 §5：Solve 提示阶梯 / Reading 三层地图 / Ask 一次澄清；`chat` 不加硬规则。

### 2.7 查看器页签作用域

- 课程会话：沿用现有持久化键（不变）。
- 对话会话：`RightViewer` 新增可选 `persistScope?: string`；tutor 传 `tutor:<sessionId>`，键名 `aiTeachViewerTabs:<scope>`。
- 不传 = 现有行为；课程侧零改动。

---

## 三、落码点（文件清单）

| 块 | 文件 | 改动 |
|---|---|---|
| 会话标记 / 建夹 | `electron/lib/agentSessionRepo.ts`、`electron/lib/aiTeachingFolders.ts`、`electron/lib/aiTeachingTutor.ts`（新） | `aiTeachMode` 字段、`setTutorFolderResolver`、建会话 + 建夹 + 锚点 |
| 消息标记 | `electron/lib/agentMessageStore.ts`、`electron/lib/agentSessionRepo.ts` | `teach_mode` 读写、`appendAgentMessage` 可选参数 |
| 通道 | `electron/lib/agentService.ts`、`electron/database/repositories/aiTeachingHandlers.ts`、`src/lib/ipc.ts` | `aiTeach:tutor:create`、`agent:chat` 新字段、camel 映射 |
| 提示词 | `electron/lib/aiTeachingTutorPrompt.ts`（新）、`electron/lib/agentService.ts` | 三种协议 + 注入 |
| 路由 | `src/lib/tutorModePure.ts`（新）、`src/lib/ipc.ts` 类型 | 自动判定纯函数 |
| 容器 UI | `src/modules/ai-teaching/index.tsx`（+ 必要时 `src/modules/ai-teaching/tutor/*` 新文件） | 入口、三栏、列表、空态、隐藏课程件 |
| 输入卡 | `src/modules/ai-teaching/index.tsx`、`src/lib/readingContext.ts`（新） | 方式 chip、单枚资料 chip、当前页注入 |
| 查看器 | `src/modules/ai-teaching/right-viewer/RightViewer.tsx`、`viewerTabs.ts` | `persistScope` |
| 阅读上下文 | `src/lib/readingContext.ts`（新）、`PdfReaderView.tsx`、`EpubReaderView.tsx` | 当前页 / 章节文本发布 |
| 契约 | `.AGENT/scripts/ai-teaching/verify-tutor-mode.mjs`（新）、`verify-all-p0.mjs` 登记 | 纯函数 + 源码接线断言 |

---

## 四、并行拆分（文件不重叠）

- **F｜主进程基座**：`electron/lib/aiTeachingTutor.ts`、`aiTeachingTutorPrompt.ts`、`aiTeachingFolders.ts`、`agentSessionRepo.ts`、`agentMessageStore.ts`、`agentService.ts`、`electron/database/repositories/aiTeachingHandlers.ts`、`src/types/index.ts`、`src/lib/ipc.ts`、`src/lib/tutorModePure.ts`、`verify-tutor-mode.mjs`。
- **V｜查看器作用域**：`src/modules/ai-teaching/right-viewer/RightViewer.tsx`、`viewerTabs.ts`（只加 `persistScope`，默认行为不变）。
- **R｜阅读上下文**：`src/lib/readingContext.ts`、`src/components/shared/pdf/PdfReaderView.tsx`、`src/components/shared/epub/EpubReaderView.tsx`（只发布当前页文本，不改 UI）。
- **U｜容器与输入卡**：`src/modules/ai-teaching/index.tsx`（+ 可选新组件）——在 F 冻结接口后开工；同一文件禁止并行编辑。
- **D｜文档/帮助**：`docs/ui-updates.md`、`resources/help/*` 在 U 完成后统一写，避免抢改。

依赖：U 依赖 F 的 IPC/类型名与 V 的 `persistScope`；V / R 可独立开工。F 完成后 U 立刻开。

---

## 五、验收（第一批 + 第二批）

- [ ] 从选择工作区点「对话」，不建课 / 大纲 / 章节即可开始。
- [ ] 新建会话后出现 `AI教学/对话/{MM-DD 标题}/`，`.session.json` 带 `kind: 'tutor'`。
- [ ] 切换会话内容不串；右侧页签各会话独立、跨重启恢复。
- [ ] `AI教学/对话/` 不出现在课程工作区列表；课程统计 / 素材登记不受影响。
- [ ] 五档方式 chip 可切换；默认自动，发送后回自动。
- [ ] 自动路由按 §2.2 命中；路由不弹确认。
- [ ] 「先问我」只出一张 ```ask 卡，答完继续原请求，不重复问。
- [ ] 「解题」先提示、可要完整解；变式题号 1..N；动作行只挂最新一条。
- [ ] 当前页文本进入下一轮上下文（≤3000 字），引用带 `[p.N]`；无原文时明说。
- [ ] 删除会话按设置处理文件夹；重命名同步改夹名。
- [ ] `verify-tutor-mode.mjs` 全绿；`verify-all-p0` 39/39+；`tsc` 双配置 0 错；`npm run build` 通过。
- [ ] 真机走一遍：拖图 → 提示 → 完整解 → 变式 → 加入题单 / 错题本。

---

## 六、开放点（落码时确认，勿静默决定）

1. 重命名会话夹的现有 IPC 名称与副作用（F 需先核对再接线）。
2. `agent:chat` 请求类型的定义位置（`src/types/index.ts` 内 `AgentChatRequest`），新字段必须同步 preload 透传。
3. 解题动作行的「最新一条」判定：以消息数组最后一条 assistant 且 `teachMode === 'solve'` 为准；同一轮多段消息只挂最后一段。
4. 资料 chip 多份资料时显示首项 + 计数（原型只有一份）。
5. 阅读上下文的 `text` 在渲染层截断，主进程再做一次 3000 字上限（双保险）。

---

## 七、实施地图（2026-11-24 探路结果，行号以当前工作树为准）

### 7.1 视图分支与入口

- `AiTeachingModule`（`src/modules/ai-teaching/index.tsx:403`）一个组件承载全部视图：
  - `activeWs` 真 → 工作区视图（**3047–4272**）；
  - `activeWs` 假 → 选择工作区页（**4273–4698**）。
- 选择页工具栏 **4296–4322**：搜索框 4297–4314、`+ 新建工作区` 4315–4319。
  「对话」入口插在两者之间（对应原型 `index.html:1259–1266`）。
- 工作区视图的顶栏 3049–3088、`preflight` 分支 3283–3297、左栏 `CourseRail` 3186–3210、中栏聊天 3274–4244、`RightViewer` 4253–4271。
- 会话列表**当前没有任何 UI**：`sessions`（406）只用于取标题 / resumeInfo；`refreshSessions` 1050–1066 已按 `source==='aiTeaching'` 过滤。
- `openSession` 1188–1213；`enterWs` 1407–1461；`exitToPicker` 1468–1473。
- 删除会话复用 `delSession` 2337–2390（含文件夹 ask/keep/delete）。

### 7.2 输入卡与消息

- `composerFooter` 常量 **2848–3037**（图片 / 模型 / 用量环 / 发送）。
- 输入卡本体 **4024–4124**：拖放层 4040、图片条 4047、引用胶囊 4057、`<textarea>` 4111、footer 4120。
- 控制托盘 4132–4218（画像 / 要求 / 思考 / 引用）；对话模式只保留思考 / 引用。
- 消息列表 3326–3566；assistant 动作条 **3511–3559**（解题动作行插在这里，按 `m.teachMode==='solve'` + 最新一条判定）。
- 发送链：`sendText` 1251–1294 → `agentChat`；`doSend` 1320–1359。
- 附件现状：**只有图片**（`useComposerImages` 412；`agentChat` 传 images 1281–1283）；没有通用资料 chip。

### 7.3 查看器

- `RightViewer` 挂载 4253–4271，`sessionId={activeId ?? ''}`。
- 页签持久化键在 `paneContracts.ts:268–278`：`VIEWER_LS_KEYS.tabsV2 = 'aiTeach.rightTabs.v2'`，**全局单键**。
- `loadBootState(sessionId)` 只在 `bootRef` 首次执行（RightViewer 152–161 / 225–226），换 `sessionId` 不会重载页签 → 按作用域持久化必须补「scope 变化重载」。
- `verify-right-viewer-tabs.mjs` §7（serialize/parse）与静态接线断言锁这一层。

### 7.4 主进程

- 提示词：`titleRuleHint` 1492、`teachStyleHint` 1587、`systemFull` 1727、`requestInjection` 1778、注入分区 `protocols` 1833。新 tutor hint **必须同时进 systemFull 与该分区**，否则 `verify-context-usage` 失败。
- `sessionLessonBrief` 1531 只对课程段生效；对话会话为空，课程类 hint 自然不注入。
- `AgentContextInfo` 已有 `context.data.attachedFiles` 注入（`agentService.ts:1736–1755`），AI 教学目前没传 `context`（index 1281 传 `undefined`）。若能复用 `context.data` 可省掉 4 处 IPC 改动；否则按 §2.4 新增字段。
- `agent:sessions` 出口 `camelRow` 2663–2678 会 spread 未知字段，新增 `aiTeachMode` 无需单独映射（若是 snake_case 才需要）。

### 7.5 原型里「真实应用没有」的三处

1. 会话列表（原型 379–541）：真实左栏只有 `CourseRail`，没有会话列表。
2. 解题动作行（原型 2065–2070）：真实应用没有；`quizRecord*` API 需要 `pageId + quizNo`（`src/lib/ipc.ts:593–613`），聊天回答不是知识页，不能直接写错题本。
3. 资料 chip（原型 673）：真实只有图片附件，没有通用文件 chip；本期用「右侧查看器当前文件 + 页码/章节」充当这一枚。

> 这三处按 §一「本批做」实现；第 2 条的「加入错题」若拿不到知识页 id，本期隐藏并登记到第三批（不要做假按钮）。

---

## 八、交付状态（2026-11-24）

| 块 | 状态 | 门禁 |
|---|---|---|
| F 主进程基座 | 完成 | `verify-tutor-mode` 72/72（含 regenerate / resume 沿用上一轮方式）；`verify-all-p0` 40/40；`tsc` 双配置 0 错；build 通过 |
| V 查看器作用域 | 完成 | `verify-right-viewer-tabs` 220/220；课程旧键不变 |
| R 阅读上下文 | 完成 | `verify-reading-context` 54/54；PDF/EPUB 发布 + 截断 |
| U 容器与输入卡 | 完成 | `verify-tutor-ui` 72/72；与 F/V/R 合龙后 `verify-all-p0` 42/42 |

### 已知偏差 / 待收口

1. F 额外改了 `electron/preload/index.ts`（新 IPC 必经之路，接受）。
2. V 的宽度持久化是 localStorage 覆盖层（`viewerResize.ts` 不在授权范围）；挂载首帧可能被全局 SETTINGS 宽度短暂覆盖，有 150ms 二次应用。后续可把 `viewerResize` 的键参数化。
3. ~~`agentRegenerate` / `agentResume` 不带 `teachMode`~~：已补 `lastTutorMode()`，重新生成 / 继续 / 编辑后重跑都会从最后一条 assistant 的 `teach_mode` 回读，非 tutor 会话不受影响。
4. ~~会话标题改了但文件夹仍是「新对话」~~：已加标题变化同步（`aiTeachRenameSessionFolder`），手动改名也走同一通道。
5. 「加入错题」本期不渲染（聊天回答无知识页 `pageId`），登记第三批；「加入题单」写 `产物/题单.md`。
6. md/txt 的阅读上下文尚未发布（PDF/EPUB 已覆盖），第二版补。
7. ~~新脚本未登记~~：`verify-reading-context.mjs` 与 `verify-tutor-ui.mjs` 已登记，`verify-all-p0` 42/42。
