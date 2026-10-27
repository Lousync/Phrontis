# AI 教学简化 · 3.14.0 实现方案

> 状态：已确认（2026-10-27）· P0–P3 已落码 · P4 清理 / 文档 / 契约收尾中
> 分支：`feature/v3.14.0`（由 `main` 创建；`fix/optimize-v3.13.2` 已合并进 `main` 并删除）
> 交互原型：[`tmp/ai-teaching-simplify-proto/index.html`](../tmp/ai-teaching-simplify-proto/index.html)
> 取代：`docs/ai-teaching-course-mode-plan.md`（3.5.0 课程化计划，保留为历史记录）
> 本文只描述 3.14.0 的落码方案；原型里未定的视觉细节不进入本文。

---

## 0. 一句话

课程 = 工作区；**章 → 知识点**两层；**一段对话覆盖同章多个知识点**；素材收敛成**一份 `sources.json`**；**每段开课前确认**（默认按目录/文件名缩窄，匹配失败回退整章）；**章末复习在本章知识点全部学完后解锁**。

---

## 1. 范围

### 1.1 保留

- 工作区 = 课程；`课程.md` 仍是人读人改的大纲真相源。
- 课程助手（整门课一个会话，负责建课 / 登记素材 / 分章 / 改大纲）。
- 段（segment）：一条会话 + 一个产物夹，覆盖同章 1..N 个知识点；段末生成交接。
- 章末复习：每章一个独立会话；本章学完才解锁；生成的《复习讲义》落章目录。
- 工件分栏 `ArtifactsPane`（讲义 / 总结 / 测验 / 示意图 / 导图 / 图片）。
- 右栏：进度 / 素材 / 支线；支线只留「引用到主线」「浮出」，**删除升格**。
- 题库 / 测验 / 错题本；收藏；资源管理器；斜杠指令；`/生图`、`/mindmap`。
- `CONSTRAINTS.md` 分层要求（全局 / 工作区 / 知识点 / 本段）；考纲、老师统一要求写这里，**不算素材**。

### 1.2 删除

- 4 个场景模板（跟我学 / 深度研读 / 周复盘 / 画像诊断）与「准备态」整块。
- 零散对话分组、新建会话菜单、会话列表（左栏不再以会话为行）。
- 学习流画布（`FlowCanvas`）与「对话 / 学习流」中栏切换。
- 课时生命周期：`openUnit` 自动续课 / 多课时 / 结束课时 / 知识点收尾 / 总结篇 / 收尾自测。
- 右栏「层级」页签（`ScopeDetail`）。
- 快捷胶囊（`继续 / 考我一道 / 换个例子 / 为什么` 整排）。
- 支线「升格为正式会话」（`promoteSideLane` 链路）。
- 课程级全局素材组；不再有「本课素材」这种跨章共享层。
- 每课时的「准备面板 / 素材 / 会话要求 / 首条消息」四件套。

### 1.3 不做（本期）

- 不做掌握度阈值 / 自动掌握度判定；复习解锁只看「学完」，不看分数。
- 不做跨章段（一段只属于一章）。
- 不做同一章多个进行中的段（同一章同时只允许一个 open 段）。
- 不做旧零散会话的 UI 入口（数据保留，界面不再列出）。

---

## 2. 最终交互

### 2.1 左栏（课程树）

从上到下：

1. **课程助手**一行（固定）。
2. **搜索框**：按章名 / 知识点名过滤；命中时自动展开对应章；点结果定位到该知识点。
3. **章手风琴**：
   - 章头：章名 + `已学 x / y` + 当前段标记；
   - 知识点行：状态点（未学 / 本段进行中 / 已学）+ 名称；进行中的段内知识点带「本段」小徽章；
   - 章末复习行：`章末复习` + `还差 N 个` / `已解锁` / `已生成讲义`，排在最后一个知识点之后，**不参与 x/y 计数**；
   - 默认只展开当前章；点章头切换；搜索命中强制展开。
4. **收藏**（保留）。
5. **资源管理器**（保留）。

点知识点的行为：

- 该知识点在**当前 open 段**里 → 设为当前聚焦知识点（不新建会话），滚动到该消息锚点。
- 该知识点**已学**且属于某个已结束段 → 打开那个段（只读续看）。
- 该知识点**未学 / 不在当前段**：
  - 当前章没有 open 段 → 打开开段预检；
  - 当前章已有 open 段 → 提示「本章还有一段没收尾，先收尾再开新段」。

### 2.2 中栏（段 / 复习 / 助手）

段视图：

- 顶部面包屑：`工作区 / 第 N 章`；`本段 · 3.1–3.3`；右侧 `收尾本段` / `分栏` / `进度`。
- 细进度条：本章 `已学 x / y`；段内 `第 k / m 个知识点`。
- 知识点胶囊条：本段 `unitIds` 逐个列出；当前聚焦的高亮；点击切换 `activeUnitId`。
- 上一段交接条（可折叠；来自同章上一段的 `交接.md`）。
- 本段素材条（只列**本段确认**的素材；可展开看标题 / 区间 / 提取稿路径）。
- 对话流：沿用现有消息 / 流式 / 工具过程 / 引用 / 斜杠 / 出题卡。
- 输入区：不再有准备面板、模板、快捷胶囊；`收尾本段` 在输入区上方或顶栏（原型在顶栏）。

复习视图：

- 面包屑：`工作区 / 第 N 章 / 章末复习`；右侧 `生成复习讲义`（已生成时变 `查看讲义`）。
- 本章知识点清单（只读，含已学状态）+ 各段交接入口。
- 本章素材条（章级分配，不是段快照）。
- 对话流；生成讲义后右侧工件分栏自动打开 `复习讲义.md`。

助手视图：

- 无大纲时就是课程助手对话 + 「还没有课程」引导卡；不再有课程主页 / 学习流。
- 有 `outline` 围栏草稿时显示草稿卡与「正式生成」。
- 课程助手负责登记素材、给出**全量**大纲、按章分配素材；不负责逐知识点开讲。

### 2.3 开段预检（新）

触发：点未学知识点 / 段收尾后点「下一段」/ 章头的「开始本章」。

预检内容（中栏整页，不是弹窗）：

1. **本段知识点**：本章未学知识点复选；默认从被点的知识点开始，连续选最多 3 个；已学知识点灰显不可选。
2. **本段素材**：列出本章分配的所有素材；每条显示 `标题 · 区间` 与匹配标记：
   - `精确`：文件名 / 标题能逐知识点对上；
   - `缩窄`：能按目录 / 文件名 / 标题缩到一段，但不是逐知识点；
   - `整章`：匹配失败，回退到本章分配区间；
   - `未分配`：本章没有任何素材覆盖。
3. **回退规则**：默认走 B（按目录 / 文件名 / 标题缩窄）；匹配不到自动回退 A（整章分配）。界面只展示结果，不要求用户再做一次模式选择；用户可取消勾选某条素材。
4. **上一段交接**：折叠预览（同章上一段）。
5. 按钮：`开始本段`（无知识点时禁用）/ `取消`。
6. 若本章 0 条素材：黄色提示「本章还没有分配素材，本段只能按大纲讲」；允许开始。
7. 若选中的知识点里有未匹配到素材的：提示「N 个知识点没有匹配到素材，将按大纲讲」。

确认后：

- 调 `openSegment(wsId, unitIds, sources)`；
- `sources` 是**本段快照**（sourceId + 收窄后的 anchor + 匹配模式），写进 `progress.json` 的段记录；
- 后续改本章分配**不影响已开的段**（下一段才生效）。

### 2.4 右栏

三个页签：

- **进度**：章手风琴；每章 `x/y`；段列表（`第 N 段 · 3.1–3.3`、进行中 / 已收尾、交接链接）；章末复习行（锁定 / 已解锁 / 已生成讲义）。点段打开该段；点复习行按解锁状态打开或提示。
- **素材**：
  - `本段`：当前段快照（只读；点开看提取稿 / 原件）；
  - `本章`：本章分配（可改区间、取消分配）；
  - `未分配`：注册了但没分到任何章的素材（可分配到本章 / 让助手分配）；
  - 顶部 `+ 登记素材`（文件 / 目录 / URL；复用现有 PDF / 视觉转写 / 网页抓取子流程）；
  - 不再有「本课 / 工作区 / 对话私有 / 上收」这些层。
- **支线**：保留列表 / 引用到主线 / 浮出；**删除升格按钮与相关文案**。

### 2.5 进度与解锁口径（已定）

- 知识点「学完」= 所在段已收尾（`finished=true`），**不看掌握度**。
- 章末复习：
  - 本章所有知识点都学完 → `已解锁`；
  - 有讲义 `rel` → `已生成讲义`（历史讲义始终可打开，即使后来回炉了某个知识点）；
  - 否则 `锁定 · 还差 N 个`。
- 复习行不计入 `x/y`。
- 进度面板按 A 方案：**顶栏细进度 + 右栏「进度」页签**；不做整页进度画布。

---

## 3. 数据模型

### 3.1 `课程.md`：章增加稳定 ID

现状：章没有 ID，`parseCourseMd` 按位置生成 `c1..`；章一重排，`progress.json` 的 `reviews` 和新的素材分配就会错位。

改为（向后兼容）：

```md
# 课程：408 操作系统
- 目标: 三轮过完
- 依据: 考研 408 考纲

## [c1] 第一章 计算机概述
- u1 | 总线与接口 | 理解三类总线 | 教材 §1.1
- u2 | I/O 编址方式 | 区分独立/统一编址 | 教材 §1.2

## [c2] 第二章 进程
- u3 | 进程与线程 | 状态转换 | 教材 §2.1
```

- `parseCourseMd`：`^#{2,6}\s+(?:\[([A-Za-z0-9_-]+)\]\s*)?(.+)$`；无 `[id]` 的旧文件按位置生成 `c1..`。
- `rewriteCourseMd`：始终写 `[id]`；已有 ID 原样保留。
- `writeCourseOutline` 写盘前做一次 **章 ID 重映射**：按章名把旧 `reviews` / 素材分配搬到新 ID；找不到同名章的旧数据保留在 JSON 里但不显示（不静默删）。
- 知识点 ID（`uN`）本来就在文件里，保持稳定；拖拽重排继续用 `moveUnitInOutline`，不动 ID 与进度。

### 3.2 `progress.json`：v1 → v2

位置不变：`.knowbase/modules/aiTeaching/progress.json`。

```jsonc
{
  "v": 2,
  "workspaces": {
    "<wsId>": {
      "lessons": {
        "<sessionId>": {
          "unitIds": ["u1", "u2", "u3"],
          "activeUnitId": "u2",
          "order": 1,
          "status": "open",
          "sources": [
            {
              "sourceId": "s_...",
              "label": "第 1 章 概述",
              "anchor": { "kind": "headings", "from": "1.1", "to": "1.3" },
              "mode": "narrow"
            }
          ],
          "handoffRel": null,
          "startedAt": "2026-10-27T10:00:00.000Z",
          "endedAt": null
        }
      },
      "units": {
        "u1": { "status": "mastered", "mastery": 0, "lastCheckedAt": null, "finished": true, "summaryRel": null }
      },
      "reviews": {
        "c1": { "sessionId": "...", "rel": "AI教学/OS/1·计算机概述/复习讲义.md" }
      },
      "assistantSessionId": "..."
    }
  }
}
```

字段口径：

- `lessons` 键名保留（历史名，语义 = 段）；新增 `unitIds`、`activeUnitId`、`sources`、`handoffRel`、`startedAt`、`endedAt`。
- `unitId`（单数）只读兼容；迁移后不再写。
- `kind`（精讲 / 习题…）不再使用；段标题只按 `order` + 首末知识点生成。旧字段留着不读。
- `enabled` 不再作为开关：有 `课程.md` 就是课程；课程助手在没有大纲时也可用。P1 的 `getState` 仍返回 `enabled: true` 兼容旧 UI，P4 删除该字段。
- `sourceBaseline` 删除（只写不读的历史快照）。
- `units[].finished` 是「学完」的唯一判据；`status` 仍写 `todo / learning / mastered`，`check / review` 只读兼容。
- `mastery` 保留字段但不再驱动解锁 / 进度文案；暂不删除，避免旧工具报错。
- `reviews` 仍按章 ID；章 ID 稳定后不再错位。

迁移：

- `normalizeProgressFile(f)`（纯函数，放 `electron/lib/aiTeachingCoursePure.ts` 或新 `src/lib/aiTeachingProgressPure.ts`）：
  - `sessions`（旧 `sessionId → unitId`）→ `lessons`；
  - `lessons[sid].unitId` → `unitIds: [unitId]`、`activeUnitId: unitId`；
  - 补 `sources: []`、`startedAt`（用会话创建时间或当前时间）、`handoffRel: null`；
  - 对每个 unit：若 `finished` 缺省，但存在覆盖它的 `ended` 段 → 置 `true`（兼容旧课时）；
  - 删除 `enabled` / `sourceBaseline`。
- `readProgressFile` 只做内存归一化；下一次 `persist` 写 `v:2`。
- 首次迁移前把原文件复制为 `.knowbase/modules/aiTeaching/progress.v1.bak.json`（只一次）；`writeJson` 原子写。
- 迁移幂等：已 `v:2` 不再动；`unitId` 已不存在时按 `unitIds` 处理。

### 3.3 `sources.json`：单文件素材登记 + 章级分配

位置：`.knowbase/modules/aiTeaching/sources.json`（与 `progress.json` 同目录，按 wsId 分组；一个仓库一份）。

```jsonc
{
  "v": 1,
  "workspaces": {
    "<wsId>": {
      "migratedAt": "2026-10-27T...",
      "sources": [
        {
          "id": "s_01J...",
          "title": "操作系统概念",
          "type": "pdf",
          "rel": "AI教学/OS/SOURCES/操作系统概念.pdf",
          "extractRel": "AI教学/OS/SOURCES/操作系统概念-p45-72.md",
          "anchor": { "kind": "pages", "from": 1, "to": 320 },
          "status": "ready",
          "index": [
            { "label": "第 1 章 概述", "anchor": { "kind": "pages", "from": 1, "to": 24 } },
            { "label": "第 2 章 进程", "anchor": { "kind": "pages", "from": 25, "to": 58 } }
          ],
          "indexUpdatedAt": "2026-10-27T...",
          "note": "",
          "createdAt": "2026-10-27T..."
        }
      ],
      "assignments": {
        "c1": [
          {
            "sourceId": "s_01J...",
            "label": "第 1 章 概述",
            "anchor": { "kind": "pages", "from": 1, "to": 24 },
            "addedAt": "2026-10-27T..."
          }
        ]
      }
    }
  }
}
```

类型：

```ts
type SourceAnchor =
  | { kind: 'whole' }
  | { kind: 'pages'; from: number; to: number }        // PDF / PPTX
  | { kind: 'headings'; from: string; to?: string }    // md 标题路径（含首尾）
  | { kind: 'files'; paths: string[] }                 // 目录素材内、仓库相对路径
  | { kind: 'lines'; from: number; to: number }        // code

interface SourceEntry {
  id: string
  title: string
  type: 'md' | 'dir' | 'pdf' | 'pptx' | 'docx' | 'image' | 'url' | 'code' | 'other'
  /** 仓库相对路径；URL 素材为 url；禁止绝对路径 */
  rel?: string
  url?: string
  extractRel?: string | null
  anchor: SourceAnchor
  status: 'ready' | 'needs-extract' | 'error'
  index?: Array<{ label: string; anchor: SourceAnchor }>
  note?: string
  createdAt: string
}

interface ChapterAssignment {
  sourceId: string
  /** 本章内的短标签，如「第 3 章 进程」 */
  label: string
  /** 本章的范围；整章=whole / 页码 / 标题区间 / 文件子集 */
  anchor: SourceAnchor
  addedAt: string
}

interface SegmentSource {
  sourceId: string
  label: string
  /** 预检收窄后的实际区间 */
  anchor: SourceAnchor
  mode: 'exact' | 'narrow' | 'fallback'
}
```

口径：

- **一份素材文件可以分配给多个章**，每章一条 `ChapterAssignment`，各自带自己的 anchor。
- **素材登记与分配分离**：登记只登记文件；分配是章级计划；开段确认是段级快照。
- **不复制文件**：分配只是引用。仓库外的文件在登记时复制进 `{工作区}/SOURCES/`（沿用现有「已入库」路径）；新素材不再鼓励「仅引用绝对路径」——`sources.json` 不存绝对路径，保证换电脑可用。
- `index` 是匹配用的轻量索引（md 的标题、目录的文件名、PDF 的章节/页码），最多 200 条/素材；不存正文。
- `status`：`ready` = 有可读正文或提取稿；`needs-extract` = PDF/PPTX/图片还没提取；`error` = 文件丢失/读失败。
- 删除素材 = 只删登记与分配，不删原文件；若段快照引用了它，段仍可显示标题，但注入会提示「素材已移除」。

### 3.4 文件夹落点

保持现有树，不搬用户文件：

```
<vault>/AI教学/<工作区>/
  课程.md
  CONSTRAINTS.md                    # 课程级要求
  SOURCES/                         # 素材原件 / 提取稿 / 索引（旧 SOURCE.md 保留只读）
  <章号>·<章名>/                    # 章目录
    复习讲义.md
    CONSTRAINTS.md                 # 可选：章级要求（本层未启用，不注入；要整章生效就写工作区层）
    <章号>·<知识点>/                # 知识点目录
      CONSTRAINTS.md
      <段1>/                        # 段产物夹（挂在段内第一个知识点下）
        交接.md
        outputs/
        visuals/
        mindmaps/
```

- 段文件夹 = **段内第一个知识点目录**下的 `段N`；这样多知识点段不会把文件拆到多个知识点夹，也不需要搬旧 `课时N` 夹。
- 旧 `课时N·类型` 夹原样保留；旧段按 `lessonFolderRel` 兼容读取。
- 课程助手仍是 `{工作区}/课程助手`；复习仍是 `{工作区}/{章号}·{章名}`。

### 3.5 纯函数（先写、先测）

新增/调整以下零依赖文件，契约脚本直接 import：

| 文件 | 内容 |
|---|---|
| `src/lib/aiTeachingProgressPure.ts` | `normalizeProgressFile`、`unitLearned`、`chapterLearned`、`reviewState`、`prevSegmentOf` |
| `src/lib/aiTeachingSourcesPure.ts` | `SourceAnchor` / `SourceEntry` / `ChapterAssignment` / `SegmentSource` 类型、`anchorLabel`、`matchPreflight`、`defaultUnitSelection`、`renderSourcesHint` |
| `src/modules/ai-teaching/courseRail.ts` | `buildCourseRail`（章 → 知识点 → 复习状态；搜索过滤；不再有会话行） |
| `electron/lib/aiTeachingCoursePure.ts` | `课程.md` 章 ID 解析/重写；`mergeOutlineAdditions` / `moveUnitInOutline` 保留 |

`matchPreflight` 的输入是 `sources + assignments + 章 + 选中的 unitIds`，输出：

```ts
interface PreflightCandidate {
  sourceId: string
  title: string
  label: string
  anchor: SourceAnchor          // 收窄后的建议区间
  mode: 'exact' | 'narrow' | 'fallback'
  matchedUnitIds: string[]
  reason: string
}
```

匹配规则（B → A）：

1. 用 `source.index` 的 `label` 与 unit 名做归一化包含匹配（中文去空格/标点，英文小写；最短 2 字）。
2. `files`：命中的文件名集合 → `exact`（逐知识点都有）/ `narrow`（只命中一部分）。
3. `headings`：命中的标题取首尾 → 收窄区间；全命中 `exact`，部分命中 `narrow`。
4. `pages`：没有文字可匹配 → 直接用本章分配 anchor，`fallback`。
5. 一条都没命中 → `fallback`，anchor = 本章分配 anchor。
6. 完全没分配 → 不产生候选，由 UI 标「未分配」。

---

## 4. 迁移

### 4.1 `progress.json`

- 读 v1 → 归一化成 v2（见 §3.2）；首次写盘前备份 `progress.v1.bak.json`。
- 旧 `sessions` → `lessons` 的迁移保留现有逻辑。
- 旧课时（单 unit）→ 单知识点段；`unitIds = [unitId]`；`sources = []`；`handoffRel` 按旧 `交接.md` 路径补。
- 旧 `reviews` 原样保留；章 ID 重映射按章名做。
- 旧 `enabled` / `sourceBaseline` 丢弃；不写回。

### 4.2 `SOURCE.md` → `sources.json`

一次性、懒迁移（第一次 `getSources` / `getCourseState` 时）：

1. 读工作区级 `SOURCES/SOURCE.md`（`parseSourceMd`）。
2. 读每个知识点级 `SOURCES/{章号}·{知识点}/SOURCE.md`；按知识点 → 章映射。
3. 读旧课时级 `SOURCES/{会话夹}/SOURCE.md`；按 `lessons[sessionId]` 的 unitIds → 章映射。
4. 按 `rel/url + title` 去重合并；同一素材多处登记 → 合并为一条，分配取并集。
5. `path` 处理：
   - `./文件名` → 相对该 SOURCE.md 所在目录解析成仓库相对路径；
   - 仓库内相对路径 → 原样；
   - URL → `url` 字段；
   - 绝对路径 → 在仓库内则转相对；在仓库外则复制进 `{工作区}/SOURCES/`，复制失败标 `status:'error'` 并保留 `note` 说明，不阻断其他条目。
6. `extracted` 指针 → `extractRel`；`range` → `anchor: pages`；否则 `whole`。
7. 章级分配：来自知识点/课时 SOURCE.md 的条目 → 对应章；工作区级条目 → 未分配（等助手/用户分配）。
8. 写 `sources.json`，`migratedAt` 打标；原 `SOURCE.md` **不删不改**。
9. 幂等：`sources.json` 已存在 → 跳过；若手动删除后重建，按同一规则再跑一次。

### 4.3 旧会话 / 旧课时 / 已升格支线

- 旧课时会话保留在 `lessons`（单 unit 段），左栏按「已学知识点」归到对应段；点已学知识点可打开旧段。
- 旧零散会话（不属于 assistant / review / lesson）**不再出现在左栏**；数据保留在 `.knowbase/agent/`，不删。
- 已升格的支线（`lane:'main'` + `parentSessionId`）不再有「支线」行；数据保留，不删。
- 迁移不主动改 `agentSessionRepo` 的 `lane` 字段；只是 UI 不再展示升格入口。

### 4.4 回滚

- 数据层：`progress.v1.bak.json` + `SOURCE.md` 保留；把 `progress.json` 换回备份即可回到 3.13.2 的进度（但 3.14.0 新建的段会丢，属预期）。
- `sources.json` 是新增文件，删除即可回到旧素材库；旧 UI 仍读 SOURCE.md（如果回滚到 3.13.2）。
- 代码层：3.14.0 分支独立；`main` 保持 3.13.2 合并后的状态。

---

## 5. 主进程改造

### 5.1 `electron/lib/aiTeachingCourse.ts`

**新增**

- `openSegment(wsId, unitIds, sources, getSetting)`：
  - 校验 unitIds 非空、去重、全部存在、同章；
  - 本章已有 open 段：若 unitIds 是该段的子集/相等 → 返回该段；否则拒绝「本章还有未收尾的段」；
  - 新段 `order = 本章 max(order)+1`；`activeUnitId = unitIds[0]`；`status:'open'`；`sources` 快照；`startedAt`；
  - 对每个 unit：`finished=false`、`status='learning'`（回炉）；
  - 建会话 `createAgentSession('第N章·段M', 'aiTeaching')` + `assignSession`；
  - 标题可带首末知识点名：`第N章 段M · 3.1–3.3`；
  - `broadcastCourse(wsId)`；返回 `{ok, sessionId, order}`。
- `setActiveUnit(sessionId, unitId)`：校验 unit 在段内、段 open；写 `activeUnitId`；广播。
- `endSegment(sessionId)`：
  - 置 `status:'ended'`、`endedAt`；
  - 对本段所有 unit：`finished=true`、`status='mastered'`、`lastCheckedAt=now`；
  - 广播；返回 `{wsId, unitIds}`。
- `finalizeSegment(sessionId, getSetting)`：
  - 取整段 transcript（现 `transcriptOf`）；
  - 生成四段式交接（沿用现有 prompt，但说「交给下一段」）；
  - 写段目录 `交接.md`；写 `handoffRel`；空段跳过；
  - 广播。
- `readPrevHandoff(sessionId, getSetting)`：
  - 找当前段；在同章找 `order` 小于它的最近一段；
  - 优先读 `handoffRel`，否则读该段文件夹 `交接.md`；
  - 返回最多 4000 字。
- `chapterLearned(wsId, chapterId, getSetting)`：从 `progress` + `lessons` 判定；供 `openChapterReview` 用。
- `sourceSummary(wsId)`：给 `CourseState` 的计数（总数 / 已分配 / 未分配 / 每章数量）。

**改写**

- `getCourseState`：P1 保留 `enabled: true` 兼容旧 UI，P4 去掉；加 `sourceCounts`；`lessons` 归一化；`reviews` 不变。
- `openChapterReview`：创建前检查 `chapterLearned`；不满足返回 `{ok:false, error:'本章还有 N 个知识点没学完'}`；已有 `rel` 的历史讲义不受限（允许打开查看）。
- `buildCourseInjection`：
  - 助手分支：全量大纲 + 进度 + **素材登记摘要**（总数/未分配/各章数量）；不再说「先只给第一章」；明确「建课流程 = 登记全部素材 → 全量大纲 → 按章分配 → 等用户开段」。
  - 复习分支：本章 unit 状态 + 各段交接 + 章级素材清单；不引入新知识点。
  - 教师分支：**必须有段**；无段返回 `''`（修掉「无课时也注入按知识点推进」的漏洞）；注入 `unitIds` / `activeUnitId` / 本段素材快照 / 上一段交接 / 进度；不再注入「当前课时 课时N·kind」和「本知识点内上一节」。
  - 删除 `enabled` 早退。
- `lessonFolderRel`：新段用第一个 unit 的目录 + `段{order}`；旧 `课时N` 段按旧路径兼容。
- `readCourseOutline` / `writeCourseOutline`：章 ID 稳定化 + `reviews` / 分配重映射。
- `setUnitProgress`：保留给手动/旧工具；不再被新 UI 调用；写 `finished` 时同步广播。
- `endLesson` / `finalizeLesson` / `openUnit` / `finishUnit` / `makeUnitQuiz` / `courseFinishUnit` / `courseReopenUnit`：新 UI 不再调用；P4 删除（P1~P3 保留兼容）。
- `writeChapterReviewDoc`：保留；返回 relPath；供复习讲义落盘。

### 5.2 `electron/lib/aiTeachingCoursePure.ts`

- `parseCourseMd` / `rewriteCourseMd` 支持 `[cN]` 章 ID；补往返用例。
- 新增 `normalizeProgressFile`（或从 `src/lib` 引）与 `chapterIdRemap` helper。
- `sourceSnapshot` / `sourceKey` 保留但不再写 `sourceBaseline`；可标 deprecated。

### 5.3 新文件 `electron/lib/aiTeachingSourceRegistry.ts`

负责：

- `ensureSources(wsId, getSetting)`：懒迁移 + 读 `sources.json`；
- `getSources(wsId)`：返回 sources + assignments（给素材页 / 预检）；
- `registerSources(wsId, items)`：类型识别、复制外部文件到 `{工作区}/SOURCES/`、建 index、写 `sources.json`、广播；
- `assignSources(wsId, chapterId, items)`：校验章与素材；写章级分配；
- `removeSource(wsId, sourceId)`：只删登记 + 分配；
- `extractSource(wsId, sourceId, anchor)`：复用 `extractRange` 的 PDF / PPTX / 视觉 / 网页能力，把结果写 `extractRel`；
- `buildSourceIndex(wsId, sourceId)`：md 标题 / 目录文件名 / PDF 页 / URL 抓取目录；
- `buildSourcesHint(sessionId, getSetting)`：按角色（助手 / 段 / 复习 / 旧会话）返回注入串；
- `getSourceSummary(wsId)`：计数。

约束：

- 只走 `jsonStore.writeJson` / `readJson`，不直接写 `.knowbase` 白名单（铁律 1/2）。
- 不存绝对路径；外部文件先复制。
- `sources.json` 写入后 `broadcastCourse(wsId)`；文件树变化时 `broadcastTreeRefresh`。
- 注册工具/UI 都走同一业务函数，避免两套逻辑。

### 5.4 `electron/lib/aiTeachingSources.ts`（收缩）

保留：

- `parseSourceMd`（仅迁移与旧 UI 兼容）、`SourceEntry`（旧类型）；
- `extractRange`、`readSourceBytes`、`transcribeVision`、`webProbeSource`、`webCrawlSource`、`webCrawlCancel`；
- `writeInventoryIndex` / `listDirFilesRecursive` / `resolveMaterialAbs` / `parseRange`；
- `unitSourceFileRel` 等旧路径 helper（兼容）。

删除/停用：

- `layout` / `SourcesScope` / 分层合并读 / `readSources` / `addSource` / `removeSource` / `readScopedSources` / `addScopedSource` / `promoteSessionSources` / `resolveSourcesForInjection`；
- 对应的 `aiTeachSrc:read/add/remove/extract/readScoped/addScoped/promote` handler（P4 删除；P1~P3 保留旧 handler 供旧 UI 回退）。
- 新注册表不复用 `SOURCE.md` 的 `layout`，避免两套作用域。

### 5.5 注入（`electron/lib/agentService.ts`）

- `sourcesHint` 改为 `buildSourcesHint(sessionId, getSettingReader())`：
  - 助手：登记摘要（不贴正文）；
  - 段：只列本段快照（标题 / 路径 / anchor / 提取稿）；最多 4000 字；
  - 复习：章级分配 + 交接路径；最多 3000 字；
  - 旧会话（无 `unitIds` 的旧课时）：P1~P3 回退旧合并素材，保证旧 UI/旧会话可用；P4 删除旧路径后为空。新段永远只读快照。
- `scopeRuleHint` 改口径：素材范围 = 本段确认 + 本章已分配；不要扫 `SOURCES/` 未确认文件；用户明确点名才扩大。
- `writeScopeHint`：段落点 = 第一个知识点下的 `段N/`；复习 = 章目录；助手 = `课程助手/`。
- 删除 `resolveSourcesForInjection` import。
- `courseHint` 调用 `buildCourseInjection`，逻辑见 §5.1。
- 其余注入顺序不变（要求、画像、收藏、标题规则、quiz、outline、ask 等）。

### 5.6 AI 工具（`electron/lib/builtinTools.ts`）

新增（全部 `requires:'write'`、`tier:'ondemand'`、schema ≤800 字符）：

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `course.sources.register` | 批量登记素材（文件/目录/URL），返回 id 与类型；不分配 | `items: [{path, title?, type?}]` |
| `course.sources.assign` | 把素材分配到章（可带区间） | `chapter`、`items: [{source, label?, anchor?}]` |
| `course.sources.extract` | 提取 PDF/PPTX 页码区间成 md | `source`、`from`、`to` |

- 工具描述不罗列返回字段；`course.sources.register` 说明「外部文件会复制进 SOURCES，仓库内文件只引用」。
- `course.outline.write` 描述去掉「先只给第一章」，改成「全量章→知识点；每段开讲前由用户确认」。
- `inventory` 保留（目录清点）；`course.review.write` 保留。
- 更新 `electron/lib/builtinTools.ts` 里 `builtin.tool.request` 的 description 工具清单（铁律 18）。
- 更新 `.AGENT/scripts/ai-teaching/verify-ai-teaching-tools.mjs` 的工具枚举与 schema 长度断言。

### 5.7 IPC / preload / types

新增：

- `aiTeachCourse:openSegment(wsId, unitIds, sources)`
- `aiTeachCourse:setActiveUnit(sessionId, unitId)`
- `aiTeachCourse:endSegment(sessionId)`
- `aiTeachCourse:finalizeSegment(sessionId)`
- `aiTeachCourse:getSources(wsId)`
- `aiTeachCourse:registerSources(wsId, items)`
- `aiTeachCourse:assignSources(wsId, chapterId, items)`
- `aiTeachCourse:extractSource(wsId, sourceId, anchor)`
- `aiTeachCourse:removeSource(wsId, sourceId)`

删除（P4）：

- `aiTeachCourse:setEnabled`（P4；P1~P3 保留 no-op 兼容旧 UI）、`openUnit`、`endLesson`、`finalizeLesson`、`finishUnit`、`makeUnitQuiz`、`setUnitProgress`（若新 UI 不再用）。
- `agent:promoteSideLane` + `aiTeachPromoteSideLane`（升格链路）。
- 旧 `aiTeachSrc:read/add/remove/extract/readScoped/addScoped/promote`（保留 `pick/pickDir/visionCheck/sofficeProbe/pdfBytes/transcribe/webProbe/webCrawl/webCancel`，改成按 `wsId/sourceId`）。

同步：

- `electron/preload/index.ts` 的 ElectronAPI；
- `src/types/index.ts`：`AiTeachLessonInfo` 加 `unitIds/activeUnitId/sources/handoffRel`；`AiTeachCourseState` P1 保留 `enabled`（恒 true）、P4 删除；加 `sourceCounts`；新增 `AiTeachSource` / `AiTeachSourceAnchor` / `AiTeachChapterAssignment` / `AiTeachSegmentSource` / `AiTeachSourcesPayload`；
- `src/lib/ipc.ts` 包装；
- `windowBus` 不需要新 scope：继续用 `aiTeach:course-refresh` + `aiTeach:tree-refresh`；素材页监听 `course-refresh`。

### 5.8 文件夹 / 要求

- `aiTeachingFolders.ts`：新增 `segmentFolderRel(sessionId)`（第一个 unit + `段N`）；`resolveWriteOwnerRel` / `ensureWriteOwnerFolder` 对段返回新路径；旧 `lessonFolderRel` 保留兼容。
- `scopePrompt.ts`：`lesson` 层标题由「课时要求」改为「本段要求」；四层顺序与上限不变；`CONSTRAINTS.md` 位置不变。
- 删除右栏「层级」页签后，提供 `RequirementsDrawer`：
  - 入口：课程助手顶部 `要求`、开段预检底部 `本段要求`、右栏进度章头 `要求`；
  - 内容：全局 / 本课程 / 本知识点 / 本段四层；显示文件相对路径；编辑走现有 `aiTeachReadConstraints` / `aiTeachWriteConstraints`；
  - 章层仍不启用；考纲 / 老师统一要求写「本课程」层。
- 新建段时若 `段N/CONSTRAINTS.md` 不存在：不主动创建；用户从抽屉点「新建本段要求」才创建（与知识点层一致）。

---

## 6. 渲染层改造

### 6.1 `src/modules/ai-teaching/index.tsx`：保留外壳，换掉课程路由

保留：

- 会话加载 / 消息渲染 / 流式 / 工具过程 / 引用 / 斜杠 / 模型与 effort / 用量 / 收藏 / 资源管理器 / 支线 / 工件栏 / 工作区选择页 / 工作区 switcher。
- `openSession` 的会话切换、消息刷新、工件恢复。
- `sendText` / `doSend` / `agentChat` 调用链。

替换：

- 状态：
  - 删 `midView`、`prepStarted`、`prepTemplate`、`prepSrcOpen`、`prepReqOpen`、`prepNavSeq`、`showNewMenu`、`leftNewMenu`、`looseOpen`、`flowScope`、`flowChapter`、`scopeCounts`、`finishQuiz`、`courseLessonStatus`（改 `segmentStatus`）。
  - 加 `activeSegmentSid`、`activeUnitId`、`preflight`（`{chapterId, unitIds, sourcePicks}` 或 `null`）、`activeChapterId`、`railTab`（`'progress' | 'sources' | 'lanes'`）。
- 左栏：
  - 用 `buildCourseRail` 取代 `buildRailTree`；
  - 删除 `TEMPLATES`、模板渲染、新建会话菜单、「零散对话」组、课时行、复习课会话行、已升格支线缩进；
  - 增加搜索框、章手风琴、知识点行、章末复习行；
  - 保留收藏 / 文件树。
- 中栏：
  - 删除 `courseEnabled && midView === 'course'` 的 `CourseHome` 渲染；
  - 无大纲：助手对话 + 「还没有课程」引导；
  - 有段：段头部 + 知识点胶囊 + 交接条 + 素材条 + 对话；
  - 预检：中栏整页（`Preflight.tsx`），对话输入隐藏；
  - 复习：复习头部 + 本章信息 + 对话；`生成复习讲义` 发一条提示，AI 调 `course.review.write`；
  - 删除「对话 / 学习流」chip、准备面板 JSX（约 3093-3100 / 3466-3531 一带）、`ScopeDetail` 渲染（约 3923）、快捷胶囊（约 3819-3825）。
- 右栏：
  - `railTab` 默认 `progress`；`ScopeDetail` 删除；
  - 进度：`CourseProgress.tsx`；
  - 素材：`CourseSources.tsx`；
  - 支线：`SideLaneCenter` 不变，去掉 `onPromote`。
- 课程动作：
  - `courseOpenUnit` → `startSegment`（调 `openSegment`）；
  - `courseEndLesson` → `endSegment` + `finalizeSegment`；
  - `courseOpenChapterReview`：先查 `reviewState`；锁定 → toast；解锁 → 打开；
  - 删除 `courseFinishUnit` / `startFinishQuiz` / `courseReopenUnit` / `courseLessonList`；
  - `promoteLane` / `onPromote` 删除；
  - `openSession` 去掉准备态分支；切会话清空段上下文/预检；
  - `prevHandoff` 按新 `readPrevHandoff`；
  - 发送完成后 `reloadCourse()`；若复习会话的 `reviews[cid].rel` 从无到有 → `openArtFile(rel)`；
  - 顶栏「进度」调 `openRail('progress')`；「分栏」不再需要手动开，工件栏内容驱动（保留现有 `ArtifactsPane` 的开合逻辑）。

### 6.2 新组件

| 组件 | 职责 |
|---|---|
| `src/modules/ai-teaching/CourseRail.tsx` | 课程树 + 搜索 + 章折叠 + 复习行；纯展示，数据来自 `buildCourseRail` |
| `src/modules/ai-teaching/Preflight.tsx` | 开段预检整页；知识点复选 + 素材勾选 + 匹配徽章 + 交接预览 |
| `src/modules/ai-teaching/CourseProgress.tsx` | 右栏进度页签；章折叠 + 段列表 + 复习行 |
| `src/modules/ai-teaching/CourseSources.tsx` | 右栏素材页签；本段 / 本章 / 未分配；登记 / 分配 / 提取入口 |
| `src/modules/ai-teaching/SegmentHeader.tsx` | 段面包屑 + 进度 + 知识点胶囊 + 交接条 + 素材条（可拆小组件） |
| `src/modules/ai-teaching/RequirementsDrawer.tsx` | 四层要求抽屉（从 `ScopeDetail` 抽出编辑区） |

`CourseSources` 复用现有能力：

- `WebSourceDialog`、`srcForm`、`visionBusy`、`pdfBytes`、`transcribe`、`webProbe/webCrawl`；
- 去掉 `srcFilter` / `srcCompact` / `groupClosed` / `srcAnon` 这些分层/紧凑控件；
- 新增 `+ 登记素材`（文件 / 目录 / URL）与 `提取`（按 anchor）；
- 行内显示 `ready / needs-extract / error`；`needs-extract` 行给「提取」按钮；
- 不再显示 `SOURCE.md` 路径、层标签、上收按钮。

### 6.3 删除的渲染层文件

- `src/modules/ai-teaching/CourseMode.tsx`
- `src/modules/ai-teaching/flow/FlowCanvas.tsx`
- `src/modules/ai-teaching/flow/flowLayout.ts`
- `src/modules/ai-teaching/flow/flowStatus.ts`
- `src/modules/ai-teaching/ScopeDetail.tsx`（编辑区抽到 `RequirementsDrawer` 后删）
- `src/modules/ai-teaching/prepPolicy.ts`
- `src/modules/ai-teaching/UnitQuizModal.tsx`
- `src/modules/ai-teaching/leftRailTree.ts`（替换为 `courseRail.ts`；旧契约脚本同步改）

### 6.4 布局 / 动效

- 模块根 `h-full`，不要 `flex-1`（铁律 11）；中栏 / 右栏滚动区 `min-h-0`。
- 章手风琴用 `.kb-collapse`（外层 grid 常驻、内层懒挂）；新行进入用 `.kb-item-in`；预检/复习切换用 `.kb-view-in`；不要自造 `transition-all`。
- 长章（> 60 个知识点）或搜索结果 > 50 行时，知识点行加 `.kb-cv-sm`；普通 12 行章不加。
- 工件分栏打开时，顶栏隐藏细进度条（原型已验）；右栏可折叠，保证 1440 宽下中栏仍有可用宽度。
- 删除快捷胶囊后，输入区高度不跳；`收尾本段` 用现有 ghost 按钮令牌。

---

## 7. 契约与验证

### 7.1 新增 / 改写脚本（实际落地）

| 脚本 | 覆盖 |
|---|---|
| `.AGENT/scripts/ai-teaching/verify-course-segments.mjs` | progress v1→v2 迁移 + 幂等、章 ID 解析/重写、复习解锁、开段预检 B→A、默认选点、课程树搜索 |
| `.AGENT/scripts/ai-teaching/verify-course-mode.mjs`（重写） | 3.14 静态接线：新组件 / 段 API / 素材注册表 / 注入 / 工具 / 旧模型下线 |
| `.AGENT/scripts/ai-teaching/verify-ai-teaching-tools.mjs`（改写） | 新工具枚举、`builtin.tool.request` 清单同步 |
| `.AGENT/scripts/ai-teaching/verify-scope-injection.mjs`（改写） | 最细层文案「本段要求」；四层顺序不变 |

### 7.2 删除 / 更新

- `verify-conversational-flow.mjs` / `verify-docx-range-entry.mjs` / `verify-flow-layout.mjs` / `verify-left-rail-tree.mjs` / `verify-prep-started.mjs` / `verify-sources-workspace.mjs` / `verify-sticky-bottom.mjs`：删除（对应旧模型 / 旧表单 / 旧滚动契约已退役）。
- `verify-rail-bottom-stick.mjs`：左栏分区头 `会话` → `课程`。
- `verify-side-lane-center.mjs`：删升格断言，保留引用 / 浮出。
- `verify-input-bubble.mjs`：同步新版自适应 rows + 升格按钮已删。
- `verify-inventory.mjs`：子文件夹排序改为码点序（跨平台确定）。

### 7.3 类型 / 构建

```bash
npx tsc --noEmit -p tsconfig.node.json
npx tsc --noEmit -p tsconfig.web.json
npm run build
```

### 7.4 手工 / 探针

- 新建工作区 → 助手登记 3 份素材（md 目录 / 单 md / PDF）→ 全量大纲 → 按章分配。
- 点未学知识点 → 预检显示精确 / 缩窄 / 回退 → 开始 3 个知识点的段 → 对话 → 收尾 → 交接。
- 本章最后一段收尾 → 复习行从「还差 N 个」变「已解锁」→ 打开复习 → 生成讲义 → 工件栏打开。
- 再开一个已学知识点 → 段回炉 → 复习行状态符合「有讲义仍可看」。
- 120 知识点演示仓库：搜索、定位、只展开当前章、右栏进度折叠。
- 旧仓库迁移：`progress.json` / SOURCE.md 三层 / 旧课时 / 旧复习 / 旧零散会话不崩。
- 可选 CDP 探针：`.AGENT/scripts/ai-teaching/probe-segment-flow.mjs`（开段 / 收尾 / 复习解锁截图）。

---

## 8. 实施顺序

按提交切分，避免中间态不可构建：

1. **P0 数据与纯函数**（不改 UI 行为）
   - 章 ID、`progress` v2 归一化、`sources.json` 类型、`matchPreflight`、`chapterLearned`、`buildCourseRail`；
   - 新契约脚本；旧 UI 仍跑旧路径。
2. **P1 主进程新增（并行）**
   - `openSegment` / `setActiveUnit` / `endSegment` / `finalizeSegment` / 新素材注册表 / 新工具 / 新 IPC；
   - 旧 IPC 保留；`buildCourseInjection` 对旧课时保持旧行为，对含 `unitIds` 的新段走新分支。
3. **P2 渲染层切换**
   - 左栏课程树、预检、段视图、复习、进度页；
   - 切到新 IPC；删除模板/准备态/学习流/快捷胶囊/升格。
4. **P3 素材 UI 切换**
   - `CourseSources` 替代旧素材面板；SOURCE.md 入口下线；旧 `aiTeachSrc:*` 分层 handler 下线。
5. **P4 清理**
   - 删除旧函数 / 旧组件 / 旧脚本；更新 help 与 docs；双 tsc / build / 契约全绿。

建议提交粒度：每个 P 一个 commit，P4 单独一个 docs/cleanup commit。

---

## 9. 风险与取舍

| 风险 | 处理 |
|---|---|
| 迁移丢进度 | 先备份 `progress.v1.bak.json`；归一化只加字段不删数据；`finished` 只在有 ended 段时补 |
| 章 ID 重排错位 | `课程.md` 写稳定章 ID；写盘前按章名重映射 `reviews` / 分配；找不到的旧数据保留不显示 |
| B 匹配误判 | 预检显示每条来源的「精确/缩窄/整章」与命中知识点；默认选择可取消；匹配失败回退 A，不静默 |
| 素材太多导致上下文爆炸 | 段只注入快照元数据（≤4k）；正文由 AI 按路径读；索引最多 200 条/素材 |
| 旧零散会话不可达 | 数据保留在 `.knowbase/agent/`；界面不列出；这是「删除零散对话」的直接代价，需用户确认 |
| 无 per-unit 总结 / 收尾自测 | 只保留段交接 + 章末复习；题库/测验/错题本仍在；需用户确认这是预期简化 |
| 旧复习讲义在未学完章节 | `reviews[cid].rel` 存在时始终可打开（历史产物）；新建复习仍要求学完 |
| 右栏 + 工件栏挤窄中栏 | 保留右栏折叠；分栏打开时隐藏细进度；不新增固定宽度 |
| `sources.json` 体积 | 只存索引，不存正文；`getSources` 按需加载，`getState` 只带计数 |

---

## 10. 需要你确认的取舍

1. **章 ID 写法**：`课程.md` 章行改成 `## [c3] 第 3 章 进程`（旧文件自动补 ID）。如果不接受改文件格式，就退回「按章名做分配键」，代价是章改名要手动重链。
2. **删除知识点收尾 / 总结篇 / 收尾自测**：新模型只保留「段收尾 → 交接」和「章末复习 → 复习讲义」。题库 / 测验 / 错题本不受影响。确认这是预期简化。
3. **旧零散会话 / 已升格支线**：数据保留但界面不再有入口。确认可以接受；如果不能，需要额外做「历史会话（只读）」入口，属于本期范围外。
4. **进度面板按 A 实现**：顶栏细进度 + 右栏「进度」页签（§2.5）。如果选 B（只放左栏）或 C（中栏整页列表），只改这一处。

> 以上四条确认后，按 §8 的 P0 开始落码；未确认前不改代码。
