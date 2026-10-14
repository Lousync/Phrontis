# AI 教学「课程大纲草稿」内联改造 · 方案（已定稿）

> **状态**：口径已定（2026-10-14，用户逐项拍板）→ **已落码**（2026-10-14，差异见 §8「落码记录」）。
> **原型**：`tmp/ai-outline-inline-proto/index.html` —— 顶部「改前（现状）/ 改后（内联）」分段器直接对比；点「正式生成」看落盘态；`index.html#before` 直进改前态、`#done` 直进已落盘态。
> **原型与落码的差别**：原型里卡是**靠左**贴正文的；用户看过原型后追加要求「**将大纲居中**」，落码按 §2-6 居中。原型不再回改（用户拍板「不用直接改原型了」）。
> **起因**：2026-10-14 用户截图反馈 ——「我在AI教学区发现了个问题，这个大纲不应该放在这编辑区占空间，我的本意是将他放在AI的这轮对话最好」。
> **一句话**：```outline 草稿卡从「钉在输入区的那条带子」挪进**产生它的那条助手回复**，跟着对话滚动；删「继续修改」，落盘后变「已落盘 · 课程.md + 打开课程」。

---

## 1. 现状与毛病

卡片的渲染点在 `src/modules/ai-teaching/index.tsx` 第 3487–3517 行：它是对话滚动区**外面**的一个 `shrink-0` 兄弟块，与「提问卡」(`askPending`)、「画像建议卡」同处**输入区那条带子**（`max-w-[820px] mx-auto`，所以它跟输入框左右对齐、而不跟消息对齐）。

按用户截图的 1.5 倍缩放换算（截图物理像素 → 逻辑 px）：

| 量 | 数值 |
|---|---|
| 大纲卡尺寸 / 位置 | x 422→1615、y 167→645 ⇒ **约 796 × 319** |
| 章节列表 | `max-h-[220px] overflow-auto`（内部滚动，第 3 章被截一半） |
| 输入区带子总高 | 大纲卡 319 + 提问卡 282 + 输入行/页脚 85 ≈ **677** |
| 对话区实际可用高 | 整块 719 − 带子 677 ≈ **40px（一条缝）** |

三个后果：① 常驻占掉对话区近一半高度；② 它不与对话一起滚动，AI 换一轮草稿它就无声换内容，看不出「哪轮给的」；③ 章节列表被 220px 掐着，要多滚一次才看得全。

**另一个事实**：协议围栏本来就被剥离不渲染（第 3345 行的正则含 `outline`），草稿也是从**那条消息**里解析出来的 —— 所以「内联回那一轮」在数据上是回家，不是搬家。

---

## 2. 拍板口径（2026-10-14 逐项确认）

| # | 项 | 定论 |
|---|---|---|
| 1 | 位置 | 内联在**产生它的那条回复正文之后**，跟着对话滚动；**整张卡展开**，不再是收起成一行 |
| 2 | 按钮 | **删掉「继续修改」**（它原本只是把卡从输入区关掉，挪走后就没意义了），只留「正式生成」 |
| 3 | 历史草稿 | AI 重发围栏时，**旧的不渲染、只有最新一条带卡**（与现状一致：只看最新一条助手消息） |
| 4 | 落盘后 | 头部标签「对话内 · 未落盘」→ **「已落盘 · 课程.md」**（转强调色），按钮 → **「打开课程」** |
| 5 | 提问卡 | **完全不动**（它是「等你回答」的临时态，答完即消失；常驻性的大纲卡性质不同） |
| 6 | 居中 | 卡**水平居中**（同 `max-w-[820px] mx-auto px-3`）。基准是**正文栏**：滚动容器是 `pl-4 pr-8`（右留白更大，给右缘定位条让位），所以卡的中心比输入框那条带子的中心**偏左 8px** —— 不刻意比对看不出来；哪天要动那处不对称留白，记得一起看 |

---

## 3. 选定形态

改后，输入区带子只剩提问卡 + 输入行，草稿卡落在末轮回复里：

```
对话区（可变高，跟着滚）
  ├ 用户气泡
  ├ 更早的助手轮            ← 它也发过 ```outline 围栏，按口径 3 只剥围栏、不出卡
  └ 最新助手轮
      ├ 工具摘要行（用了 3 个工具 · 总耗时 4.2s）
      ├ 正文（围栏已剥）
      ├ ┌──────────────────────────────────────┐   ← ★ 大纲草稿卡（居中，宽 820，与输入框对齐）
        │ 📖 课程大纲草稿   已落盘 · 课程.md      │
        │ 小学数学 36 讲 · 打通…                  │
        │  第1章 第一章 数与运算                  │
        │   · 万以内数的认识与数位  …（7 条，铺开） │
        │  第2章 第二章 分数与小数  🔒 未展开       │
        │  第3章 第三章 式与方程    🔒 未展开       │
        │                          [ 正式生成 ]    │
        └──────────────────────────────────────┘
      └ 操作条（整理成文档 / 复制 / 就这点追问）
输入区带子（固定）
  ├ 提问卡（不动）
  └ 输入行 + 页脚
```

视觉规格全部沿用现卡（不改配色）：`border: 1px solid color-mix(accent 40%)` + `background: var(--accent)/8` + `rounded-lg`；章条目 `border-[var(--border-color)] bg-[var(--bg-primary)]`。

**几何变化**：带子 677 → **358**（提问卡 282 + 输入行/页脚 85），对话区 40 → **约 360**（同一窗口高度下）。

**位置次序**：卡放在**操作条之前**（正文 → 工件卡 → **草稿卡** → 操作条），与正文里「工件卡」的既有次序一致。

---

## 4. 实现清单

### 4.1 `src/modules/ai-teaching/index.tsx`（主改动）

| # | 改什么 | 怎么改 |
|---|---|---|
| 1 | `outlineFence` 带出所属消息下标 | 返回 `{ raw, idx } \| null`（现在只返回 `raw` 字符串）。循环语义不变：**只看最新一条 assistant 消息**，它没有围栏就是 `null` |
| 2 | `outlineDraft` | 改读 `outlineFence.raw` |
| 3 | 落盘态换实现 | `outlineCardHidden: boolean` → `outlineDone: { fence: string; rel: string } \| null`；`outlineCommitted = outlineDone?.fence === outlineFence?.raw`。重置 effect 保持 `[outlineFence, activeId]` |
| 4 | `commitOutlineDraft` | 成功后 `setOutlineDone({ fence: outlineFence.raw, rel: r.relPath ?? '' })`（不再 `setOutlineCardHidden(true)`） |
| 5 | 卡 JSX 挪位 | 从第 3487–3517 行（输入区带子）挪进 `messages.map` 的助手分支，门条件 `idx === outlineFence?.idx && outlineDraft`，外壳 `mt-2 w-full max-w-[820px] mx-auto px-3`（居中，保留 `max-w-[820px] mx-auto px-3` 子串以免动到既有断言计数） |
| 6 | 卡内两处 | ① 头部标签二态；② 章节列表**去掉** `max-h-[220px] overflow-auto`；③ 按钮区：`outlineCommitted ? 打开课程 : 正式生成`，「继续修改」删除 |
| 7 | 「打开课程」 | `window.dispatchEvent(new CustomEvent('kb-open-note', { detail: { relPath: outlineDone.rel, from: 'aiTeaching' } }))` —— 与本模块画像 / 全局要求 / 工作区要求的「ensure 产物 → 跳编辑区打开」同一范式 |
| 8 | 清理 | `outlineCardHidden` / `setOutlineCardHidden` 全删（无残留引用） |

### 4.2 `electron/lib/aiTeachingCourse.ts`（1 行）

`writeOutlineFromAssistant` 的 **append 分支**漏了 `relPath`（create 分支有）—— 补上，否则「展开下一章」后落盘的卡拿不到路径：

```ts
const r = applyOutlineAdditions(id, additions, getSetting)
const rel = outlineRel(id, getSetting)?.rel      // + 新增
return r.ok ? { ok: true, mode: 'append', added: r.added, relPath: rel } : { ok: false, error: r.error }
```

IPC 返回类型（`src/types/index.ts`、`src/lib/ipc.ts`、preload）**本来就声明了 `relPath?`**，无需改签名。

### 4.3 契约脚本 `.AGENT/scripts/ai-teaching/verify-outline-fence.mjs`

- 改：第 34 行 `草稿卡含「继续修改 / 正式生成」` → 断言「正式生成」+「打开课程」+「已落盘」（「继续修改」已删，旧断言必然红）。
- 增：① 卡在消息分支里（`idx === outlineFence.idx`）；② 章节列表不再有 220px 内滚（负向：`!mod.includes('max-h-[220px] overflow-auto')` 针对该卡，注意图/要求卡也有同名类 —— 用带上下文的断言）；③ 卡已从输入区带子移走（负向：`outlineFence` 与 `max-w-[820px]` 不再同块相邻）；④ append 分支返回 `relPath`（`course.includes("mode: 'append', added: r.added, relPath: rel")`）。

### 4.4 文档与数据

| 文件 | 改什么 |
|---|---|
| `CHANGELOG.md` | v3.5.0 段内补一条（课程助手那组的收尾项）→ **必须重跑** `.AGENT/scripts/release-notes/build-release-notes.mjs`（铁律 24） |
| `resources/help/AI 教学 · 课程模式.md` | 第 19 行已写「先把大纲草稿放在对话里」，补一句「就挂在那条回复末尾；点『正式生成』落盘 `课程.md`，之后按钮变『打开课程』」 |
| `docs/ai-outline-inline-plan.md` | 本文件 |

---

## 5. 取舍与边界（明写，免得后面反复）

1. **「打开课程」跳编辑区，不跳课程主页。** 理由：本模块已有三个同类产物（画像 PROFILE.md / 全局与工作区 CONSTRAINTS.md）都是「ensure 落文件 → `kb-open-note` 跳编辑区」；`课程.md` 的定位是「**人读人改的唯一真相源**」（`aiTeachingCourse.ts` 第 32 行注），要能改。跳课程主页只读，反而少了改的入口。原型里演示的是跳课程主页 —— **以本节为准**。
2. **落盘态是内存态**（与现状同）：切走会话再回来会退回「未落盘」。做成持久态要拿草稿内容与磁盘 `课程.md` 对账，属于另一个量级的改动，本轮不做。
3. **只有最新一条助手消息能带卡**（口径 3）：若 AI 下一轮没发围栏（比如用户只是道谢），卡就没了。这是**现状行为**，本轮不改 —— 用户要的是「别在编辑区占地方」，不是「让卡活得更久」。
4. **卡宽封 820、且居中**：这个模块的助手正文是满栏铺开的（不像全面板那样收窄），不封宽会拉到 1100+。居中的基准是**正文栏**（滚动容器 `pl-4 pr-8` 的左右留白不等），故卡与输入框那条带子差 8px —— 没有为这 8px 加补偿位移（一处魔法常数换看不见的对齐，不划算），写在这里备案。
5. **章节列表不再内部滚动**：章多时由对话本身滚动承担。分批协议下未展开章通常只有一行，展开一章约 8 条，长度可控。
6. **提问卡不动**、画像建议卡不动 —— 它们仍在输入区带子。

---

## 6. 验收

```bash
node .AGENT/scripts/ai-teaching/verify-outline-fence.mjs      # 主契约（本轮改过）
node .AGENT/scripts/ai-teaching/verify-course-mode.mjs       # 大纲纯函数 + 死链负向断言
node .AGENT/scripts/ai-teaching/verify-ai-teaching-tools.mjs # append 通道 + 工具注册
node .AGENT/scripts/ai-teaching/verify-input-bubble.mjs      # 输入壳 820 居中（同带子）
node .AGENT/scripts/ai-teaching/verify-profile-banner.mjs    # 同带子邻居
node .AGENT/scripts/ai-teaching/verify-ask-collapse.mjs      # 同带子邻居
node .AGENT/scripts/ai-teaching/verify-profile-patch.mjs     # 断言 max-w-[820px] mx-auto px-3 计数
node .AGENT/scripts/ai-teaching/verify-side-lane-center.mjs  # 侧车（共用消息渲染）
node .AGENT/scripts/ai-teaching/verify-conversational-flow.mjs # 已知 19/1（旧账，与本轮无关）
node .AGENT/scripts/release-notes/verify-release-notes.mjs
npx tsc --noEmit -p tsconfig.node.json
npx tsc --noEmit -p tsconfig.web.json
npm run build
node .AGENT/scripts/release-notes/build-release-notes.mjs     # 铁律 24
```

真机三看：① 卡在末轮回复里、跟着滚；② 输入区只剩提问卡、对话区不再被挤成一条缝；③ 点「正式生成」→ 标签转「已落盘 · 课程.md」、按钮转「打开课程」，点它跳编辑区打开 `课程.md`。

---

## 8. 落码记录

2026-10-14 落码，与 §4 的差异只有三处（都是落码时才发现的具体情况）：

1. **重置 effect 的依赖收窄**：原计划写 `[outlineFence, activeId]`，落码改成**只依赖 `activeId`** —— `outlineFence` 是 `messages` 的 memo，消息数组一变它就换对象，会让「已落盘」在每次消息刷新时被无谓清掉。真正的守卫是 `outlineDone.fence === outlineFence.raw` 这句内容比对（草稿一变自然退回未落盘），重置只在**换会话**时做。
2. **契约脚本的负向断言换了写法**：原打算断言「旧带子外壳类名 `pb-1.5 pt-1.5` 已消失」，实测会**误伤画像建议卡**（它与旧大纲卡用的是同一串外壳类名 `shrink-0 w-full max-w-[820px] mx-auto px-3 pb-1.5 pt-1.5`）。改为锚定卡标题的精确断言：`shrink-0 w-full max-w-[820px] mx-auto px-3` 与「课程大纲草稿」不再同时出现；正向也改成 `mt-2 w-full max-w-[820px] mx-auto px-3">` 与卡标题同现。
3. **`继续修改` 的负向断言**用 `!mod.includes('>继续修改<')` 而不是裸串 —— 拍板理由写在卡块的注释里，注释里带这个词是正常的。
4. **居中的基准写清楚了**（§2-6 / §5-4）：卡的居中基准是**正文栏**，而正文栏的滚动容器是 `pl-4 pr-8`（右留白更大，给右缘定位条让位）—— 所以卡的中心比输入框那条带子偏左 8px。§4.1 原写的是「与输入框那条带子左右对齐」，实测不成立；没有加补偿位移（不留魔法常数），备案在 §5-4。

验收实测（2026-10-14）：

| 项 | 结果 |
|---|---|
| `verify-outline-fence` | **21 PASS / 0 FAIL**（原 12 条 → 加 9 条，删 1 条旧断言） |
| `verify-course-mode` | 91/91 |
| `verify-ai-teaching-tools` | 19/0 |
| `verify-input-bubble` | 70/0 |
| `verify-profile-banner` | 31/0 |
| `verify-ask-collapse` | 11/0 |
| `verify-profile-patch` | 83/83 |
| `verify-side-lane-center` | 40/0 |
| `verify-conversational-flow` | 19/1（**旧账**：`拖拽停靠走 toggleSideLaneWide`，与本轮无关） |
| `tsc --noEmit`（node / web） | 两个工程均干净 |
| `verify-release-notes` | PASS（46 版本 / 630 条目） |

**未做**：真机三看（草稿卡跟着对话滚 / 输入区只剩提问卡 / 点「正式生成」→ 已落盘 →「打开课程」跳编辑区）。这一步留给用户在自己开的窗口里过一遍。

