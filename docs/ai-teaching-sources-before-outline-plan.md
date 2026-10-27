# AI 教学 · 未建课前允许登记素材（方案）

> 状态：已实施（2026-10-27，方案 B）
> 分支：`feature/v3.14.0`
> 触发：2026-10-27 用户反馈「没有跟 AI 教学助手说明素材前，素材页不能登记」
> 结论：当前是 **UI 硬门禁**，不是数据层限制；已放开登记，章级分配仍依赖大纲。

---

## 1. 现状（代码核实）

### 1.1 渲染层把整个素材页挡住了

`src/modules/ai-teaching/index.tsx` 右栏「素材」分支：

```tsx
{courseState?.outline && activeWs && activeWs !== '__none__' ? (
  <CourseSources
    wsId={activeWs}
    outline={courseState.outline}
    activeChapterId={railActiveChapter}
    activeSegment={activeSegment}
    ...
  />
) : (
  <div>先让课程助手建课，再登记 / 分配素材。</div>
)}
```

`src/modules/ai-teaching/CourseSources.tsx` 的 props 又把 `outline` 定为必填：

```ts
interface Props {
  wsId: string
  outline: AiTeachCourseOutline   // ← 必填
  activeChapterId: string | null
  activeSegment: AiTeachLessonInfo | null
  ...
}
const chapterId = activeChapterId ?? outline.chapters[0]?.id ?? ''
```

所以没有 `课程.md` 时，不是「登记按钮禁用」，而是**整个素材面板被替换成一行提示**。

### 1.2 数据层并不要求先有课程

`electron/lib/aiTeachingSourceRegistry.ts`：

```ts
export function registerSources(wsId, items, getSetting) {
  const w = workspaceAbs(wsId, getSetting)
  if (!w) return { ok: false, ... }
  const f = readFile()
  const s = f.workspaces[wsId] ?? (f.workspaces[wsId] = { sources: [], assignments: {}, ... })
  ...
}
```

- `sources.json` 按 **wsId** 存；
- 登记只写 `sources`，`assignments` 可以是空对象；
- `getSources` / 提取 / 删除都不读 `课程.md`；
- 课程助手在没有大纲时也能通过 `course.sources.register` 登记；
- 只有 `assignSources(wsId, chapterId, ...)` 需要章 id。

### 1.3 结论

- **不是数据层 bug**：后端支持先登记。
- **是设计问题**：渲染层把「登记」和「章级分配」绑在一起，造成「要先建课才能登记素材」的鸡生蛋。
- 方案文档原本的口径是「登记 / 章级分配 / 段级确认三分离」，登记不该依赖章。

---

## 2. 目标行为（方案 B）

### 2.1 没有大纲（或 `课程.md` 为空）

素材页仍然可开：

- 顶部 `+` 始终可用：文件 / 目录 / URL 都可登记；
- 只显示 **未分配** 组；登记后立刻出现在这里；
- **不显示「本章」「本段」**（没有章/段，画出来就是假入口）；
- 顶部提示：

  > 还没有课程大纲。可以先登记素材；大纲生成后再按章分配。

- 未分配行的动作：
  - 保留「提取」「删除」；
  - 不显示「分配到本章」；改为灰色说明「大纲生成后分配」，或直接不显示。

### 2.2 有大纲后

- 自动出现「本章」「本段」；
- 已登记但未分配的素材进入「未分配」，可「分配到本章」；
- 章级改区间 / 取消分配 / 开段预检与现在一致；
- 课程助手补大纲或重排章后，素材页通过 `aiTeach:course-refresh` 自动刷新。

### 2.3 没有工作区

保持现状：提示先进入工作区；素材页不渲染（模块本身也没有 wsId）。

---

## 3. 改动清单

### 3.1 `src/modules/ai-teaching/CourseSources.tsx`

1. props 改可空：
   ```ts
   outline: AiTeachCourseOutline | null
   ```
2. 派生：
   ```ts
   const chapters = outline?.chapters ?? []
   const hasOutline = chapters.length > 0
   const chapterId = activeChapterId && chapters.some((c) => c.id === activeChapterId)
     ? activeChapterId
     : chapters[0]?.id ?? ''
   const chapter = chapters.find((c) => c.id === chapterId) ?? null
   ```
3. 章级分配只认**当前大纲里存在的章**：
   ```ts
   const validChapterIds = new Set(chapters.map((c) => c.id))
   const assignedIds = new Set(
     Object.entries(assignments)
       .filter(([cid]) => validChapterIds.has(cid))
       .flatMap(([, list]) => list.map((a) => a.sourceId)),
   )
   ```
   - 没有大纲时 `assignedIds` 为空 → 所有素材都进「未分配」；
   - 大纲删章 / 改章 id 后，失效分配不再把素材藏起来。
4. `chapterAssignments`：`chapterId ? assignments[chapterId] ?? [] : []`。
5. `assignToChapter` / `saveAnchor`：`if (!chapterId) return`（已经有部分守卫，补全）。
6. `sourceRow` 的未分配动作：
   - `chapterId` 存在 → 「分配到本章」；
   - 否则 → 灰色文字「大纲生成后分配」，不渲染可点击按钮。
7. 渲染分区：
   - `{hasOutline && <section>本段…</section>}`（没有大纲时不显示空的「本段」）；
   - `{hasOutline && chapter && <section>本章…</section>}`；
   - 「未分配」始终显示。
8. 没有大纲时顶部提示（放在登记表单下方 / 组上方）：
   ```tsx
   {!hasOutline && (
     <div className="rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2 py-1.5 text-[10px] text-[var(--text-muted)]">
       还没有课程大纲。可以先登记素材；大纲生成后再按章分配。
     </div>
   )}
   ```
9. 没有大纲且 0 条素材时，「未分配」空态文案改为「还没有素材。点右上 `+` 先登记。」（不再说「没有未分配素材」）。

### 3.2 `src/modules/ai-teaching/index.tsx`

把右栏素材分支改为：

```tsx
{activeWs && activeWs !== '__none__' ? (
  <CourseSources
    wsId={activeWs}
    outline={courseState?.outline ?? null}
    activeChapterId={railActiveChapter}
    activeSegment={activeSegment}
    onOpenFile={(rel) => void openArtFile(rel)}
    onReloadCourse={() => void reloadCourse()}
  />
) : (
  <div>先进入工作区。</div>
)}
```

要点：

- 不再以 `courseState?.outline` 作为是否渲染 `<CourseSources>` 的条件；
- `courseState === null`（刚进工作区、状态未拉回）也允许登记，组件自身会 `getSources`；
- `sourceCounts` 由 `getCourseState` 返回；登记后 `onReloadCourse()` 刷新顶栏素材计数。

### 3.3 左栏空态文案（可选但建议）

`src/modules/ai-teaching/CourseRail.tsx` 无大纲提示补一句：

> 还没有课程大纲。点上面的「课程助手」建课；也可以先在右栏「素材」登记资料。

### 3.4 帮助文档

- `resources/help/AI 教学 · 课程模式.md`「建课」第 1 步补：也可以先在右栏「素材」登记资料，大纲生成后再按章分配。
- `resources/help/AI 教学素材与代码.md`「登记方式」补：没有大纲也能登记；章级分配需要大纲。

---

## 4. 边界与数据一致性

| 场景 | 行为 |
|---|---|
| 没有 `课程.md` | 可登记；全部显示在「未分配」；无本章/本段 |
| `课程.md` 存在但 `chapters` 为空 | 按「没有大纲」处理（`hasOutline=false`） |
| 有 `课程.md`，章被删/改 id | 旧章分配视为失效，不参与「已分配」判断；素材回到「未分配」可重新分配 |
| 没有大纲但 `sources.json.assignments` 有历史键 | 不显示失效分配；数据保留，若同名/同 id 章回来仍可能恢复（可后续做「清理失效分配」） |
| 先登记、后让助手建大纲 | 助手摘要能看到未分配素材；`course.sources.assign` 可正常分配 |
| 只登记、不建课 | 素材留在 `sources.json`，不产生课程/段；可随时删除登记 |
| 工作区未激活 | 素材页不显示（与现状一致） |

**不做**：

- 不新增 IPC / 不改 `sources.json` schema；
- 不自动把未分配素材塞进新章（仍由用户 / 助手显式分配）；
- 不在无大纲时伪造「本章 / 本段」；
- 不自动删除失效章分配（保留数据，先隐藏）。

---

## 5. 验证

### 5.1 静态 / 类型

```bash
npx tsc --noEmit -p tsconfig.web.json
npx tsc --noEmit -p tsconfig.node.json
npm run build
```

### 5.2 契约

更新 `.AGENT/scripts/ai-teaching/verify-course-mode.mjs`：

- 断言 `CourseSources` 的 `outline` 允许 `null`；
- 断言 `index.tsx` 不以 `courseState?.outline` 作为 `<CourseSources>` 的渲染条件；
- 断言无大纲提示文案存在；
- 断言 `assignedIds` 过滤 `validChapterIds`（静态检查变量名与 `validChapterIds`）。

新增可选探针 `.AGENT/scripts/ai-teaching/probe-sources-before-outline.mjs`（CDP）：

1. 新建空工作区（无 `课程.md`）；
2. 进 AI 教学 → 右栏「素材」；
3. 断言 `+` 可见、提示「还没有课程大纲」、无「本章 / 本段」；
4. 登记一份临时 md；
5. 断言「未分配 1」，且无「分配到本章」；
6. 写入 `课程.md` 并等广播；
7. 断言「本章」出现、可分配；
8. 清理临时工作区 / 文件。

### 5.3 手工验收

- 全新工作区，未建课 → 素材页能开、能登记、显示未分配；
- 让助手建大纲 → 素材页自动出现本章；未分配素材可分配；
- 有历史章分配、但大纲被删 → 素材回到未分配，不再被隐藏；
- 有正常课程 → 现有分配 / 提取 / 预检无回归。

---

## 6. 工作量与风险

- 改动集中在 1 个组件 + 1 处渲染条件 + 文案 + 契约；后端零改动。
- 风险低：不涉及数据迁移；最坏情况是空态 UI 文案不理想。

---

## 7. 实施记录（2026-10-27）

已按方案 B 落码：

- `src/modules/ai-teaching/CourseSources.tsx`：`outline` 可空；无大纲只显示「未分配」与登记提示；章级分配只认当前大纲有效章；失效分配不再隐藏素材。
- `src/modules/ai-teaching/index.tsx`：素材页只以工作区为渲染条件，不再以 `courseState.outline` 为门禁。
- `src/modules/ai-teaching/CourseRail.tsx`：无大纲空态补「可先登记」入口说明。
- `resources/help/AI 教学 · 课程模式.md`、`resources/help/AI 教学素材与代码.md`：同步「没有大纲也能先登记」。
- `.AGENT/scripts/ai-teaching/verify-course-mode.mjs`：补 4 条静态契约。

验证：

- `npx tsc --noEmit -p tsconfig.web.json` 通过；
- `npx tsc --noEmit -p tsconfig.node.json` 通过；
- `npm run build` 通过；
- `verify-course-mode.mjs` 55/55 通过；
- `verify-rail-bottom-stick.mjs` 24/24 通过（同步更新课程优先布局断言）；
- `verify-help-retrieval.mjs` 171/171 通过；
- 手工 CDP 验收：无大纲登记 → 未分配；补大纲 → 本章出现并可分配；清空大纲 → 素材回到未分配。未新增独立探针脚本。
