# AI 教学体验问题记录（2026-10-28）

> 状态：**问题与方案已记录，未落码**。当前另有对话在改 AI 教学相关代码，本文作为移交/备忘，避免两边同时改同一批文件。
> 版本线：`fix/3.14.1`。
> 左栏段分组的实现方案已单独成文：`docs/ai-teaching-rail-segments-plan.md`（原型已确认）。
> 后续可合并进 `docs/pending-fixes.md`，建议编号 B-48（交接重复）、B-49（支线首条消息失效）。

---

## 实现方案索引

| 问题 | 状态 | 方案位置 |
|---|---|---|
| 问题 1：交接文档重复 / ask 出现「生成交接文档」 | 已确认，待落码 | 本文「问题 1」；三道闸 + 收尾幂等 |
| 问题 2：支线旁问新建后首条消息无效 | 已确认，待落码 | 本文「问题 2」；`onLaneReady` 移到首轮完成后 |
| 问题 3：上一段交接在输入区常驻 | 已确认，待落码 | 本文「问题 3」；首轮后直接移除 |
| 问题 4：输入区知识点胶囊没有实际用途 | 已确认，待落码 | 本文「问题 4」；直接删除胶囊 |
| 问题 5：左栏看不出哪些知识点属于同一段 | 已确认，待落码 | **`docs/ai-teaching-rail-segments-plan.md`**（段节点分组） |

---

## 问题 1：交接文档重复，且 ask 选项卡出现「生成交接文档」

### 现象

- 一个知识点结束时，AI 在对话里生成了一份交接文档；
- 之后点击「收尾本段」，系统又生成一份 `交接.md`；
- 文件树里出现两份甚至三份交接，用户无法判断哪份会被下一段读取。

### 已确认的产品口径

交接文档功能本身没有问题，问题在于**出现了第二个写者**。唯一真相源应保持为：

- **段级产物**：一段一份；
- **唯一生成时机**：用户点击「收尾本段」；
- **唯一落点**：`{段目录}/交接.md`；
- **唯一注入来源**：`handoffRel`（或标准路径 `{段目录}/交接.md`）；
- AI 在对话中**不生成、不写盘、不提供「生成交接文档」选项**。

重复文件处理：保留 `handoffRel` 指向的那份（没有则保留段目录下的标准 `交接.md`），其余用回收站删除；删除前确认没有标准交接未覆盖的独有内容。

### 根因

1. 系统侧只有 `finalizeSegment()` 会写交接：`electron/lib/aiTeachingCourse.ts` 约 L651，固定写 `{段目录}/交接.md` 并回填 `handoffRel`。
2. AI 侧没有专用交接工具，但可以通过 `course.organize.archive`（`electron/lib/builtinTools.ts` 约 L2718）写任意标题的 Markdown；底层 `archiveOrganizedPage()`（`electron/lib/aiTeachingCourse.ts` 约 L1041）使用 `uniqueFileName()`（`electron/lib/workspaceManager.ts` 约 L159），撞名会生成 `交接(1).md`，**不会覆盖**。
3. `readPrevHandoff()`（`electron/lib/aiTeachingCourse.ts` 约 L492）只认 `handoffRel` 或标准 `{段目录}/交接.md`；AI 写到 `output/`、知识点目录或 `交接(1).md` 的那份不会进入下一段交接条，但会留在文件树里，形成“重复”。
4. B-47 的本意是“AI 主动建议收尾”，不是“AI 自己写交接”。如果实现时把建议做成 ask 选项，用户点选项等于让 AI 去写，正好制造重复。

### 建议修复

#### 1. 提示词层

在 `electron/lib/aiTeachingCourse.ts` 的教师分支（约 L819）加一条纪律：

> 交接文档只由用户点击右上角「收尾本段」时由系统生成。你不要在对话中提供「生成交接文档 / 写交接 / 整理交接 / 输出交接」这类选项，也不要自行创建 `交接.md` 或任何交接文件。本段讲完只需在正文里建议用户点「收尾本段」。

同步在 `electron/lib/agentService.ts` 的 `ask` 协议（约 L1151）补教师段会话限制：**ask 选项禁止出现交接文档生成类选项**。B-47 的“主动建议”写成正文一句话，不写成 ask 选项。

#### 2. 客户端兜底

`src/modules/ai-teaching/index.tsx` 已有 `sanitizeCourseAssistantAsk()`（约 L272），可照此增加段会话过滤：

- 过滤 `/生成交接|写.*交接|整理.*交接|输出.*交接|做.*交接/`；
- 过滤后不足 2 项，补“继续下一个知识点 / 再看一个例子”这类安全项；
- 仅对 `activeSegmentSid === activeId` 的段会话生效。

#### 3. 工具硬闸

在 `archiveOrganizedPage()`（`electron/lib/aiTeachingCourse.ts` 约 L1041）中判断：段会话标题命中“交接 / handoff”直接拒绝，返回明确错误：

> 交接由「收尾本段」统一生成，不能用整理归档创建。

这样即使用户手动要求“写个交接”，AI 也绕不过去。

#### 4. 收尾幂等

`finalizeSegment()` 增加检查：`handoffRel` 已存在且文件存在 → 直接复用，不重新调用模型生成；需要重新生成时走显式二次操作。避免重复点击收尾时内容被覆盖。

#### 5. 帮助文档

`resources/help/AI 教学 · 课程模式.md` 第 51 行附近补一句：

> 知识点结束不单独生成交接；只有「收尾本段」生成一份 `交接.md`。

### 涉及文件

- `electron/lib/aiTeachingCourse.ts`（`finalizeSegment` / `archiveOrganizedPage` / 教师注入）
- `electron/lib/agentService.ts`（ask 协议）
- `electron/lib/builtinTools.ts`（`course.organize.archive` 描述）
- `src/modules/ai-teaching/index.tsx`（ask 过滤）
- `resources/help/AI 教学 · 课程模式.md`
- `.AGENT/scripts/ai-teaching/verify-course-mode.mjs`（契约）

### 验收

- 段会话 ask 卡片中不再出现「生成交接文档 / 写交接 / 整理交接」。
- AI 不再自行创建 `交接.md` 或 `交接(N).md`。
- 重复点击「收尾本段」仍只有一份 `交接.md`，`handoffRel` 稳定。
- 下一段开段预检与对话顶部交接条都只显示这一份。
- 契约脚本补负向断言：教师提示词无“让 AI 写交接”的指令；`archiveOrganizedPage` 拒绝交接标题；`finalizeSegment` 在 `handoffRel` 存在时不重复生成。

---

## 问题 2：支线旁问新建后，第一条消息发出去没效果

### 现象

点击 AI 每段回复后面的「就这点追问」按钮，在右栏「支线」中心新建一条支线后：

- 第一条消息发出后没有 AI 回复，界面看起来像没反应；
- 把文字复制下来再发一次，第二次正常；
- 第一条请求可能仍在后台跑完，导致同一条支线里存在两轮请求。

### 根因

这是面板生命周期竞态，不是消息发送 API 的问题。

1. `src/modules/ai-teaching/index.tsx` 约 L2691：点击「就这点追问」调用 `openCenter({ kind: 'create', anchorMessageId })`，右栏切到「支线」并让 `SideLaneCenter` 进入创建分支。
2. `src/modules/ai-teaching/SideLaneCenter.tsx` 约 L118–132：创建分支渲染 `SideLanePanel`，key 为 `create:${creatingAnchor}`。
3. `src/modules/ai-teaching/SideLanePanel.tsx` 的 `doSend()`：
   - 约 L191 先调用 `onLaneReady?.(laneId, ...)`；
   - 约 L198 才 `await agentChat(laneId, text, ...)`。
4. `onLaneReady` 回调（`SideLaneCenter.tsx` 约 L129）立刻执行：
   ```tsx
   setCreatingAnchor(null)
   setActiveId(lid)
   void load()
   onChanged?.()
   ```
   创建分支被卸载，详情分支（key 为 `activeId`）重新挂载。
5. 第一条 `agentChat` 仍在旧组件闭包里继续执行；流式草稿 `useAgentStream` 是面板局部状态，随旧组件卸载消失。新面板只调用一次 `agentMessages`，此时 AI 回复尚未落库，之后也不会再刷新。
6. 旧请求没有 abort，会继续跑完；用户复制重发后新面板已经稳定，所以第二次正常，但可能产生并发两轮。

### 建议修复

最小改动，不动「追问」按钮本身：

1. 在 `SideLanePanel.doSend()` 中，把 `onLaneReady` 从发送前移到**首轮 `agentChat` + `refresh` 完成之后**（放 `finally`，保证失败/中断也会回调）。
2. `doSend()` 补 `try/finally`，保证 `refresh`、`endStream`、`setPending(false)` 一定执行，避免 IPC 异常时永久卡在“生成中”。
3. 增加 `aliveRef`（或 `mountedRef`）：面板已卸载就不再回调 `onLaneReady`，避免用户中途关闭后父级又被切到详情。
4. `useCallback` 依赖数组补 `onLaneReady`。
5. `SideLaneCenter` 不需要大改；如果想把语义写清楚，可新增 `onFirstTurnDone`，但移动回调已经足够修掉竞态。

### 涉及文件

- `src/modules/ai-teaching/SideLanePanel.tsx`（`doSend` / `onLaneReady` / 清理效应）
- `src/modules/ai-teaching/SideLaneCenter.tsx`（创建分支 / 详情分支切换）
- `src/modules/ai-teaching/index.tsx`（「就这点追问」入口，仅确认，无需改动）
- `.AGENT/scripts/ai-teaching/verify-side-lane-center.mjs`（契约）

### 验收

- 右栏「支线」→「就这点追问」→ 首条消息：创建面板里能看到流式回答；答完自动切到详情，用户消息和 AI 回复都在，不需要复制重发。
- 首轮报错 / 中断：仍然切到详情，`pending` 不悬挂。
- 首轮生成中关闭：不误切视图，不删除已锁定的支线。
- 右下角浮窗路径回归：浮窗没有传 `onLaneReady`，行为应保持不变。
- 契约脚本补静态检查：`onLaneReady` 的调用位于 `agentChat` / `refresh` 之后。

---

## 问题 3：上一段交接在输入区常驻，太占位置（已确认：首轮后直接移除）

### 现象

- 进入新段时，输入框上方会展开「上一段交接（同章）」卡片；
- 第一轮对话时显示可以接受，但发出第一条消息后它仍然常驻，并占掉输入区上方约 160px（长文本还要内部滚动）；
- 用户需要在整个段内一直看到它，觉得太占位置。

### 根因

- `src/modules/ai-teaching/index.tsx` 约 L3160–3171：只要 `activeSegment && activeId === activeSegmentSid && prevHandoff` 就渲染卡片，没有“仅首轮显示”的条件。
- `handoffOpen` 默认 `true`；`prevHandoff` 加载完成的 effect（约 L566–574）每次都会 `setHandoffOpen(true)`，所以切回该段时又自动展开。
- 卡片位于输入区上方、知识点胶囊之上，展开时会把输入框整体往下推。

### 已确认方案：首轮后直接移除

用户明确不需要“收起成一行”或“移到段头”，要求**第一轮对话开始后交接提示直接消失**。

- 段内**还没有用户消息**时：保持现状，完整卡片展开，方便开段前阅读。
- 发出第一条用户消息后：交接卡**直接卸载**，输入区恢复原高度；不保留一行摘要、不在段头加入口。
- 实现：用 `messages.some(m => m.role === 'user')` 判断首轮；再配合 `messagesSidRef.current === activeSegmentSid`，避免会话切换时消息未加载完的闪一下。
- 首条发送时用 `.kb-collapse` 或 `.kb-item-out` 做一次短收起/淡出后再卸载，避免输入区硬跳；尊重 `prefers-reduced-motion`。
- 之后想回看交接，走上一段的 `交接.md` 文件本身；AI 侧本来就会把上一段交接注入上下文，不依赖这张卡。

### 涉及文件

- `src/modules/ai-teaching/index.tsx`（`prevHandoff` / `handoffOpen` / 输入区渲染）
- `.AGENT/scripts/ai-teaching/verify-course-mode.mjs`（如需补契约）

### 验收

- 首轮：完整交接卡可见。
- 发出第一条消息后：卡片直接消失，不再每轮出现；输入区高度恢复。
- 切换段/会话时不闪出旧会话的交接卡；不出现布局硬跳；尊重 `prefers-reduced-motion`。

> 状态：方案已确认（首轮后直接移除），待落码。

---

## 问题 4：输入区知识点胶囊没有实际用途（已确认：直接删除）

### 现象

- 输入框上方有一排本段知识点胶囊（截图：微处理器、总线、性能指标、数制编码、补码溢出）；
- 用户实际体验后觉得没有作用，只是持续占据输入区高度；
- 同一信息在段头已经用文字列出（`activeSegmentUnitNames.join('、')` + `N 个知识点`），胶囊属于重复展示。

### 现状用途

- 胶囊点击会调用 `aiTeachCourseSetActiveUnit`，切换本段 `activeUnitId`；
- `activeUnitId` 会进入课程上下文注入，标出 `【当前聚焦】`；
- 但左栏课程树点“本段内”的知识点也会切换聚焦（`courseOpenUnit()`，约 L1193），所以胶囊不是唯一入口。

### 建议方案

**A（推荐）：直接删除输入区这一排胶囊**

- 删除 `src/modules/ai-teaching/index.tsx` 约 L3172–3191 的整块渲染；
- 聚焦切换保留在左栏课程树（点本段内知识点即切换）；
- 段头现有文字保留，可把当前聚焦显示成 `本段 N 个知识点 · 当前：<名称>`，不加新控件、不占新行；
- “本段已收尾（只读）”已由输入框 placeholder 与隐藏的「收尾本段」按钮表达，必要时在段头补一个 `已收尾` 小徽章。

**B（如果还想保留一键切换）：把胶囊收进段头下拉**

- 段头文字改成可点击的 `本段 N 个知识点 · 当前：X ▾`，点开下拉选择聚焦；
- 输入区不再保留胶囊，段头高度不变；
- 代价是要新增一个下拉菜单及关闭逻辑。

### 涉及文件

- `src/modules/ai-teaching/index.tsx`（删除胶囊块 / 可选段头显示）
- `resources/help/AI 教学 · 课程模式.md` 第 48 行（删除“输入区上方是知识点胶囊”的说明）
- `.AGENT/scripts/ai-teaching/verify-course-mode.mjs`（如需补契约）

### 验收

- 输入区不再出现知识点胶囊，输入框高度恢复。
- 左栏点本段内知识点仍能切换聚焦；段头能看出当前聚焦（若采用 A 的段头文案）。
- 收尾只读状态仍可见。
- 帮助文档不再描述不存在的胶囊。

> 状态：已确认采用 A（直接删除输入区知识点胶囊），待落码。

---

## 问题 5：左栏看不出“哪几个知识点属于同一个段 / 对话”（已确认：段节点分组）

### 现象

- 设计上“一段 = 一个对话，覆盖同章 1..N 个知识点”；
- 左栏课程树目前是「章 → 知识点」平铺，同一段的几个知识点只是连续几行，各自带一个 `本段` 小徽章，看不出它们属于同一组；
- `inSegment` 目前只对**当前激活段**为 true；一旦切到别的段 / 章节 / 课程助手，进行中段的 `本段` 徽章就消失，看起来像没开课，必须点进对话才知道。

### 根因

- `src/modules/ai-teaching/courseRail.ts` 的 `RailUnit` 只有 `learned / active / inSegment`，没有段身份；
- `src/modules/ai-teaching/index.tsx` 的 `railChapters` 只用 `activeSegmentSid` 算 `activeIds`，所以 `inSegment` 只覆盖当前激活段；
- `src/modules/ai-teaching/CourseRail.tsx` 按知识点平铺渲染，没有“段”节点。

### 采用方案：把“段”作为左栏的一级分组节点

```text
v 预备章 微机系统与...        0/15  [进行中]
  ▾ 第1段 · 进行中 · 5 个知识点
      • 微处理器、微机与...
      • 总线与三总线结构
      • 微机的性能指标
      • 计算机中数与编码...
      • 有符号数的补码表示...
  ▸ 第2段 · 已收尾 · 3 个知识点      ← 默认折叠
  • 8086/8088 的内部结构...          ← 未开课，保持直接行
  ...
  🔒 章末复习                        还差 15 个
```

- **段头**：`第N段 · 进行中/已收尾 · N 个知识点`；点段头打开该段对话，chevron 只负责展开/收起。
- **进行中段**：默认展开；**已收尾段**：默认折叠，点开可看组内知识点。
- **章头**：本章有进行中段时显示 `进行中` 徽章/圆点，章节折叠时也能看出已开课。
- **知识点行**：去掉每行的 `本段` 徽章，段头已经表达；保留状态点（进行中 accent / 已学 success / 未开课 gray）和 active 高亮。
- **未入段的知识点**：保持直接行，排在所属大纲位置；不加额外分组，避免“未开课”三个字反复出现。
- 搜索命中段内某个知识点时，强制展开该段；段内无命中则整段不显示。

### 实现要点

- `courseRail.ts`：`RailUnit` 增加 `segmentId / segmentOrder / segmentStatus`；新增纯函数 `buildRailRows(units)` 按 `segmentId` 分组（保留首次出现位置，支持非连续 unitIds）；`activeChapterId` 改为识别任意 open 段。
- `index.tsx`：`railChapters` 从 `chapterSegments()` 建段映射；`inSegment` 改为“属于任一 open 段”，`active` 仍只标当前聚焦；给 `CourseRail` 传 `onSegment={(sid) => openSegmentBySid(sid)}`。
- `CourseRail.tsx`：渲染段头 + 组内知识点；本地 `collapsedSegs` 状态（open 默认展开、ended 默认折叠、搜索强制展开）；章头加 `进行中` 指示。
- `resources/help/AI 教学 · 课程模式.md`：左栏说明改为「章 → 段 → 知识点」，补“段头可打开对话 / 已收尾段默认折叠”。
- `.AGENT/scripts/ai-teaching/verify-course-segments.mjs`：补 `buildRailRows` 用例（同段分组、非连续 unitIds、open/ended 状态、搜索后段头保留）。

### 验收

- 左栏能一眼看出同一段的几个知识点是一组；进行中段在切换章节/助手后仍然可见。
- 章头折叠时也能看出本章有进行中的段。
- 点段头能打开对话；点段内知识点仍能切换聚焦/回看。
- 已收尾段默认折叠，展开后知识点为已学状态。
- 搜索命中段内知识点时自动展开该段；无命中不残留空段头。
- 不改变右栏「进度」页签的段列表逻辑。

> 状态：**已确认**（原型通过）· 段节点分组、已收尾段默认折叠、章头 `进行中` 徽章、段头点击打开对话均已确认。
> 实现方案：**`docs/ai-teaching-rail-segments-plan.md`**（含数据派生、文件改动、边界与验收）。

---

## 相关记录

- `docs/pending-fixes.md`：B-47「段 / 知识点讲完后 AI 不主动建议收尾生成交接并跳下一段」。
- 本文问题 1 与 B-47 的关系：B-47 只做“建议收尾”，不要做成“AI 写交接”或 ask 选项；否则会重新引入重复。
- 本文问题 2 与 AI 教学的 3.14 段模型无关，是右栏支线中心的面板挂载时序问题。

---

## 待确认

1. 问题 1 的重复文件，是否已经确认保留哪一份、删除哪两份？删除前是否要检查内容合并？
2. 问题 2 的复现路径是否仅在右栏「支线」中心；右下角浮窗的「新建」是否需要单独验证？
3. 两条问题是否合并进 `docs/pending-fixes.md` 作为 B-48 / B-49，还是保持本文独立记录？
