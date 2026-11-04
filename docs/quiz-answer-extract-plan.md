# 题单「提取答案」· 复制作答给 AI 判题

> 状态：**已落地（2026-11-03）**
> 版本：待发布（计划原写 3.17.0；实际未随该版本发布，落码时未抬版本号）
> 来源：开发负责人 2026-11-02 对话
> 关联：`docs/quiz-short-answer-answer-state-plan.md`（简答题作答与痕迹存储）
> 范围：只动题单阅读态的顶部状态条；不改答题存储、不改 `quiz` 围栏协议、不改错题本。
> 2026-11-04 扩展：AI 教学右侧工件页签（md 题单阅读态）复用同一条状态条，只保留「提取答案」；工件栏没有题单内重做视图，不渲「错题重做」。

---

## 1. 要解决的问题

题单是知识库里的 `.md`，题干、选项、参考答案都在页面正文的 ` ```quiz ` 围栏里。
用户的作答（选择题 `picked`、简答题 `text`）不在正文，而是按页存进 `.knowbase/modules/quiz/*.json`（`electron/database/repositories/quizRepo.ts`）。

于是：

- AI 读页面只能读到题面，读不到用户答了什么；
- 想让 AI 判题，用户只能手工抄一遍答案；
- 题单与答案「分离存放」本身没错（答题痕迹要跨次保留），缺的是一个**把答案取出来**的出口。

## 2. 已确认的设想

1. 题单最开头放一个「提取答案」按钮；
2. 点击后，选择题与简答题按固定格式自动复制到剪贴板；
3. 用户把复制内容直接粘给 AI 判题即可。

## 3. 入口与交互

### 3.1 位置

- 组件：`src/components/shared/QuizSheetBar.tsx`（题单状态条：已答 / 错题 / 草稿 + 错题重做）
- 宿主①：`src/modules/knowledge/components/PageEditor.tsx:2241`（阅读态、`quizzes.length > 0` 时渲染；`onReview` 给「错题重做」）
- 宿主②：`src/modules/ai-teaching/ArtifactsPane.tsx` 的 md 页签（2026-11-04；不传 `onReview`，只留计数 + 提取答案）
- 按钮放在状态条右侧；知识库宿主与「错题重做」同排（在它左边），工件栏宿主只保留提取答案。
- 图标 `ClipboardCopy`（lucide），文案「提取答案」。

### 3.2 状态与反馈

| 场景 | 行为 |
|---|---|
| 有作答 | 点击 → 组文本 → `copyText` → 成功 Toast |
| 无任何作答 | 按钮禁用，tooltip「当前还没有作答」 |
| 复制失败 | `copyText` 返回 false → 错误 Toast「复制失败」 |
| 成功 | Toast「已复制 N 题作答（选择 X · 简答 Y）」，detail「粘贴给 AI 即可判题」 |

- 动效：按钮走现有 `transition-colors`，Toast 走全局；不新增动效类。
- 剪贴板：`copyText`（`src/lib/ipc.ts:17`，主进程代理），不直连 `navigator.clipboard`（与 `src/lib/noteActions.ts:247-359` 的口径一致）。

## 4. 数据来源

| 数据 | 来源 | 用途 |
|---|---|---|
| 题号 / 题型 | `quizzes: QuizItem[]`（`src/components/shared/QuizParser.ts:18-30`） | 排序与分组 |
| 选择题作答 | `QuizRecordDto.draft.picked`（`src/types/index.ts:234-240`） | 导出 |
| 简答题作答 | `QuizRecordDto.draft.text` | 导出 |
| 已有判分 | `QuizRecordDto.lastResult` | **不导出**（避免给 AI 先入为主） |
| 正确答案 / 解析 | `QuizItem.answer` / `referenceAnswer` / `explanation` | **不导出**（题单里已有） |

- 读取：`store.getRecords()`（`src/components/shared/QuizRecordStore.tsx:140`），按 `quizNo` 建 Map；`QuizSheetBar` 已通过 `useQuizRecords(store)` 订阅，点击时取最新快照。
- 只处理当前题单；跨页 / 错题本不在本入口。

## 5. 复制格式（草案）

```text
【题单作答】《第二章 进程管理 · 自测》
请对照本题单判分，逐题给出对错与解析；简答题按要点给分。

1. [选择] B
2. [选择] 未作答
3. [简答]
进程是资源分配单位，线程是调度单位……
① ……
② ……
4. [简答] 未作答
```

规则：

- 题号升序，一题一行（简答题可多行）；
- 选择题只写选项 key；
- 简答题保留原始换行与空白，不截断；
- 未作答统一写「未作答」；
- 不写正确答案、解析、自评结果、错题次数；
- 头部一句判分指令可选（见未定项）。

## 6. 边界（v1 不做）

- 不自动判题、不调用模型；只负责复制。
- 不做「复制整卷（题面 + 答案）」。
- 不做历史快照 / 多次作答对比。
- 不做跨题单批量导出。
- 不改答题存储结构，不改出题协议。
- 全屏刷题模式（`QuizMode`）暂不加入口；后续可复用同一纯函数。

## 7. 已拍板口径（2026-11-03）

1. 头部带「请对照本题单判分，逐题给出对错与解析；简答题按要点给分」。
2. 简答题**不带题干**，保持「答案专用」。
3. 未作答的题也列出，便于 AI 提示漏答。
4. 不带自评结果，避免先入为主影响判分。
5. 按钮文案：「提取答案」。
6. 带题单标题，不带页码。

## 8. 落码清单（已落地）

- 新增 `src/components/shared/quizAnswerExportPure.ts`：`buildAnswerExport({ title, quizzes, records }) → { text, answered, choiceAnswered, shortAnswered, total }`，纯函数，契约脚本直接断言。
- 改 `src/components/shared/QuizSheetBar.tsx`：按钮 + 禁用态 + `copyText` + Toast；按钮在「错题重做」左边；`onReview` 改为可选，无重做视图的宿主只出提取答案。
- 改 `src/modules/ai-teaching/ArtifactsPane.tsx`（2026-11-04）：md 页签用 `extractQuizzes` 解析题单，渲染同一状态条。
- 契约新增 `.AGENT/scripts/quiz-tools/verify-answer-export.mjs`：32 项断言，覆盖顺序、题型、未作答、多行简答、不含答案/解析/自评、只读旧记录不冒充作答、工件栏宿主接线。
- 帮助文档 `resources/help/AI 教学 · 课程模式.md` 补「提取答案」说明。
- 未抬版本号、未改 `CHANGELOG.md` / release notes（按本轮「不升版本号」口径）。

## 9. 验收

- `npx tsc --noEmit -p tsconfig.node.json` / `tsconfig.web.json`：通过
- `node --experimental-strip-types --no-warnings .AGENT/scripts/quiz-tools/verify-answer-export.mjs`：32/32 通过（含工件栏宿主接线断言）
- 待手测：
  1. 纯选择题题单答 3 题 → 复制内容 3 条 + 其余「未作答」；
  2. 简答题多行作答 → 换行保留；
  3. 全未作答 → 按钮禁用；
  4. 粘贴到 AI 助手 → AI 能按题号对上题单并判分；
  5. 复制内容不含正确答案 / 解析 / 自评；
  6. AI 教学工件栏打开题单 md 页签 → 顶部出现同一条状态条，「提取答案」可用；不出现「错题重做」。

## 10. 备注

- 已按上述口径落码，并新增契约脚本；UI 只加一个按钮，未改答题存储与 `quiz` 围栏协议。
- 全屏刷题模式（`QuizMode`）仍未加入口；后续可复用同一个纯函数。AI 教学工件栏 md 页签已于 2026-11-04 接入。
- 若后续决定不做，按归档规则移入 DP `Phrontis/搁置功能与想法/`。
