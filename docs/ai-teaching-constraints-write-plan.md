# AI 教学分层要求写入工具（course.constraints.write）实现方案

> 状态：已落码（2026-11-09 用户拍板走 B：专用 AI 工具；明确不做确认卡）· 待真机验收
> 目标版本：3.22.0（新功能，按 AGENTS.md 版本口径抬 minor）
> 关联文档：`docs/ai-teaching-simplify-plan.md`、`docs/ai-teaching-course-mode-plan.md`、`docs/ai-teaching-module-rework.md`
> 影响面：AI 教学（`source='aiTeaching'`）的课程助手 / 段会话 / 复习课 / 零散教学会话；四层 `CONSTRAINTS.md` 写入

---

## 0. 结论摘要

只做一件事：给 AI 教学助手一个专用的写要求工具 `course.constraints.write`。

- AI 识别到用户说「写一个规范 / 限制 / 约束 / 要求 / 规则」时，直接把内容写进四层 `CONSTRAINTS.md` 中正确的一层，不再另建 `规范.md`、`学习规范.md` 之类的普通产物。
- 不新增确认卡、不新增弹层、不新增 fence 协议。用户说写，AI 就写。
- 复用现有 `aiTeachingScope` / `aiTeachingFolders` 的写盘与广播，不新造文件格式、不开 `.knowbase` 写白名单、不新增 IPC / preload / types。
- 默认 `append`（追加条目），`replace`（整篇覆盖）只在用户明确说「重写 / 替换 / 清空」时使用。
- 写入后**下一轮用户消息**生效；本轮回答不会重新注入刚写的要求。
- 每层注入上限是 12 条 / 1200 字符；写入超限时工具返回警告，避免「文件写了但没进 AI 上下文」。

不做：

- 不做 C 方案的 `constraints` 围栏 + 确认卡。
- 不做要求文件的独立编辑器 / 新弹层；现有 `RequirementsDrawer` 保留。
- 不改四层注入顺序、截断规则和 `scopePrompt` 契约。
- 不改通用助手的 `.assistant/CONSTRAINTS.md` 通道。
- 不做定时任务、自动整理要求、AI 自审要求。

---

## 1. 背景

### 1.1 用户反馈

在 AI 教学区让教学助手「生成一个规范文档」，结果：

- 文件名不对：不是 `CONSTRAINTS.md`；
- 位置不对：落在会话产物目录，不是四层要求路径；
- 结论：这份文档不会被 `scopePrompt` 读取，起不到规范 AI 的作用。

### 1.2 现状核查结论

注入链路本身正常：`verify-scope-injection.mjs` 31/31、`verify-scope-files.mjs` 91/91 通过。问题不在读取，而在**AI 从未被告知文件契约**：

| # | 缺口 | 证据 | 后果 |
|---|---|---|---|
| G1 | 模型只看到要求正文，看不到文件名与路径 | `electron/lib/scopePrompt.ts:25-47`、`:89-97` | 不知道应该写 `CONSTRAINTS.md` |
| G2 | 四层全空时零注入 | `electron/lib/scopePrompt.ts:96` | AI 连这套机制存在都不知道 |
| G3 | 产物落点纪律要求写会话夹，禁止写工作区根 / 章根 | `electron/lib/agentService.ts:1343-1352` | 与 `{工作区}/CONSTRAINTS.md`、`段N/CONSTRAINTS.md` 冲突 |
| G4 | 裸文件名被归一到会话夹 | `electron/lib/builtinTools.ts:429-444`、`:2337-2338` | 即使写对文件名也会落错位置 |
| G5 | 没有面向 AI 的要求写入工具 | `electron/lib/aiTeachingScope.ts:294-298`、`electron/lib/builtinTools.ts:2010` | AI 只能用通用 `vault.write` / `course.organize.archive` |
| G6 | `course.organize.archive` 缺省落会话产物目录，且同名会 `uniqueFileName` | `electron/lib/aiTeachingCourse.ts:1587-1610` | 可能生成 `规范.md` 或 `CONSTRAINTS (1).md` |
| G7 | 课程助手提示词要求「落盘只走这些工具，不要另造文件」 | `electron/lib/aiTeachingCourse.ts:1290` | 模型没有写要求文档的合法路径 |
| G8 | 2026-11-03 起不再播种会话 / 段级 `CONSTRAINTS.md` | `electron/lib/aiTeachingFolders.ts:171-172`、提交 `9dbdfdf8` | 新会话没有骨架提示；四层全空时 AI 完全不知道机制存在 |

### 1.3 为什么选 B

用户明确不要 C 的确认卡：多一步确认会增加信息负担；用户说「写一个限制」时，期望就是直接写 `CONSTRAINTS.md`。

B 的写法符合这个期望：

- 不新增确认 UI；用户只看到正常的工具执行步骤。
- `course.constraints.write` 是 `tier:'ondemand'` 工具，模型通过 `builtin.tool.request` 装载；这个申请是**模型内部**的工具启用，不需要用户点确认（`electron/lib/builtinTools.ts:2006-2071`），与 C 的卡片确认不是一回事。
- 写入后 AI 在回答里给出落盘相对路径；这是信息，不是二次确认。

---

## 2. 目标与非目标

### 2.1 目标

- 用户说「写一条要求 / 规范 / 限制 / 规则」时，AI 写入正确层的 `CONSTRAINTS.md`，而不是普通产物。
- 支持四层：全局 / 本课程 / 本知识点 / 本段。
- 文件名固定 `CONSTRAINTS.md`；目录不存在时自动创建。
- 写完复用现有广播，文件树、要求抽屉、课程画布计数即时刷新。
- 写入内容下一轮对话自动注入，真正约束 AI。
- 默认追加，避免误覆盖用户已有要求。
- 超注入上限、覆盖已有内容等风险有工具级提示，不静默失败。

### 2.2 非目标

- 不做确认卡 / fence 协议 / 预览弹层。
- 不做新的要求编辑器；继续用现有 `RequirementsDrawer` 手动改。
- 不新增 `course.constraints.ensure`；`write` 内部完成创建。
- 不把四层要求塞进 `.knowbase` JSON；文件仍是唯一真相源。
- 不改通用助手要求通道，也不改画像通道。
- 不做要求内容的自动分类 / 自动摘要 / 自动迁移。

---

## 3. 工具设计

### 3.1 名称与注册属性

| 项 | 值 |
|---|---|
| 工具名 | `course.constraints.write` |
| 标题 | 写入分层要求 |
| 层级 | `tier: 'ondemand'` |
| 权限 | `requires: 'write'` |
| 只读 | `readOnly: false` |
| 模块 | 不设 `module`（与 `course.outline.write` 等课程工具一致） |
| 可用面 | 仅 `ctx.source === 'aiTeaching'` 且 `ctx.sessionId` 非空 |
| 不可用面 | 通用助手、日程助手、情报助手、支线（支线写工具会被工具面预过滤） |

选择 `ondemand` 的理由：AGENTS.md 铁律 16，新增工具默认不进 core；单工具 schema 控制在 800 字符以内。它只在用户明确要求写要求时才需要，没必要每轮常驻。

### 3.2 输入 schema 草稿

```json
{
  "type": "object",
  "properties": {
    "level": {
      "type": "string",
      "enum": ["global", "workspace", "unit", "segment"],
      "description": "要求层：global=所有课程；workspace=本课程；unit=本知识点；segment=本段/本对话"
    },
    "text": {
      "type": "string",
      "description": "markdown 正文；append 时建议一行一条，以「- 」开头"
    },
    "mode": {
      "type": "string",
      "enum": ["append", "replace"],
      "description": "append=追加（默认，推荐）；replace=整篇覆盖本层，仅用户明确要求重写时用"
    },
    "unit": {
      "type": "string",
      "description": "level=unit 时的知识点名称或 id；缺省=当前聚焦知识点"
    }
  },
  "required": ["level", "text"]
}
```

约束：

- `text` 去首尾空白后不能为空。
- `text` 上限 20000 字符；超过直接拒绝（防止模型一次性刷巨大文件）。
- 拒绝 NUL 字符。
- `level` 必须命中四枚举；`chapter` 不接受。
- `unit` 只在 `level='unit'` 时有意义；其他层忽略。

### 3.3 层级与落点

统一使用现有解析器，不在工具里手拼路径：

| level | 解析方式 | 最终文件 |
|---|---|---|
| `global` | `rootDirName(getSetting)` | `{AI教学产物根}/CONSTRAINTS.md` |
| `workspace` | `workspaceFolderRel(wsId, getSetting)` | `{工作区}/CONSTRAINTS.md` |
| `unit` | `unitFolderRel(wsId, unitId, getSetting)` + `unitConstraintsRel()` | `{工作区}/第N章 章名/知识点/{NN} 知识点/CONSTRAINTS.md` |
| `segment` | `writeConstraints(sessionId, ...)` → `ensureSessionFolder` | `{工作区}/第N章 章名/段N/CONSTRAINTS.md` |

补充：

- `global` 不要求会话归属工作区；任何 AI 教学会话都可写。
- `workspace` 要求 `getWorkspaceOfSession(sessionId)` 有值；没有则报「当前对话未归属工作区」。
- `unit` 只允许在段会话中写，且知识点必须属于本段（`getSessionUnitFolderRels` 的范围），不能跨段写。
- `segment` 只允许在段会话中写；课程助手 / 复习课没有段层，报错并提示改用 `workspace` 或 `global`。
- 课程助手默认写 `workspace`（本课程层）；段会话默认写 `segment`（本段层）；用户明确点名范围时按用户。

### 3.4 默认层规则

写进 system prompt，由模型自己选 `level`：

- 用户说「所有课程 / 以后都这样 / 跨课程」→ `global`。
- 用户说「这门课 / 本课程 / 这个工作区」→ `workspace`。
- 用户说「这个知识点 / 这一节这个点」→ `unit`。
- 用户说「这一段 / 这次对话 / 接下来这节」→ `segment`。
- 没有明确范围时：
  - 课程助手 / 复习课 → `workspace`；
  - 段会话 → `segment`。
- 课程助手 / 复习课不要用 `segment`；工具会拒绝并提示改层。

### 3.5 append / replace 语义

**默认 `append`：**

1. 读当前层正文；
2. 归一 CRLF；
3. `existing.trimEnd()` 与 `text.trim()` 之间插入一个空行；
4. 末尾补一个换行；
5. 写回。

**`replace`：**

1. 归一 CRLF；
2. `text.trim()` + 末尾换行；
3. 整篇覆盖本层。

规则：

- 只有用户明确说「重写 / 替换 / 清空 / 重新生成一份」时才用 `replace`。
- 用户说「再加一条 / 补一条」时只用 `append`。
- `replace` 覆盖已有非空内容时，工具结果带 `warning: '已覆盖本层原有内容'`；AI 应在回答里说明。
- 不因为 `replace` 弹确认框——这是 B 方案的核心；风险由提示词、默认值和工具警告控制。

### 3.6 注入上限与截断

四层注入的硬上限在 `electron/lib/scopePrompt.ts`：

- 每层 ≤ 12 条非空行；
- 每层 ≤ 1200 字符；
- 超出追加「（已截断）」。

工具必须在写完后做一次同样的裁剪检查：

```ts
const cut = cutScopeLayer(body)
```

返回：

- `truncated: true`（本层超出注入上限）；
- `hint: '本层超过注入上限（12 条 / 1200 字符），超出部分不会进入 AI 上下文；请压缩后重写或改用 replace。'`

另外两种情况要单独提示：

- `append` 时，如果**原有内容**已经 `truncated`，新追加的条目大概率不会进入注入范围；返回 `warning: '原有内容已超过注入上限，追加内容可能不生效；建议用 replace 写一份精炼版'`。
- `replace` 写入后仍 `truncated` → `warning: '内容仍超过注入上限，超出部分不会注入'`。

这是本方案必须保留的“真实性检查”：用户要的是能规范 AI 的文档，不是只写进磁盘的文档。

### 3.7 返回值

建议返回：

```json
{
  "ok": true,
  "level": "workspace",
  "relPath": "AI教学/数学冲刺/CONSTRAINTS.md",
  "mode": "append",
  "chars": 86,
  "items": 3,
  "truncated": false
}
```

异常时返回（工具 handler 抛错，模型看到 `ok:false`）：

```json
{ "ok": false, "error": "当前对话未归属工作区" }
```

工具描述只说「返回落盘相对路径」，不要在 description 里罗列全部返回字段（AGENTS.md 铁律 16）。

### 3.8 不新增确认 UI

- 不弹卡片、不弹抽屉、不要求用户再点一次。
- 用户的一句话就是意图确认；AI 执行后把 `relPath` 写在回答里。
- 写入是真实的文件写入，走工具审计；失败时按执行纪律如实说明「未执行」。

---

## 4. 业务实现

### 4.1 新增业务函数

放在 `electron/lib/aiTeachingScope.ts`（该文件已经是“层 → 文件”的唯一解析地）：

```ts
export type AiTeachConstraintLevel = 'global' | 'workspace' | 'unit' | 'segment'

export interface AiTeachConstraintWriteInput {
  level: AiTeachConstraintLevel
  text: string
  mode?: 'append' | 'replace'
  unit?: string | null
}

export interface AiTeachConstraintWriteResult {
  ok: boolean
  level?: AiTeachConstraintLevel
  relPath?: string
  mode?: 'append' | 'replace'
  chars?: number
  items?: number
  truncated?: boolean
  warning?: string
  hint?: string
  error?: string
}

export function writeConstraintsForAiTeaching(
  sessionId: string,
  input: AiTeachConstraintWriteInput,
  getSetting: (key: string) => unknown,
): AiTeachConstraintWriteResult
```

实现步骤：

1. 校验 `sessionId`、`text`、`level`、`mode`。
2. `wsId = getWorkspaceOfSession(sessionId)`（`global` 可为空）。
3. 解析层级：
   - `global`：直接用 `rootDirName(getSetting)`；
   - `workspace`：要求 `wsId`；
   - `unit`：要求段会话；解析 `unit` 名称 / id / 当前聚焦知识点；
   - `segment`：要求段会话。
4. 读当前正文：
   - 非段层：`readScopeText(ref, getSetting)`；
   - 段层：`readConstraints(sessionId, getSetting)`。
5. 按 `append` / `replace` 合成正文。
6. 写：
   - 非段层：`writeScopeText(ref, body, getSetting)`；
   - 段层：`writeConstraints(sessionId, body, getSetting)`，并补发 `aiTeachCourseRefresh`（`writeConstraints` 目前只发 tree refresh）。
7. 用 `cutScopeLayer(body)` 计算 `truncated`，用 `countConstraintItems(body)` 计算条目数。
8. 返回 `relPath`、`mode`、`chars`、`items`、`truncated`、`warning/hint`。

### 4.2 段会话 / 知识点解析

在 `electron/lib/aiTeachingCourse.ts` 新增一个轻量 helper：

```ts
export interface SessionLessonBrief {
  unitIds: string[]
  activeUnitId?: string
}

export function getSessionLessonBrief(
  sessionId: string,
  getSetting: (key: string) => unknown,
): SessionLessonBrief | null
```

实现：

```ts
const wsId = getWorkspaceOfSession(sessionId)
if (!wsId) return null
const s = wsState(readProgressFile(), wsId)
const l = s.lessons?.[sessionId]
if (!l) return null
return { unitIds: lessonUnitIds(l), activeUnitId: l.activeUnitId }
```

用途：

- 判断当前会话是不是段会话（`segment` / `unit` 层可用性）；
- 解析 `unit` 缺省值（`activeUnitId` → `unitIds[0]`）。

`unit` 显式值解析：

- 先按 id 精确匹配；
- 再按名称精确匹配；
- 只在 `getSessionUnitFolderRels(sessionId, getSetting)` 返回的本段知识点范围内匹配；
- 匹配不到报「该知识点不在本段；请到对应段或知识点层写入」。

### 4.3 广播

- 非段层：`writeScopeText` 已经发 `aiTeachTreeRefresh` + `aiTeachCourseRefresh`，直接复用。
- 段层：`writeConstraints` 发 `aiTeachTreeRefresh`；新函数补发 `aiTeachCourseRefresh`，保证课程画布 / 右栏要求计数刷新。
- 不新增广播通道（铁律 1）。

### 4.4 错误口径

| 场景 | 错误 |
|---|---|
| 非教学会话 | `仅可在 AI 教学对话中使用` |
| 缺会话 id | `仅可在 AI 教学对话中使用` |
| `level` 非法 | `未知要求层：xxx` |
| `global` 无仓库 | `尚未打开仓库` |
| `workspace` 未归属 | `当前对话未归属工作区` |
| `unit` / `segment` 但非段会话 | `当前会话不是段会话；课程助手 / 复习课请用 workspace 或 global` |
| `unit` 未指定且无法解析 | `无法确定知识点；请传 unit（知识点名称或 id）` |
| `unit` 不在本段 | `该知识点不在本段；请到对应段或知识点层写入` |
| `text` 空 | `text 不能为空` |
| `text` 过长 | `text 过长（上限 20000 字符）` |
| 写入失败 | 原样返回 fs 错误，AI 如实转述 |

---

## 5. 工具注册与提示词

### 5.1 注册位置

在 `electron/lib/builtinTools.ts` 的「对话驱动建课」工具段注册，建议放在 `course.review.write` 之前或之后，保持课程工具聚在一起。

handler 要点：

```ts
const sid = String(ctx?.sessionId ?? '')
if (!sid || ctx?.source !== 'aiTeaching') throw new Error('仅可在 AI 教学对话中使用')
const r = writeConstraintsForAiTeaching(sid, {
  level: args.level as AiTeachConstraintLevel,
  text: str(args.text),
  mode: args.mode === 'replace' ? 'replace' : 'append',
  unit: args.unit == null ? null : str(args.unit),
}, getSettingReader())
if (!r.ok) throw new Error(r.error ?? '写入要求失败')
return r
```

### 5.2 `agentService` 新增提示

在 `electron/lib/agentService.ts` 的 AI 教学提示段新增一个稳定 hint，建议放在 `writeScopeHint` 之后：

```ts
const constraintsToolHint = source === 'aiTeaching' && !isSideLane
  ? '\n\n【要求文档（AI教学）】四层要求统一是 CONSTRAINTS.md：全局 / 本课程 / 本知识点 / 本段。'
    + '用户说「写一个规范 / 限制 / 约束 / 要求 / 规则」时，指的是写这些要求文件，不是普通讲义或笔记。'
    + '用 course.constraints.write 落盘（不在工具列表时先 builtin.tool.request 申请）：'
    + 'level 选最匹配当前场景的一层；课程助手 / 复习课默认 workspace，段会话默认 segment；'
    + '用户明确点名范围时按用户（所有课程→global，这门课→workspace，这个知识点→unit，这一段→segment）。'
    + '默认 mode=append 追加条目；只有用户明确要求「重写 / 替换 / 清空」才用 replace；unit 层缺省用当前聚焦知识点。'
    + '不要用 vault.write / course.organize.archive 创建要求文档，也不要另起文件名。'
    + '每层注入上限 12 条 / 1200 字符，内容保持精炼；超出部分不会进入 AI 上下文。'
  : ''
```

同时：

- 在 `writeScopeHint` 末尾加一句例外：`要求文档（四层 CONSTRAINTS.md）除外：用 course.constraints.write 写入，见【要求文档】。`
- 在 `systemFull` 拼接中把 `constraintsToolHint` 放在 `writeScopeHint` 之后。
- 在 `injection.ruleChars` 中加上 `constraintsToolHint.length`。
- 支线会话不注入（`requires:'write'` 工具本来也会被过滤）。

### 5.3 `builtin.tool.request` 清单

在 `electron/lib/builtinTools.ts:2010` 的工具清单中加入 `course.constraints.write`，位置放在 `course.organize.archive` 附近。

模型需要知道这个工具存在；否则只会申请 `vault.write` 或 `course.organize.archive`，然后被兜底拦截。

### 5.4 课程注入文案

`electron/lib/aiTeachingCourse.ts` 的课程助手分支末尾（当前 `:1290`）补一句：

> 要求 / 规范 / 限制用 `course.constraints.write` 写四层 `CONSTRAINTS.md`（默认本课程层），不要用 `course.organize.archive` 或 `vault.write` 造普通文档。

段会话分支可补一句：

> 要求文档用 `course.constraints.write`：本段用 `segment`（默认），本课程用 `workspace`，本知识点用 `unit`，全局用 `global`；不要另建 `规范.md`。

---

## 6. 兜底拦截

即使提示词到位，模型仍可能走旧的普通写路径。需要两道硬闸：

### 6.1 `builtin.vault.write`

在 `electron/lib/builtinTools.ts` 的 `vault.write` handler 中，`normalizeAiTeachingWritePath` 之后、`assertCanWrite` 之前：

```ts
const base = rel.split('/').pop()?.toLowerCase() ?? ''
if (ctx?.source === 'aiTeaching' && base === 'constraints.md') {
  throw new Error('要求文档请用 course.constraints.write 写入（level 指定层），不要用 vault.write 另建或覆盖 CONSTRAINTS.md')
}
```

### 6.2 `builtin.vault.edit`

同样在 `vault.edit` handler 中按 basename `constraints.md` + `ctx.source === 'aiTeaching'` 拦截，提示改用 `course.constraints.write`。

### 6.3 `course.organize.archive`

在 `electron/lib/aiTeachingCourse.ts` 的 `archiveOrganizedPage` 中，`isHandoffTitle` 旁边加：

```ts
const titleBase = String(title ?? '').replace(/\.md$/i, '').trim().toLowerCase()
if (titleBase === 'constraints') {
  return { ok: false, error: '要求文档请用 course.constraints.write 写入，不要用整理归档创建 CONSTRAINTS.md' }
}
```

只拦 AI 教学里的这三条创建 / 改写路径；`vault.rename` / `vault.move` 不在本轮范围。

---

## 7. UI 刷新

写入本身已经走广播，但 `RequirementsDrawer` 不会自动重读。建议做最小接线：

- `RequirementsDrawer.tsx` 增加可选 `reloadKey?: number`，`load` 的 `useEffect` 依赖里带上它。
- `src/modules/ai-teaching/index.tsx` 增加 `reqTick` 状态：
  - 在 `onTree`（`aiTeach:tree-refresh`）里 `setReqTick(v => v + 1)`；
  - `kb:file-saved` 且 basename 是 `CONSTRAINTS.md` 时也 `setReqTick(v => v + 1)`；
  - 把 `reloadKey={reqTick}` 传给 `RequirementsDrawer`。
- 这样 AI 写完后，用户若正打开要求抽屉，内容会刷新到最新；抽屉关闭时无额外开销。
- 已加 `dirty` 判定：有未保存草稿时，`reloadKey` 触发的重读直接跳过（切层仍照常载入），避免 AI 写盘时覆盖用户正在编辑的内容。

---

## 8. 文件改动清单

| 文件 | 改动 |
|---|---|
| `/home/lousync/Projects/Phrontis/electron/lib/aiTeachingScope.ts` | 新增 `AiTeachConstraintLevel` / 输入输出类型 / `writeConstraintsForAiTeaching()`；segment 写入补 `aiTeachCourseRefresh` |
| `/home/lousync/Projects/Phrontis/electron/lib/aiTeachingCourse.ts` | 新增 `getSessionLessonBrief()`；`archiveOrganizedPage` 拦 `CONSTRAINTS` 标题；课程助手 / 段提示词补一句 |
| `/home/lousync/Projects/Phrontis/electron/lib/builtinTools.ts` | 注册 `course.constraints.write`；`vault.write` / `vault.edit` 拦 `CONSTRAINTS.md`；`builtin.tool.request` 清单加入新工具 |
| `/home/lousync/Projects/Phrontis/electron/lib/agentService.ts` | 新增 `constraintsToolHint`；`writeScopeHint` 加要求例外；拼进 `systemFull`；`ruleChars` 计入 |
| `/home/lousync/Projects/Phrontis/src/modules/ai-teaching/RequirementsDrawer.tsx` | 可选 `reloadKey`，写盘后刷新 |
| `/home/lousync/Projects/Phrontis/src/modules/ai-teaching/index.tsx` | `reqTick` 状态与 `reloadKey` 接线 |
| `/home/lousync/Projects/Phrontis/.AGENT/scripts/ai-teaching/verify-scope-files.mjs` | 扩展真实临时目录用例：四层写入 / append / replace / unit 解析 / segment / 截断警告 |
| `/home/lousync/Projects/Phrontis/.AGENT/scripts/ai-teaching/verify-ai-teaching-tools.mjs` | 新工具注册 / schema / request 清单 / 提示词静态断言 |
| `/home/lousync/Projects/Phrontis/.AGENT/scripts/ai-tools-audit/out-schema-baseline.txt` | 生成基线：工具总数 68、新工具 schema 472 字符 |
| `/home/lousync/Projects/Phrontis/resources/help/AI 教学 · 课程模式.md` | 「要求」节补「可以直接对助手说写一条要求」及默认层规则 |
| `/home/lousync/Projects/Phrontis/CHANGELOG.md` | v3.22.0 新功能条目 |

不需要改：

- `electron/preload/index.ts`
- `src/lib/ipc.ts`
- `src/types/index.ts`
- `electron/main/index.ts`
- `windowBus` 广播通道
- `.knowbase` 任何 JSON

---

## 9. 契约与测试

### 9.1 `verify-scope-files.mjs` 新增用例

用真实临时目录往返，建议覆盖：

1. `global` append：文件不存在 → 创建；内容正确。
2. `workspace` append：已有内容 → 保留原内容 + 空行 + 新内容；不出现三连空行。
3. `unit` 按 id 写、按名称写、缺省 activeUnitId 写。
4. `unit` 不在本段 → 拒绝且不创建文件（负向）。
5. `segment` 写 `段N/CONSTRAINTS.md`；课程助手写 segment → 拒绝（负向）。
6. `replace` 覆盖已有内容；`append` 不覆盖。
7. `text` 为空 / 超长 / NUL → 拒绝（负向）。
8. `level` 非法 → 拒绝且不落盘（负向）。
9. 写盘后 `aiTeachTreeRefresh` 与 `aiTeachCourseRefresh` 各一次（segment 也补 course refresh）。
10. 内容超过 12 条 / 1200 字符 → `truncated: true` + hint。
11. 原有内容已截断时 append → warning（负向保护）。
12. CRLF 输入被归一为 LF。

### 9.2 `verify-ai-teaching-tools.mjs` 新增断言

- `tools.includes("name: 'course.constraints.write'")`
- 注册对象同时含 `requires: 'write'` 与 `tier: 'ondemand'`
- `builtin.tool.request` 描述含 `course.constraints.write`
- `agentService.ts` 含 `course.constraints.write` 与「四层要求统一是 CONSTRAINTS.md」
- `aiTeachingCourse.ts` 课程助手提示含 `course.constraints.write`
- schema 序列化长度 ≤ 800（如脚本能解析注册对象）
- `vault.write` / `vault.edit` 拦截 `constraints.md` 的静态断言
- `archiveOrganizedPage` 拦截 `constraints` 标题的静态断言

### 9.3 类型与构建

- `npx tsc --noEmit -p tsconfig.node.json`
- `npx tsc --noEmit -p tsconfig.web.json`
- `npm run build`

### 9.4 真机验收

1. 课程助手说「写一条要求：每次先给结论再展开」→ 检查 `AI教学/{工作区}/CONSTRAINTS.md`。
2. 段会话说「这段的要求：例题先讲思路」→ 检查 `.../第N章 章名/段N/CONSTRAINTS.md`。
3. 段会话说「这个知识点的要求：…」→ 检查 `.../知识点/{NN} 知识点/CONSTRAINTS.md`。
4. 说「以后所有课程都…」→ 检查 `AI教学/CONSTRAINTS.md`。
5. 说「再加一条…」→ 原内容保留，新条目追加。
6. 说「重写成…」→ 原内容被替换，工具结果有覆盖提示。
7. 发下一条消息 → AI 的回答遵守新要求（下一轮注入生效）。
8. 检查没有生成 `规范.md` / `学习规范.md` / `CONSTRAINTS (1).md`。
9. 打开要求抽屉 → 内容与文件一致；若保持打开，AI 写后应刷新。

---

## 10. 帮助文档与发布

### 10.1 帮助手册

`/home/lousync/Projects/Phrontis/resources/help/AI 教学 · 课程模式.md` 的「要求（CONSTRAINTS.md）」节补：

- 可以直接对助手说「写一条要求：…」，助手会写到对应层；
- 课程助手 / 复习课默认本课程层，段会话默认本段层；
- 说「所有课程」写全局，说「这个知识点」写知识点层；
- 写入后下一轮生效；每层注入上限 12 条 / 1200 字符。

### 10.2 CHANGELOG / 更新说明

- `CHANGELOG.md` 增 v3.22.0 段，标题建议「AI 教学 · 要求文档」。
- 按 AGENTS.md 铁律 24 重跑：
  `node .AGENT/scripts/release-notes/build-release-notes.mjs`
- `npm run pack` → `packs/3.22.0`；发布按 `scripts/publish-release.py`。

---

## 11. 风险与回退

| 风险 | 处理 |
|---|---|
| AI 选错层 | 提示词给默认层规则；工具拒绝非法层并给出明确错误；工具返回 `relPath`，用户能看到落点 |
| AI 用 `vault.write` 旧路径 | `vault.write` / `vault.edit` / `course.organize.archive` 三道硬闸拦截并提示改用新工具 |
| 误覆盖用户已有要求 | 默认 `append`；`replace` 只由明确指令触发；工具结果带覆盖 warning |
| 写入内容过长，实际不注入 | `cutScopeLayer` 检查 + `truncated` / hint；提示词要求精炼 |
| 原有内容已超限，append 不生效 | 工具返回 warning，建议 replace 精炼版 |
| 工具申请多一轮 | `tier:'ondemand'` 的既有代价；不弹用户确认，不增加用户操作。若真机体感差，再评估升 core |
| 抽屉打开时被刷新覆盖草稿 | P0 先直接刷新；如出现编辑冲突，P1 加 dirty 判断 |
| 课程助手写 segment 被拒 | 明确错误文案引导改用 workspace / global；不静默改层 |
| 后续要求格式变化 | 文件仍是 `CONSTRAINTS.md` 纯文本，不新增 JSON 结构；改动只影响写入策略 |

回退：

- 删除工具注册与提示词即可回到现状；已写入的 `CONSTRAINTS.md` 仍是普通文件，不影响读取。
- 不涉及数据迁移，不需要回滚脚本。

---

## 12. 待确认

1. **`course.constraints.read` 是否同批做？**
   建议 P1：当前注入已经给正文（超限会标「已截断」），MVP 不需要 read；如果后续经常需要「整篇重写长要求」，再加只读工具。
2. **课程助手写 `segment` 是否允许？**
   建议拒绝：课程助手没有段层，默认 workspace；要只约束当前助手对话，继续用现有「会话要求」入口。
3. **目标版本是否 3.22.0？**
   按 AGENTS.md「新功能抬 minor」，当前 3.21.0 → 3.22.0；如要并到别的版本，落码前改这里。

---

## 13. 落码记录（2026-11-09）

- 已实现 `course.constraints.write`（ondemand / write）：四层解析、append / replace、unit 层按 id / 名称 / 当前聚焦解析、段层拒绝课程助手、注入上限截断提示。
- 已实现 `vault.write` / `vault.edit` / `course.organize.archive` 三道 `CONSTRAINTS.md` 兜底拦截。
- 已补 `agentService` 要求文档协议、`writeScopeHint` 例外、课程助手 / 段会话提示、`builtin.tool.request` 清单。
- 已补 `RequirementsDrawer` 的 `reloadKey` 刷新链路。
- 契约：`verify-scope-files.mjs` 117/117、`verify-scope-injection.mjs` 31/31、`verify-ai-teaching-tools.mjs` 55/55、`verify-course-mode.mjs` 83/83；`tsc node/web` 0 错误；`npm run build` 通过。
- 已随 3.22.0 发版补齐：`CHANGELOG.md` v3.22.0 段、`package.json` / `package-lock.json` 版本号、`build-release-notes.mjs`。

## 14. 产物落点优先级修正（2026-11-09）

### 14.1 问题

用户在**本课程** `CONSTRAINTS.md` 里写明「教材写到章根目录」，AI 却回复「系统规则要求产物统一写入会话文件夹」，把教材落到 `第N章/段1/`。根因是旧 `writeScopeHint` 把系统默认落点写成绝对规则，且四层注入串的标题只叫「工作区要求 / 本段要求」，模型把系统 `writeScopeHint` 误当成「本段」层（类别错误——四层其实全是用户文件）。

### 14.2 拍板口径

优先级（高→低）：

1. **系统硬边界**：权限 / 作用域、`SOURCES/` 只读、`.knowbase` 与点目录禁写、系统生成文件（`交接.md`、`课程.md`、`.session.json`、`CONSTRAINTS.md`）、支线角色、UI 协议（quiz / 标题 / ask / plan / outline）。
2. 用户当前消息
3. 用户本段要求（`段N/CONSTRAINTS.md`）
4. 用户知识点要求（`知识点/{NN} 知识点/CONSTRAINTS.md`）
5. 用户本课程要求（`{工作区}/CONSTRAINTS.md`）
6. 用户全局要求（`AI教学/CONSTRAINTS.md`）
7. 系统默认策略（默认落点：会话夹 > 工作区夹 > 仓库；段会话 archive 不指定 target）
8. 内置人设

产物类型分流：

- **教材 / 知识库正文**：`vault.write` 直接写用户指定路径；`.md` 传 `ensureId:true`，落盘时补稳定 frontmatter id（已有 id 原样保留）。
- **普通课程产物**（讲义 / 笔记 / 测验 / 总结）：默认 `course.organize.archive` 进会话夹；用户要求指定落点时按用户要求。
- **要求文档**：只走 `course.constraints.write`（全文读取用 `course.constraints.read`）。

### 14.3 落码点

| 文件 | 改动 |
|---|---|
| `electron/lib/scopePrompt.ts` | 抬头改为「用户分层要求」，四层标题加「用户」；抬头写明完整优先级链与系统硬边界。 |
| `electron/lib/agentService.ts` | `writeScopeHint` 重写为「产物落点与优先级」：用户要求 > 系统默认；教材走 `vault.write` + `ensureId`；系统硬边界清单。`scopeRuleHint` 允许四层要求扩大取材范围。 |
| `electron/lib/aiTeachingCourse.ts` | 长资料笔记落点改为「用户要求优先，未指定才问」；课程助手提示补教材 `vault.write` + `ensureId`；段会话 archive 拒绝文案指向 `vault.write`；拦 `课程.md` 与 `SOURCES`。 |
| `electron/lib/builtinTools.ts` | `vault.write` 新增 `ensureId`；新增 `aiTeachingWriteBoundaryError`（SOURCES / 点目录 / 交接 / 课程 / CONSTRAINTS）；显式多段路径不再被归一化；新增 `course.constraints.read`；`builtin.tool.request` 清单同步。 |
| `electron/lib/aiTeachingScope.ts` | 新增 `readConstraintsForAiTeaching`；write/read 共用 `resolveConstraintLayer`。 |
| `electron/lib/quizDocPure.ts` | 新增 `ensureKnowledgeDocFrontmatter` / `readFrontmatterId`。 |
| `src/modules/ai-teaching/constraintsParse.ts` | 新增注入上限常量与 `exceedsConstraintInjectLimit`（与 `scopePrompt` 同口径）。 |
| `src/modules/ai-teaching/RequirementsDrawer.tsx` | 超限时一行内联轻提示。 |

### 14.4 契约

- `verify-scope-injection.mjs`：37/37（含新优先级链断言）。
- `verify-scope-files.mjs`：128/128（新增 `course.constraints.read` 全文 / 截断提示 / 负向用例）。
- `verify-ai-teaching-tools.mjs`：73/73（新工具、`ensureId`、硬边界、提示词与抽屉提示断言）。
- `verify-constraints-parse.mjs`：46/46（渲染层上限常量与 `scopePrompt` 同口径）。
- `verify-quiz-fence.mjs`：`ensureKnowledgeDocFrontmatter` / `readFrontmatterId` 用例通过。
- `verify-course-layout.mjs`：64/64。

## 附录 A：提示词草稿（可直接落码）

```text
【要求文档（AI教学）】四层要求统一是 CONSTRAINTS.md：全局 / 本课程 / 本知识点 / 本段。
用户说「写一个规范 / 限制 / 约束 / 要求 / 规则」时，指的是写这些要求文件，不是普通讲义或笔记。
用 course.constraints.write 落盘（不在工具列表时先 builtin.tool.request 申请）：
level 选最匹配当前场景的一层；课程助手 / 复习课默认 workspace，段会话默认 segment；
用户明确点名范围时按用户（所有课程→global，这门课→workspace，这个知识点→unit，这一段→segment）。
默认 mode=append 追加条目；只有用户明确要求「重写 / 替换 / 清空」才用 replace；unit 层缺省用当前聚焦知识点。
不要用 vault.write / course.organize.archive 创建要求文档，也不要另起文件名。
每层注入上限 12 条 / 1200 字符，内容保持精炼；超出部分不会进入 AI 上下文。
```

## 附录 B：工具 description 草稿

```text
把用户的规范 / 限制 / 约束 / 要求写入 AI 教学四层要求文件 CONSTRAINTS.md。
level=global 全局、workspace 本课程、unit 本知识点、segment 本段；
默认 append 追加条目，只有用户明确要求整篇重写才用 replace。
返回落盘相对路径；写入后下一轮对话生效。
```

## 附录 C：验收口径

- 用户说「写一个规范」→ 文件必须叫 `CONSTRAINTS.md`，不能是 `规范.md`。
- 课程助手默认落 `{工作区}/CONSTRAINTS.md`，不是 `课程助手/output/`。
- 段会话默认落 `段N/CONSTRAINTS.md`，不是 `段N/规范.md`。
- 写入后下一轮回答能感受到新要求。
- 超 12 条 / 1200 字符时，AI 必须知道「超出部分不会注入」，不能只说「已写入」。
- 所有写入都有工具审计；失败时 AI 必须如实说「未执行」。
