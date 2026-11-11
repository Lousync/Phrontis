# AI 教学 · 小步引导讲课口径

> 状态：已落码（2026-11-10）
> 触发：用户反馈「AI 每次回答都回答一大段，恨不得一下就把所有知识说出来；这是解决问题的输出，不是教书育人的输出」。

## 1. 问题

旧版 `electron/lib/agentService.ts` 的 `teachStyleHint` 要求：

> 讲知识点必须展开：问题/场景 → 前置桥接 → 定义 → 直觉 → 推导（每步为什么）→ 例题 → 反例/易错 → 检查 → 最后才总结。

这条口径本意是防止讲课退化成要点总结，但它把**一个知识点的完整教学流程**压进**一条回答**，模型只能一次倒完。表现就是：

- 一条回答同时出现定义、推导、例题、总结；
- 学生还没回应上一个台阶，模型已经讲到下一步；
- 回答看起来像「解题输出 / 小讲义」，不像老师在对话里带学生。

段会话原有的「不要一次把整门课讲完」只约束了**跨知识点**的进度，没有约束**单个知识点内部**的展开节奏，所以没有拦住这个问题。

## 2. 口径

默认 `stepwise`（小步引导）：

- 一条回答只推进**一个台阶**：一个概念 / 一步推导 / 一个例子，正文约 **300–500 字**（公式、代码不计）。
- 讲完**立刻停下**，用正文一句话问一个具体、可回答的检查问题，等学生回答；不自问自答，不把下一台阶带出来。
- 答对 → 下一台阶；答错 / 卡住 → 只纠正当前这一步，换更小的例子或类比，不重讲整节。
- 禁止一条回答同时给「定义 + 推导 + 例题 + 总结」；禁止用要点列表代替推导。
- 检查问题用正文一句话；`ask` 只用于选择 / 确认，不要每个台阶都弹选择卡。
- `quiz` 快检只在讲完一个完整知识点后出，一条回答最多一道；单个台阶的检查不要用 quiz 围栏。
- 例外：学生明确说「一次讲完 / 给我完整讲义 / 整段精讲 / 快速过完整节」时才展开；展开前先说明“这会比较长”。
- 教材 / 讲义类产物仍可一次性落盘成文档，但对话里只回一句「教材已生成，先读第 X 节，读完把卡点告诉我」，不把全文贴进对话。
- 事务性回答（查资料、改文件、日程等）不受这条约束，仍按基础人设置简洁直接。
- 课程里的旧版讲课手册若与本条冲突，以本条为准；手册里的教材结构、素材纪律、出题边界仍然有效。

`expanded`（整段精讲）保留 2026-11-04 版旧口径，供需要一次性完整讲解的用户切回。

## 3. 实现

| 文件 | 作用 |
|---|---|
| `electron/lib/teachStylePrompt.ts` | 零依赖纯函数：`TeachStyleMode` / `DEFAULT_TEACH_STYLE_MODE` / `normalizeTeachStyleMode` / `buildTeachStyleHint`；两套口径文案的唯一真相源 |
| `electron/lib/agentService.ts` | `teachStyleHint = source === 'aiTeaching' ? buildTeachStyleHint(normalizeTeachStyleMode(getSettingReader()('aiTeachLectureStyle'))) : ''`；仍只对 AI 教学注入 |
| `src/lib/settings.ts` | 新增 `aiTeachLectureStyle`，默认 `stepwise`，anchor `aiTeach.lectureStyle`，`aiTab: 'teach'` |
| `src/modules/settings/views/AiTeachingView.tsx` | 设置 → AI → 教学 → 「讲课节奏」：小步引导（推荐） / 整段精讲 |
| `electron/lib/aiTeachingCourse.ts` | 段会话纪律引用 system 讲课口径；单个台阶检查用正文一句话，quiz 快检只在完整知识点后 |
| `.AGENT/scripts/ai-teaching/verify-teach-style.mjs` | 契约：纯函数真实执行 + agentService / settings / UI / 帮助文档接线 + 画图 Skill 资产 |

设置是全局的，改动下一轮生效；改设置会让 system 稳定前缀失效一次（prompt cache 失效一轮），可接受。

## 4. 为什么不用 Skill

应用内 Skill 是**按需调用的提示词包**（`electron/lib/skillService.ts`）：用户 `/` 指定或模型主动调用时，才在那一轮注入提示词；下一轮就没了。它适合「周报撰写 / 出题官」这类一次性任务，不适合「每一轮讲课都要遵守」的常驻节奏。因此本方案把规则放进 system 常驻口径，而不是做成 Skill。

## 5. 验收

```bash
node .AGENT/scripts/ai-teaching/verify-teach-style.mjs
npx tsc --noEmit -p tsconfig.node.json
npx tsc --noEmit -p tsconfig.web.json
node .AGENT/scripts/help-kb/verify-help-retrieval.mjs
npm run build
```

契约脚本会把两套口径的文案、默认值回落、设置 / UI 接线、帮助文档关键词全部锁住；改坏提示词不会静默通过。

## 6. 边界

- 不改变「教材先行」：段会话仍可生成完整教材文档，只是对话里不贴全文。
- 不改变出题协议：quiz 围栏、ask 围栏、plan 围栏的格式规则不变。
- 不改变普通 AI 助手：`source !== 'aiTeaching'` 时不注入本口径。
- 用户仍可用四层 `CONSTRAINTS.md` 或当前消息覆盖默认节奏；用户当前消息优先级最高。
- 已有课程如果在 `CONSTRAINTS.md` 里写死了旧版「八步一次展开」节奏，以课程要求为准；需要时让课程助手重写该层（或把 `tmp/ai-teaching-course-kit/CONSTRAINTS.compact.md` 的新版合并进去）。
