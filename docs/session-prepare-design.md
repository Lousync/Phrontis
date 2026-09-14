# 会话「准备态」实现方案（v3.1.2 · 条目 1 + 条目 7 合并）

> 状态：**待确认 → 已确认，进入编码**
> 合并来源：`更新计划/v3.1.2.md` 条目 1（模板预填输入框）+ 条目 7（会话准备态）
> 原型：`tmp/session-prepare-proto/index.html`（v2，准备面板固定占据输入区）
> 日期：2026-09-14

---

## 一、需求（志岩确认口径）

| # | 决策 | 结论 |
|---|---|---|
| 1 | 粒度 | 直接做**完整版「会话准备态」**（条目 1 并入，不做轻量版过渡） |
| 2 | 诊断场景 | 与其余场景**完全一致**：进准备态、预填首条消息、不自动发 |
| 3 | 切走切回 | 还原到**切走那一瞬间的状态**（快照持久化，不是重置也不是丢弃） |
| 4 | 面板位置 | **固定占据输入区位置**（同一块区域：准备态内容 ⇄ 正常输入框） |
| 5 | 折叠 | 素材 / 会话要求做成**可折叠摘要条**，默认折叠；首条消息为主体 |
| 6 | 「准备中」徽标 | 左栏保留 |

**核心行为**：新建对话 → **零 LLM 调用** → 进准备态；备好三件事（素材 / 会话要求 / 首条消息）→ 点「开始对话」→ 才发首条消息，进正常对话。

---

## 二、代码事实核对（逐行验证）

| 事实 | 位置 | 处置 |
|---|---|---|
| `newTask` 末尾 `void startScene(row.id)` | `ai-teaching/index.tsx` L784 | **删除**（改为进准备态） |
| `startScene`（虚拟首轮，主进程 `allowEmptyHistory`） | L744-758 | **保留不删**，渲染层不再自动调用 |
| `TEMPLATES` 4 场景只有 `rule` | L132-162 | 新增 `startPrompt` |
| `Template` 类型 | L118-130 | 新增 `startPrompt: string` |
| **已存在按会话持久化**：`writeNav/readNav`（`aiTeach.nav.{sid}` localStorage），`openSession` L645 读取恢复 | L241-253 / L499-508 / L645-648 | **复用**，扩 `prep` 字段 |
| `openSession` 复位 `midView`/`artTabs`/`input` 后再按 nav 恢复 | L635-649 | 恢复链里加准备态分支 |
| `input` 是全局单 state（不按会话存） | L300 | 准备态草稿单独存 nav，不混用 |
| 素材列表 `srcEntries` + `refreshSources(sid)` | L904 / L1022 | 直接复用渲染迷你清单 |
| 约束读 `aiTeachReadConstraints(sid)` → `activeInstr` | L556-560 / L1024-1031 | 复用；编辑走既有弹层 |
| 输入区渲染：`textarea ref={inputRef}` + 工具行 | L2260-2263 / L2267-2270 | 准备面板替换这一块 |
| 空态「开始对话」占位 | L1958-1960 | 准备态时中栏显示引导区替代 |

---

## 三、数据结构

```ts
// 1) Template 加字段（4 个场景全部）
type Template = { /* …既有… */ startPrompt: string }

// 2) AiTeachNav 扩 prep（同文件 L241-244，模块内私有类型，不进 src/types）
type AiTeachNav = {
  midView?: 'chat' | 'quiz'; docRel?: string | null
  readerRel?: string | null; readerPage?: number
  /** 会话准备态快照：未开讲时承载用户编辑的三块内容 */
  prep?: {
    started?: boolean   // false/缺省 = 停准备态；true = 已开讲（此后不再进准备态）
    draft?: string      // 首条消息（用户编辑后的值；缺省回落场景 startPrompt）
    srcOpen?: boolean   // 素材条展开态
    reqOpen?: boolean   // 会话要求条展开态
  }
}
```

**关键设计**：
- `draft` **只在准备态期间**写入 nav；「开始对话」后清空 `prep`（或置 `started:true`），正常对话期不再写，避免 localStorage 无限累积。
- 素材块 / 会话要求块**不存快照**，改为实时读 `srcEntries` / `activeInstr`——因为这两者的真相源分别是 `SOURCE.md` / `CONSTRAINTS.md`，切走期间可能被别处（编辑器、AI 工具）改动，实时读才能既「一致于切走瞬间的用户输入」又不「丢掉外部变更」。

---

## 四、改动清单

### 4.1 `src/modules/ai-teaching/index.tsx`（唯一改动文件）

| # | 位置 | 改动 |
|---|---|---|
| 1 | L118-130 `Template` type | 加 `startPrompt: string` |
| 2 | L132-162 `TEMPLATES` | 4 个场景各加 `startPrompt`（文案见 §五） |
| 3 | L241-244 `AiTeachNav` | 加 `prep?` 字段 |
| 4 | 新增 state | `const [prepStarted, setPrepStarted] = useState(true)`、`prepDraftRef`；折叠态随 nav 走 |
| 5 | L761-785 `newTask` | 删 `void startScene(row.id)`；改为 `writeNav(row.id, { prep: { started:false, draft: tpl.startPrompt } })` + 复位 + `setPrepStarted(false)`；`draft` 同步进 `input` 初值 |
| 6 | L635-649 `openSession` | 读 `nav.prep`：`started===false` → 进准备态并回填 draft / 折叠态；否则进正常对话态 |
| 7 | 新增 `startPreparedChat` | 「开始对话」：`writeNav(sid,{prep:{started:true}})` → `setPrepStarted(true)` → 走既有 `doSend(draft)` |
| 8 | 新增 `onPrepDraftChange` | textarea onChange → `setInput` + 防抖 `writeNav` 落 draft |
| 9 | 渲染层输入区（L2256-2270 区块） | 按 `prepStarted` 二选一：准备面板 / 既有输入框 |
| 10 | 中栏空态（L1958-1960） | 准备态时渲染引导区（图标 + 场景名 + 工作区素材迷你清单） |
| 11 | 左栏会话项 | 未开讲会话挂「准备中」徽标 |

### 4.2 主进程：**零改动**

`agentStartScene` / `agentService` / IPC 全部保留。`startScene` 函数体留在渲染层不删（防止别处引用），只是不再被 `newTask` 调用。

### 4.3 其他文件：无

---

## 五、`startPrompt` 四场景文案（志岩已认可）

```ts
// 跟我学
startPrompt: '我要学：〈主题，如 数列极限的定义与证明〉\n资料：〈网址 / 文件路径 / 素材编号，留空则由你从已登记素材里选〉\n其他要求：〈可选，如 多举例子 / 跳过基础推导〉'

// 深度研读
startPrompt: '研究主题：〈关键词，如 傅里叶变换的物理意义〉\n范围：〈可指定素材编号如 #1#3，留空则用全部已登记素材〉'

// 周复盘
startPrompt: '复盘时间段：〈本周 / 上周 / MM-DD ~ MM-DD〉\n关注重点：〈可选，如 学习时长 / 打卡连续性〉'

// 画像诊断
startPrompt: '开始入学诊断：我想先把本主题的学习者画像建起来。\n说明：〈可选，补充你的背景或特别想被了解的点〉'
```

---

## 六、状态机

```
newTask(tpl)
  └─ 建会话 → 归属工作区 → 建会话夹(folder) → 播种 rule 进 CONSTRAINTS.md
     └─ writeNav(sid, { prep: { started:false, draft: tpl.startPrompt } })
        └─ setPrepStarted(false) → 进准备态（零 LLM）

准备态
  ├─ ① 素材条（折叠）── 摘要「已登记 N 项 · 首项…」+ ✓；展开 = srcEntries 迷你清单 +「＋素材」→ 既有登记弹层
  ├─ ② 要求条（折叠）── 摘要「场景流程已自动播种 · N 行」；展开 = activeInstr 预览 +「编辑」→ 既有会话要求弹层
  ├─ ③ 首条消息 textarea ── 初值 nav.prep.draft ?? tpl.startPrompt
  └─ 任意编辑 → writeNav(sid, { prep: { draft, srcOpen, reqOpen } })

「开始对话」
  └─ writeNav(sid, { prep: { started:true } }) → setPrepStarted(true) → doSend(draft)
     └─ 首轮带「素材目录 + 会话要求 + 用户消息」→ 正常对话态

openSession(sid)  [切回]
  └─ nav.prep?.started === false → 准备态（draft/折叠态从 nav 还原，素材与约束实时读文件）
     nav.prep?.started !== false → 正常对话态（既有逻辑）
```

---

## 七、边界与铁律

| 项 | 处置 |
|---|---|
| **切走切回** | `prep.draft` + 折叠态存 nav；素材/约束实时读 → 与切走瞬间一致，且不丢外部变更 |
| **未归属工作区的会话** | 无场景（非 `newTask` 创建）→ `prep` 缺省 → 直接正常对话态，不受影响 |
| **旧会话** | `nav.prep` 缺省 → 走原有逻辑，零回归 |
| **AI 落盘导致素材/约束变化** | 既有 `aiTeach:tree-refresh` → `syncSessionFiles` 已覆盖，准备态自动同步 |
| **AGENTS.md#13 动效** | 折叠用 `grid-template-rows`（对齐 `.kb-collapse` 唯一例外）；进出用 `.kb-view-in`；按钮反馈 `.kb-micro-pop`；不另造过渡、不用 `transition-all` |
| **AGENTS.md#17** | 不动工具 schema，无提示词膨胀 |
| **AGENTS.md#21** | 本文件串行 Edit，不并行 |
| **AGENTS.md#9/#13 拖拽** | 本项不涉及 |

---

## 八、验证口径

1. 新建 4 个场景对话 → **均无任何自动 LLM 请求**，均进准备态、均预填对应 `startPrompt`；
2. 准备态内：加素材（既有弹层）/ 改约束（既有弹层）/ 编辑首条消息 → 三块状态正确；
3. 「开始对话」→ AI 首轮**带着素材目录 + 会话要求 + 用户消息**响应，调用轨迹**无 `vault.search` 群**；
4. 准备态中切走 → 切回：输入框内容、折叠开合、素材摘要、是否已开讲**全部与切走瞬间一致**；
5. 未开讲的会话左栏带「准备中」徽标，开讲后消失；
6. 旧会话打开 / 续聊**完全不受影响**；
7. 深 / 浅两主题各看一眼准备态观感；
8. `tsc` 双侧 0 错误。
