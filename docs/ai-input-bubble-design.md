# AI 输入区「气泡化」设计

> **状态：已落码**（2026-09-15，提交 `9dc2c3e`）· 归属 **v3.2.0 批次条目 8**。
> **落地差异备忘**：① #1 的发送键在改后补了 `title="发送"`（无文字图标键的 a11y 需要，见 §3.1(4)）；② 实测合规提示为 **4 个源文件各 1 处 = 5 处 UI**（`Composer` 同时服务 #3 与 #4），与 §6.17 的「5 处」口径一致；③ `SideLanePanel` 的 `X` 保留（L227 消息关闭键在用）。
> **来源**：开发负责人 + 两张参考截图 —— 目标形态 = WorkBuddy 的输入卡（大圆角卡片 + 卡内底栏 + 圆形发送键）；起点 = Phrontis 现状（贴容器底边的扁平条）。2026-09-15 追加「**侧边 AI 对话和扩后的 AI 对话界面也要改成这种气泡样式**」→ 范围由 1 处扩到 4 处；同日再追加「**支线旁问一并气泡化**」→ 最终 **5 处**。
> **已定方案：变体 B「最小改动」**（2026-09-15 开发负责人指定：样式选 B）。
> **三条待拍板已于 2026-09-15 全部拍定**：① **放弃**变体 A 的「会话要求 + ＋ 弹层」映射；② 扩后（`Composer`）**需要补**一行合规提示；③ 支线旁问输入条**一并气泡化**。→ 详见第七节。
> **原型**：`tmp/input-bubble-proto/index.html`（单文件、可交互；未进 git，落码后归档 DP `Phrontis/原型/`）。
> **行号出处**：均为 2026-09-15 改动前的定位，落码后会有位移。

---

## 一、范围：5 张输入区，同一套气泡

| # | 输入区 | 组件 / 位置 | 气泡底栏内容 |
|---|---|---|---|
| 1 | **AI 教学** 主输入区 | `src/modules/ai-teaching/index.tsx`（外壳 L2474） | 提示语 + 模型菜单 + ⓘ 用量 + 圆形发送 / 停止 |
| 2 | **侧边 AI 对话** | `src/components/shared/AssistantPanel/index.tsx`（输入容器 L817） | 提示语 + 圆形发送（pending 转圈） |
| 3 | **扩后的 AI 对话**（全屏 AI 学堂·完整对话区） | `src/components/shared/AiLearn/index.tsx` 的 `Composer`（L460 调用） | 提示语 + 圆形发送 |
| 4 | **学堂右栏「随行对话」**（与 #3 同一个 `Composer`，`compact` 变体） | 同上（L215 调用） | 提示语 + 圆形发送 |
| 5 | **支线旁问面板** | `src/modules/ai-teaching/SideLanePanel.tsx`（输入区 L312） | 提示语 + 圆形发送 / 停止 |

**共同的四条要求**：

1. **气泡式**：一整块圆角卡片，输入框自身不再画边框；
2. **不完全贴容器底边**：卡片与容器底缘之间要有可见留白（`pb-2.5`）；
3. **元素集合尽量不动** —— 这就是「B 最小改动」的定义：不新增 `＋` 弹层、不加「会话要求」pill；
4. **合规提示统一**（拍板②）：**5 处底栏左端一律有**「AI 生成内容，请注意甄别」这行弱化小字（改前只有 #1 / #2 有）。

---

## 二、现状（实测）

### 2.1 AI 教学（#1）

```
src/modules/ai-teaching/index.tsx
L2474  <div className="shrink-0 border-t border-[var(--border-color)] p-2 bg-[var(--bg-secondary)]">   ← 输入区外壳
         {!prepStarted && prepTemplate ? ( 准备态面板 )                                  L2477–2553
          : (
            <>                                                                           L2555
              {askVisible && askPending ? ( 提问卡 ) : ( 引用 / 压缩提示 / 技能 + textarea )}   L2558 : L2649–2707
              <div className="flex items-center gap-2 mt-1.5"> …提示语 / 模型 / ⓘ / 发送… </div>  L2709–2926
            </>                                                                          L2927
          )}                                                                             L2928
       </div>                                                                            L2929
```

1. **底栏是「提问卡态」与「正常态」共用的** —— L2709 的底栏落在 ask 三元**之外**、非准备态分支**之内**。所以想把底栏放进气泡，**必须把三元拉平 + 把底栏提取出来**；直接改结构会把提问卡也塞进气泡（卡片套卡片）。
2. **合规提示语现在就在底栏左端**（L2712 `AI 生成内容，请注意甄别`，`text-[10.5px] text-[var(--text-disabled)]`）—— B 方案保留原位，**无需移动**。
3. **输入区外壳（L2474）同时包着准备态面板与提问卡** —— 动它的 `border-t` / `bg-secondary`，会连带改变那两态的周边（见「取舍」第 1 条）。
4. **发送 / 停止现为带文字的小胶囊**（L2913–2925）：发送 = `bg-[var(--accent)]` + `<Send size={12} />` + 文字「发送」；停止 = `bg-[var(--text-primary)]` + 内嵌 `w-2 h-2 rounded-[2px]` 方块 + 文字「停止」。

### 2.2 侧边 AI 对话（#2）

布局（`flex-1 min-w-0 flex flex-col` 内，L660 起）是**三个兄弟块**：

| 块 | 位置 | 现类名 |
|---|---|---|
| 引用胶囊 + 上下文徽章 | L773–814 | `px-3 pb-1 shrink-0 space-y-1` |
| 输入容器 | L817–851 | `p-2.5 shrink-0 border-t border-[var(--border-color)] space-y-1.5` |
| 合规提示 | L853 | `px-3 pb-1.5 -mt-0.5 shrink-0 text-[10.5px] leading-none text-[var(--text-disabled)]` |

- 输入容器内含：压缩提示（L818–823）、Skill chip（L824–831）、`relative flex items-end gap-2` 的 textarea + 按钮。
- textarea（L836–845）：`flex-1 px-2.5 py-2 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[12px] resize-none outline-none focus:border-[var(--accent)]`，`rows={2}`。
- 按钮（L846–849）：`p-2 rounded-md bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-40 transition-opacity`，内容 `pending ? <Loader2 size={14} className="animate-spin" /> : <SendIcon />`；本地 `SendIcon` 定义在 L932–938（手写纸飞机 SVG）。
- 无模型选择器、无 ⓘ 用量 → 气泡底栏比 AI 教学更简单（只有提示语 + 圆键）。

> **⚠️「停止」不在输入区（不要顺手统一）**：输入区按钮在 `pending` 时是**禁用 + 转圈**（`disabled={pending || compressing || !input.trim()}`）；真正的停止入口在**消息流里的流式气泡** —— `StreamBubble.tsx` L140–146 与 `MessageList.tsx` L230–240 的 `<Square size={9} /> 停止`。→ 本次**只换外观、不动行为**：圆键在 `pending` 时仍是转圈 + 禁用。

> **⚠️ 波及面**：L852 注释原文「**本组件多模块共用，改一处全局生效**」—— 侧栏助手是所有模块共用的。这一处改完，**所有模块的侧栏助手输入区一起变**（这正是本次想要的，但验收要抽查 ≥2 个不同模块）。

### 2.3 扩后的 AI 对话（#3 / #4）

「扩后」= `AssistantPanel` 的 `full` 态挂载的全屏层，内部是 **AiLearnShell**（三页签）。它有一个**共用的 `Composer` 组件**（`src/components/shared/AiLearn/index.tsx` L111–142），**两处调用**：

- L215–220：**随行对话右栏**（传 `compact`，docMode / step 两种 placeholder）；
- L460：**完整对话区**（不传 `compact`）。

- 容器（L122）：`flex shrink-0 items-end gap-2 border-t border-[var(--border-color)] bg-[var(--bg-secondary)] ${compact ? 'px-3 py-2.5' : 'px-4 py-2.5'}`
- textarea（L123–132）：`flex-1 resize-none rounded-lg border border-[var(--border-color)] bg-[var(--input-bg)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]`，紧凑 / 非紧凑给不同字号内距；`rows={2}`
- 按钮（L133–139）：`flex shrink-0 items-center justify-center rounded-lg bg-[var(--accent)] text-white transition-opacity hover:opacity-90 disabled:opacity-40 h-9 w-9`，`disabled ? <Loader2 size={13} /> : <Send size={compact ? 13 : 14} />`
- **改前无合规提示**、无引用胶囊、无模型选择器 → 气泡底栏原本只剩一个圆键 → **按拍板② 补上提示语**。

### 2.4 支线旁问面板（#5）

`src/modules/ai-teaching/SideLanePanel.tsx`，L311–340：

```
L312  <div className="shrink-0 border-t border-[var(--border-color)] p-2.5">                    ← 输入区外壳
L313    <div className="flex items-end gap-2 rounded-lg border border-[var(--border-color)]
                        bg-[var(--input-bg)] px-2.5 py-1.5
                        focus-within:border-[var(--accent)]/60 transition-colors">            ← 输入框自带一圈「小卡片」
L314–327    <textarea …/>   （无自己的边框，外层那圈就是它的框）
L328–338    {pending ? 停止键（<X size={13}/>） : 发送键（<Send size={13}/>）}
L339    </div>
L340  </div>
```

1. **它是「半只脚已在气泡里」的第 5 套实现** —— 外层已有一圈 `rounded-lg border`，但**贴容器底边**（L312 只有 `p-2.5`）、**圆角小**、**无阴影**、**焦点描边挂在输入框上**。→ 改法 = 把 L313 那圈**升格成气泡本体**（`rounded-xl` + `shadow-lg` + `bg-[var(--bg-primary)]`），`focus-within` 留在卡片上；L312 变 `px-2.5 pb-2.5 pt-2`。
2. **⚠️ 与 #1 同类、与 #2 不同：停止键就在输入区内**（L328–332）—— 面板窄，所以**发送 / 停止都只能是图标键**（`w-8 h-8 rounded-full`），放不下「发送 / 停止」文字。
3. **现状停止用的是 `✕`**（L331 `<X size={13} />`）—— 全应用既有约定是「方块 = 停止」（#1 现为 `w-2 h-2 rounded-[2px]` 内嵌方块）→ 本次**一并换成方块**（取舍第 11 条给了保留 `✕` 的退路）。
4. **改前无合规提示** → 按拍板② 的同原则补上（要求 4）。
5. **`rows={wide ? 2 : 2}`（L322）** —— 三元两支结果相同，是无意义写法；**本条不动**（自适应高度归条目 6），落码时可顺手化简。
6. **上方 L301–309 是「升格为会话」动作条**（`laneId && !pending && onPromote` 时出现）—— 它在输入区**之外的上方**，**不属于气泡**，本次不动。

### 2.5 两处现成范式（零新增设计令牌的照抄源）

同槽位的**提问卡外壳**（`ai-teaching/index.tsx` L2572）= `rounded-xl border border-[var(--border-color)] bg-[var(--bg-primary)] shadow-lg px-3.5 pt-3 pb-2.5`；**圆形发送键**（同文件 L2637–2643）= `w-8 h-8 rounded-full bg-[var(--accent)] text-white flex items-center justify-center hover:opacity-90 disabled:opacity-30 transition-all` + `<ArrowUp size={15} />`。

---

## 三、改动清单（B 方案）

### 3.1 `src/modules/ai-teaching/index.tsx`（#1）

**（1）输入区外壳 L2474**

| | 类名 |
|---|---|
| 改前 | `shrink-0 border-t border-[var(--border-color)] p-2 bg-[var(--bg-secondary)]` |
| 改后 | `shrink-0 px-3 pb-2.5 pt-2` |

去分割线与灰底 → 气泡悬浮在对话区背景之上。**「不贴底」的留白就来自这里的 `pb-2.5`**，不需要给卡片加 margin。

**（2）三元拉平 + 底栏提取（L2555–2928）** —— 在 `return` 之前新增变量收纳原 L2709–2926 整段底栏：

```jsx
const composerFooter = (
  <div className="flex items-center gap-2 mt-0.5">   {/* 原为 mt-1.5 */}
    {/* ……原 L2712 提示语 / L2714 起模型菜单 / ⓘ 用量 / 发送键，类名照旧…… */}
  </div>
)
```

结构改后：

```jsx
{!prepStarted && prepTemplate ? (
  /* 准备态面板：内部不动 */
) : askVisible && askPending ? (
  <>
    {/* 提问卡：内部不动 */}
    {composerFooter}
  </>
) : (
  <div className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-primary)] shadow-lg
                  px-3 pt-2.5 pb-2 focus-within:border-[var(--accent)]/60">
    {/* 引用胶囊 / 压缩提示 / 技能标签：原 L2651–2697 整段原样搬入 */}
    <div className="relative">
      {slashOpen && <SlashCommandMenu … />}
      <textarea … />
    </div>
    {composerFooter}
  </div>
)}
```

**（3）textarea（L2702–2705）**

| | 类名 |
|---|---|
| 改前 | `w-full px-3 py-2 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[13px] resize-none outline-none focus:border-[var(--accent)]` |
| 改后 | `w-full px-0.5 py-1 rounded-none border-0 bg-transparent text-[13px] resize-none outline-none` |

**焦点态从 textarea 上移到卡片**（边框现在属于卡片）。`rows={2}` **保持不变** —— 高度抖动归条目 6。

**（4）发送 / 停止改圆形图标键（L2913–2925）**

```jsx
{pending ? (
  <button onClick={() => { void agentAbort(chatIdRef.current) }} title="停止生成（已完成的轮次保留）"
    className="w-8 h-8 rounded-full bg-[var(--text-primary)] text-[var(--bg-primary)] flex items-center justify-center hover:opacity-80 transition-opacity">
    <span className="w-2.5 h-2.5 rounded-[2px] bg-current" />
  </button>
) : (
  <button onClick={() => { void doSend() }} disabled={!input.trim()} title="发送"
    className="w-8 h-8 rounded-full bg-[var(--accent)] text-white flex items-center justify-center hover:opacity-90 disabled:opacity-30 transition-all">
    <ArrowUp size={15} />
  </button>
)}
```

- `ArrowUp` **已在 L2 导入**（提问卡在用）——无新增 import。
- `Send` 在本文件**仅 L2923 一处**使用 → 顺手从 L2 的 import 列表删掉。

**（5）底栏内部按钮尺寸（可选）**：模型键 / ⓘ 现为 `px-1.5 py-0.5`（约 22px 高），与 32px 圆键同行偏小 → 建议压成 `h-7 px-2`。**合规提示、模型菜单弹层、ⓘ 用量弹层的类名一律不动。**

### 3.2 `src/components/shared/AssistantPanel/index.tsx`（#2 侧边 AI 对话）

把 L773–853 的三个兄弟块收进一只气泡（**原 L817 的 `border-t` 与 L853 那行都要去掉**，提示语移入气泡内）：

```jsx
<div className="shrink-0 px-3 pb-2.5 pt-2">
  <div className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-primary)] shadow-lg
                  px-3 pt-2.5 pb-2 focus-within:border-[var(--accent)]/60">
    {/* 原 L773–814 引用胶囊 + 上下文徽章：去掉自己的 `px-3 pb-1 shrink-0`，其余原样 */}
    {/* 原 L818–831 压缩提示 + Skill chip：原样 */}
    <div className="relative">
      {slashOpen && <SlashCommandMenu items={slashItems} … />}
      <textarea rows={2} … className="w-full px-0.5 py-1 rounded-none border-0 bg-transparent text-[12px] resize-none outline-none" />
    </div>
    <div className="flex items-center gap-2 mt-0.5">
      <span className="flex-1 min-w-0 truncate text-[10.5px] text-[var(--text-disabled)] select-none"
        title="AI 生成内容可能存在错误，请自行核实">AI 生成内容，请注意甄别</span>
      <button onClick={() => { void send() }} disabled={pending || compressing || !input.trim()} title="发送"
        className="w-8 h-8 rounded-full bg-[var(--accent)] text-white flex items-center justify-center hover:opacity-90 disabled:opacity-30 transition-all">
        {pending ? <Loader2 size={13} className="animate-spin" /> : <ArrowUp size={15} />}
      </button>
    </div>
  </div>
</div>
```

- ⚠️ **原 L853 那行必须删掉**（已移入气泡），否则提示语会**出现两次**。
- 原 L817 的 `space-y-1.5` 由气泡内自然间距取代。
- 本地 `SendIcon`（L932–938）改为不再被引用 → **一并删掉**（留着即死代码）。
- lucide 导入（L4–6）**加 `ArrowUp`**。
- **不动**：`disabled` 三个条件、`SlashCommandMenu` 调用、压缩提示与 Skill chip 的内容、宽度拖拽条（L862–886）、`StreamBubble` / `MessageList` 里的「停止」。

### 3.3 `src/components/shared/AiLearn/index.tsx`（#3 + #4，改一处覆盖两处）

```jsx
<div className={`shrink-0 ${compact ? 'px-3' : 'px-4'} pb-2.5 pt-2`}>
  <div className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-primary)] shadow-lg
                  px-3 pt-2.5 pb-2 focus-within:border-[var(--accent)]/60">
    <textarea rows={2} value={draft} … spellCheck={false}
      className={`w-full resize-none rounded-none border-0 bg-transparent text-[var(--text-primary)] outline-none px-0.5 py-1 ${compact ? 'text-[12px]' : 'text-[12.5px]'}`} />
    <div className="flex items-center gap-2 mt-0.5">
      {/* 拍板②：底部新增合规提示行，与 #1 / #2 同款 */}
      <span className="flex-1 min-w-0 truncate text-[10.5px] text-[var(--text-disabled)] select-none"
        title="AI 生成内容可能存在错误，请自行核实">AI 生成内容，请注意甄别</span>
      <button onClick={push} disabled={disabled || !draft.trim()} title="发送"
        className="w-8 h-8 shrink-0 rounded-full bg-[var(--accent)] text-white flex items-center justify-center hover:opacity-90 disabled:opacity-30 transition-all">
        {disabled ? <Loader2 size={13} className="animate-spin" /> : <ArrowUp size={15} />}
      </button>
    </div>
  </div>
</div>
```

- `h-9 w-9 rounded-lg` → `w-8 h-8 rounded-full`；原「textarea 与按钮并排（`items-end gap-2`）」改为「textarea 全宽 + 底栏右端圆键」。
- lucide 导入（L3–5）：**加 `ArrowUp`、删 `Send`**（`Send` 在本文件仅 L138 一处使用）。
- **不动**：`disabled` 语义、自带草稿 state、Enter 行为、L215 / L460 两个调用点、`compact` 的左右边距差异（保留 `px-3` / `px-4` 的区分）。

### 3.4 `src/modules/ai-teaching/SideLanePanel.tsx`（#5 支线旁问 —— 拍板③ 新增）

```jsx
{/* 输入区 */}
<div className="shrink-0 px-2.5 pb-2.5 pt-2">
  <div className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-primary)] shadow-lg
                  px-3 pt-2.5 pb-2 focus-within:border-[var(--accent)]/60">
    <textarea
      ref={inputRef} value={input} onChange={e => setInput(e.target.value)}
      onKeyDown={/* 原 L318–321 原样 */} rows={2} spellCheck={false}
      placeholder="就这一点追问…（Enter 发送 · Shift+Enter 换行）"
      className="w-full resize-none rounded-none border-0 bg-transparent px-0.5 py-1 text-[12.5px] leading-relaxed
                 text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none max-h-32"
      disabled={stopped} />
    <div className="flex items-center gap-2 mt-0.5">
      {/* 拍板② 同原则：底栏左端补合规提示 */}
      <span className="flex-1 min-w-0 truncate text-[10.5px] text-[var(--text-disabled)] select-none"
        title="AI 生成内容可能存在错误，请自行核实">AI 生成内容，请注意甄别</span>
      {pending ? (
        <button onClick={() => { void agentAbort(chatIdRef.current) }} title="停止生成"
          className="w-8 h-8 shrink-0 rounded-full bg-[var(--text-primary)] text-[var(--bg-primary)] flex items-center justify-center hover:opacity-80 transition-opacity">
          <span className="w-2.5 h-2.5 rounded-[2px] bg-current" />
        </button>
      ) : (
        <button onClick={() => { void doSend() }} disabled={!input.trim() || stopped} title="发送"
          className="w-8 h-8 shrink-0 rounded-full bg-[var(--accent)] text-white flex items-center justify-center hover:opacity-90 disabled:opacity-30 transition-all">
          <ArrowUp size={15} />
        </button>
      )}
    </div>
  </div>
</div>
```

- 原 L313 那圈（`flex items-end gap-2 rounded-lg border … focus-within:border-[var(--accent)]/60 transition-colors`）被**卡片取代**：`focus-within` / `transition` 上移到卡片，`rounded-lg` → `rounded-xl`，加 `shadow-lg` + `bg-[var(--bg-primary)]`（原为 `bg-[var(--input-bg)]`）。
- 原「textarea 与按钮并排」→「textarea 全宽 + 底栏右端圆键」。
- `ArrowUp` **已在 L8 导入**（L306「升格为会话」在用）——无新增 import。
- `Send` 在本文件**仅 L336 一处** → 变死引用，从 L8 删；**`X` 不能删**（L227 消息关闭键仍在用）。
- **不动**：`disabled={stopped}`、`Escape` 关窗、`Enter` / `Shift+Enter`、`max-h-32`（内部滚动）、L301–309「升格为会话」动作条、消息区。

### 3.5 不改的文件

| 文件 | 原因 |
|---|---|
| `src/components/shared/SlashCommandMenu.tsx` | 它是 `absolute bottom-full left-0 right-0`，依赖 `relative` 父级 —— 那层 `<div className="relative">` 仍在，且气泡没有 `overflow-hidden`，菜单照旧浮在气泡上方 |
| `src/components/shared/AssistantPanel/MessageList.tsx` / `StreamBubble.tsx` | 「停止」入口在这里，本次不动 |
| `src/styles/index.css` | 气泡外壳复用提问卡的 `rounded-xl / border / shadow-lg`，**不新增设计令牌** |
| 主进程 / IPC / 其它模块 | 零改动（纯渲染层形态调整） |

---

## 四、明确不做

1. **不给 textarea 做自适应高度** —— 原型里有，但那是条目 6 的范围，本次 `rows={2}` 四处都不动（#5 的 `rows={wide ? 2 : 2}` 同属此列）。
2. **不重做准备态面板与提问卡** —— 它们只是「换了个背景」（灰条 → 对话区背景），卡片本身原样。
3. **不动 #5 的「升格为会话」动作条（L301–309）与消息区** —— 只把输入区气泡化。
4. **不引入变体 A 的 `＋` 弹层与「会话要求」pill**（**拍板① 已明确放弃**）—— 现有入口保持原样（顶部会话要求条 L2262–2269、素材登记走原路径）。
5. **不改键位**：Enter / Shift+Enter、`/` 唤起指令、`Esc`（#5 关窗）、`Ctrl+Shift+J`（收侧栏）一律不变。
6. **不统一「停止」的位置**：AI 教学与支线在输入区、侧栏在流式气泡里、学堂是转圈禁用 —— 这是既有分工；**本次只换外观**。
7. **不合并两种 pending 语义**：#2 / #3 / #4 在 pending 时是**转圈 + 禁用**（不可重复发送），#1 / #5 是**方块停止**（可中断）。既有分工，本次保留。
8. **不给气泡加进出场动画** —— 只保留 `transition-colors` / `focus-within` 这类既有微过渡（铁律 13：形状类动效若要加须先补基建，本次不涉）。

---

## 五、取舍与风险

1. **去灰底会同时改变提问卡 / 准备态面板的周边**（灰条 → 对话区背景）。判定为**三态统一**的正向变化，但**验收时三态必须各看一眼**。
2. **发送 / 停止键变成无文字图标**：AI 教学的停止态从「黑胶囊 + 停止」变成「圆内方块」。方块 = 停止是通用约定，**`title` 必须保留**；可读性不够时的退路是圆键左侧补一个小字「停止」。
3. **侧栏助手是多模块共用组件**（L852 注释）→ 改一处全模块生效；**验收要抽查 ≥2 个不同模块**的侧栏，确认没有哪个模块的容器给输入区套了额外背景 / 边框而产生「卡中卡」。
4. **`Composer` 是两处复用**（随行对话 `compact` / 完整对话区）→ 改一处同时覆盖 #3 与 #4；`compact` 的 `px-3` / `px-4` 差异**要保留**，否则右栏随行对话会突然变宽。
5. **三处图标会变成死代码**：`AssistantPanel` 的本地 `SendIcon`（L932–938）、`AiLearn` 的 lucide `Send` 导入、`SideLanePanel` 的 `Send` 导入 → **一并清理**（`tsconfig` 未开 `noUnusedLocals`，不删不报错，但留着是死引用）。⚠️ **`SideLanePanel` 的 `X` 不能删**（L227 在用）。
6. **AI 教学底栏提取成 `composerFooter` 变量**：**不是**新建组件（不引入新的渲染边界与 props 身份问题），只是把同一段 JSX 用两次。注意**别漏闭包变量** —— 该段引用了 `effModelBare` / `convoEffort` / `EFFORT_LABEL` / `providerList` / `visionList` / `showAllVision` / `tokenStats` / `usage` / `budget` / `monthTokens` / `fmtTok` / `pickModel` / `pickVision` / `pending` / `input` / `doSend` / `chatIdRef` 等，全部来自同一组件作用域，变量式提取天然安全。
7. **`focus-within` 的副作用**：点开模型菜单时焦点仍在卡内 → 卡片保持描边。属预期。
8. **textarea 横向净空变化**：AI 教学 `px-3` → `px-0.5`，文字与卡片内缘的距离改由卡片的 `px-3` 提供；净空与现状接近，但**需要肉眼确认与上方引用胶囊的左右对齐**。
9. **`shadow-lg` 在深色主题下偏重**：与提问卡同款，故不单独调；若显得脏，统一在提问卡与气泡上一起降档。
10. **五处气泡的「不贴底」留白一致**（`pb-2.5`），但**容器不同**：AI 教学与侧栏是「消息区 + 页脚带」，学堂是「全屏 flex 列」，支线旁问是**窄面板**（还有 `wide` / 窄两档）——五处都要确认卡片下方确实有可见空隙。
11. **#5 的停止图标由 `✕` 改方块** —— 为与 #1 统一（方块 = 停止）。若开发负责人认为支线的 `✕` 有独立语义（「关掉这次追问」），退路是**保留 `✕` 只换圆形底盘**（改一行）。
12. **#5 的合规提示是本次唯一的「新增文案」** —— 拍板② 只点了 `Composer`，支线是按「同类 AI 生成面一律有」这个原则**推断适用**。若不要，删掉 3.4 里那个 `<span>` 即可，不影响其余部分。
13. **#5 面板窄 → 气泡外边距收成 `px-2.5`**（原 `p-2.5`），内距仍 `px-3`；窄态下必须确认圆键不被挤换行、提示语能 `truncate`。

---

## 六、验证

**通用（五处）**

1. 气泡与窗口底部**都有可见空隙**、左右也留白；输入框自身无边框；**点进去整卡描边**。
2. 浅色 / 深色两套主题都成立（深色下 `shadow-lg` 不显脏）。
3. `tsc` 双端 0 错（node / web 两条基线）。

**#1 AI 教学**

4. 空 / 有引用 / 有素材 / 有 Skill 四类上下文都在气泡内顶部成胶囊且可逐个 × 掉。
5. 回车发送 → 圆键变**方形停止**、`pending` 结束复原；停止可用且已落库内容保留。
6. 打 `/` 的指令菜单与模型 / ⓘ 两个弹层都**浮在气泡上方不被裁切**。
7. **三态各看一眼**：准备态面板 / 提问卡 / 正常态。
8. 长文本换行不掉高度、对话区不被顶飞。

**#2 侧边 AI 对话**

9. 气泡留白、整卡描边、引用胶囊在气泡内、**提示语只出现一次**（不重复）。
10. `pending` 期间圆键**仍是「转圈 + 禁用」**，**不得**变成停止键（停止在消息流里）。
11. **抽查 ≥2 个不同模块**的侧栏助手，确认无「卡中卡」（外层容器没有额外背景 / 边框）。

**#3 / #4 扩后 · 学堂**

12. 完整对话区气泡成立；**随行对话右栏**同款但左右边距仍为 `px-3`（比完整区窄）；**两处底栏都有合规提示语**（拍板②）。
13. 侧栏 ↔ 全屏展开 / 收起动画不因气泡改动而抖动。

**#5 支线旁问**

14. 气泡成立、留白、整卡描边；**窄 / 宽两档**（`wide` 切换）都不挤压圆键，提示语 `truncate` 生效。
15. 发送中圆键变**方块停止**（可中断）；`stopped` 态下 textarea 与发送键仍是禁用。
16. `Esc` 关窗、`Enter` 发送 / `Shift+Enter` 换行、`max-h-32` 内部滚动、上方「升格为会话」动作条**均不变**。

**收尾**

17. **合规提示复核**：全应用搜「AI 生成内容，请注意甄别」应命中 **5 处**（改前 2 处：`ai-teaching/index.tsx` L2712、`AssistantPanel/index.tsx` L853）。

---

## 七、拍板结论（2026-09-15）

| # | 问题 | 结论 | 落点 |
|---|---|---|---|
| ① | 参考图的「**默认权限 ⌄**」在 Phrontis 没有对应物 | **放弃** —— 不引入「会话要求」pill 与 `＋` 弹层（变体 A）；B 方案为最终样式，元素集合保持现状 | 第四节第 4 条 |
| ② | `AiLearn` 的 `Composer` 是否补一行合规提示 | **需要补** —— 与 #1 / #2 一致；并**按同原则**给 #5 支线旁问也补上（见取舍 12） | 3.3 / 3.4 |
| ③ | 支线旁问输入条（`SideLanePanel.tsx` L312–340）是否一并气泡化 | **一并气泡化** —— 范围由 4 处扩到 5 处；停止键顺带 `✕` → 方块（取舍 11） | 第一节第 5 行 / 3.4 |

---

## 八、原型与归档

| 项 | 位置 / 动作 |
|---|---|
| 交互原型 | `tmp/input-bubble-proto/index.html`（单文件、浏览器直开；**四档形态：AI 教学 / 侧栏 AI 对话 / 扩后 · 学堂 / 支线旁问**，另四组开关：主题 / 底栏组织 A·B·C / 上下文 / 新旧对照。「扩后是否补提示」默认已改为**补一行**、「底栏组织」默认 **B**，与拍板结论一致） |
| 自检脚本 | `tmp/input-bubble-proto/_smoke.mjs`（Node 读 utf8 → 脚本语法 + 结构 + 中文编码 + 标签配对断言；按归档规则第 8 条，探针脚本留 `tmp/` 不归档） |
| 落码后归档 | 按 `docs/DESIGN-ARCHIVE.md`：本文档 → DP `Phrontis/已实现设计文档/`；原型 → DP `Phrontis/原型/` |
