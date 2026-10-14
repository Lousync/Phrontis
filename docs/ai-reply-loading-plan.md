# AI 回复「生成态」改造 · 方案（已定稿）

> **状态**：口径已定（2026-10-13 第三轮拍板）→ **已落码**（2026-10-13，与 §3 的差异见 §10「落码记录」）。
> **原型**：`tmp/ai-chat-experience-proto/index.html` 第 3 节 —— 四格对照（现状 / 备选 A / 备选 B / **选定 C**），都是活的；顶部「生成态」开关切换主界面用哪一套，**默认已是 C**，点「▶ 播放这一轮」看它跑起来。
> **起因**：2026-10-13 讨论轮，用户看原型时说「这个加载中的样式我总觉得有些不舒服呢，你去学一下那些开源的或者成熟的 agent 工具的回复加载样式」。
> **检索说明**：本机 web 检索通道不通（搜索端点 401、`web_fetch` DNS 失败），**§2 的共性不是现场查文档得来的**，是从对 Claude Code / ChatGPT / Claude.ai / Cursor / Cline / VS Code Copilot 这些工具的实际观感里提炼的判据。若要引用原文口径，需先修好检索通道再补一次。

---

## 1. 现状的五个毛病（改造理由）

`StreamBubble.tsx` 是 AI 教学中栏 / 侧车 / 全局面板**三面共用**的组件，现状：

| # | 毛病 | 具体表现 |
|---|---|---|
| 1 | **框中框** | 外层是带描边 + 底色的盒子，里面又套一个带描边的「思考块」盒子 —— 与用户刚否掉的代码卡片两层框是同一类问题 |
| 2 | **同一时刻两个状态标签** | 头行写「思考中…」，下面思考块头又写一遍。用户会以为卡了两层 |
| 3 | **秒表一直跳** | 头行每 100ms 刷一次「已等待 N.Ns」，把等待焦虑做成可见的计数器 |
| 4 | **两个停止入口** | 输入区发送键已经变停止钮，状态行里再放一个 |
| 5 | **工具行像表格** | 工具名 + 等宽目标 + 右对齐 `tabular-nums` 耗时，读起来像日志表 |

---

## 2. 判据：成熟工具的 8 条共性

| # | 判据 | 谁这么做 | 本方案怎么落 |
|---|---|---|---|
| R1 | **状态是一条线，不是一个盒子** —— 框只留给「需要用户操作」的东西 | Claude Code / ChatGPT / Claude.ai / Copilot 都不给生成态画框 | 去掉外框与思考内框 |
| R2 | **同一时刻只有一个状态标签** | 全部 | 状态行唯一，思考只在完成后留一行 |
| R3 | **滑动指示优先于转圈**：转圈读作「系统忙」，滑动读作「AI 在说话」；转圈只留给「某个工具在执行」 | ChatGPT / Claude.ai / Copilot | **下滑条**（纯 `transform`）；工具转圈随工具行一起不再出现在生成中 |
| R4 | **状态字形原地替换**（spinner → ✓），高度不变、不重排 | Claude Code / Cline / Copilot | 生成中不显示工具 ⇒ 不存在换字形抖动 |
| R5 | **耗时是安静的**：不跳、不抢眼，够交代就行 | Claude.ai 的 "Thought for 8s" | 状态行里的耗时 **>3 秒才出现**、弱色、每秒一次；完成后总耗时进工具摘要行 |
| R6 | **思考内容不是二级盒子**：一行「已思考 N 秒」+ 左细线展开体 | Claude.ai / Claude Code | 沿用现状的一行折叠，但**去掉内框**，展开体改左细线 |
| R7 | **停止入口只有一个** | 全部 | 只留输入区（现状已是） |
| R8 | **工具行是事件流，不是表格** | Cline / Cursor / Claude Code | 生成中不显示；完成后收成一行摘要，展开才看清单 |

> 另一条观察：**过程在完成后会被收起来**（ChatGPT / Claude 收成一行 "Thought for Ns"）。本方案按这条把工具清单也收起来。

---

## 3. ★ 选定方案：C 极简光标 + 纯 transform 下滑条

### 3.1 生成中（`streaming` 阶段）

助手消息位置**只有两样东西**：

```
正在回答…                                     4.1s   ← 状态行：12px --text-secondary 文字（无转圈）
▬▬▬▬▬▬▬▬▬▬▬▬                                     ← 其下方 2px 轨道，里面 34% 宽的 accent 短条来回滑
时间片轮转把就绪队列当成一个环，每个进程轮流拿一个固定时间片▌   ← 流式正文 + 打字光标
```

- 状态文案沿用主进程给的 `it.label`（`正在思考…` / `正在调用 {工具名}…` / `正在回答…` / `正在等待模型响应…`），与现状同源，不新增文案。
- **不显示**：工具行、第二个停止按钮；**不画**任何边框 / 底色 / 圆角。状态行里也**不放转圈** —— 滑动本身就是指示器（R3）。
- **耗时 >3 秒**才在状态行右侧以弱色出现（短回复不闪、长回复有交代），之后**每秒刷一次**（不是现状那种 100ms 跳）。实现要点：跨过 3 秒时只重绘一次（为了插入那个元素），之后直接改它的文字 —— 否则每秒重绘会不停重启下滑条的动画。
- 下滑条规格：轨道 `height:2px` + `border-radius:1px` + `background:var(--border-color)`，`overflow:hidden`；短条 `width:34%` + `background:var(--accent)`；`@keyframes` 只动 `transform: translateX(0 → 194%)`，`1.15s ease-in-out infinite alternate`。短条与状态文字同宽（`inline-flex` 列容器，短条 `width:100%`）。
- `prefers-reduced-motion` 降级：动画停，短条铺满整条（`width:100%; transform:none`）—— 静态下仍读得出「进行中」。

### 3.2 完成后

状态行消失，依次是：

1. **思考行**（有 reasoning 且 `s.aiShowThinking !== false` 时）：一行「已思考 N 秒 ›」，点开是左细线缩进的推理文本，`max-height:72px` 尾部截断（保留现状行为）。
2. **工具摘要行**（有工具调用时）：「用了 N 个工具 · 总耗时 ›」，**默认收起、永不自动展开**。
   - 展开体：每步一行（状态点 + 工具名 + 截断目标 + 耗时），失败步用红点标出。
   - **最多列 5 步**，其余折成「还有 M 步」（模块内常量 `MAX_TOOL_STEPS_SHOWN = 5`，**不进设置项**）。
   - **0 个工具时不出现这一行**。
3. 正式回复正文。
4. 消息操作条（`actsFor`，与现状一致）。

### 3.3 其余口径

| 项 | 定论 |
|---|---|
| 实时秒表 | **>3 秒才以弱色出现在状态行右侧**（不是删除：短回复不闪、长回复有交代），之后每秒刷一次、不跳动 |
| 停止入口 | **只在输入区**（现状已是），状态行不再有 |
| 错误态 | 仍**只走 Toast**，不新增行内错误气泡；失败的工具只在展开清单里标红 |
| 兜底气泡（无流式草稿时） | 两处（`ai-teaching/index.tsx` 第 3444 行、`MessageList.tsx` 第 251 行）**一起改成同一套状态行**，否则过程中会闪一下旧样式 |
| 工具展示价值判断 | 用户明确认为「工具调用的展示对用户的体验不大」⇒ 生成中完全不显示是**有意为之**，不是遗漏 |

---

## 4. 被否掉的备选（留档）

| 备选 | 为什么没选 |
|---|---|
| **A · 单行状态 + 保留工具行**（Claude Code / Copilot 口径） | 过程可见，但工具多时会占掉一屏；与「工具展示价值不大」的判断冲突 |
| **B · 事件流 + 完成后收成一行**（Cline / Cursor 口径） | 过程感最强，但需要「步骤集合 → 收成一行 → 展开还原」的状态机；既然生成中根本不想显示工具，这套机制就是多余的 |
| **文字流光**（`background-clip:text` + 动 `background-position`） | 观感最像成熟工具，但**不在铁律 13 的 `transform` / `opacity` / `grid-rows` 清单里**。为它开一条「只跑 paint」的例外并写进 `docs/ui-animation-plan.md` 不划算 —— 下滑条能做到同等表达且零例外 |

> 「秒表 >3 秒才显示」最初是作为备选列出来的，**第三轮拍板实际采纳**，口径见 §3.1 / §3.3。

---

## 5. 落码影响面

| 位置 | 改动 |
|---|---|
| `src/components/shared/AssistantPanel/StreamBubble.tsx` | **主战场，三面共用**（AI 教学中栏第 3438 行 / 支线面板第 315 行 / 全局面板 `MessageList` 第 246 行）⇒ 改一处三面生效 |
| 同文件 · 外壳 | 去掉 `mr-6 rounded-lg bg-[var(--bg-secondary)] border` 那层；内容直接落在消息流里 |
| 同文件 · 头行 | 去掉秒表与停止按钮；阶段文案 + 下滑条合成「状态行」 |
| 同文件 · `ThinkingBlock` | 去掉内框（`rounded-md border bg-primary/50`）；保留一行折叠与 `max-height:72px` 截断 |
| 同文件 · `ProcessTimeline` | 生成中不再渲染；改为完成后的「工具摘要行 + 可展开清单」新组件 |
| `src/modules/ai-teaching/index.tsx` 第 3444 行 | 「无流式草稿时的兜底气泡」换成同一套状态行 |
| `src/components/shared/AssistantPanel/MessageList.tsx` 第 251 行 | 同上（全局面板那版兜底气泡另带停止按钮，一并去掉） |
| 输入区 | **不动** —— 停止入口本来就在那里 |

> ⚠️ 冲突：`StreamBubble.tsx` 与 `MessageList.tsx` 当前**干净**，但 `ai-teaching/index.tsx` 正被另一个对话改动，且 `index.css` 也在改（页面条溢出 F-16）。落码时序按 `docs/code-block-card-plan.md` §4 那套走：**等 `ai-teaching/index.tsx` 与 `index.css` 落库**。

---

## 6. 动效基建（**不需要给铁律 13 开例外**）

1. **下滑条**：新增工具类（建议名 `.kb-sweep`，放 `src/styles/index.css`）—— 轨道 + `::after` 短条，只动 `transform`，**完全落在铁律 13 的清单内**，按既有「补工具类」流程走即可，`docs/ui-animation-plan.md` 里补一行登记（不是例外，是新增令牌）。
2. **过程收起 / 展开**（工具摘要行、思考行）：走既有 `.kb-collapse`（`grid-rows` 过渡），不要另造高度过渡。
3. **打字光标**：沿用现状（2 × 13px accent，`animate-pulse` 等价物）。
4. 全部动画带 `prefers-reduced-motion` 兜底；下滑条降级成静态满格下划线。

---

## 7. 已定口径汇总

| 项 | 定论 |
|---|---|
| 候选 | **C 极简光标**（生成中不显示工具） |
| 指示器 | **纯 transform 下滑条**（不用文字流光，不开动效例外） |
| 工具清单阈值 | **展开体最多 5 步**，其余折成「还有 M 步」；默认收起、永不自动展开；0 工具不显示该行 |
| 秒表 | **>3 秒才以弱色出现**（不是删除：短回复不闪、长回复有交代；出现位置在状态行右侧、弱色、不跳动） |
| 停止入口 | 只在输入区 |
| 错误 | 只走 Toast |

---

## 8. 验收口径（落码时）

- 契约脚本新增断言（建议 `.AGENT/scripts/ai-reply-loading/verify-reply-loading.mjs`）：
  1. 生成态 DOM **不含** `StreamBubble` 的外框类（`rounded-lg` / `bg-[var(--bg-secondary)]` / `border`）；
  2. 同一时刻**只有一个**状态标签（`.stage-label` 计数 === 1）；
  3. 生成中**不渲染**任何工具行；
  4. 完成后**有**工具摘要行（工具数 > 0 时）且**默认收起**；展开体步数 ≤ 5，超出显示「还有 M 步」；
  5. 0 工具时**不出现**摘要行；
  6. 秒表：`<3s` 不出现、`>3s` 出现且为弱色，且刷新间隔 ≥1s（不得每 100ms 跳）；
  7. 下滑条：`animation` 只含 `transform`（不得出现 `background-position`）；`prefers-reduced-motion` 下无动画且短条铺满；
  8. 停止按钮：状态区内**零个**，输入区**一个**；
  9. 错误仍只走 Toast（DOM 里没有行内错误卡）。
- 原型基线：`tmp/ai-chat-experience-proto` 的 **11 个场景 / 647 条浏览器断言 + 60 条静态契约**（`_probe.py` / `_static_check.py`）。
- 真机三面各看一眼：AI 教学中栏、AI 教学侧车、全局助手面板（同一组件、不同宽度）。
- 类型门禁双 tsconfig；`CHANGELOG.md` 加段 + 重跑 `.AGENT/scripts/release-notes/build-release-notes.mjs`；`resources/help/` 里讲 AI 教学的篇目补一句「回答生成中只显示一条进度线」（用户可见行为变化）。

---

## 9. 与其它文档的关系

- 同一轮讨论的另一半（代码卡片）见 `docs/code-block-card-plan.md`；两份方案在 `index.css` 上有交集，落码时序见该文 §4。
- 动效令牌与工具类遵循 `docs/ui-animation-plan.md`（本方案为下滑条补一条工具类登记，**不新增例外**）。
- 「去气泡」口径见 `docs/ai-teaching-module-rework.md` 的 P3a；本条是该口径在生成态上的延续。

---

## 10. 落码记录（2026-10-13，与 §3 的口径差异都记在这里）

> 全部落码完成；契约脚本 `.AGENT/scripts/ai-reply-loading/verify-reply-loading.mjs`（46 条）全绿。

### 10.1 ★ 修正：「停止入口只在输入区」这条在两面**不成立**，必须补键

§3.3 写的是「只留输入区（现状已是）」——**这个现状判断只对 AI 教学中栏成立**。实际盘点：

| 面 | 输入区有没有停止键 | 原因 |
|---|---|---|
| AI 教学中栏 | ✅ 有 | `index.tsx` 的发送键在 `pending` 时变圆内方块（P3b 就是这么做的） |
| AI 教学侧车 | ➖ 没有，也没有中断需求 | `StreamBubble` 本来就没传 `onAbort` |
| 全局面板 / 右栏 / 整页（`ChatBody`） | ❌ **没有** | 发送键在 `pending` 时只是 `disabled` + 转圈 |
| AiLearn 两处（`ChatBody` 同族） | ❌ **没有** | 同上 |

⇒ 状态区那颗按钮一去掉，后两面会**彻底失去中断能力**。所以本轮同时给它们的输入区补上停止键
（与中栏同一套「`bg-[var(--text-primary)]` + 圆内方块」口径，`title` 也沿用
「停止生成（已完成的轮次保留）」）：

- `src/components/shared/AssistantPanel/ChatBody.tsx` —— 发送键按 `pending` 分档；
  `pending` 从发送键的禁用条件里退出（由停止键那一档接管），`compressing` 保留。
- `src/components/shared/AiLearn/index.tsx` —— `Composer` 新增可选 `onStop`；
  不传时退化成旧的「禁用 + 转圈」。两处调用点都传 `chat.onAbort`。

配套：`MessageListProps` 的 `onAbort` 随之删除（它唯一的用途就是那颗按钮），
契约脚本 `verify-input-bubble.mjs` / `verify-slash-commands.mjs` 里依赖旧文案的三条断言已同步改写
（**不是放宽**：由「不是停止键」翻成「是停止键，且四面的输入区各恰 1 个」）。

### 10.2 修正：工具摘要行的落点是**已完成消息**，不是 StreamBubble

§5 把「工具摘要行」写成 `ProcessTimeline` 的同文件改造，但 `StreamBubble` 只在 `pending` 期间挂载
（`{pending && (draft ? <StreamBubble/> : …)}`），流一结束就卸载 —— 摘要行放它里面根本看不见。
真正对应「完成后」的是**已完成消息的渲染面**，而那里本来各有一个「调用轨迹（N 步）」入口：

| 文件 | 原入口 | 改后 |
|---|---|---|
| `src/components/shared/AssistantPanel/MessageList.tsx` | 消息下方的 `TraceBlock`（虚线框） | `<ToolSummary rows={traceRows(m.trace)} />`，放在正文**之前** |
| `src/modules/ai-teaching/index.tsx` | 操作条里的 `调用轨迹（N 步）` `<details>` | 同上 |

⇒ 新建 `src/components/shared/AssistantPanel/ToolSummary.tsx`（`ToolStepView` 归一化行视图 +
摘要行 + `.kb-collapse` 展开体）。两处各有一个薄的 `traceRows()` 适配器（工具名可读化各面本就不同）。
「用了 N 个工具」只数工具行；LLM 行以「思考」保留在展开体里 —— **不丢信息**，
旧 `TraceBlock` 展示的 tokens 在操作条的 `TokensOf` 里本来就有。
**同一个信息不再有两个入口**（旧的两处已删）。

### 10.3 修正：思考行进行中也说「已思考 N 秒」

原 `ThinkingBlock` 在进行中显示「思考中…」，而状态行此刻正好也在说「正在思考…」
⇒ 就是 §1 毛病 2 换了个地方复发。改后思考行**始终**是「已思考 N 秒」（进行中 = 活计数器，
`Math.max(1, …)` 兜底），状态行独占阶段文案。契约脚本有一条正向断言锁这件事
（`StreamBubble` 全文「思考中…」恰 1 处）。

### 10.4 补齐：兜底气泡其实有**三**处

§3.3 只列了两处，`src/modules/ai-teaching/SideLanePanel.tsx` 还有一处
（`<Loader2 … />思考中…`，连气泡都不是）。三处统一成同一套 `.kb-gen-row` + `.kb-stage` + `.kb-sweep`。

### 10.5 未做 / 记一笔

- **`AiLearn` 的 `Loader2` 转圈分支保留**：`onStop` 不传时仍是旧行为，作为回退路径。
- **历史消息里的「思考行」不做**：reasoning 文本从不落库（只有流式期间在 `draft.thinking` 里），
  所以「完成后」的思考行只可能是刚生成那一轮 —— 现有行为即如此，本轮没改这条数据流。
- 真机三面各看一眼这条**待办**（`npm run dev` 下人工过一遍），见 §8。
