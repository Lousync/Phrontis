# 工作台分屏分区精细化 · 技术方案（v3.4.0 第 7 项）

> 状态：**方案定稿，待开发负责人确认后编码**
> 前置：三栏外壳分区精细化（第 6 项）已落地；副栏准入收窄原型 v2 已验收（20/20 PASS）
> 关联原型：`outputs/workbench-split-scope-prototype.html`
> 观测证据：`outputs/workbench-review/split-instance-probe.json`（实机探针）+ `tmp/probe-cross-parent*.mjs`（React 结构实验）

---

## 一、本轮要修的四个问题（拍板结果）

| # | 问题 | 拍板 |
|---|---|---|
| ① | 主栏是「日程」等非准入模块时按 `Ctrl+\`，现状**无条件**给副栏塞 knowledge（旁路绕过了准入意图） | **B 方案**：置灰 + 提示，不换主栏、不强开副栏；**分屏按钮不置灰**（只提示） |
| ② | 副栏可开任意 palette 模块（命令面板「分屏：在副栏打开 日程」等） | **收窄为「编辑区 / 知识库」两者**；存量：`secondaryTab` 本就**不持久化**（每次启动均为 null）→ **无需迁移** |
| ③ | 副栏模块名 chip 带一个 `⌄` 菜单（`SplitPaneMenu`）——开发负责人明确不要这个「类似菜单的按钮」 | **删除**：`paneMenuNode` + `SplitPaneMenu.tsx` 整体删除；chip 降为**纯标识** |
| ④ | **跨栏搬迁丢失模块内部状态**（本轮必修） | 实证根因 + 改结构保活（见 §四） |

### 问题 ④ 的实证结论（两句硬事实）

**事实 1 —— 现象**（实机探针 `.AGENT/scripts/workbench-shell/probes/probe-split-instance.mjs`）：

```
>>> 搬迁前后：items 2 → 0，slot main → undefined，active probe-note-1 → null
>>> 结论：跨栏搬迁【丢失】模块内部状态 —— 不是两个独立实例，是同一个实例被卸载重建
```

**事实 2 —— 根因**（`tmp/probe-cross-parent5.mjs`，React 19.2.7 + linkedom 真实挂载）：

| 结构 | mounts / unmounts | 结论 |
|---|---|---|
| P1 现状：两个不同父节点各挂一份（`key={name}` 相同） | 2 / 1 | ❌ **卸载重建** |
| **P2 单父节点 + 常驻兄弟槽，只改样式决定落点** | **1 / 0** | ✅ **保活** |
| P3 `createPortal` 换 target | 2 / 1 | ❌ 卸载重建（portal 换目标同样重挂） |

**判定**：React 的 reconciliation 以「**父节点的 children 数组**」为作用域 —— 同 key 换父节点 = 旧位置删除 + 新位置新增。所以：
- 「给容器挂跨父节点稳定 key」**不可行**（key 只在同父节点内有效）；
- 「Portal 复用」**不可行**（换 target 一样重挂）；
- 「把模块状态提到 App 层」**不必要**（代价大且要改所有模块 props 契约）。

**唯一可行且代价最小的路径 = P2**：让模块容器成为**同一个父节点下的常驻兄弟**，`pane` 变化只改容器的样式（宽度 / 伸缩 / 视觉归属），DOM 父节点与兄弟顺序**从不变化**。

---

## 二、改动清单（按文件）

### 1. `src/lib/appModules.ts` —— 新增准入常量（唯一真相源）

```ts
/** 可分屏（进副栏）的模块 —— 只有编辑区与知识库。
 *  ⚠️ 这是分屏准入的唯一真相源：toggleSplit / 命令面板 / 启动校验 / 契约脚本全读它，
 *  别在任何调用点写第二份字面量（见 AGENTS.md 铁律 14 的同款病）。 */
export const SPLIT_ELIGIBLE: TabName[] = ['editor', 'knowledge']
export const isSplitEligible = (t: TabName | null | undefined): t is TabName =>
  !!t && SPLIT_ELIGIBLE.includes(t)
```

**取舍**：放 `appModules.ts` 而非 `workbenchLayout.ts` —— 消费者是 App 的 Tab 逻辑与命令面板，与模块清单同域；且 `appModules.ts` 已是「清单唯一真相源」，同类信息不应分裂到两处。

### 2. `src/App.tsx` —— 五处改动

#### 2.1 `toggleSplit` 加准入判断（B 方案）

```ts
const toggleSplit = useCallback(() => {
  if (secondaryTab) {              // 已分屏 → 关闭（任何主栏模块都允许关）
    setSecondaryTab(null)
    setActivePane('main')
    return
  }
  // B 方案：主栏非准入模块 → 不换主栏、不强开副栏，只给一次提示
  if (!isSplitEligible(activeTab)) {
    showToast({ type: 'info', message: '分屏仅支持编辑区 / 知识库' })
    return
  }
  setSecondaryTab(activeTab === 'editor' ? 'knowledge' : 'editor')
}, [secondaryTab, activeTab])
```

要点：
- **关闭分支不加准入**（`Ctrl+\` 关分屏应永远生效，否则用户被锁死在分屏里）；
- `showToast` 已在 App 顶部 import（`./lib/toast`，现有第 29 行），零新增依赖；
- 提示形态 = **现有 toast 组件**（`type: 'info'`）。不新造状态栏提示条 —— 项目已有统一轻提示通道，禁另造。

#### 2.2 命令面板「分屏」组收敛为 2 条

```ts
items.push(...SPLIT_ELIGIBLE.filter((t) => t !== activeTab).map((id) => ({
  id: `split-${id}`,
  label: `分屏：在副栏打开 ${labelOf(id)}`,
  group: '分屏',
  run: () => { setSecondaryTab(id); setPalette(null) },
})))
```

- **删掉**现在的 `split-toggle`（「开启/关闭副栏」）项 —— 拍板「2 条：在副栏打开编辑区 / 在副栏打开知识库（排除主栏自身）」，不保留关闭项；
- 关闭副栏仍有 **`Ctrl+\`** 与 **副栏 ✕** 两个入口，能力不丢；
- 主栏 = 知识库时只剩 1 条（「在副栏打开 编辑区」），主栏 = 其他模块时 2 条全出。**注意**：主栏非准入模块时命令面板仍给 2 条（用户明确点选 = 主动意图，应放行并顺带把主栏让出），见下方 §三 取舍说明。

#### 2.3 删 `paneMenuNode` + chip 降为纯标识

- 删除 `App.tsx:1101-1120` 整个 `paneMenuNode` 函数；
- `App.tsx:19` 的 `import { SplitPaneMenu }` 一并删除；
- 删除 `src/components/shared/SplitPaneMenu.tsx` 文件（唯一用途就是这个菜单，删除后无引用）；
- 副段 `lead` 改为内联的**纯标识 chip**：

```tsx
lead: (
  <span
    data-pb-pane-chip={secondaryTab}
    className="flex h-7 shrink-0 cursor-default items-center gap-1.5 rounded-md bg-[var(--bg-secondary)] px-2 text-[12.5px] text-[var(--text-primary)]"
    title={`副栏：${tabLabel(secondaryTab)}`}
  >
    <span className="shrink-0 text-[var(--accent)]"><Columns2 size={13} /></span>
    <span className="max-w-[110px] truncate">{tabLabel(secondaryTab)}</span>
  </span>
)
```

与原型 v2 逐字对齐：`span` 而非 `button`、`cursor-default`、无 hover 变化、无 `ChevronDown`。

#### 2.4 `Ctrl+\` 快捷键 —— 零改动

`App.tsx:1074-1084` 本就调 `toggleSplit()`，准入判断收在 `toggleSplit` 内部 → 快捷键、分屏按钮、命令面板**三个入口自动同口径**。这是把判断放收口层而非各调用点的收益。

#### 2.5 ★ 跨栏保活的结构改造（本轮核心）

**现状结构**（`App.tsx:1360-1438`）：

```tsx
<div className="flex min-h-0 min-w-0 flex-1">
  <div data-wb="mainPane" ...>              {/* 父节点 A */}
    {...[activeTab, ...others.filter(t => t !== activeTab && t !== secondaryTab)]
      .map(t => renderMounted(t, t === activeTab, 'main'))}
  </div>
  {secondaryTab && secondaryTab !== activeTab && (
    <ResizablePanel ...>
      <div data-wb="splitPane" ...>          {/* 父节点 B（另一个父节点！） */}
        {renderMounted(secondaryTab, true, 'secondary')}
      </div>
    </ResizablePanel>
  )}
</div>
```

**✅ 最终落码结构（已用最小实验逐轮验证，`tmp/probe-rowg-order.mjs` 全场景零卸载）**：
模块容器**全部是一条 flat flex 行的直接子元素**（单一父节点），DOM 顺序按 `mountedTabs` 访问序**恒定**；
`pane` 只改**样式**（`order` 控制视觉左右 + 宽度 + 显隐）。

```tsx
<div className="relative flex min-h-0 min-w-0 flex-1">   {/* ← 唯一父节点 */}
  {/* 主栏内容级操作浮层：绝对定位，宽度 = 100% - 副栏宽 */}
  <div data-wb="mainPane" className="pointer-events-none absolute inset-y-0 left-0 z-30 ..." />
  {/* 模块序列：顺序恒定 */}
  {rowModules.map((t) => {
    const isSec = t === secondaryTab
    return (
      <div key={t} data-pane={isSec ? 'secondary' : 'main'}
           style={{ order: isSec ? 2 : 1,
                    width: isSec ? splitWidth : undefined,
                    flex: isSec ? '0 0 auto' : 1,
                    display: t === activeTab || isSec ? undefined : 'none' }}>
        {renderMounted(t, t === activeTab || isSec, isSec ? 'secondary' : 'main')}
      </div>
    )
  })}
  {/* 手柄：绝对定位在副栏左缘 —— 不占 children 槽位，不干扰 key 序列 */}
  {secondaryTab && <SplitHandle ... />}
</div>
```

三条不可动摇的约束（任何一条破了就退回卸载重建）：
1. **单一父节点** —— 模块容器不能挂进「主栏区 / 副栏区」这类嵌套容器；
2. **顺序恒定** —— 数组顺序按访问序，**绝不能**写成「主栏列表 + 副栏拼接到末尾」（副栏模块会换下标）；
3. **pane 只改样式** —— `order` / `width` / `flex` / `display`，不改 DOM 结构。

**推翻的三个错路**（都实测过，写下来避免重犯）：
- ❌「给容器挂跨父节点稳定 key」—— key 只在同父节点作用域内有效；
- ❌「`createPortal` 复用实例」—— 换 target 一样重挂（实测 2 mounts / 1 unmount）；
- ❌「两个常驻槽 + 模块在槽间搬」= 仍是两个父节点（实测 3 mounts / 2 unmounts）。

**配套新件 `SplitHandle.tsx`**：不再用 `ResizablePanel` 装模块（它的 `{visible && children}` 会卸载 children，且结构上必然把模块变成它的子孙 = 另一个父节点）。新组件把 `ResizablePanel` 的拖拽语义**原样搬过来**（pointer capture + 四路收尾 + body 污染兜底 + dead-zone + 双击复位），只把「宽度归属」改成 App 持有（`onWidthChange` 上报），因为宽度同时被模块容器与顶栏副段消费。


---

## 三、取舍与已知风险

| 项 | 取舍 | 理由 |
|---|---|---|
| 提示形态 | 复用现有 `showToast(type:'info')` | 项目已有统一轻提示通道；禁另造状态栏提示条（AGENTS 铁律 12/13 精神） |
| 分屏按钮不置灰 | 采纳拍板 | 置灰需新增 disabled 态样式，且与项目其他按钮口径不一致；点击/按键同样只给提示即可 |
| 命令面板在主栏非准入模块时仍给 2 条 | **有意为之** | 命令面板是**显式点选**（主动意图），与 `Ctrl+\` 的「随手快捷键」不同。用户点「分屏：在副栏打开 知识库」= 明确要这个，应当放行；此时主栏保持不动（副栏与主栏不同模块即可）。若开发负责人希望严格一致（非准入时命令面板也只提示），改一行 `filter(!isSplitEligible(activeTab) ? [] : ...)` 即可 —— **此项待确认**。 |
| 状态锚修法选 P2 | 不动模块 props 契约 | 提到 App 层要碰 `KnowledgeModule`/`EditorModule` 等全部模块的 props，改动面大且引入回归风险；P2 只改 App 的外壳结构 |
| 存量副栏 | 不迁移 | `secondaryTab` 是 `useState`（`App.tsx:222`），**不持久化**，每次启动为 `null`；已与开发负责人确认「没有原先开着的①」 |

---

## 四、验证方案

> ⚠️ 本节已按**实际落地的断言编号**重写。计划阶段的 G1-G7 在编码时被并入了既有 G 段并扩展为
> **J 段（J1-J13）**，计划稿里的编号与最终编号不再对应 —— 以本节为准。

### 4.1 契约脚本（源码层，`verify-workbench-shell.mjs` **J 段**）

落点：既有 G/H/I 段之后，共 13 条。**158 项断言全绿**（2026-09-18）。

| 断言 | 内容 |
|---|---|
| J1 | `SPLIT_ELIGIBLE` / `isSplitEligible` 落在 `appModules.ts`（准入唯一真相源） |
| J2 | 开副栏收敛到 `openInSecondary`（准入判断在收口层，三个入口自动同口径） |
| J3 | `toggleSplit` 在主栏非准入时**不换主栏、不强开副栏**，只给一次 toast（B 方案） |
| J4 | 命令面板分屏组只消费 `SPLIT_ELIGIBLE`（排除主栏自身；旧「开启/关闭」两条已删） |
| J5 | `SplitPaneMenu.tsx` 已删 + `App.tsx` 无 `paneMenuNode` 残留（副段不再是菜单） |
| J6 | 副段 chip = 纯标识 `span`（`data-pb-pane-chip` / `cursor-default` / 全文件无 `ChevronDown`） |
| **J7** | ★ 模块序列 `rowModules` 按 `mountedTabs` **访问序**生成（顺序恒定，不随栏位变化） |
| **J8** | ★ 单一父节点 + pane 只改样式：模块容器同挂一行，`order` 决定视觉左右 |
| **J9** | ★ 副栏模块**不再单独渲染进另一个容器**（旧结构 = 跨父节点搬迁 = 卸载重建） |
| J10 | 副栏不再用 `ResizablePanel` 装模块（它会把模块变成子孙 = 另一个父节点）；改用 `SplitHandle` |
| J11 | 副栏仍有 `splitPaneModules` / 宽度上报（宽度真相源在 App） |
| J12 | `SplitHandle` 原样继承 `ResizablePanel` 的拖拽语义（pointer capture + 四路收尾 + body 污染兜底） |
| **J13** | ★ 副栏宽度兜底**单一真相源** `SPLIT_FALLBACK_WIDTH`（见 §4.4） |

### 4.2 实机探针（`probes/probe-split.mjs`，v6）

运行：`node .AGENT/scripts/workbench-shell/probes/run-probe.mjs .AGENT/scripts/workbench-shell/probes/probe-split.mjs`

| 断言 | 判据 |
|---|---|
| S1a/S1b | 未分屏：分屏开关在主段尾部；无副栏 |
| S2a/S2b | 点开关 → 副栏渲染；主栏知识库 → 副栏编辑器 |
| S2c/S2d | 副段 chip 是 `SPAN`、无 `⌄` 菜单、`cursor: default` |
| S2e | **分界对齐**：副段左缘 ≈ 副栏左缘（±2px） |
| S3a/S3b | 知识库在主栏有页签（基线非零）；主栏编辑器 → 副栏知识库 |
| **S3c** | ★ **跨栏保活**：知识库搬副栏后页签数与激活页 id **不变** |
| **S4** | ★ 搬回主栏后状态仍保持（完整往返零丢失） |
| S5a/S5b | 主栏非准入（博客）时 `Ctrl+\` 不开副栏 + 给出提示 |
| S6/S6b | 单实例：知识库容器只一份；副栏容器不在主栏区域内 |
| S7 | console 零 error（含 React #310 防线） |

### 4.3 门禁

- `tsc --noEmit -p tsconfig.web.json`（**必须 `--noEmit`**，见技能 `tsc-shadowing-emit`）
- `cd /E/Projects/KnowledgeRecorder && npm run build`（**大写盘符 cwd**，否则 help docs `?raw` 解析失败）
- 构建后**跑渲染层探针**（React #310 只有运行时炸）：`run-probe.mjs` **必须带 `--no-sandbox --disable-gpu`**

### 4.4 ★ 副栏宽度兜底必须只有一个数（S2e 抓到的新缺陷，2026-09-18）

**症状**：分屏后顶栏分界竖线比副栏左缘**右偏 81px**（探针实测 `secWrap=663 / pane=582`）。

**根因**：同一个未知量（`splitWidth` 尚未上报时的首帧副栏宽度）被写了两份兜底，且**基准不同**——

| 位置 | 旧兜底 | 数值 |
|---|---|---|
| `App.tsx`（模块容器 / 浮层 / 手柄 / 工具槽） | `380`（px） | 380px ✓ |
| `WorkbenchPageBar.tsx`（副段宽度） | `'46%'` | 46% × 651 ≈ 300px ✗ |

**修法**：`App.tsx` 顶部声明 `SPLIT_FALLBACK_WIDTH = 380`，派生
`splitSecondaryWidth = splitWidth > 0 ? splitWidth : SPLIT_FALLBACK_WIDTH`，
**五处调用点全部改用它**；`WorkbenchPageBar` 删掉自带的 `46%` 兜底，改为**要求调用方传入已解析的值**
（`style={{ width: secondary.width }}`）。J13 断言锁住这条。

**教训**：兜底值属于「同一个概念的多份字面量」——典型 list-drift 类缺陷（见技能 `list-drift-audit`）。
凡是「同一个未知量在多个组件各自兜底」，必须收敛成单点常量；跨组件时约定**由上游传入解析结果**、
下游不自带兜底。

---

## 五、编码顺序（实际执行，已完成）

1. **地基**：`appModules.ts` 加 `SPLIT_ELIGIBLE` / `isSplitEligible`
2. **收窄**：`openInSecondary` 收口 + `toggleSplit` 准入 + 命令面板 2 条
3. **删菜单**：删 `paneMenuNode` / `SplitPaneMenu.tsx` / import，chip 改 `span`
4. **★ 保活改造**：外壳结构改「单一 flat flex 行」——这步风险最高，改完**立刻**跑探针
5. **修 React #310**：两个 `useMemo` 上移到 `if (!loaded) return null` 之前（hook 数恒定）
6. **收尾**：J 段 13 条 + 探针 v6 + §4.4 兜底收敛，全绿

### 5.1 走错过的路（勿重蹈）

第 4 步第一次的实现是「两个常驻槽 + 副栏容器提到外层」，我写了 `probe-verify-my-fix.mjs` 复核 →
**3 mounts / 2 unmounts，缺陷照旧**。根因：主栏数组与副栏槽**仍是两个不同父节点**。
改成单一 flat 行后实测 **1 mount / 0 unmount**。

**教训：不要假设「让容器常驻」就够了，必须验证模块容器的父节点在搬迁前后是同一个。**

---

## 六、开发负责人拍板记录

| # | 事项 | 结论 |
|---|---|---|
| 1 | 命令面板在主栏非准入模块时给几条？ | **仍给 2 条**（显式点选 = 主动意图，应放行）；点选后**必须让主栏让位** → 由 `openInSecondary` 收口 |
| 2 | 提示文案 | `分屏仅支持编辑区 / 知识库` |
| 3 | S4 验收强度 | **页签组 + 激活页 id 为硬断言**；滚动位置只做附加观测 |
