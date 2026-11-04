# AI 教学左栏「段节点分组」· 实现方案（2026-10-28）

> 状态：**已确认（原型通过）· 待落码**
> 原型：`tmp/ai-teaching-rail-proto/index.html`（本地单文件，`tmp/` 不进 git）
> 反馈记录：`docs/ai-teaching-ux-feedback-2026-10-28.md` 问题 5
> 范围：只改 AI 教学左栏课程树。不改段数据模型，不改右栏「进度」页签，不改开段 / 收尾 / 交接逻辑。

---

## 1. 目标

当前左栏是「章 → 知识点」平铺：

- 同一段的几个知识点只是连续几行，各自带一个 `本段` 徽章，看不出它们属于同一个对话；
- `inSegment` 只对当前激活段为 true，切到别处后进行中段的徽章消失，看起来像没开课；
- 已收尾段没有分组，学过的知识点和未开课知识点混在同一层。

目标：把「段」建成左栏的一级分组节点，让用户不点进对话也能看出：

1. 哪几个知识点属于同一个段；
2. 哪些段正在进行 / 已收尾；
3. 本章是否有进行中的段（章节折叠时也能看出来）。

---

## 2. 已确认的交互

### 2.1 结构

```text
v 预备章 微机系统与 8086       0/15  [进行中]
  ▾ 第1段 · 进行中 · 5 个知识点
      • 微处理器、微机与单片机的组成    ← 当前聚焦
      • 总线与三总线结构
      • 微机的性能指标
      • 计算机中数与编码的基本概念
      • 有符号数的补码表示与溢出判断
  ▸ 第1段 · 已收尾 · 4 个知识点        ← 默认折叠
  • 8086/8088 的内部结构与寄存器      ← 未开课，直接行
  ...
  🔒 章末复习                        还差 15 个
```

### 2.2 规则

- **章 → 段 → 知识点** 三层；段头显示 `第N段 · 进行中/已收尾 · N 个知识点`。
- **进行中段默认展开**；**已收尾段默认折叠**，点 chevron 展开。
- **点段头标题直接打开该段对话**（已收尾段打开为只读）；chevron 只负责展开/收起。
- **章头**在本章存在进行中段时显示 `进行中` 徽章；章节折叠时也保留。
- 知识点行：
  - 当前聚焦：accent 实心点 + 行高亮；
  - 本段内但未聚焦：accent 空心点；
  - 已学：success 实心点 + 弱化文字；
  - 未开课：灰色实心点；
  - 分组模式下**不再显示每行的 `本段` 徽章**，状态由段头承载。
- **未入段的知识点**保持直接行，排在所属大纲位置，不加“未开课”分组。
- **搜索**：命中章名保留整章；只命中知识点时只保留命中行；命中的段强制展开；搜索时章节也强制展开。
- **不做的**：
  - 不在左栏列“会话”本身（段节点就是段的入口）；
  - 不改右栏「进度」页签的段列表；
  - 不新增“收起已收尾段”设置项，默认折叠写死；
  - 不做跨章段（现有模型一段只属于一章）。

---

## 3. 数据与派生规则

### 3.1 `RailUnit` 扩展

`src/modules/ai-teaching/courseRail.ts`：

```ts
export interface RailUnit {
  id: string
  name: string
  learned: boolean
  /** 当前聚焦知识点（仅当前激活段内） */
  active: boolean
  /** 属于任一进行中段（不再只算当前激活段） */
  inSegment: boolean
  /** 所属段（若被多个段覆盖：open 优先，其次 order 最大） */
  segmentId?: string | null
  segmentOrder?: number | null
  segmentStatus?: 'open' | 'ended' | null
}
```

- `inSegment` 语义从「当前激活段」改为「任一 open 段」；
- `active` 仍只标当前 `activeUnitId` 且属于当前激活段，用于高亮；
- 新增字段全部可选，存量 `verify-course-segments.mjs` 的旧 fixture 不传也能跑。

### 3.2 段映射

在 `src/modules/ai-teaching/index.tsx` 的 `railChapters` 中：

```ts
const lessons = courseState?.lessons ?? {}
const segs = chapterSegments(lessons, ids)

// unitId -> 段（open 优先，其次 order 最大）
// ProgressLessonLike 来自 src/lib/aiTeachingProgressPure.ts（仅类型）
const byUnit = new Map<string, { sessionId: string; lesson: ProgressLessonLike }>()
for (const s of segs) {
  for (const uid of lessonUnitIds(s.lesson)) {
    if (!ids.includes(uid)) continue
    const prev = byUnit.get(uid)
    if (!prev) { byUnit.set(uid, s); continue }
    const prevOpen = prev.lesson.status === 'open'
    const nextOpen = s.lesson.status === 'open'
    if (nextOpen && !prevOpen) byUnit.set(uid, s)
    else if (nextOpen === prevOpen && (Number(s.lesson.order) || 0) >= (Number(prev.lesson.order) || 0)) {
      byUnit.set(uid, s)
    }
  }
}
```

每个 unit 输出：

```ts
{
  id, name,
  learned: unitLearned(u.id, courseState?.progress, courseState?.lessons),
  active: activeUnitId === u.id && !!activeSegmentSid && activeIds.includes(u.id),
  inSegment: seg?.lesson.status === 'open',
  segmentId: seg?.sessionId ?? null,
  segmentOrder: seg ? Number(seg.lesson.order) || 0 : null,
  segmentStatus: seg?.lesson.status ?? null,
}
```

`activeIds` 仍只取当前激活段，避免“本段内但未聚焦”被误标为 active。

### 3.3 分组纯函数

在 `courseRail.ts` 新增：

```ts
export type RailRow =
  | {
      kind: 'segment'
      sessionId: string
      order: number
      status: 'open' | 'ended'
      units: RailUnit[]
    }
  | { kind: 'unit'; unit: RailUnit }

export function buildRailRows(units: ReadonlyArray<RailUnit>): RailRow[]
```

规则：

- 按 `segmentId` 分组；
- 行顺序按**首次出现位置**：段头出现在该段第一个 unit 的位置；
- 组内 units 保持大纲顺序；
- 无 `segmentId` 的 unit 作为独立 `kind: 'unit'` 行；
- 非连续 `unitIds`（例如一段覆盖第 1、3、5 个知识点）也归入同一段头，组内按大纲顺序排列；中间未入段的 unit 作为独立行排在该段之后。**这是已接受的取舍**，因为开段预检默认连续选点，非连续是少数情况。
- `segmentStatus` 缺省按 `open` 处理（仅防御旧数据）；正常数据必有值。

### 3.4 章激活

`activeChapterId()` 改为识别任一 open 段：

```ts
const withActive = chapters.find((c) =>
  c.units.some((u) => u.active || u.segmentStatus === 'open' || u.inSegment)
)
```

这样即使用户当前在看别的章 / 课程助手，左栏仍会把有进行中段的章作为默认激活章；用户手动折叠仍保留折叠状态。

---

## 4. 文件改动清单

### 4.1 `src/modules/ai-teaching/courseRail.ts`

- 扩展 `RailUnit`：`segmentId / segmentOrder / segmentStatus`。
- 新增 `RailRow` 与 `buildRailRows()`。
- `activeChapterId()` 加入 `segmentStatus === 'open'` 判据。
- 不改变 `buildCourseRail()` 的搜索语义；搜索仍只负责过滤 units，分组在渲染层做。

### 4.2 `src/modules/ai-teaching/index.tsx`

- 引入 `chapterSegments`。
- `railChapters` 增加段映射（§3.2）。
- 给 `<CourseRail>` 增加：
  - `activeSegmentId={activeSegmentSid}`
  - `onSegment={(sid) => void openSegmentBySid(sid)}`
- 不改开段 / 收尾 / 交接逻辑。

### 4.3 `src/modules/ai-teaching/CourseRail.tsx`

- `import { useState } from 'react'`、`import { buildRailRows, reviewLabel } from './courseRail'`。
- `Props` 增加：
  - `activeSegmentId: string | null`
  - `onSegment: (sessionId: string) => void`
- 新增本地状态：

```ts
const [segOverride, setSegOverride] = useState<Record<string, boolean>>({})
```

key 用 `${sessionId}:${status}`，这样段从 open 变 ended 后默认重新按“已收尾折叠”处理，不会沿用旧的展开状态。

- 展开状态：

```ts
const segKey = (row: RailRow & { kind: 'segment' }) => `${row.sessionId}:${row.status}`

const isSegmentOpen = (row: RailRow & { kind: 'segment' }) => {
  if (search.trim()) return true
  const key = segKey(row)
  if (key in segOverride) return segOverride[key]
  return row.status === 'open'
}

const toggleSegment = (row: RailRow & { kind: 'segment' }) => {
  if (search.trim()) return
  setSegOverride((prev) => ({ ...prev, [segKey(row)]: !isSegmentOpen(row) }))
}
```

- 渲染：

```tsx
{buildRailRows(ch.units).map((row) =>
  row.kind === 'segment' ? (
    <div key={`seg:${row.sessionId}:${row.status}`}>
      <div className={`flex items-center gap-0.5 pl-2 pr-1 rounded-md ${row.sessionId === activeSegmentId ? 'bg-[var(--bg-selected)]' : ''}`}>
        <button
          type="button"
          onClick={() => toggleSegment(row)}
          aria-expanded={isSegmentOpen(row)}
          aria-label={isSegmentOpen(row) ? '收起该段' : '展开该段'}
          className="shrink-0 w-5 h-5 inline-flex items-center justify-center rounded text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-40"
          disabled={!!search.trim()}
          title={search.trim() ? '搜索时自动展开' : isSegmentOpen(row) ? '收起该段' : '展开该段'}
        >
          <ChevronRight size={10} className={`kb-chevron ${isSegmentOpen(row) ? 'rotate-90' : ''}`} />
        </button>
        <button
          type="button"
          onClick={() => {
            setSegOverride((prev) => ({ ...prev, [segKey(row)]: true }))
            onSegment(row.sessionId)
          }}
          className="min-w-0 flex-1 flex items-center gap-1.5 py-1 text-left"
          title="打开该段对话"
        >
          <span className="shrink-0 text-[10px] text-[var(--text-muted)]">第{row.order}段</span>
          <span className={`shrink-0 rounded-full border px-1 text-[9px] leading-[14px] ${row.status === 'open' ? 'border-[var(--accent)]/25 bg-[var(--accent)]/10 text-[var(--accent)]' : 'border-[var(--border-color)] text-[var(--text-muted)]'}`}>
            {row.status === 'open' ? '进行中' : '已收尾'}
          </span>
          <span className="ml-auto shrink-0 text-[9px] text-[var(--text-muted)]">{row.units.length} 个</span>
        </button>
      </div>
      <div className={`kb-collapse ${isSegmentOpen(row) ? 'open' : ''}`}>
        <div className="min-h-0">
          <div className="ml-4 border-l border-[var(--border-color)] pl-0.5">
            {row.units.map((u) => renderUnitButton(ch, u))}
          </div>
        </div>
      </div>
    </div>
  ) : (
    renderUnitButton(ch, row.unit)
  )
)}
```

- `renderUnitButton` 保持现有按钮结构，只改状态点与文案：
  - `active` → `bg-[var(--bg-selected)] text-[var(--accent)]`，点用 accent 实心；
  - `learned` → 点 success 实心，文字 muted；
  - `inSegment`（open 但非 active）→ 点 `border border-[var(--accent)] bg-transparent`；
  - 其余 → 点 `bg-[var(--text-disabled)]`；
  - 移除 `本段` 徽章；
  - `title` 按 learned / inSegment / 未开课区分。
- 章头增加进行中徽章：

```tsx
const hasOpen = ch.units.some((u) => u.segmentStatus === 'open')
...
{hasOpen && (
  <span className="shrink-0 rounded-full border border-[var(--accent)]/25 bg-[var(--accent)]/10 px-1 text-[9px] leading-[15px] text-[var(--accent)]">
    进行中
  </span>
)}
```

- 章节折叠逻辑不变；搜索时仍强制展开。
- 段内折叠走现有 `.kb-collapse`（`grid-template-rows 0fr↔1fr`），不要新增 `max-height` 过渡；chevron 用 `.kb-chevron`，不要用 `transition-transform`。
- 搜索时 chevron 禁用，避免“点了没反应”的错觉。

### 4.4 `resources/help/AI 教学 · 课程模式.md`

更新左栏说明（约 L25–L34）：

- 左栏结构改为「章 → 段 → 知识点」；
- 段头显示 `第N段 · 进行中/已收尾 · N 个知识点`；
- 点段头打开对话；点段内知识点切换聚焦 / 回看；
- 已收尾段默认折叠；
- 章头有进行中徽章；章节折叠时也能看出本章有进行中的段。

同时若与问题 4 同批落码，删除 L48「输入区上方是本段知识点胶囊」并改为「点左栏本段内的知识点切换聚焦」。

### 4.5 契约脚本

`.AGENT/scripts/ai-teaching/verify-course-segments.mjs`：

- import `buildRailRows`。
- 新增用例：
  1. 同一 `segmentId` 的两个 unit → 一行 `kind: 'segment'`，组内两个 unit；
  2. 无 `segmentId` 的 unit → `kind: 'unit'`；
  3. 非连续 unitIds（`u1(seg1), u2(loose), u3(seg1)`）→ 段头包含 `u1,u3`，`u2` 为独立行；
  4. `status: 'ended'` 的组 `status` 为 `ended`，`order` 正确；
  5. `activeChapterId` 在有 open 段但非激活段时仍选中该章；
  6. 搜索过滤后 `buildRailRows` 只组命中 unit，且段头不丢。
- 跑 `node .AGENT/scripts/ai-teaching/verify-course-segments.mjs`，保持全 PASS。

可选：`.AGENT/scripts/ai-teaching/verify-course-mode.mjs` 增加静态断言：

- `CourseRail` 引用 `buildRailRows`；
- `CourseRail` 有 `data-*`/`onSegment` 接线；
- `index.tsx` 传 `activeSegmentId` 与 `onSegment`。

---

## 5. UI 细节

- 段头高度约 24px；组内 unit 行保持现有 5px 上下 padding，整体比平铺多一层段头，但已收尾段折叠后会明显更短。
- 段头左侧缩进 2，组内 unit 左侧缩进 4 + 竖线，形成层级。
- 进行中段头：accent 徽章；当前激活段头：`bg-[var(--bg-selected)]` + 左侧 2px accent 内阴影（可用 `shadow-[inset_2px_0_0_var(--accent)]`）。
- 已收尾段头：灰色徽章；组内 unit 为 success 点 + muted 文字。
- 未入段 unit：灰色点，hover 可显示 `未开课` 小字（不要常驻，避免噪音）。
- 动效：
  - 段展开/收起走 `.kb-collapse`；
  - chevron 用 `.kb-chevron`；
  - 不新增 `transition-all`；
  - 尊重 `prefers-reduced-motion`。
- 可访问性：
  - 段头 chevron 是独立 `<button>`，`aria-expanded` + `aria-label`；
  - 段标题是独立 `<button>`，不嵌套；
  - 章节头现有按钮保持不变。

---

## 6. 边界与取舍

| 场景 | 处理 |
|---|---|
| 一个 unit 被多个段覆盖 | open 优先；同为 open 取 order 最大；同为 ended 取 order 最大。左栏只显示一个归属，避免重复行。 |
| 段内 unit 已从大纲删除 | 过滤掉；若整段没有可显示 unit，不渲染段头。 |
| 非连续 unitIds | 按首次出现位置成组，组内按大纲顺序；中间未入段 unit 作为独立行排在该段之后。已接受。 |
| 已收尾段默认折叠 | 写死；用户手动展开的状态按 `${sessionId}:${status}` 记忆，段状态变化后恢复默认。 |
| 搜索命中段内 unit | 强制展开该段；搜索时 chevron 禁用，避免“点了没反应”。 |
| 章节 0 个知识点 | 不显示段头；显示现有空态。 |
| 多个 open 段（数据异常） | 每个段各自成组；章头仍显示一个进行中徽章。 |
| 旧 `unitId` 单知识点课时 | `lessonUnitIds()` 已兼容，按单 unit 段显示。 |
| 性能 | 映射 O(units + segments)，每次 `courseState` 变化重算；量级为课程大纲规模，无需缓存。 |

---

## 7. 验收

### 手动

1. 打开有进行中段的章：段头显示 `第N段 · 进行中 · N 个知识点`，5 个 unit 收在组内；不再显示每行 `本段` 徽章。
2. 切到别的章 / 课程助手再回来：进行中段仍然可见，章头 `进行中` 徽章仍在。
3. 折叠章头：章头仍显示 `进行中`，展开后段头仍在。
4. 点已收尾段头：默认折叠；点标题打开只读对话；点 chevron 展开后能看到已学 unit。
5. 点进行中段头：打开该段；点段内 unit：切换聚焦并高亮。
6. 搜索 `端口` / `译码`：只保留命中 unit；所在段自动展开；无命中显示空态。
7. 左栏宽度 220–340px：段头 `第N段 / 进行中 / N 个` 不换行；长知识点名仍 truncate。
8. 右侧「进度」页签行为不变；开段预检 / 收尾 / 交接不变。

### 自动

- `npx tsc --noEmit -p tsconfig.web.json`
- `npx tsc --noEmit -p tsconfig.node.json`（本次无 node 改动，仍跑一遍）
- `node .AGENT/scripts/ai-teaching/verify-course-segments.mjs`
- `node .AGENT/scripts/ai-teaching/verify-course-mode.mjs`
- `npm run build`（发版前）

---

## 8. 实施顺序

1. **P0 纯函数**：扩展 `RailUnit`、新增 `buildRailRows`、改 `activeChapterId`；补 `verify-course-segments.mjs` 用例。
2. **P1 数据接线**：`index.tsx` 的 `railChapters` 段映射 + `CourseRail` props。
3. **P2 UI**：`CourseRail.tsx` 段头 / 组内 unit / 章头徽章 / 折叠状态。
4. **P3 文案与回归**：帮助文档、契约、双 tsc、手动验收。

---

## 9. 关联改动

- **问题 4（输入区知识点胶囊）**：同一批落码时删除 `index.tsx` 约 L3172–3191 的胶囊块；本方案已经在左栏提供聚焦切换，不另做替代控件。帮助文档 L48 同步改。
- **问题 3（上一段交接卡）**：独立改动，首轮后移除；不与本方案耦合。
- **问题 2（支线首条消息）**：独立改动，`onLaneReady` 时序修复；不与本方案耦合。
- **问题 1（交接重复 / ask 选项）**：独立改动；本方案不碰交接生成逻辑。
