# 题单 · 简答题渲染与答题痕迹保留 实现方案

> 状态：已实施（2026-10-28，v3.15.0；Phase 1–3 落码，Phase 4 收尾完成）
> 日期：2026-10-28
> 版本：3.15.0（新功能，按 minor 抬版本）
> 原型：`/home/lousync/Projects/Phrontis/tmp/quiz-short-answer-proto/index.html`（本地工作区，不进 git）
> 原型验证：`/home/lousync/Projects/Phrontis/tmp/quiz-short-answer-proto/probe.mjs`（56 条断言全过）

---

## 一、背景与目标

这次只做两件事，不混在一起：

| # | 工作 | 目标 |
|---|---|---|
| 1 | **大题正确渲染** | AI 出的大题不再把 `<details>` 标签当正文显示；题面 + 参考答案折叠正常排版 |
| 2 | **答题痕迹保留** | 下次进入同一题单，选择题选项/对错、简答草稿/是否看过答案/自评结果都还在；题单内可错题重做 |

两件事共用同一套简答题协议：工作 1 先把协议、解析、题卡壳子做出来；工作 2 再往题卡里加作答框、存档和错题重做。**不要先用 `spoiler-answer` 过渡再改一次**，否则存量文档和状态键都要迁移两遍。

### 已确认的产品行为（原型）

- 简答卡顺序：题号/题型/状态 → 题干 → 作答框 → 「显示参考答案」→ 自评。
- 自评按钮在展开参考答案后才出现；两个按钮：「答对了 / 答错了」。
- 题号全卷连续 1..N；题干里不再手写 `1.` / `（1）` 这类题号。
- 错题重做 = 带着上次答案重做，不清空；参考答案默认收起；只抽当前题单 `lastResult === 0` 的题。
- 题单内联作答；全屏「刷题模式」保持选择题，不塞简答题。
- 草稿自动保存（防抖 500ms，失焦立即保存）。
- 旧 `<details>` 只转成只读折叠块，不变成可作答卡；要可作答需 AI 按新协议重出。
- 原型右上角「只读 · 工作 1」只是分阶段验收开关，不是正式产品功能；正式版直接上完整作答卡。

### 非目标（v1 不做）

- 不做简答题 AI 自动批改；自评。
- 不做独立的题单列表/管理页；题单 = 现有的一篇题目 `.md`。
- 不把 408 老格式 `### 第 N 题 + spoiler-answer` 升级成可作答卡；保持现状（仍可折叠看答案）。
- 不改造错题本界面；只做兼容，错题本整改不受影响。
- 不做多设备冲突合并；本地单人使用，最后写入者生效。
- 不做简答题进全屏刷题模式（后续可单独开）。

---

## 二、出题协议

### 2.1 选择题（完全不变）

````markdown
```quiz
{"no":1,"question":"题干（支持 markdown）","options":[{"key":"A","text":"选项一"},{"key":"B","text":"选项二"},{"key":"C","text":"选项三"},{"key":"D","text":"选项四"}],"answer":"A","explanation":"答案解析（支持 markdown）"}
```
````

- 没有 `type` 或 `type:"choice"` = 选择题。
- `options` ≥ 2，`answer` 必须是某个选项 key。
- `points` 仍容忍但不渲染。

### 2.2 简答题（新增）

````markdown
```quiz
{"type":"short","no":4,"question":"简述 I/O 接口的四项主要功能，并各举一句说明。","referenceAnswer":"① 地址译码或设备选择功能：……\n② 数据缓冲功能：……","explanation":"补充：接口之所以需要，是因为存在速度不匹配、信号形式不匹配、信息格式不匹配以及多设备争用总线四组矛盾。"}
```
````

硬规则：

1. `type` 必须是 `short`。
2. `no` 全卷连续 `1..N`，不按大题/小题重新从 1 开始；题干里不再手写题号。
3. 不输出 `options` / `answer`；`referenceAnswer` 必填，支持 Markdown。
4. `referenceAnswer` 字符串里**不要出现三反引号代码围栏**；需要代码时用 4 空格缩进代码块。否则 Markdown 围栏会提前截断（与 408 spoiler 的既有约束同源）。
5. 禁止 `<details>` / `<summary>` 等原生 HTML 折叠标签；参考答案一律放 `referenceAnswer`，由客户端折叠。
6. JSON 字符串内部禁止未转义的英文双引号；需要引用时用中文引号。

### 2.3 提示词落点

| 文件 | 改动 |
|---|---|
| `electron/lib/agentService.ts`（`quizRuleHint`，约 1139–1144 行） | 在选择题格式后补简答题格式、连续题号、禁止 `<details>`、禁止三反引号代码围栏 |
| `resources/skills/quiz-generator/SKILL.md` | 把「简答 / 大题 → 普通 Markdown + spoiler 答案折叠」改为新 `type:"short"` 协议；保留「AI 教学场景直接落文档，不在正文贴整卷」的口径 |
| `resources/help/AI 教学 · 课程模式.md` | 补一句：简答题在题单内作答，草稿自动保存，可错题重做 |

> 注意：`quiz-generator` 是可选 Skill 包，默认不安装；系统提示里的出题规则才是主路径。Skill 只作为兜底/外部安装时的规范，不要依赖它。
>
> 全局 AI 助手（非 AI 教学）若被要求出题，仍可能写 `<details>`；渲染层的 `<details>` 兼容会让它至少显示为只读折叠块，不会露标签。**可作答的题单规范只承诺 AI 教学**；要把全局助手也纳入，另开一段提示词改动。

### 2.4 解析层

`src/components/shared/QuizParser.ts`：

```ts
export type QuizItemType = 'choice' | 'short'

export interface QuizItem {
  type: QuizItemType
  no: number
  points: string
  question: string
  options: QuizOption[]
  answer: string
  referenceAnswer: string
  explanation: string
}
```

`asQuizItem` 分支：

- `type === 'short'`：要求 `no` 为正整数、`question` 非空、`referenceAnswer` 非空；`options` 归一为 `[]`、`answer` 归一为 `''`。
- 其他：走现有选择题校验（`options.length >= 2` 且 `answer` 非空）。
- 未知 `type` → `null`（走 `QuizFailCard`）。
- `no` 缺失/非正整数 → `null`；旧数据都有 `no`，不会回归。
- 旧 408 转换的 `parseQuestionBlock` / `toQuizFence` 也要补 `type: 'choice'`、`referenceAnswer: ''`，否则 `QuizItem` 新字段缺省会让下游判空。

`extractQuizzes` 两个修正：

1. **不再用 `\{...\}` 非贪婪提取**，改为按围栏提取：
   ```ts
   const re = /```quiz[^\n]*\n([\s\S]*?)\n```/g
   ```
   这样 `referenceAnswer` 里的 `}`（集合、代码、公式）不会提前截断。
2. 返回全部题型（选择题 + 简答题）；调用方按需过滤（刷题模式只取 `type === 'choice'`）。

`preprocessContent` 两个分支：

- 旧 408 选择题块 → `` ```quiz ``：保持不变。
- 旧 `<details><summary>…</summary>…</details>` → `` ```spoiler-answer ``：只读折叠，不生成可作答卡；详见 §七。

---

## 三、数据模型与存储

### 3.1 存储位置

真相源仍是 vault：

```
<vault>/.knowbase/modules/quiz/records.json
```

一行 = 一道题的记录，键 = `(page_id, quiz_no)`。本次只加字段，不新建文件、不改表结构。

### 3.2 `draft_json`

`electron/lib/kbStore/quizVaultRepo.ts` 的 `VaultQuizRecordRow` 增加可选字段：

```ts
export interface VaultQuizRecordRow {
  // ...现有字段
  /** 作答痕迹（JSON 字符串）：选项/简答草稿/是否看过答案/自评时的文字快照 */
  draft_json?: string
}
```

`draft_json` 内容：

```json
{
  "picked": "B",
  "text": "接口负责地址译码、数据缓冲、输入输出控制和信息转换。",
  "revealed": true,
  "assessedText": "接口负责地址译码、数据缓冲、输入输出控制和信息转换。",
  "updatedAt": "2026-10-28 10:30:00"
}
```

字段语义：

| 字段 | 适用 | 说明 |
|---|---|---|
| `picked` | 选择题 | 上次选的 key；用于恢复高亮与错题重做时的「上次选 X」 |
| `text` | 简答题 | 草稿原文；纯文本，上限 20,000 字符 |
| `revealed` | 简答题 | 是否展开过参考答案 |
| `assessedText` | 简答题 | 自评那一刻的文字快照；用于「答案已修改，建议重新自评」 |
| `updatedAt` | 全部 | 草稿更新时间；**不是**记录的 `updated_at` |

关键约束：

- **`saveDraft` 不动 `last_result` / `wrong_count` / `correct_count` / `streak_correct` / `updated_at`。**
  - 草稿更新不应把题目顶到错题本列表顶部，也不应影响掌握/统计。
  - 只有 `quizRecordReport`（自评/选择判题）才改这些字段。
- 草稿记录允许 `last_result = null`；它不会进 `kind: 'wrong' / 'favorite' / 'all'`（`quizRecordList` 的 `matchKind` 只看收藏与错题）。
- `quizDataStats.total` 会包含草稿行（当前按 `rows.length`）；这是可接受的「题目数」口径。若不想，后续给 stats 加 `hasActivity` 过滤，不在本次范围。
- 文本上限 20,000 字符；超出截断并在 UI 提示？v1 直接截断，避免 JSON 膨胀。

### 3.3 DTO

`src/types/index.ts`：

```ts
export interface QuizDraftDto {
  picked: string | null
  text: string
  revealed: boolean
  assessedText: string | null
  updatedAt: string | null
}

export interface QuizSnapshotDto {
  no: number
  question: string
  options: QuizOptionDto[]
  answer: string
  explanation: string
  /** 新：题型；旧快照缺省 = choice */
  type?: 'choice' | 'short'
  /** 新：简答题参考答案 */
  referenceAnswer?: string
}

export interface QuizRecordDto {
  // ...现有字段
  /** 新：作答痕迹；旧记录为 null */
  draft: QuizDraftDto | null
}
```

`electron/database/repositories/quizRepo.ts`：

- `vaultRowToDto` 增加 `draft: parseDraft(row.draft_json)`。
- `parseSnapshot` 允许简答题：
  ```ts
  if (v.type === 'short') {
    return { ...v, options: Array.isArray(v.options) ? v.options : [] }
  }
  if (!Array.isArray(v.options)) return null
  ```
- 新增 `parseDraft` / `serializeDraft`（或放 `electron/lib/quizRecordPure.ts`，便于契约脚本 import）。

### 3.4 记录创建与幂等

沿用 `vaultEnsureRecord(pageId, quizNo, { pageTitle, snapshot })`：

- `saveDraft` 首次调用时创建行；`last_result=null`、`wrong_count=0`。
- `report` 首次调用时创建行（已有行为）。
- 已有行：`saveDraft` 只合并 `draft_json`；`report` 只改计数与 `last_result`。
- **选择题的 `picked` 由 `report` 一并写入 `draft_json`**：`report` 的 meta 增加 `picked?: string`，在同一次写盘里更新 `last_result/counts/draft_json.picked`，避免「判了题但没记住选了哪个」。
- `snapshot_json`：`saveDraft` / `report` 收到快照时更新（保证题目被编辑后错题本里是新题干）；更新是幂等的。

---

## 四、主进程 IPC

### 4.1 新增 `quizRecord:saveDraft`

```ts
export function quizRecordSaveDraft(
  pageId: string,
  quizNo: number,
  patch: {
    picked?: string | null
    text?: string
    revealed?: boolean
    assessedText?: string | null
  },
  meta: { pageTitle?: string; snapshot?: QuizSnapshotDto },
): QuizRecordDto
```

行为：

1. 校验 `pageId` / `quizNo`（同 `quizRecordReport`）。
2. 若 patch 全空且该 `(pageId, quizNo)` 还没有记录 → no-op，避免空草稿行；已有记录则保留（不删除标签/收藏）。
3. `vaultEnsureRecord` 找或建行。
4. 读取现有 `draft_json`，合并 patch：
   - `text` 截断到 20,000 字符。
   - `updatedAt = vaultLocalNow()`。
5. 写回 `draft_json` + `snapshot_json` / `page_title`（有值才更新）。
6. **不广播**（高频写；界面由 store 乐观更新）。
7. 返回最新 DTO。

### 4.2 新增 `quizRecord:migratePageId`

```ts
export function quizRecordMigratePageId(oldPageId: string, newPageId: string): { moved: number; merged: number }
```

用途：`auto:<rel>` 页面首次保存/转正后，把答题记录迁到真 UUID，避免状态丢失。

行为：

- `old === new` 或任一为空 → no-op。
- 逐行找 `page_id === old`：
  - 若不存在同 `quiz_no` 的新行：直接改 `page_id`（保留 id、关联标签/分组）。
  - 若已存在：合并到新行：
    - `wrong_count` / `correct_count` 相加；
    - `streak_correct` 取较大值；
    - `last_result` / `snapshot_json` 取 `updated_at` 较新者；
    - `draft_json` 取草稿内 `updatedAt` 较新者（旧数据没有该字段时退回 `updated_at`）；
    - `is_favorite` 取 OR；
    - `note` 取非空；
    - `created_at` 取较早，`updated_at` 取较晚。
  - 连带迁移关联表：把 `quiz_record_tags` / `quiz_record_collections` 里 `record_id === oldRow.id` 的行改到保留的 `record_id`，按联合键去重；删除旧行前必须处理，否则留下孤儿关联。
  - 删除旧行。
- 写一次 `records.json`；不广播（调用方刷新）。
- 纯逻辑抽到 `electron/lib/quizRecordPure.ts` 的 `mergeRowsOnPageIdMigration`，契约脚本直接 import；关联表迁移在 repo 层做（读关联 → 重映射 → 写回）。

### 4.3 新增 `knowledge:findByRel`

```ts
export function knowledgeFindByRel(rel: string): { id: string; title: string; path: string } | null
```

- 用 `getKnowledgeIndex().pages.find(p => p.path === rel)`。
- 返回索引里的 id（可能是 `auto:<rel>`，也可能已转正）。
- 注册 IPC / preload / `src/lib/ipc.ts` / `ElectronAPI`。

用途：AI 教学工件栏、题单 store 在只知道 `relPath` 时反查 `pageId`。

### 4.4 `quizRecord:report` 补 picked + 广播

`quizRecordReport(pageId, quizNo, correct, meta)` 的 `meta` 增加：

```ts
picked?: string
```

- 选择题判题时把用户选的 key 写进 `draft_json.picked`（与 `last_result/counts` 同一次写盘）。
- `QuizMode` 的 `pick` 也要传 `picked: key`，否则刷题模式答完的选择题没有 picked 可恢复。

在现有 handler 末尾加：

```ts
broadcastDataChanged('quiz')
```

理由：错题本/收藏/统计是 `useDataChanged('quiz')` 的消费者；此前报告结果不广播，错题本要等重新进入才刷新。只读高频的 draft 不广播。

### 4.5 preload / 渲染层包装

`electron/preload/index.ts`：

```ts
quizRecordSaveDraft: (pageId, quizNo, patch, meta) => ipcRenderer.invoke('quizRecord:saveDraft', pageId, quizNo, patch, meta),
quizRecordMigratePageId: (oldPageId, newPageId) => ipcRenderer.invoke('quizRecord:migratePageId', oldPageId, newPageId),
knowledgeFindByRel: (rel) => ipcRenderer.invoke('knowledge:findByRel', rel),
```

`src/lib/ipc.ts` / `src/types/index.ts` 同步包装与签名。

---

## 五、渲染层

### 5.1 QuizRecordStore（新）

文件：`src/components/shared/quizRecordStore.ts`（或 `.tsx`）

不要在每个 `QuizCard` 里各调一次 `quizRecordGetByPage`（40 题 = 40 次 IPC，且草稿保存会让整页重渲染）。用一个页面级 store：

```ts
export interface QuizStore {
  readonly pageId: string
  readonly records: Map<number, QuizRecordDto>
  readonly wrongNos: Set<number>
  readonly summary: { answered: number; wrong: number; drafts: number }
  saveDraft(no: number, patch: QuizDraftPatch, snapshot: QuizSnapshotDto): void
  report(no: number, correct: boolean, snapshot: QuizSnapshotDto, picked?: string): Promise<void>
  toggleFavorite(no: number, snapshot: QuizSnapshotDto): Promise<void>
  refresh(): Promise<void>
}
```

实现要点：

- `createQuizRecordStore({ pageId, relPath, pageTitle })`：
  - 若 `pageId` 是 `auto:` / `draft:` 且有 `relPath`：
    - 调 `knowledgeFindByRel(relPath)`；
    - 若返回真 id（不以 `auto:`/`draft:` 开头），先 `quizRecordMigratePageId(old, new)`，再用新 id 拉记录；
    - 在 React 包装层用 `useDataChanged('knowledge', resolve)`，页面转正后重新解析。
  - 非 auto/draft：直接使用。
  - 拉取 `quizRecordGetByPage(pageId)`，建 `Map<quizNo, DTO>`；失败 → 空记录 + 一次 Toast，不阻塞阅读（题卡退化为本地作答）。
  - fetch 期间用户已经输入的本地缓冲：加载完成后先 flush 本地 draft，再合并远端记录；不要让 fetch 覆盖正在输入的草稿。
  - 在 React 包装层用 `useDataChanged('quiz', refresh)`：错题本/刷题模式报告后刷新。
  - 每个 `no` 的草稿保存串行化：一个 `inFlight` Promise + 待合并 patch，避免两次 IPC 乱序覆盖。
  - `report` 先乐观更新（`lastResult`/counts/`draft.picked`），再发 IPC；失败回滚并 Toast「作答记录保存失败」。
  - `saveDraft` 失败：保留本地草稿，Toast「草稿保存失败，稍后重试」；下一次输入会重试。
- React 接入：
  - `useQuizRecord(store, no)`：`useSyncExternalStore` + 按 `no` 缓存的 snapshot，只有该题变化才重渲染。
  - `useQuizSummary(store)`：只在 answered/wrong/drafts 变化时重渲染。
  - 页面级 `QuizRecordContext.Provider value={store}`；store 实例稳定，避免 `MarkdownPreview` memo 失效。
- 无 store（AI 聊天里的单题快检）：
  - `ShortAnswerCard` / `QuizCard` 退化为本地状态；可判题、可自评，但不落盘、不收藏。
  - 这是明确的边界：**要留痕迹必须走题目文档/知识库页面**。

### 5.2 ShortAnswerCard（新）

文件：`src/components/shared/ShortAnswerCard.tsx`

结构（与原型一致）：

```
[第 N 题] [简答]                       [未作答/草稿/答对/答错/待重做]
题干（MarkdownPreview）
┌ textarea：写下你的答案…（自动保存） ┐
└ ✓ 已保存                         26 字 ┘
[显示参考答案 ▸]  [对照后自评：答对了 / 答错了]
┌ 参考答案（.kb-collapse，MarkdownPreview）
│ 补充：…
└
已记录 · 自评答错                              重做本题
```

实现要点：

- 本地 `text` 缓冲；`record.draft.text` 初始化。
- 输入：更新本地 text + char count + 「保存中…」；防抖 500ms 调 `store.saveDraft(no, { text }, snapshot)`；失焦/卸载立即 flush。
- `记录` 更新时，若 textarea 未聚焦且本地未修改，则同步；聚焦时不覆盖用户输入。
- 「显示参考答案」：先 flush 当前 text 的防抖保存，再 `store.saveDraft(no, { revealed: !revealed })`；用 `.kb-collapse`，内容常驻 DOM，靠 `open` 类切换（遵守动效硬约束）。
- 自评按钮：仅在 `revealed` 后出现；点击：
  - 先 flush 当前 text 的防抖保存；
  - `store.saveDraft(no, { assessedText: text, revealed: true })`
  - `store.report(no, ok, snapshot)`
  - `snapshot()` = `{ no, type: 'short', question, options: [], answer: '', referenceAnswer, explanation }`。
  - 状态 chip 用 `.kb-micro-pop` 做一次反馈。
- 已自评后再改文字：显示「答案已修改，建议重新自评」；不自动清掉上次结果，避免错题列表突然消失。
- 「重做本题」：本地 `redo=true` → 收起参考答案、隐藏上次自评高亮、显示「上次自评：答错」；重新自评后 `redo=false`。
- 无 store：`text`/`revealed`/`correct` 全本地；不显示收藏。
- 草稿是纯文本：只放进 `<textarea>` 的 value，绝不当 HTML/`dangerouslySetInnerHTML`。参考答案走 `MarkdownPreview`（未装 rehype-raw，安全边界不变）。
- 无障碍：`aria-expanded`、`aria-pressed`、textarea label；状态 chip 可加 `aria-live="polite"`。
- 与选择题卡共用 `data-quiz-card` + `data-quiz-no`：`QuizCard` 答对后的 `scrollToNext` 会按 DOM 顺序找下一张卡，简答卡也必须能被找到，否则混合卷会跳过简答题。

### 5.3 QuizCard（选择题改造）

文件：`src/components/shared/QuizCard.tsx`

- 去掉组件内 `quizRecordGetByPage` / `quizRecordReport` / `quizRecordToggleFavorite` 直调；改走 store。
- 初始化：
  - `picked = record.draft.picked ?? null`
  - `answered = record.lastResult != null`
  - 若 `lastResult != null` 但 `draft.picked` 为空（旧记录）：仍显示答对/答错，但不高亮具体选项；解析按 `lastResult` 展开。
- 判题：
  - 未答：点击 → `store.report(no, ok, snapshot, key)`，乐观更新（`picked` 随报告落盘）；答对滚动下一题。
  - 已答且非 `redo`：锁定。
  - `redo`（来自「错题重做」或「重做本题」）：允许重选；隐藏正确答案/解析；显示「上次选 X」；重选后 `store.report`，`redo=false`。
- 收藏：`store.toggleFavorite(no, snapshot)`；无 store 时隐藏星标。
- `snapshot()` 增加 `type: 'choice'`。
- 键盘 1-4 / A-D 保留；`redo` 时同样可用。

### 5.4 MarkdownPreview

文件：`src/components/shared/MarkdownPreview.tsx`

`pre` 分支：

```tsx
if (/language-(quiz|json)/.test(cls)) {
  const src = extractText(children)
  const quiz = parseQuizFence(src) ?? (/language-quiz/.test(cls) ? parseQuizFenceLoose(src) : null)
  if (quiz) {
    return quiz.type === 'short'
      ? <ShortAnswerCard quiz={quiz} pageTitle={pageTitle} />
      : <QuizCard quiz={quiz} pageTitle={pageTitle} />
  }
  if (/language-quiz/.test(cls)) return <QuizFailCard onRetry={onQuizRetry} />
}
```

- `QuizCard` / `ShortAnswerCard` 从 `QuizRecordContext` 取 store；`MarkdownPreview` 不再传 `pageId` 给卡片（收藏/状态由 store 负责）。
- `pageId` 仍保留给插件围栏等其他用途。
- `QuizFailCard` 文案不变；简答 JSON 解析失败同样走它。

### 5.5 PageEditor

文件：`src/modules/knowledge/components/PageEditor.tsx`

1. `quizzes = extractQuizzes(content)` 现在包含简答。
2. 新增：
   ```ts
   const choiceQuizzes = useMemo(() => quizzes.filter(q => q.type === 'choice'), [quizzes])
   const quizStore = useQuizRecordStore({
     pageId: quizzes.length > 0 ? pageId : '',
     relPath: page?.path ?? '',
     pageTitle: title,
   })
   ```
   - store 内部对空 `pageId` no-op。
3. 阅读态（`preview`）的内容区外套 `<QuizRecordContext.Provider value={quizStore}>`：`QuizSheetBar`、`QuizReviewPane`、`MarkdownPreview` 都在 Provider 内，卡片才能拿到同一份记录。
4. 阅读态标题下加 `QuizSheetBar`（新组件）：
   - 左侧：「题单 · 已答 3/6 · 错题 2 · 草稿 1」。
   - 右侧：「错题重做 (2)」按钮（按当前 `quizzes` 的 no 过滤 `wrongNos`；为 0 时禁用/隐藏）。
   - 计数用 `quizzes` + `store.records` 现算，避免题目被删后旧记录把数字撑大。
   - 只在 `quizzes.length > 0` 且 `preview` 时显示。
   - 样式用现有 token + `kb-view-in`；不新造常驻动画。
5. `...` 菜单：
   - 「刷题模式」改用 `choiceQuizzes.length`；为 0 时隐藏（不再显示「0 题」的假按钮）。
   - 新增「错题重做 (N)」：按当前 `quizzes` 过滤后的错题数为 0 时隐藏；点击切到阅读态并打开 review。
6. `QuizMode`：
   - 只传 `choiceQuizzes`；简答题不进入全屏模式。
7. `QuizReviewPane`（新组件）：
   - `reviewNos` 在打开时冻结（`new Set(quizzes.filter(q => quizStore.wrongNos.has(q.no)).map(q => q.no))`）。
   - 渲染 `quizzes.filter(q => reviewNos.has(q.no))`，每题 `<QuizCard redo />` 或 `<ShortAnswerCard redo />`。
   - 顶部：「错题重做 · N 题」+「退出重做」；不是中央模态，是页面内子视图（遵守铁律 25）。
   - 重做过程中卡片状态实时更新；退出后 `QuizSheetBar` 的错题数按最新记录重算。
   - 若冻结的题在内容里已不存在（文本被改），跳过并提示「有 N 题已不在当前题单」。
   - `useEffect([pageId])` 关闭 review、清空冻结列表，避免切页后残留上一页的错题。
8. 单题「重做本题」：卡片本地 `redo`，不走 review pane。

### 5.6 QuizMode / QuizCollection 兼容

`src/components/shared/QuizMode.tsx`：

- v1 **只处理选择题**；入口加防御：
  ```ts
  const quiz = quizzes[idx]
  if (quiz && quiz.type !== 'choice') { /* 跳过或提示 */ }
  ```
  更简单：调用方保证只传选择题；`QuizMode` 内部 `quizzes.filter(q => q.type === 'choice')` 兜底。
- `snapshot()` 加 `type: 'choice'`；`quizRecordReport` 调用补 `picked: key`。
- 其余判分/完成页/键盘逻辑不变。

`src/modules/knowledge/components/QuizCollection.tsx`：

- `startReview(items)` 过滤 `r.snapshot && (r.snapshot.type ?? 'choice') === 'choice' && (r.snapshot.options?.length ?? 0) >= 2`；若跳过了简答题，Toast「简答题请在原题单内重做」。
- 卡片：
  - 简答记录显示「简答」chip；展开区显示 `referenceAnswer`，不渲染 options。
  - 「重刷本题」对简答记录改为「去原页重做」（调用 `onOpenPage(r.pageId)`）；不喂给 `QuizMode`。
- `QuizMode` 的 `pageId` 取 `reviewing` 对应的记录，不要用 `filtered.find(r => r.snapshot)` 的第一条——否则简答记录可能抢先，报告落到错误的页面。
- 这是错题本整改前的兼容层，不扩大范围。

### 5.7 AI 教学工件栏

`src/modules/ai-teaching/ArtifactsPane.tsx`：

- md 页签渲染 `<MarkdownPreview>` 时：
  - 用 `tab.rel` 调 `knowledgeFindByRel` 或直接让 `useQuizRecordStore({ pageId: '', relPath: tab.rel, pageTitle: tab.title })` 内部解析。
  - 外套 `<QuizRecordContext.Provider>`，这样工件栏里的题单也能保存痕迹。
- 解析不到页面（生成中/未入索引/被 .ignore）→ 无 store，题卡退化为本地可作答但**不保存**；可加一行小字「未绑定知识库页面，本次作答不会保存」。
- AI 聊天消息里的单题快检没有 pageId，保持一次性；不在本次范围。

### 5.8 旧 `<details>` 兼容

`src/components/shared/QuizParser.ts` 的 `preprocessContent` 增加一段**行级状态机**（不是全局正则）：

- 先把早期 return 的条件改掉：当前是「不含 `第` 或 不含 ``` 就直接返回」，纯 `<details>` 文档会被漏掉；改成含 `第` / `<details` / ``` 任一才继续。
- 跳过三反引号 / 波浪线代码围栏内的内容。
- 遇到 `<details>` 开始 → 收集到匹配的 `</details>`（支持嵌套深度计数）。
- 提取 `<summary>…</summary>` 与主体；把主体包成：
  ````markdown
  ```spoiler-answer
  **解析**：

  <主体>
  ```
  ````
- `<summary>` 文本丢弃（`SpoilerBlock` 的按钮已写「显示答案」）；如果 summary 不是「参考答案/答案/解析」，可在主体前加一行 `**summary**` 保留语义。
- 主体里若含三反引号代码围栏：**不转换**，原样保留（现有 `SpoilerBlock` 不支持嵌套围栏；强行转换会截断）。这是已知边界，原型/文档都只承诺文本型 `<details>`。
- 该转换只影响渲染，不写回文件；用户原文不变。

408 老格式：

- `### 第 N 题 + spoiler-answer` 仍按现有 `preprocessContent` 选择题转换；简答块原样保留，继续用 `SpoilerBlock` 折叠。
- 不改成可作答卡，避免 846 道老题的渲染/状态行为一次性变化。

旧记录：

- `draft` 为 null 时，选择题按 `lastResult` 显示对错（无 picked 高亮）；简答题显示题干 + 参考答案（若快照有 `referenceAnswer`），无草稿。
- 不迁移旧记录；字段可选，零破坏。

---

## 六、页面身份（auto → UUID）

这是「答题痕迹」能不能真正持久的关键，必须先解决。

### 问题

- AI 用 `course.organize.archive` / `organizeDoc` 落盘的 `.md` 没有 frontmatter `id`。
- 知识索引先给 `auto:<relPath>` 临时身份；首次保存才注入真 UUID（`PageEditor.doSave` 的 `ensureFrontmatterId`）。
- 如果在转正前答题，记录会绑在 `auto:` 上；转正后页面 id 变了，记录变孤儿。

### 方案

1. **新题单落盘即写 id**（主路径）：
   - `electron/lib/aiTeachingFolders.ts` 的 `organizeDoc` 和 `electron/lib/aiTeachingCourse.ts` 的 `archiveOrganizedPage`：
     - 检测 content 是否含 `` ```quiz `` 围栏；
     - 若无 frontmatter `id`，前置：
       ```yaml
       ---
       id: <randomUUID>
       title: "<title>"
       type: quiz
       ---
       ```
       `title` 只取单行，双引号与反斜杠要转义，避免 YAML 破坏。
     - `organizeDoc` 的同名同内容判断要先**剥离 frontmatter** 再比正文；否则同一内容每次生成新 UUID 会被当成不同内容，落出 `(1).md`。
     - `archiveOrganizedPage` 每次写新文件，直接生成 id 即可，无幂等问题。
   - 抽 `ensureQuizDocFrontmatter(title, content)` 纯函数，放 `electron/lib/quizDocPure.ts`（零依赖，可被契约脚本 import）；另抽 `stripFrontmatter` 供幂等比较。
2. **存量 auto 页面**：store 解析 + 迁移：
   - `useQuizRecordStore` 发现 `pageId` 以 `auto:` / `draft:` 开头且有 `relPath`：
     - `knowledgeFindByRel(relPath)`；
     - 若索引已给真 id → `quizRecordMigratePageId(old, new)` → 用新 id 拉记录；
     - 监听 `knowledge` 数据变更，下次再解析。
   - 若文件仍是 auto（还没保存）→ 继续用 auto；答题记录先落 auto；等转正后迁移。
   - `quizRecordMigratePageId` 的合并规则见 §4.2。
3. **PageEditor 保存时**：
   - 现在 `doSave` 是 `ensureFrontmatterId(prefix, rel, crypto.randomUUID())`；改成先拿 id 再注入，**写入成功后才迁移**：
     ```ts
     const newId = crypto.randomUUID()
     const ensured = ensureFrontmatterId(vaultPrefixRef.current, rel, newId)
     if (ensured.injected) vaultPrefixRef.current = ensured.prefix
     const res = await workspaceWriteFile(...)
     if (res?.ok && ensured.injected) {
       void quizRecordMigratePageId(`auto:${rel}`, newId)
     }
     ```
   - 不能先迁移再写盘：写盘失败会把记录迁到一个文件里不存在的 id 上。
   - 注意：`pageId` prop 可能仍是 auto，store 的解析逻辑会在 `knowledge` 刷新后接管；不要依赖 PageEditor 立即换 id。
   - 迁移 IPC 必须幂等；若文件已经是真 id（例如外部工具已写入），`ensureFrontmatterId` 不会注入，不触发迁移。
4. **AI 教学工件栏**：`tab.rel` → `knowledgeFindByRel`；解析真 id 后用同一 store。

### 验收

- 新建一篇 AI 题单 → 打开即带 `id`，答题 → 重启 → 痕迹还在。
- 旧 `auto:` 题单 → 答题 → 首次保存转正 → 记录迁移，无重复、无丢失。
- 同一题单在知识库和 AI 教学工件栏打开 → 共用同一份记录。

---

## 七、文件清单

> 以下路径均相对仓库根。

| 文件 | 类型 | 改动 |
|---|---|---|
| `src/components/shared/QuizParser.ts` | 改 | `QuizItem.type` / `referenceAnswer`；`asQuizItem` 分支；`extractQuizzes` 围栏提取；`preprocessContent` `<details>` 兼容 |
| `src/components/shared/ShortAnswerCard.tsx` | 新 | 简答题卡；作答框/草稿/参考答案折叠/自评/重做 |
| `src/components/shared/QuizCard.tsx` | 改 | 走 store；恢复 picked/lastResult；`redo`；收藏走 store |
| `src/components/shared/quizRecordStore.ts` | 新 | 页面级记录 store；auto→UUID 解析；草稿串行保存；`useSyncExternalStore` 选择器 |
| `src/components/shared/QuizReviewPane.tsx` | 新 | 题单内错题重做子视图 |
| `src/components/shared/QuizSheetBar.tsx` | 新 | 已答/错题/草稿 + 错题重做入口 |
| `src/components/shared/MarkdownPreview.tsx` | 改 | 简答题分发；不再给卡片传 pageId |
| `src/components/shared/QuizMode.tsx` | 改 | 选择题兜底过滤；snapshot 加 type |
| `src/modules/knowledge/components/PageEditor.tsx` | 改 | store/Provider；题单条；review pane；菜单入口；choice-only QuizMode；auto 迁移 |
| `src/modules/knowledge/components/QuizCollection.tsx` | 改 | 简答记录兼容；startReview 只取选择题 |
| `src/modules/ai-teaching/ArtifactsPane.tsx` | 改 | rel → pageId；Provider |
| `src/types/index.ts` | 改 | `QuizDraftDto`、`QuizSnapshotDto.type/referenceAnswer`、`QuizRecordDto.draft`、IPC 签名 |
| `src/lib/ipc.ts` | 改 | `quizRecordSaveDraft` / `quizRecordMigratePageId` / `knowledgeFindByRel` 包装 |
| `electron/preload/index.ts` | 改 | 三条 IPC 暴露 |
| `electron/database/repositories/quizRepo.ts` | 改 | saveDraft / migrate / parseDraft / parseSnapshot；report 广播 |
| `electron/lib/kbStore/quizVaultRepo.ts` | 改 | `draft_json?` 字段 |
| `electron/lib/quizRecordPure.ts` | 新 | 草稿归一/合并、pageId 迁移合并、wrongNos（纯函数，供契约） |
| `electron/lib/quizDocPure.ts` | 新 | `ensureQuizDocFrontmatter`（纯函数，供契约） |
| `electron/lib/aiTeachingFolders.ts` | 改 | `organizeDoc` 写题单 frontmatter id |
| `electron/lib/aiTeachingCourse.ts` | 改 | `archiveOrganizedPage` 写题单 frontmatter id |
| `electron/database/repositories/knowledgeRepo.ts` | 改 | `knowledgeFindByRel` + IPC 注册（若放这里更顺） |
| `electron/lib/agentService.ts` | 改 | 出题规则补简答题协议/禁止 HTML/连续题号 |
| `resources/skills/quiz-generator/SKILL.md` | 改 | 简答协议同步 |
| `resources/help/AI 教学 · 课程模式.md` | 改 | 用户可见行为说明 |
| `CHANGELOG.md` | 改 | 3.15.0 条目 |
| `package.json` | 改 | 3.15.0 |
| `electron/lib/releaseNotes/data.ts` | 生成 | 跑 `build-release-notes.mjs`，不手改 |
| `.AGENT/scripts/quiz-tools/verify-quiz-fence.mjs` | 改 | 简答解析/围栏/`<details>` 用例 |
| `.AGENT/scripts/quiz-tools/verify-quiz-record.mjs` | 新 | 草稿合并/迁移/wrongNos 纯函数契约 |
| `docs/ui-updates.md` | 改 | 追加一条 UI 变更流水 |
| `docs/quiz-short-answer-answer-state-plan.md` | 新 | 本文 |

---

## 八、分阶段实施

> Phase 1 是内部里程碑：若单独发版，简答题只能看不能答。建议 3.15.0 一次发完 Phase 1–3；Phase 1 先合入分支，便于逐段验收。

### Phase 1：大题正确渲染（工作 1）

1. `QuizParser`：`type` / `referenceAnswer` / `extractQuizzes` / `<details>` 兼容。
2. `ShortAnswerCard` 只读版：题面 + 参考答案折叠（无作答框）。
3. `MarkdownPreview` 分发简答题。
4. `agentService` 提示词 + `quiz-generator` skill。
5. 契约：`verify-quiz-fence.mjs` 扩展。
6. 验收：AI 新出的简答题正常渲染；旧 `<details>` 文档刷新后折叠；408 选择题/简答不回归。

> Phase 1 的卡片组件就按最终结构写，只是隐藏作答区；Phase 2 不重写组件，只打开交互。

### Phase 2：数据层与页面身份（工作 2 的地基）

1. `draft_json`、`saveDraft`、DTO、`parseDraft`/`parseSnapshot`。
2. `ensureQuizDocFrontmatter` + `organizeDoc`/`archiveOrganizedPage`。
3. `knowledgeFindByRel` + `quizRecordMigratePageId` + 合并纯函数。
4. 契约：`verify-quiz-record.mjs`。
5. 验收：新题单带 id；旧 auto 题单迁移无重复；数据层契约 PASS。此时还没有交互 UI。

> 页面身份必须先于持久化 UI：否则 Phase 3 上线后，`auto:` 题单的痕迹仍会丢。

### Phase 3：答题痕迹 UI（工作 2）

1. `quizRecordStore`：fetch/乐观更新/串行草稿保存/选择器 + auto→UUID 解析。
2. `ShortAnswerCard` 交互版 + `QuizCard` 恢复/重做。
3. `QuizSheetBar` + `QuizReviewPane` + `PageEditor` 菜单。
4. `quizRecord:report` 广播；`QuizMode`/`QuizCollection` 兼容。
5. 验收：刷新/重启恢复；错题重做；选择题回归。

### Phase 4：收尾

1. AI 教学工件栏 Provider。
2. 帮助文档 / CHANGELOG / 版本 / release notes。
3. 全量 tsc/build/contract/手工验收。

---

## 九、验证计划

### 9.1 类型与构建

```bash
npx tsc --noEmit -p tsconfig.node.json
npx tsc --noEmit -p tsconfig.web.json
npm run build
```

### 9.2 契约脚本

```bash
node --experimental-strip-types --no-warnings .AGENT/scripts/quiz-tools/verify-quiz-fence.mjs
node --experimental-strip-types --no-warnings .AGENT/scripts/quiz-tools/verify-quiz-record.mjs
node .AGENT/scripts/help-kb/verify-help-retrieval.mjs
```

`verify-quiz-fence.mjs` 新增用例：

- 选择题旧格式零变化。
- 简答题解析：`type/referenceAnswer/no` 正确；`options=[]`、`answer=''`。
- 简答缺 `referenceAnswer` → null。
- `extractQuizzes` 混合卷：选择题 + 简答题都提取；参考答案里含 `}` 不截断。
- `preprocessContent` `<details>` → `spoiler-answer`；代码围栏内的 `<details>` 原样。
- 408 简答块（`### 第 N 题 + spoiler-answer`）不被误转成 quiz。
- 重复 `no` 的防御（若实现）。

`verify-quiz-record.mjs` 新增用例：

- `applyDraftPatch` 合并/截断/空值。
- `mergeRowsOnPageIdMigration`：无冲突迁移、有冲突合并计数/快照/草稿。
- `wrongNosOf`：只取 `lastResult === 0`；draft-only 不算。
- `ensureQuizDocFrontmatter`：无 id 注入、已有 id 不重复、非 quiz 文档不动。

### 9.3 UI 探针（建议）

参考 `.AGENT/scripts/desktop/probes/probe-toolbar-prototype.mjs` 的 Electron + CDP 手法，补一个 `probe-quiz-sheet.mjs`：

1. 打开测试题单 → 输入简答 → 失焦 → 断言「已保存」。
2. `Page.reload` → 断言选项/草稿/展开/自评恢复。
3. 点「错题重做」→ 断言只渲染错题、参考答案收起。
4. 改对 → 退出 → 断言错题数减少。

时间不够时至少走 §9.4 手工验收；纯函数与解析层由两个契约脚本兜底。

### 9.4 手工验收

1. 新建 AI 题单（选择 + 简答混合）→ 简答正常渲染，无 `<details>` 原文。
2. 简答输入 → 失焦/等待 → 「已保存」；刷新 → 恢复。
3. 显示参考答案 → 自评答错 → 状态「答错」；刷新 → 仍答错且参考答案状态恢复。
4. 选择题答对/答错 → 刷新 → 选项/对错/解析状态恢复。
5. 「错题重做 (N)」→ 只显示错题；带着上次答案；参考答案收起；改对后退出 → N 减少。
6. 单题「重做本题」→ 可重选/重新自评。
7. 旧 `<details>` 文档 → 折叠块（只读）；408 老题 → 选择题仍判题、简答仍 spoiler。
8. AI 教学工件栏打开同一题单 → 作答 → 回知识库 → 状态一致。
9. 旧 `auto:` 题单 → 作答 → 保存转正 → 记录迁移，无重复。
10. 长题单（40 选择 + 7 简答）输入时不卡顿；只有当前题卡重渲染。

### 9.5 回归风险点

- `QuizCollection` 的错题重刷只跑选择题；简答记录不喂 `QuizMode`。
- `extractQuizzes` 返回简答后，任何依赖「全是选择题」的调用方都要过滤：
  - `PageEditor` 刷题模式；
  - `QuizCollection.startReview`；
  - 其他 `extractQuizzes` 消费者（grep 确认）。
- `QuizSnapshotDto.options` 对简答为空数组；所有渲染 options 的地方要判 `type`。
- `quizRecordStats` / `quizDataAdmin` 对 draft-only 行的口径（已知会算进 total）。
- 题号重复：同一页两个 `no` 相同的题会共享记录。`extractQuizzes` 返回后做一次 `Set(no)` 检查；`PageEditor` 发现重复时在题单条显示警告「题号重复，答题状态可能串号，请让 AI 重新生成」，不要静默。AI 提示词已强制连续题号，这里是防御。
- `knowledgeFindByRel` 对 Windows 反斜杠路径先归一为 `/`，再与索引的 `path` 比较。

---

## 十、性能与安全

### 性能

- 每页只拉一次 `quizRecordGetByPage`；卡片按 `no` 订阅，草稿保存不触发整页重渲染。
- 草稿防抖 500ms + 失焦 flush + 卸载 flush；同一 `no` 的保存串行。
- 保存草稿不广播；只有 `report` 广播 `quiz`。
- 题单条/统计用 `useMemo`；长题单不额外加 `content-visibility`（文档本身已有滚动容器）。

### 安全

- 草稿是纯文本，只进 `<textarea>` value；不 `dangerouslySetInnerHTML`。
- 参考答案走 `MarkdownPreview`；未装 `rehype-raw`，HTML 仍按文本处理。
- `<details>` 兼容只做文本转换，不解禁 HTML。
- `referenceAnswer` 不单独设上限，随 Markdown 文档大小约束；草稿 20,000 字符上限。
- IPC 校验 `pageId` / `quizNo`；`migratePageId` 校验非空字符串，避免误删。

---

## 十一、文档、版本与发布

1. `package.json` → `3.15.0`。
2. `CHANGELOG.md` 新增 3.15.0 段：
   - 简答题题卡（题干/作答/参考答案折叠/自评）
   - 答题痕迹保存（选项/草稿/展开/自评）
   - 题单内错题重做
   - 旧 `<details>` 兼容
   - AI 出题协议支持 `type:"short"`
3. 跑 `.AGENT/scripts/release-notes/build-release-notes.mjs` 生成 `electron/lib/releaseNotes/data.ts`（不手改）。
4. 帮助文档同步后跑 `verify-help-retrieval.mjs`。
5. `docs/ui-updates.md` 追加一条。
6. 发布前 `npm run pack`；产物落 `packs/3.15.0`。

> Linux 版帮助手册按 `docs/linux-port-plan.md` 决策 #13 不维护；本次改动是跨平台功能，Windows 侧仍需同步。

---

## 十二、风险与待定

| 风险 | 影响 | 处理 |
|---|---|---|
| `auto:` 页面转正前的记录 | 状态绑在临时 id | 新题单落盘即写 id；store 解析 + 迁移；契约覆盖 |
| 简答参考答案含三反引号 | Markdown 围栏截断 | 提示词禁止；契约用例；检测到嵌套围栏时不转换 `<details>` |
| 旧 408 简答块不升级 | 老题不能保存草稿 | 明确非目标；需要时后续单独做批量转换 |
| 错题本整改中 | 简答记录出现在错题本列表 | 兼容层：简答记录不喂 `QuizMode`，改为去原页重做 |
| 多窗口同时作答 | 最后写入者覆盖 | 本地单人使用；记录级 last-write-wins，不阻塞 |
| draft-only 记录进 stats.total | 题目数口径变化 | 接受；后续可加 `hasActivity` 过滤 |
| 长题单输入性能 | 整页重渲染 | store 按 `no` 订阅；草稿不广播；实测 40+7 题 |
| AI 仍写 `<details>` | 新文档露标签 | 提示词 + `<details>` 兼容双保险；兼容只读，不静默变成可作答卡 |

### 实现默认值（如无异议按此落）

1. `QuizSheetBar` 落点：阅读态标题下一条紧凑条（推荐）；`...` 菜单保留同一入口作为兜底。
2. 「错题重做」抽题口径：`lastResult === 0`（和原型一致）；错题本的 `wrongCount > 0 && streak < 2` 口径不动。
3. 简答题「重做本题」：保留旧文字作为起点（原型行为），不清空。
4. `QuizCollection` 简答记录：显示只读的 `referenceAnswer`，不喂 `QuizMode`。
5. `quizDataStats.total`：接受包含 draft-only 行；错题本整改时再统一口径。

---

## 十三、验收标准

- [ ] AI 新出的简答题是题卡，页面源码里没有 `<details>` 原文。
- [ ] 选择题行为与现在完全一致（判题/解析/收藏/刷题模式）。
- [ ] 简答草稿、选择题选项、是否展开参考答案、自评结果在刷新/重启后恢复。
- [ ] 「错题重做 (N)」只抽当前题单 `lastResult === 0` 的题；重做正确后 N 减少。
- [ ] 旧 `<details>` 文档刷新后显示折叠块，不再露标签。
- [ ] 408 老格式选择题仍可判题；老简答仍 spoiler 折叠。
- [ ] 旧 `auto:` 题单转正后记录不丢、不重复。
- [ ] `npx tsc --noEmit -p tsconfig.node.json` / `tsconfig.web.json` 零新增错误。
- [ ] `npm run build` 通过。
- [ ] 两个契约脚本 PASS；帮助检索 PASS。
- [ ] 没有中央模态；动效只用现有 token / 工具类。
- [ ] 帮助文档、CHANGELOG、release notes 已同步。

---

## 附：原型与截图

- 原型：`/home/lousync/Projects/Phrontis/tmp/quiz-short-answer-proto/index.html`
- 自动验证：`/home/lousync/Projects/Phrontis/tmp/quiz-short-answer-proto/probe.mjs`（56/56）
- 截图：`shot-01-initial.png` / `shot-02-answered.png` / `shot-03-redo.png` / `shot-04-after-redo.png` / `shot-05-readonly.png` / `shot-06-drawer.png`

原型只验证交互与排版，未接 AI 出题和真实 IPC；数据在 localStorage。正式实现按本文 §三–§六 落 vault 与 IPC。
