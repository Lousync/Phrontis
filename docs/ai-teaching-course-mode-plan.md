# 「AI教学」课程化重构 · 计划（3.5.0）

> 状态：计划稿（随讨论滚动更新）。创建：2026-09-30 · 目标版本：3.5.0
> 来源：2026-09-30 讨论轮（用户：「AI 教学区现在看来其实本质还是 AI 问答」；焦点＝**跨会话连续性 / 练习检验太弱 / 缺教学指令入口**；范围＝**重构成「课程化」体验**）。
> 取代：`docs/ai-teaching-interactivity-plan.md`（其第一批「教法+chip」、第二批「划词动词条」并入本计划的「上课」体验，见 §六；其余第三批工件回传不在本轮）。
> 模块总纲（P0~P8 实施记录）：`docs/ai-teaching-module-rework.md`。
> 交互原型：`docs/prototypes/ai-teaching-course-mode.html`（单文件，浏览器直接打开）。

## ★ 状态速览（每次更新文档时刷新）

| 类别 | 内容 |
|---|---|
| ✅ 已拍板 | 课程模式＝**工作区可选开启** · **知识点与会话解耦** · 存储＝**md + JSON 混合** · 掌握度＝**练习驱动 + AI 建议（需确认）** · 课程模式进工作区**首屏＝课程主页** · 大纲来源＝**建课时可选**（锚定考纲/目录 · 已有素材 · 锚定+补充 · 无来源自由生成）· 大纲**两级（章→知识点）、粒度可调** · 大纲**可演进**（AI 只提议、确认才写入） |
| ⏳ 待拍板 | 掌握度阈值公式 · 会话↔知识点关联（显式选 / AI 判定）· 覆盖度报告的触发时机（生成时 / 每次打开）· 存量工作区懒升级 · 是否纳入「教法选择」· 划词动词条是否入 3.5.0 |
| 🛠 已落码（分支 `AIteachingplus`） | 主进程 `aiTeachingCourse.ts` + `aiTeachingCoursePure.ts`、IPC 四件套、`agentService` 注入 `courseHint`、`CourseMode.tsx`、`index.tsx` 挂载（覆盖层 + 课程入口 + chip + 检验写回）；契约 `verify-course-mode.mjs` 36/36 绿；双 tsconfig 零错误。**未落**：划词动词条、覆盖度自检 UI、AI 提议增补卡 |
| 📐 原型 | 课程主页 / 上课（chip + 划词）/ 检验闭环 / 建课向导 四视图 |

---

## 一、根因诊断（为什么像「传统问答」）

1. **系统提示词里没有「教师」**：`electron/lib/agentService.ts:440` 的 `SYSTEM_PROMPT_BASE` 是通用助手人设，`quiz/plan/ask` 三段规则（`agentService.ts:675-685`）只定义输出格式协议，不定义教学行为 ⇒ AI 默认「有问必答、一次答全」。
2. **流程推进靠 AI 自觉**：「跟我学」模板 rule 写了「每步停下互动」，但 plan 围栏只是展示层。
3. **用户侧发起通道只有打字**：划词「问 AI」（`src/modules/ai-teaching/index.tsx:704`）只把选区收进引用胶囊，不发送、无教学意图。
4. **没有跨会话的学习状态**：会话是孤立问答单元，工作区只是文档文件夹；画像/错题本存在，但不驱动「下一步学什么」。

⇒ 本轮从第 3、4 条切入（用户所选焦点），把「工作区＝文档文件夹」升级为「工作区＝有教学状态的课程」。

## 二、核心概念

- **课程（Course）** = 一个**开启了课程模式的工作区**。未开启的工作区维持现状自由问答，二者共存。
- **知识点 / 学习单元（Unit）** = 课程大纲上的有序条目，带目标与掌握度。**掌握度挂在知识点上，不挂在会话上。**
- **一节课（Lesson）** = 一次会话，可覆盖 0..N 个知识点，也可以是纯自由提问。

## 二·五、大纲可信度机制（回应「AI 给的度不可控」）

用户疑问：**不敢保证 AI 生成的课程大纲正好是自己需要的**。设计原则：**大纲不是 AI 的一次性产物（合同），而是「有据可依 + 粒度可调 + 可对账 + 可演进」的活文档。**

| 机制 | 做法 |
|---|---|
| **来源锚定** | 建课时选依据：官方考纲/教材目录 · 已有 `SOURCES/` 素材 · 锚定+补充 · 无来源。锚定态下 AI **只做结构化、不发明**；每条知识点标出处（`考纲 §2.2` / `课件 p12` / `AI 补充`），AI 补充项显著标记 |
| **两级 + 粒度可调** | 大纲＝「章 → 知识点」两级；先出章级（粗），用到某章再展开其下知识点（细）—— 不逼用户一开始定死「度」；章可折叠 |
| **覆盖度自检** | 生成后 AI 对照来源逐条核对：列出**已覆盖 / 漏掉的来源条目 / AI 自行补充的条目**；漏的可一键补、补的可一键删 —— 用户审的是**差异**，不是从头核对 |
| **可演进** | 学习中 AI 发现缺漏只**提议增补**（复用画像建议卡心智），用户确认才写入；大纲随时可手动增删/重排/改来源 |

## 三、数据模型（md + JSON 混合，靠稳定 id 关联）

**大纲（人读人改，程序解析）** `AI教学/{工作区}/课程.md` —— 与 `SOURCE.md` / `CONSTRAINTS.md` 同款「md + 固定字段行」：

```markdown
# 课程：408 操作系统
- 目标: 三轮过完，重点虚存与调度
- 依据: 考研 408 考纲

## 二、进程与处理器
- id: u2 | 名称: 进程与线程 | 来源: 考纲 §2.1
- id: u3 | 名称: 调度算法   | 来源: 考纲 §2.2
- id: u4 | 名称: 同步与互斥 | 来源: 考纲 §2.3
```

**进度（机器维护，原子写）** `.knowbase/modules/aiTeaching/progress.json` —— 与现有 `workspaces.json` 同目录（`electron/lib/aiTeachingWorkspaces.ts:41`）：

```json
{ "<workspaceId>": { "units": [
  { "id": "u1", "status": "mastered", "mastery": 0.92, "lastCheckedAt": "…", "evidence": ["…"] }
] } }
```

- `status` 枚举：`todo` 未开始 / `learning` 学习中 / `check` 待检验 / `mastered` 已掌握 / `review` 待复习。
- 知识点 `id` 稳定，md 与 JSON 靠它关联；课程模式开关与工作区元数据同放 `workspaces.json`。

## 四、体验闭环（loop）

```
建课 ──→ 课程主页 ──→ 上课 ──→ 检验 ──→ 写回 ──→ 注入下一轮 ──→ 回主页
 (wizard)  (单元列表)   (会话+chip) (QuizMode) (progress.json) (agentService)
```

1. **建课**：工作区开启课程模式 → 选**大纲依据**（锚定/素材/混合/自由）+ 填目标 → AI 按依据生成**两级大纲** → 出**覆盖度报告** → 用户对照差异增删/补漏 → 写 `课程.md` + 初始化 `progress.json`。
2. **课程主页**：章节（可折叠）+ 知识点（状态标签 + 掌握度条 + 来源标注）+ 总进度 +「继续学习」+ AI 提议增补卡（可演进）。
3. **上课**：点知识点开课（复用现有准备态 `src/modules/ai-teaching/index.tsx:3077`），会话标注本课覆盖的知识点。
4. **检验**：知识点级「检验」→ 复用 `src/components/shared/QuizMode.tsx` → 判分。
5. **写回**：结果进 `progress.json`，错题进现有错题本（`quizRepo`）；低于阈值 → `review`。
6. **注入**：`agentService` 每轮把「本课知识点 + 该点掌握度 + 课程目标」拼进 `electron/lib/agentService.ts:756` 的 `systemFull`。
7. **入口 chip / 划词动词条**：上课态输入区上方常驻意图 chip；划词追加教学动词条。

## 五、涉及文件（预估）

| 位置 | 改动 |
|---|---|
| `src/modules/ai-teaching/index.tsx` | 课程主页覆盖层挂载、开课绑定知识点、输入区 chip、检验结果写回 |
| `src/modules/ai-teaching/CourseMode.tsx`（新） | 课程主页 + 建课向导（三态：未开启/无大纲/有大纲） |
| `electron/lib/aiTeachingCoursePure.ts`（新） | `课程.md` 解析/重写 + 模型 JSON 解析（**零依赖纯函数**，供契约脚本 import） |
| `electron/lib/aiTeachingCourse.ts`（新） | 课程模式开关 + 大纲读写 + `progress.json` 读写 + AI 生成大纲 + 课程注入构造 + IPC |
| `electron/lib/agentService.ts` | 注入 `courseHint`（课程/知识点/掌握度）到 `systemFull` |
| `src/lib/assistantContext.ts` + 划词浮条 | 划词动词条可选 `verbs` 字段（并入计划稿第二批；**尚未落码**） |
| `src/components/shared/QuizMode.tsx` / `quizRepo` | 检验复用 + 结果写回（不重造轮子） |

## 六、与旧计划稿的关系

`docs/ai-teaching-interactivity-plan.md` 的三批并入如下：
- **第一批（教法选择 + 快捷意图 chip）** → 并入本计划「上课」体验；chip 已入原型，教法是否纳入待拍板。
- **第二批（划词动词条）** → 并入本计划第 7 步；已入原型。
- **第三批（工件回传 / 开放作答卡）** → **不在本轮**，保留在原稿待议。

## 七、分阶段实施（草案，待确认）

- **C0 数据与开关**：课程模式开关（`workspaces.json`）+ `课程.md` 解析 + `progress.json` 读写；纯主进程 + 纯函数，先补契约脚本。
- **C1 课程主页**：单元列表 / 状态 / 掌握度 /「继续学习」；进课程首屏切主页。
- **C2 上课挂接 + 注入**：开课关联知识点；`agentService` 注入课程上下文；输入区 chip。
- **C3 检验闭环**：单元级检验 → QuizMode → 写回 progress + 错题回流。
- **C4 建课向导**：依据选择（锚定/素材/混合/自由）→ 两级大纲生成 → 覆盖度自检与补漏 → 确认落盘；AI 提议增补卡（可演进）。
- **C5（可选）划词动词条**：`assistantContext` 加 `verbs`。

依赖：C0 → C1 → C2 → C3；C4 依赖 C0；C5 独立。

## 八、验收门禁（实施时）

- 类型门禁双 tsconfig（`npx tsc --noEmit -p tsconfig.node.json` / `tsconfig.web.json`）零新增；
- `课程.md` 解析/重写、`progress.json` 读写补独立契约脚本 `.AGENT/scripts/ai-teaching/verify-course-mode.mjs`（纯函数真实实现 + IPC 四件套静态断言）；
- 真机验收：建课 → 主页 → 上课 → 检验 → 进度变化 → 重进主页已同步；
- AI 工具成本复查 `.AGENT/scripts/ai-tools-audit/`（课程上下文走注入，不新增工具 schema）；
- 收尾提醒同步 `resources/help/` AI 教学相关篇目（课程模式为用户可见行为变更）。

## 九、更新记录

| 日期 | 更新内容 |
|---|---|
| 2026-09-30 · R1 | 建课程化计划稿：根因诊断、核心概念、md+JSON 数据模型、闭环、分阶段 C0~C5；产出原型 `docs/prototypes/ai-teaching-course-mode.html`；并入旧稿第一批/第二批 |
| 2026-09-30 · R2 | 回应「AI 给的度不可控」：加 §二·五 大纲可信度机制（来源锚定 / 两级粒度可调 / 覆盖度自检 / 可演进）；数据模型加两级与「来源」字段；原型升 v2（建课向导加依据选择 + 覆盖度报告 + 来源标注 + 章折叠 + AI 提议增补卡） |
| 2026-09-30 · R3 | **首版落码**（分支 `AIteachingplus`，基于 `feature/v3.4.0`）：`aiTeachingCoursePure.ts` + `aiTeachingCourse.ts`（大纲/进度/开关/生成/注入 + IPC 六件）、IPC 四件套接线、`agentService` 注入 `courseHint`、`CourseMode.tsx`（课程主页 + 建课向导）、`index.tsx` 挂载（覆盖层 + 课程入口 + chip + 检验写回）、契约脚本 `verify-course-mode.mjs`（36 断言全绿）、双 tsconfig 零错误。**未含**：划词动词条、覆盖度自检报告 UI、AI 提议增补卡（原型有、实机未落） |
| 2026-09-30 · R4 | 修「四模式生成大纲总报错」：① `parseOutlineJson` 改**配对平衡扫描 + 候选从后往前取**（思考型模型 qwen3.8-flash 的推理片段含零散 `{}`，旧「首个 `{` 到末个 `}`」会跨段截断）；② 生成时传**当前对话模型**（`effModel`），并加「第一个启用供应商」兜底（无需 `defaultChatModel`）；③ 失败时错误信息附**模型原文片段**便于定位；契约脚本补 3 条思考噪声用例（39/39） |
| 2026-09-30 · R5 | 生成改**流式 + 过程反馈**（修「非流式久等无反馈/挂起」）：新增 IPC `aiTeachCourse:generateOutlineStream` + 广播通道 `aiTeach:course-gen-progress`，主进程用 `invokeLlmStreamInternal`（含首字节/空闲超时）逐段回传 `request/reasoning/answer/parsing/done/failed`；建课向导新增**过程面板**（实时打印模型输出 + 当前阶段 + 模型名 + 失败原因），填掉原空白区；契约 43/43 |
| 2026-09-30 · R6 | **定位拍板并落地**：课程模式＝**工作区主界面**（不再是盖在会话上的浮层）。开启后：左栏「会话」区换成**「课程大纲」树**（章/知识点 + 状态点，点即上课，资源管理器保留）；中栏在**「课程主页 ⇄ 上课」**间切换（顶栏分段器）；未开启的工作区顶栏显示**「开启课程模式」**入口。去掉原全屏浮层与含糊的「课程」按钮。顺带修 chip 泄漏（`courseUnit && activeId === courseLessonSid` 双重把关，切工作区/会话即隐）。契约 43/43，双 tsconfig 零错误 |
| 2026-09-30 · R7 | 交互微调：生成过程面板**完成后自动收起**（标题栏可点开重看，显示「查看输出（N 字）」）；左栏**「课程大纲」分区可折叠**（`collapsedSec.courseOutline`，与资源管理器同机制） |
