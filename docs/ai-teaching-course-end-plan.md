# AI 教学 · 结课与资料沉淀 · 实现方案

> 状态：已实施（v3.41.0，2026-11-16）· 原型已验收：`tmp/ai-teaching-course-end-proto/index.html`
> 目标版本：v3.41.0（新功能，抬 minor；v3.40.0 已被多模态输入批次占用）
> 本文只写实现口径；交互细节以原型为准。原型里被否定的长段提示文字，落码时一律不进入正式界面。

---

## 0. 一句话

课程可以**在任何进度手动结课**；结课后课程沉到选择页末尾、章节与大纲只读，但课程助手仍可对话。结课时可把「讲义 / 总结 / 导图 / 示意图」先收集到课程内 `待整理/`，再整理进笔记区指定的空间 / 笔记本；素材、题单与错题不参与沉淀。

---

## 1. 范围与不变量

### 1.1 本期做

- 选择页：已结课分组沉底、条目样式变化、可结课提示、提前结课入口。
- 结课流程：确认 → 挑选资料 → 整理沉淀 → 完成；支持中途退出并从 `待整理` 继续。
- 结课报告：`{工作区}/结课报告.md`，程序事实 + 错题摘要；可查看全文。
- 结课后只读：大纲 / 段 / 复习 / 素材 / 产物写入关闭；课程助手仍可对话。
- 重新开课：清除结课状态，保留报告与进度。
- 资料沉淀：课程产物 → 笔记区空间 / 笔记本 / 子文件夹；保留章目录可选。
- AI 工具与文件写入的结课守卫。

### 1.2 本期不做

- 不做「第 N 轮」课程模型；重新开课 = 原课程续用。
- 不沉淀素材原件、素材提取稿、题单、错题；不做 PDF/PPT 搬运。
- 不沉淀生图图片与 PPT 阅读产物（本期只收五类：复习讲义 / 段讲义 / 总结 / 导图 / 示意图）。
- 不改课程布局 `chapter-segment-v1`；不改 `progress.json` v2 结构。
- 不做自动结课；不按掌握度判定。
- 不做知识库侧的「从课程导入」反向入口。

### 1.3 必须守住

- 渲染层只传 `{ wsId, relInWs, target }`，不传绝对路径（AGENTS 核心不变量 3）。
- 写盘走 `workspaceManager` / `kbStore` 业务函数，不给 `.knowbase` 开写白名单。
- 结课状态、报告、沉淀清单都是可读文件/JSON；换电脑拷走仓库仍成立。
- 不动 `AI教学` 系统排除根（v9）；沉淀必须物理写到根外。
- 所有新 UI 按「界面引导」：不加解释段落、不加教学式提示条、不用 `transition-all`。

---

## 2. 数据模型

### 2.1 `workspaces.json`：只加一个状态位

`electron/lib/aiTeachingWorkspaces.ts`

```ts
export interface AiWorkspace {
  id: string
  name: string
  createdAt: string
  /** 结课时间；null/缺省 = 进行中。状态唯一真相源，不派生自进度 */
  endedAt?: string | null
}
```

- 现有文件无 `endedAt` → 按进行中读，不做迁移。
- `endedAt` 与进度解耦：允许 `learned < total` 时结课。
- 不把状态写进 `课程.md`（`rewriteCourseMd` 整篇重写，frontmatter 存不住）。

`WorkspaceInfo` 增：

```ts
endedAt: string | null
course: {
  chapters: number
  total: number
  learned: number
  reviewsDone: number
  ready: boolean
} | null // 没有课程.md 的主题工作区 = null
```

- `ready = total > 0 && learned >= total && reviewsDone >= chapters`。
- `listWorkspaces` 为每个工作区读一次 `课程.md` + `progress.json` 生成摘要；工作区数量少，和现有 `countDocs` 同量级。若后续工作区过百，再加 `wsId + mtime` 内存缓存。

新增纯函数模块 `electron/lib/aiTeachingCourseSummary.ts`（零 electron 依赖）：

```ts
summarizeCourseWorkspace(workspaceAbs: string): {
  chapters: number; total: number; learned: number; reviewsDone: number; ready: boolean
} | null
```

- 读 `课程.md` → `parseCourseMd`；读**仓库级** `.knowbase/modules/aiTeaching/progress.json` → `normalizeProgressFile`（progress 不在工作区文件夹内，按 wsId 取本课程键）。
- `learned` 用 `unitLearned`；`reviewsDone` 用 `reviews[cid]?.rel`（已有讲义才算）。
- 空章不计入 ready（与 `chapterLearned` 口径一致）。
- 主进程与契约脚本共用。

### 2.2 `progress.json`

结构不动。结课不修改进度、不自动收尾 open 段。

### 2.3 结课报告

路径：`{工作区}/结课报告.md`。

- 结课时若已存在：先重命名为 `结课报告·<YYYY-MM-DD-HHmm>.md`（`uniqueFileName` 防重名），再写新报告；历史报告保留在文件树里。
- 报告不写 `id`（AI教学根在系统排除根内，不进知识索引），只写人读 frontmatter：

```yaml
---
title: 408 操作系统 · 结课报告
course: 408 操作系统
endedAt: 2026-11-16T10:00:00.000Z
---
```

- 正文由纯函数 `renderCourseEndReport()` 生成，结构固定：

```markdown
# 408 操作系统 · 结课报告

## 基本情况
- 学习跨度：2026-08-15 – 2026-11-16（93 天）
- 覆盖范围：12 章 / 64/140 个知识点 / 21 个学习段
- 测验：4 次，平均 82 分；27 道错题

## 复盘
（程序摘要：未完成章节 + 错题集中标签；用户可编辑）

## 资料处置
- 已沉淀：27 份 → 考研 / 408 操作系统 / 结课资料
- 留在课程内：题单 2 份（答题记录绑定）
```

- **v1 不调用 LLM**：复盘段由程序生成（完成情况 + 错题 Top 标签 + 一句可执行建议）。用户可在编辑器里改写；结课报告是普通 md，不锁定。
- 错题统计：扫描工作区内 `测验·*.md` 的 frontmatter id / `auto:<rel>`，用 `quizVaultRepo.readQuizRecords()` / 标签表过滤，输出次数、平均正确率、Top 标签。无测验则写 `—`。

### 2.4 `待整理` 暂存区

路径：`{工作区}/待整理/`，隐藏清单 `{工作区}/待整理/.manifest.json`。

```jsonc
{
  "v": 1,
  "wsId": "ws-...",
  "createdAt": "2026-11-16T...",
  "entries": [
    {
      "id": "a1",
      "group": "review",
      "title": "复习讲义",
      "sourceRelInWs": "第3章 进程/章末复习/复习讲义.md",
      "stageRelInWs": "待整理/章末复习/第3章 进程/复习讲义.md",
      "chapterRel": "第3章 进程",
      "kind": "md",
      "size": 47104
    }
  ]
}
```

- 只用**工作区相对路径**存清单，工作区 / 根目录改名后仍可解析。
- `待整理` 是可见文件夹（用户可在树里看到），`.manifest.json` 点开头，树里自然隐藏。
- 收集 = **复制**，课程原件不动；重新收集 = 重建清单并回收旧暂存文件（`trashWorkspacePath`，绝不 rm）。暂存区被明确定义为临时区，不做编辑保留。

### 2.5 沉淀清单

路径：`.knowbase/modules/aiTeaching/deposits.json`（与 `progress.json` / `sources.json` 同目录）。

```jsonc
{
  "v": 1,
  "workspaces": {
    "ws-...": {
      "lastTarget": {
        "space": "考研", "notebook": "408 操作系统", "subfolder": "结课资料", "keepChapter": true
      },
      "entries": {
        "<relInWs>": {
          "pageId": "uuid / auto:...",
          "targetRel": "考研/408 操作系统/结课资料/第3章 进程/复习讲义.md",
          "kind": "md",
          "depositedAt": "2026-11-16T..."
        }
      }
    }
  }
}
```

- 按 `relInWs` 幂等：同一份课程产物重复沉淀直接跳过（不产生第二份）。
- 非 md（导图 / 示意图）也记在这里，避免重复拷贝。
- 目标空间 / 笔记本 / 子文件夹由 `lastTarget` 记住，下次默认沿用；首次默认笔记本 = 课程名。

### 2.6 沉淀页的溯源 frontmatter

落进笔记区的 md 由 `vaultCreatePage` 生成新 UUID，并注入：

```yaml
aiTeachCourse: ws-...
aiTeachSource: 第3章 进程/章末复习/复习讲义.md
aiTeachEndedAt: 2026-11-16T...
tags: [AI教学, 408 操作系统]
```

- 不复制原文档的 `id`；避免与课程内原件撞 id。
- 题单不沉淀，所以不存在答题记录断链。
- 溯源字段只用于「是否已沉淀」与回查，不参与知识库分类。

---

## 3. 文件分类与盘点

新增 `electron/lib/aiTeachingCourseEndPure.ts`（零 fs / electron，契约脚本直接 import）。

### 3.1 五类可沉淀产物

| 组 | 判定 | 落点 |
|---|---|---|
| `review` 章末复习讲义 | 路径含 `/章末复习/` 且 `复习讲义*.md` | 章末复习 |
| `lecture` 段讲义 | `段*/讲义·*.md`（含 `讲义·xxx.md`） | 段 |
| `summary` 阶段总结 | `总结·*.md`；`课程助手/output/**/总结*.md` | 课程助手 / 章 |
| `mindmap` 思维导图 | `**/mindmaps/*.json` | 段 |
| `visual` 示意图 | `**/visuals/*.html` | 段 |

### 3.2 明确排除

- 整个 `SOURCES/`（素材原件 / 提取稿）。
- `课程.md`、`CONSTRAINTS.md`、`PROFILE.md`、`SOURCE.md`、`交接.md`、`结课报告*.md`、`.session.json`。
- `测验·*.md`：不进候选，但计入「留在课程内」与错题统计。
- `待整理/`、`_templates/`、`.开头的目录`、`node_modules/`、`教材/`、`_extracts/`。
- 图片 `.png` / `.pptx`：本期不收。

### 3.3 盘点函数

```ts
export interface EndArtifact {
  id: string
  group: 'review' | 'lecture' | 'summary' | 'mindmap' | 'visual'
  title: string
  relInWs: string
  chapterRel: string | null
  kind: 'md' | 'json' | 'html'
  sizeBytes: number
}

export function buildArtifactInventory(entries: Array<{ relInWs: string; sizeBytes: number }>): EndArtifact[]
export function countArtifacts(entries: EndArtifact[]): number
export function classifyArtifact(relInWs: string): EndArtifact['group'] | 'quiz' | 'excluded'
```

- 纯函数只做「路径 → 分类」，读盘与深度遍历在主进程 `aiTeachingCourseEnd.ts`（`walkWorkspace`，深度 ≤ 5、不跟随符号链接）；契约脚本直接喂路径 + 字节数。
- 排序：章号 → 组 → 文件名。
- `id` 用 `relInWs` 的稳定 hash 或直接 `relInWs`。

主进程 `listCourseEndArtifacts(wsId)` 负责把绝对路径解析成 `relInWs`，再调纯函数。

### 3.4 修正现有 `docCount`

`aiTeachingWorkspaces.ts` 的 `countDocs` 现在把 `课程.md`、`交接.md` 也算「产物」。改为：

- 扫描工作区，按 `buildArtifactInventory` 的口径计数；
- 加 `测验·*.md` 计数（题单也是产物，但不沉淀）；
- 排除 `待整理`、`结课报告*.md`。
- 选择页「产物」统计从此是真产物数，不再被结构文件抬高。

---

## 4. 结课流程（主进程）

新增 `electron/lib/aiTeachingCourseEnd.ts`，对外函数：

```ts
getCourseEndState(wsId, getSetting): {
  endedAt: string | null
  completion: CourseProgressSummary | null
  artifacts: EndArtifact[]
  staging: StagingEntry[]
  report: { relInWs: string; summary: string } | null
  deposit: { count: number; target: EndTarget | null }
  targets: DepositTargets
}

listEndArtifacts(wsId, getSetting): EndArtifact[]
collectEndArtifacts(wsId, relsInWs, getSetting): { ok, count, error? }
getEndStaging(wsId, getSetting): StagingEntry[]
depositEndArtifacts(wsId, entryIds, target, getSetting): DepositResult
endCourse(wsId, opts, getSetting): { ok, endedAt, reportRel, error? }
reopenCourse(wsId): { ok, error? }
getEndReport(wsId, getSetting): { relInWs, markdown, summary } | null
getDepositTargets(getSetting): DepositTargets
```

### 4.1 结课动作

`endCourse(wsId)`：

1. 校验工作区存在、有 `课程.md`（没有大纲的主题工作区不提供结课入口；接口层拒绝）。
2. 允许 `learned < total`、允许 open 段存在；**不修改 progress**。
3. 归档旧 `结课报告.md`（若存在）。
4. 生成并写 `结课报告.md`（含完成情况、错题摘要、资料处置）。
5. `workspaces.json.endedAt = now`；`persist`。
6. 广播：`aiTeach:course-refresh`（现有）+ `aiTeach:tree-refresh`。
7. 返回 `{ok, endedAt, reportRel}`。

`reopenCourse(wsId)`：

1. `endedAt = null`；persist；广播。
2. 不删报告、不删 `待整理`、不清进度。
3. 返回 `{ok}`。

### 4.2 收集

`collectEndArtifacts(wsId, relsInWs)`：

1. 校验每个 rel 在 `buildArtifactInventory` 结果中，且不是 `quiz` / 素材 / 结构文件。
2. 暂存目录 `{ws}/待整理`；若已存在旧清单，先 `trashWorkspacePath` 旧暂存目录（只回收暂存副本，不碰原件）。
3. 逐条复制到 `待整理/<group>/<chapter?>/<name>`：`mkdir -p` + `copyFileSync`；同名用 `uniqueFileName`。
4. 写 `.manifest.json`；广播 `aiTeach:tree-refresh`。
5. 返回条数与清单。

- 收集是「替换暂存清单」，不是增量合并；原件始终保留。
- 复制走 `workspaceManager` 新增的 `copyWorkspacePath(rootId, fromRel, toRel)`，内部 `requireInside` + `markSelfWrite` + `invalidateIndexIfCurrentVault`。

### 4.3 沉淀

`depositEndArtifacts(wsId, entryIds, target)`：

1. 只接受 `.manifest.json` 中存在的 entry id；校验 `stageRelInWs` 下文件存在。
2. 目标解析 / 创建（`ensureDepositTarget`）：
   - `space`：`vaultGetCategories()` 找 `categoryType:'space'` 同名；没有则 `vaultCreateCategory({categoryType:'space', parentId:null, path:name})` + `mkdir`。
   - `notebook`：在选中空间下找同名 `categoryType:'notebook'`；没有则创建。
   - `subfolder`：在笔记本下找同名 `categoryType:'folder'`；没有则创建。
   - `keepChapter`：每条 entry 的 `chapterRel` 作为子文件夹，惰性创建 / 复用。
   - 所有名称走 `sanitizeTargetSegment`：禁 `\/:*?"<>|`、`.`/`..`、截 40；大小写按平台。
3. 幂等：读 `deposits.json`；`entries[relInWs]` 已存在且目标页/文件仍在 → 跳过；不存在则写。
4. md：
   - `parseMarkdown` 源文件 → `body`；标题 = frontmatter.title 或文件名去扩展。
   - `vaultCreatePage({ title, contentMd: body, dirRel, fileType:'md', tags:['AI教学', 课程名], extraFrontmatter: { aiTeachCourse, aiTeachSource, aiTeachEndedAt } })`。
   - `vaultCreatePage` 新增可选 `extraFrontmatter`（见 §6.4）。
5. json/html：
   - 目标目录 + `uniqueFileName` 复制文件；`invalidateKnowledgeIndex()`；索引按非 md 条目收录（导图 JSON 自动取 title / isMindmap）。
6. 写 `deposits.json`（成功的条目）；失败的条目保留在暂存清单，返回 `{ok:false, failed:[...]}`。
7. 全部成功：`trashWorkspacePath` 回收 `待整理`；`endCourse(wsId)`（若尚未结课）；重写结课报告的「资料处置」段；广播 `knowledge` + `aiTeach:course-refresh` + `tree-refresh`。
8. 部分失败：不结课（若尚未结课），保留暂存与清单，渲染层只显示失败条数 + 重试按钮（不写长错误说明）。

### 4.4 直接结课（不沉淀）

- 流程第 1/2 步提供「直接结课」：`endCourse(wsId)`，报告「资料处置」写 `未沉淀`。
- 结课后仍可从完成页点「资料沉淀」重新进入第 2/3 步；沉淀成功后追加/更新报告的资料处置段，不重复结课。

### 4.5 错题摘要

`getCourseQuizSummary(wsId, getSetting)`：

1. 扫描工作区内 `测验·*.md`，读 frontmatter id；无 id → `auto:<vaultRel>`。
2. `readQuizRecords()` 过滤 `page_id` 集合。
3. 统计：测验份数、作答记录数、错题数、平均正确率、Top 3 标签（`record-tags` + `tags`，按错次降序）。
4. 无测验返回全 0；报告写 `—`。

不修改任何 quiz 数据。

---

## 5. 选择页改造

文件：`src/modules/ai-teaching/index.tsx`（picker 分支），`src/types/index.ts`。

### 5.1 列表

- `wsList` 现在带 `endedAt` / `course`。
- 排序：
  - 进行中：`lastActive` 倒序；
  - 已结课：`endedAt` 倒序，整体放在进行中之后。
- 分组头：`已结课` + 数量；默认展开、可收起；搜索时强制展开。
- 条目：
  - 进行中：保持 folder 图标；`course.ready` 时尾部显示安静的 `可结课`（accent 文字，无徽标）。
  - 已结课：`check-circle` 图标、名称降为 secondary、尾部 `已结课 MM-DD`；meta 为 `N 章 · 120 知识点` 或 `N 章 · 已学 64/140`。
  - 已结课不参与「继续上次」。
- 搜索命中只保留匹配项；分组头保留。

### 5.2 预览

进行中：

- 统计 / 进度条 / 最近对话保持现状；`course.ready` 时在进度块下加一行：
  - 左侧 check + `120/120 · 12/12`，右侧 `结课` 按钮。
  - 不写「可以结课了」之类说明；check 与数字已经表达。
- 操作条始终加 `提前结课…`（ready 时文案 `结课…`）；图标按钮不变。

已结课：

- 头部：`check-circle` + 名称 + `已结课 · 11-16`；目录行保留。
- 三格统计：`N 章` / `learned/total 知识点` / `已沉淀 N 份`（无沉淀显示 0）。
- 结课报告：一行摘要（`getEndReport` 的 `summary`）+ `查看全文`。
- 资料沉淀：`N 份已沉淀到 空间 / 笔记本 / 子文件夹` + `M 份留在课程内`（题单等）。不写「课程文件保留」。
- 课程助手：bot 图标 + 最近一句 + `继续对话`。不写「结课后仍可对话」。
- 操作条：`进入课程` / `结课报告` / `资料沉淀` / `重新开课` / 删除图标。
- 预览不再渲染旧进度条。

### 5.3 继续上次

`resumeId` = 进行中且 `lastActive` 最大的工作区；若 `lastWorkspaceId` 指向已结课，自动回退到该值；全结课时不显示快捷条。

---

## 6. 结课流程 UI

新组件：`src/modules/ai-teaching/CourseEndFlow.tsx`。

- 入口：选择页 `提前结课…` / `结课…` / 已结课预览 `资料沉淀`。
- 模块内整页视图（不是中央弹窗）：顶部返回 + 标题 + 三步指示；底部固定操作条。
- 状态由 `index.tsx` 持有：`endFlow: { wsId, step: 1|2|3|'result', artifacts, staging, target } | null`。
- 步骤：

#### 第 1 步 · 确认

- 事实格：章数 / `learned/total` / `已收尾段/总段` / 测验与错题。
- 若未完成：只显示一行**数据** `64/140 · 5/10`，不写长警告；「提前结课」按钮本身已表达允许。
- 结课报告草稿：展示 `renderCourseEndReport` 的前两段，只读预览。
- 底栏：`取消` / `直接结课`（ghost）/ `下一步：挑选资料`。
- 不用「结课不会删除任何文件」这类说明。

#### 第 2 步 · 挑选资料

- 只渲染五组；组头 checkbox + 名称 + 数量 + 体积；无组时整组不渲染。
- 行内：checkbox + 文件名 + 路径 + 大小。
- 顶部：`已选 N 份 · 约 X MB` + `全选` / `全不选` / `只选终态资料`。
- 底栏：`上一步` / `直接结课` / `收集并继续`（无选中时 disabled）。
- 不写「收集 = 复制到待整理」的说明；按钮文案 + 底栏路径 `收集到 {课程}/待整理/` 足够。
- 题单 / 错题 / 素材不出现任何行或锁定组。

#### 第 3 步 · 整理沉淀

- 左：`待整理 · 课程` 列表（分组、checkbox、路径），可取消勾选。
- 右：目标区域 select / 笔记本 select（含「新建…」内联输入）/ 子文件夹 input / `保留章目录结构` checkbox。
- 路径预览块实时显示 `空间 › 笔记本 › 结课资料 › 第3章 …/复习讲义.md`。
- 底栏：`上一步` / `沉淀到笔记区`（无选中 disabled）。
- 去掉「重名时保留两份」：沉淀恒不覆盖，重复条目按 `deposits.json` 跳过；需要第二份时换子文件夹。
- 不写「沉淀后课程文件保留」的说明。

#### 完成

- 大 check + `课程 · 已结课` + 三格统计（沉淀 / 留在课程 / 学习跨度）+ 目标路径。
- 操作：`查看结课报告` / `进入课程` / `返回课程列表`。
- 不加「课程助手仍可对话」等说明行。

#### 报告抽屉

- 新组件 `CourseEndReportDrawer.tsx`：右侧 520px 抽屉，`MarkdownPreview` 渲染报告；顶部关闭；底部 `在编辑器中打开`。
- 复用现有抽屉动效令牌（`.kb-overlay` / 抽屉骨架），不新造过渡。

---

## 7. 结课后课程界面

文件：`src/modules/ai-teaching/index.tsx`（工作区分支），`CourseRail.tsx`、`CourseProgress.tsx`。

- `CourseState` 增 `endedAt: string | null`；`enterWs` 后 `ended = !!state.endedAt`。
- 进入已结课工作区：
  - 默认打开 **课程助手**（`openCourseAssistant` 返回已有会话；没有则懒建）。
  - 左栏 `CourseRail` 加 `readOnly`：章 / 知识点可点已学段只读查看；未学行 disabled；不显示「开新段 / 收尾本段 / 生成复习讲义」。
  - 中栏默认 `课程助手` 对话；输入框保留，走现有 assistant 发送链路。
  - 打开段 / 复习讲义 = 只读文档 / transcript；返回 chip 回课程助手。
  - 顶栏只留 `结课报告` / `重新开课`；进度 / 大纲 / 素材写入入口消失（用「不存在」表达只读，不靠 tooltip）。
  - 不写「章节与大纲只读」的横幅。
- `重新开课`：`reopenCourse` → 重新 `loadCourse` → 回到正常编辑态；报告与进度保留。
- `CourseProgress` / `CourseRail` 的 `openSegment` / `openReview` 回调在 `readOnly` 下只读打开；不触发写接口。

---

## 8. 只读与 AI 工具边界

### 8.1 业务函数守卫

新增 `assertWorkspaceEditable(wsId)`（`aiTeachingCourseEnd.ts` 导出）：

- `writeCourseOutline` / `writeOutlineFromAssistant` / `applyOutlineAdditions`
- `removeCourseUnit` / `moveCourseUnit`
- `openSegment` / `openUnit`
- `openChapterReview`（新建复习；已有 `reviews[cid].rel` 的查看仍允许）
- `endSegment` / `finalizeSegment` / `setActiveUnit` / `setUnitProgress`
- `writeChapterReviewDoc`
- `registerSources` / `assignSources` / `removeSource` / `extractSource`
- `archiveOrganizedPage` / `organizeDoc`（会话属于已结课工作区时）
- `writeConstraints`（课程 / 段 / 知识点层）/ `writeWorkspaceProfile`
- 统一抛 `课程已结课，请重新开课`；读函数不拦。

### 8.2 会话 / 工具守卫

- `assertCourseEditableBySession(sessionId)`：
  - `sessionId` → 会话行 → `parentSessionId || sessionId` → `getWorkspaceOfSession`；
  - 工作区 `endedAt` 非空 → 抛错；
  - 无工作区（自由对话）→ 放行。
- `builtinTools.aiTeachingWriteBoundaryError` 增加 `ctx` 参数：`ctx.source === 'aiTeaching'` 时先查会话所属工作区是否结课；`vault.write` / `vault.edit` / `vault.rename` / `vault.write-batch` 统一拦截。
- 工具清单加守卫（按 `builtinTools.ts` 实际工具名）：
  - `course.outline.write` / `course.outline.remove-unit`
  - `course.sources.register` / `course.sources.assign` / `course.sources.extract`
  - `course.organize.archive`
  - `course.review.write`
  - `course.constraints.write`（课程 / 段 / 知识点层；全局层不动）
  - `course.constraints.read` 放行
- `openCourseAssistant` 不拦；读取类工具（vault.read / search / quiz.list / stats）不拦。
- `buildCourseInjection` 在已结课时注入一段只读提示（prompt，不是 UI）：
  - 「本课程已结课；可以回答课程内容、复盘、二轮计划；不要调用 course.* 写工具或写文件。」
- `AgentRunner` 的写落点 hint 不变；工具层守卫兜底。

---

## 9. 知识库落点

### 9.1 目标选择

- 新 IPC `aiTeachCourse:getDepositTargets` 返回：
  ```ts
  {
    spaces: Array<{
      id: string; name: string; path: string;
      notebooks: Array<{ id: string; name: string; path: string }>
    }>
    lastTarget: { space: string; notebook: string; subfolder: string; keepChapter: boolean } | null
  }
  ```
- 渲染层只显示名称；ID/路径由主进程解析。
- 首次：`space = '考研'`（若无空间则默认第一个 / 新建），`notebook = 课程名`，`subfolder = '结课资料'`。
- 新建空间 / 笔记本：主进程 `vaultCreateCategory`；名称为空 / 非法直接禁用确认按钮（界面引导，不报长文案）。

### 9.2 `vaultCreatePage` 扩展

`phrontis-core/src/kbStore/knowledgeVaultRepo.ts`：

```ts
vaultCreatePage(data: {
  title: string
  contentMd: string
  categoryId?: string | null
  dirRel?: string | null
  fileType?: string
  tags?: string[]
  /** 额外 frontmatter（溯源用）；标准字段优先，禁止覆盖 id/title/fileType */
  extraFrontmatter?: Record<string, string | number | boolean | string[]>
}): VaultPage
```

- 在 `fm` 组装后合并 `extraFrontmatter`，过滤 `id/title/fileType/created/updated/status` 等保留键。
- 契约脚本补往返用例：extra 字段进 frontmatter、索引可见、标准字段不被覆盖。
- 这是 `phrontis-core` 变更；同步更新 `../phrontis-core` 的测试 / 版本。

### 9.3 目录结构

沉淀后：

```
{空间}/
  {笔记本}/
    结课资料/
      第3章 进程/
        复习讲义.md
        讲义·进程与线程.md
      第5章 死锁/
        ...
      （keepChapter=false 时平铺）
```

- `结课资料` 是 `folder` 类目；章子目录由 `dirRel` 写入后索引自动补分类，或主进程显式创建 `folder` 类目（取显式，避免分类类型漂移）。
- 非 md 导图 / 示意图同目录复制；索引自动识别导图 title / isMindmap。
- 不写 `SOURCES`、不复制素材。

---

## 10. IPC / preload / types

### 10.1 主进程 handler

`electron/lib/aiTeachingCourseEnd.ts` 的 `registerAiTeachingCourseEndHandlers(getSetting)`，在 `electron/main/index.ts` 注册：

```ts
aiTeachCourse:getEndState
aiTeachCourse:listEndArtifacts
aiTeachCourse:collectEndArtifacts
aiTeachCourse:getEndStaging
aiTeachCourse:depositEndArtifacts
aiTeachCourse:endCourse
aiTeachCourse:reopenCourse
aiTeachCourse:getEndReport
aiTeachCourse:getDepositTargets
```

- 全部只接受 `wsId` / `relInWs` / entry ids / target 名称；主进程组装绝对路径。
- 写成功广播：`aiTeach:course-refresh`、`aiTeach:tree-refresh`、`knowledge`（沉淀时）。

### 10.2 preload / ipc / types

- `electron/preload/index.ts`：新增同名方法。
- `src/lib/ipc.ts`：包装为 `aiTeachGetEndState` 等。
- `src/types/index.ts`：
  - `AiTeachWorkspaceInfo` 增 `endedAt` / `course`；
  - 新增 `AiTeachEndArtifact` / `AiTeachEndStagingEntry` / `AiTeachEndTarget` / `AiTeachEndState` / `AiTeachDepositResult` / `AiTeachEndReport`；
  - `ElectronAPI` 增方法。
- 不改 `windowBus` scope；复用 `aiTeach:course-refresh` / `aiTeach:tree-refresh`。

---

## 11. 边界与失败处理

| 场景 | 处理 |
|---|---|
| 工作区无 `课程.md` | 不提供结课入口；`endCourse` 返回错误 |
| 结课时有 open 段 | 允许；段保持 `open`，课程只读；报告写明「有未收尾段」；重新开课可继续 |
| `待整理` 已存在 | 收集重建：旧暂存进回收站，原件不动 |
| 沉淀部分失败 | 不结课（若尚未），保留暂存与清单，返回失败条数；重试只处理未成功条目 |
| 目标重名 | md 由 `vaultCreatePage` 自动 `(n)`；清单按 `relInWs` 幂等，不重复沉淀 |
| 知识库同名笔记本 | 复用；不新建 |
| 工作区 / 根目录改名 | 清单存工作区相对路径，读取时用当前 `workspaceFolderRel` 解析 |
| 删除工作区 | 现有语义不变：只删归属；文件夹 / 报告 / 待整理保留 |
| 重新结课 | 旧报告改名归档，新报告重写；`deposits.json` 保留 |
| 报告被用户删除 | 课程仍为已结课；预览摘要回退到「已沉淀 N 份」；`endCourse` 可重建 |
| 素材 / 题单 | 盘点层排除；工具层仍禁止写 SOURCES / 题单沉淀 |

---

## 12. 契约与验证

### 12.1 新增脚本

`.AGENT/scripts/ai-teaching/verify-course-end.mjs`：

- `summarizeCourseWorkspace`：满进度 / 部分 / 空章 / 无大纲。
- `buildArtifactInventory`：五类命中；排除 SOURCES / 交接 / 课程 / 要求 / 画像 / 测验 / 结课报告；导图 / 示意图命中。
- `renderCourseEndReport`：含完成情况、未完成章节、错题 Top、资料处置；无绝对路径。
- `sanitizeTargetSegment`：非法字符 / `..` / 超长 / 空白。
- `depositTargetRel`：保留章结构 / 平铺；重名后缀。
- `extractReportSummary`：摘要截断、无复盘段落回退。
- `deposits.json` 幂等：相同 `relInWs` 不重复。
- `endedAt` 守卫：`openSegment` / `writeCourseOutline` / `sources` 写接口拒绝；读接口放行。

### 12.2 更新脚本

- `verify-picker.mjs`：已结课分组、条目样式、`可结课` 尾部、`继续上次` 跳过已结课。
- `verify-course-mode.mjs`：新组件 / 新 IPC / 只读守卫静态接线。
- `verify-ai-teaching-tools.mjs`：结课守卫工具枚举与 `builtin.tool.request` 清单同步。
- `verify-ai-teaching` 相关脚本：`countDocs` 新口径。

### 12.3 类型 / 构建

```bash
npx tsc --noEmit -p tsconfig.node.json
npx tsc --noEmit -p tsconfig.web.json
npm run build
```

### 12.4 手工 / 探针

- 满进度课程：结课 → 49 份 → 沉淀 → 主页沉底 → 进入课程和助手对话 → 重新开课。
- 部分进度：提前结课 → 27 份 → 沉淀 → 条目 `64/140` → 课程 rail 显示部分章。
- 无产物 / 直接结课：报告「未沉淀」；完成页 `资料沉淀` 可再进。
- 目标：已有空间 / 新建空间 / 新建笔记本 / 子文件夹 / 保留章目录。
- 重复沉淀：第二次全部跳过。
- 题单：不出现候选、不复制；错题统计进报告。
- 素材：不出现候选；SOURCES 未被写。
- 改名：结课后重命名工作区 / 根目录，报告与待整理仍可读。

---

## 13. 文案与引导（硬约束）

按 AGENTS 铁律 26 与本次拍板：**不加提示性文字，界面本身做引导**。

落码时删除原型中的这些内容：

- 「结课不会删除任何文件。课程报告与资料处置记录会写进课程文件夹。」
- 「收集 = 先在课程内复制到待整理，原文件保留、章节内的链接不断……」
- 「沉淀后课程文件保留；题单与错题本不在这里处理。素材一般不放在工作区目录内……」
- 「结课后仍可对话」「章节与大纲只读」等说明行。
- 长警告段落。未完成状态只用 `64/140 · 5/10` + `提前结课` 按钮表达。

保留的文本只限：

- 数据：数量、日期、路径、文件名、进度。
- 动作：`提前结课…` / `直接结课` / `收集并继续` / `沉淀到笔记区` / `重新开课` / `继续对话`。
- 必要错误：沉淀失败条数、目标名称非法（短句，不解释背景）。
- 无障碍 `aria-label` / `title` 只用于图标按钮，不写说明性长句。

UI 引导手段：

- 步骤指示器表达流程；
- 计数 + 选中数 + 体积表达选择范围；
- `下一步` / `沉淀` 的 disabled 表达前置条件；
- 路径预览表达落点；
- 已结课分组、对勾、灰名、日期表达状态；
- 已结课工作区用「不存在的按钮」表达只读，而不是提示条。

---

## 14. 文档与发版

- 本方案：`docs/ai-teaching-course-end-plan.md`。
- 模块总纲 `docs/ai-teaching-module-rework.md` 状态速览补一条指向本文。
- `docs/ui-updates.md` 增本轮 UI 记录。
- `docs/pending-fixes.md` 如实现中发现问题按 B-xx 登记。
- 用户手册：`resources/help/AI 教学 · 课程模式.md` 增「结课 / 重新开课 / 资料沉淀 / 题单不沉淀」；按 `.AGENT/help-rewrite/README.md` 流程，跑 `.AGENT/scripts/help-kb/verify-help-retrieval.mjs`。
- 版本：`package.json` → `3.40.0`；`CHANGELOG.md` 新段；重跑 `.AGENT/scripts/release-notes/build-release-notes.mjs`（铁律 24）；`npm run pack`。
- 提交：分阶段 commit；push 等用户明确指令。

---

## 15. 实施顺序

1. **P0 纯函数 + 摘要**：`aiTeachingCourseSummary.ts`、`aiTeachingCourseEndPure.ts`、`extraFrontmatter`；契约脚本（不改 UI）。
2. **P1 状态与主进程**：`workspaces.json.endedAt`、`listWorkspaces` 摘要、盘点 / 收集 / 沉淀 / 结课 / 重开、`copyWorkspacePath`、`deposits.json`、IPC / preload / types。
3. **P2 选择页**：分组、条目、预览、提前结课入口、继续上次。
4. **P3 结课流程**：`CourseEndFlow` 三步 + 完成页 + 报告抽屉。
5. **P4 结课后界面 + 守卫**：只读 rail、助手默认、重新开课、业务函数 / AI 工具守卫、注入。
6. **P5 收尾**：契约全绿、双 tsc、build、帮助文档、CHANGELOG / release notes。

---

## 16. 已确认口径（实施按此）

1. **结课时机**：本方案采用「流程最后一步（沉淀完成或直接结课）才写 `endedAt`」，中途退出课程仍是进行中、`待整理` 可续。是否认可？另一种是第 1 步确认即结课。
2. **重新开课**：本方案是原课程续用（清 `endedAt`，保留报告与进度）。是否现在就要「第 N 轮」模型？
3. **重复沉淀**：按 `deposits.json` 的 `relInWs` 幂等跳过，不提供「保留两份」开关；需要第二份时换子文件夹。是否认可？
4. **沉淀范围**：本期只收五类（复习讲义 / 段讲义 / 总结 / 导图 / 示意图）；生图图片与 PPT 产物暂不沉淀。是否认可？
