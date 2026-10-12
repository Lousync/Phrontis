# 非 Markdown 文件的统一顶栏（批 2）设计

> 状态：**已落码**（2026-10-12）。拍板原型：`E:\Projects\KnowledgeRecorder\tmp\nonmd-topbar-proto\index.html`（945 行，可交互）。
> 上游：批 1（`docs/knowledge-content-routing-design.md`）—— 那一批把非 md 的**落点**修对了，本批修它的**工具区**。
> 契约：`.AGENT/scripts/nonmd-topbar/verify-nonmd-topbar.mjs` · 探针 `.AGENT/scripts/nonmd-topbar/probe-nonmd-topbar.mjs`

## 一、问题

md 有顶栏（`NoteTopBar`，2026-10-11 落地），非 md 只有**右上角一颗悬浮胶囊**（`[data-wb='floatBar']`）。

那颗胶囊在知识库里几乎是空的。批 1 的注释已经算过这笔账（`PageEditor.tsx` 1307-1312 行）：

- 「关联 / 删除」要 `!vaultMode`，而 `vaultMode` **恒 true**（`knowledge/index.tsx`「R6 D9 后恒 vault」）
- 「文件格式」同样要 `!vaultMode`
- 「收藏」排除归档条目，而仓库内非 md **全是** `entryKind:'file'` 归档条目
- 「沉浸阅读」只给 md/txt

⇒ 四条条件同时掏空它，只剩一个绿点 + 一颗 ⋮，点开只有一条分隔线（批 1 补了「文件」组才不空）。

同时它还有两个**语义错误**：

1. **绿点恒亮**：非 md 当时没有保存动作，却照样显示「已保存」。
2. **胶囊是浮层**：portal 到外壳右上角（`#editor-toolbar-slot`），正文滚过它底下；而顶栏是**行内**渲染，与正文连成一整片。

## 二、拍板（原型控制条，用户逐项确认）

| 项 | 选择 | 说明 |
|---|---|---|
| 方案 | **统一顶栏** | 非 md 改用与 md 同一个 `NoteTopBar` |
| PDF 两条栏 | **合并公共部分** | 阅读器那条只留阅读控件；文件名 / 页数上移顶栏 |
| 中段保存点 | **只对有真实保存动作的类型显示** | ★ 见 §三·①，比原型默认更准 |
| ⋮ 无内容时 | **隐藏 ⋮** | ★ 见 §三·②，实为潜伏守卫 |
| 文本类落地 | ~~直接只读文本~~ | **已被批 1 的「直接编辑」取代**，本批不处理 |

## 三、方案阶段发现的两个新问题

### ① 保存点的判断依据在批 1 之后过期

原型的理由是「非 md 没有保存动作，却照样显示『已保存』」（`index.html:806`）—— 那是批 1 **之前**的事实。
批 1 之后 `TEXT_VIEWABLE_EXT_SET` 内的文本类**有真实的防抖自动保存**，一刀切隐藏会把真信号也藏掉。

⇒ 落码口径：`showSaveDot = isMdNote || 可编辑文本类`。PDF / 图片 / 二进制 / 导图 / 超限只读文本隐藏。

### ② 「隐藏空 ⋮」已无触发场景

非 md 的「文件」组恒有 4 项（文件信息 / 在系统中打开 / 在文件夹中显示 / 复制相对路径），只被 `!isMdNote` 挡着
⇒ ⋮ **永远不会空**。md 侧「沉浸阅读」只要 `onRequestReading` 在就恒有。

⇒ 落码口径：照实现（一个布尔，成本极低），接受它**潜伏**；将来 ⋮ 项被收窄时自动生效。

## 四、落码

### 4.1 `NoteTopBar.tsx` —— 加四个纯展示 prop（不引入新真源）

| prop | 默认 | 作用 |
|---|---|---|
| `showSaveDot?: boolean` | `true` | 中段绿点。非 md 按 §三·① 传值 |
| `subtitle?: string` | — | 中段次要文本（PDF 的「N 页」），锚点 `noteTopSubtitle` |
| `showViewToggle?: boolean` | `true` | 阅读/编辑切换钮。非 md 现状没有预览态 ⇒ 不给 |
| `showMore?: boolean` | `true` | `false` 时 ⋮ 整个不渲染（不是渲染成禁用态） |

★ 该组件「纯展示 + 槽」的定位**不变**：它不取任何数据，`fileType / saving / preview / AI 四态` 的真源仍在 `PageEditor`，历史栈真源仍在 `KnowledgeModule`。

### 4.2 `PageEditor.tsx` —— 门槛从 `isMdNote` 放开到「非导图」

- 顶栏门槛：`{isMdNote && …}` → `{!isMindMapFile && !pdfImmersive && …}`
  - **导图不挂**：它自带工具条（与胶囊同一门槛口径，`PageEditor.tsx:1161` 的原注释）
  - **PDF 沉浸时不挂**：见 4.3
- 右段菜单：`moreMenu={isMdNote ? md 菜单 : 非 md 菜单}`
  - md 菜单**一字不改**（作对照基准）
  - 非 md 菜单 = 批 1 那个「文件」组**原样搬入**，五个锚点不变：
    `peHtmlSource` / `peFileInfo` / `peOpenInSystem` / `peRevealInFolder` / `peCopyRelPath`
  - 加一条「沉浸阅读」，门槛对齐模块层 `enterReading`（`knowledge/index.tsx:620`：md / txt / html）
- **删掉整个悬浮胶囊**：`createPortal` 块、`toolbarSlot` state、`setToolbarSlot` effect、5 处 `.kb-float-hide`、
  以及**随之变死的** `isActive` prop（它唯一用途就是给那颗 portal 做门槛）

### 4.3 `PdfReaderView.tsx` —— 「合并公共部分」

加三个可选 prop，**默认值 = 现状**（书架那条路一行不动）：

| prop | 默认 | 作用 |
|---|---|---|
| `chrome?: 'full' \| 'reader-only'` | `'full'` | `'reader-only'` 时阅读器那条**去掉** `FileText + 文件名 + N 页` |
| `onDocInfo?: (i: { pages: number }) => void` | — | 文档装载后上报页数 → 顶栏 `subtitle` |
| `onImmersiveChange?: (v: boolean) => void` | — | 沉浸态上报 → 顶栏跟着隐藏 |

保留在阅读器那条上的（PDF 专属）：模式切换 / 翻页 / 适配与缩放 / 大纲 / 搜索 / 书签 / 护眼 / 沉浸 / 百分比。

★ **为什么必须加 `onImmersiveChange`**：`immersive` 是 `PdfReaderView` 的**内部 state**（`PdfReaderView.tsx:191`），
它沉浸时把自己的栏 `hidden` 掉（同文件 1205 行）。顶栏在它**外面**，无从得知 ⇒ 不补这个回调就会
「正文进沉浸、顶栏还挂着」。★ 同理 `pdfImmersive` 要在 `pageId` 变化时复位（阅读器按 `page.path` 重挂，
它的内部 state 归零，外层 state 不会）。

★ 好消息：知识库内没传 `onBack`（`PageEditor.tsx` 传 props 处），所以「← 返回书架」那段**根本不渲染**，
合并量比原型小。

### 4.4 顺带修掉的一个真 bug：PDF 沉浸态按 Esc 会连页面一起关掉

**症状**：PDF 进入沉浸阅读后按 `Esc`，沉浸退出了，**页面页签也一起没了**。

**根因**（两个 `window` keydown 监听打架）：

| 监听 | 位置 | Esc 语义 |
|---|---|---|
| `PdfReaderView` | 「Esc 逐级退出」分支 | `immersive` 为真 → `toggleImmersive()`，**既不 `preventDefault` 也不 `stopPropagation`** |
| `PageEditor` | 「Escape — back to list」 | `e.preventDefault()` → `onBack()`，而模块层的 `onBack` = `handleCloseTab(activePageId)` |

两个监听都挂在 `window` 上 ⇒ **一次 Esc 跑完两段**。`stopPropagation()` 也救不了：它拦的是别的**元素**，
拦不住同元素的兄弟监听（要 `stopImmediatePropagation()`，那就变成依赖注册顺序的脆弱写法）。

**修法**：在 `PageEditor` 的 Esc 分支加一道让路守卫 `if (pdfImmersiveRef.current) return`。
判据用 ref 镜像 —— 那个 keydown effect 的依赖刻意只有 `[doSave, onBack]`，把 state 塞进去会让每次沉浸切换都重挂监听。

★ **为什么这个守卫以前写不出来**：`immersive` 是阅读器的内部 state，外层**无从得知**。
批 2 加了 `onImmersiveChange` 上报，才第一次有条件判「我现在在 PDF 沉浸里」。
⇒ 这不是顺手扩大范围，是本批新增的能力顺带解掉的既有缺陷。契约断言见 `verify-nonmd-topbar.mjs` B15/B16。

### 4.5 删掉悬浮胶囊基建（4 处，含一处已死代码）

| 位置 | 内容 |
|---|---|
| `src/styles/index.css` `[data-wb='floatBar']` 整段 | 胶囊外观 + `.kb-float-hide` 把手 + 空胶囊隐身 + reduced-motion 兜底 |
| `src/App.tsx` floatBar 槽 | `data-wb="floatBar"` + `#editor-toolbar-slot` |
| `src/App.tsx` `wbContentActionsEl` / `wbContentActionsRef` | **全仓无写入方**（v3.4.0 页面条的遗留死代码），顺手清 |
| `src/modules/knowledge/components/PageEditor.tsx` | 见 4.2 |

## 五、契约同步（不改必红）

★ 这批最容易被忽略的代价：**旧契约里锁着旧结构**，而且全是**正向**断言 ⇒ 代码改对了、契约反而红了。
逐条对照如下（都已同批改完）：

| 契约 | 为什么必须改 | 改成了什么 |
|---|---|---|
| `verify-workbench-shell.mjs` F8 / F8b / F8c | 三条都**正向断言**胶囊存在（`data-wb="floatBar"` + `#editor-toolbar-slot` 计数为 1 + `.kb-float-hide` 样式段 + 毛玻璃 + 空胶囊隐身） | 三条全转**负向断言**：任何残留都说明退役没做干净 |
| `verify-page-split.mjs` F1 | 它锁「副栏 PageEditor 必须 `isActive={false}`」—— 该 prop 已随胶囊删除 | 改锁「槽与胶囊零残留」+ 新增 F1b「副栏仍是独立 PageEditor 实例」 |
| `probe-page-split.mjs` P15 | 原来读 `#editor-toolbar-slot` 的子节点数（槽没了 ⇒ 断言变成永远为真的空转） | 改断言「槽与胶囊都不存在」 |
| `verify-note-topbar.mjs` B8 / B9 / B10 | 原锁「仅 md 挂顶栏」+「非 md 才 portal」—— 两条在批 2 都反了 | 改写 B8/B9/B10，新增 B9b 与 B10b–f（含 PDF 三条） |
| 批 1 `verify-content-routing.mjs` D2b / D4 / E6 | ⋮ 锚点 `peMore` → `noteTopMore`；「文件」组从 `!isMdNote &&` 变成 ⋮ 菜单的 else 分支；换页 effect 多复位两个 state | 三条同批改写（D4 改用下标比较，不再用长距离正则） |
| 批 1 `probe-content-routing.mjs` | 它拿「有顶栏」当 md 的判据 —— 批 2 后非 md 也有顶栏 ⇒ 判据失效，会把非 md 误判成 `md-editor` | 换成顶栏里的「阅读切换」钮（`showViewToggle={isMdNote}`）；点击目标换 `noteTopMore`；新增 §3.7 一节 |
| **新增** `verify-nonmd-topbar.mjs` + `probe-nonmd-topbar.mjs` | —— | 本批的正向契约（54 项）与实机探针（含 PDF 沉浸 Esc 的实机锁） |

## 六、范围锁

**不做**（本批之外）：

- 图片渲染（批 3）
- 导图挂顶栏（它自带工具条，要单独拍板）
- md 的顶栏与菜单（**一字不改**，作对照基准）
- 非 md 的「文件格式」钮（原型刻意不给：`handleFileTypeChange` 只在内存改、不落盘，
  而非 md 的扩展名来自文件名 ⇒ 加了就是一个重启即失效的假按钮）
- `verify-workbench-shell.mjs` 的 5 条**既有** FAIL（E6f / G4 / G9 / N8 / N13b，与本次无关）

## 七、门禁（2026-10-12 实测）

| 门禁 | 结果 |
|---|---|
| `tsc -p tsconfig.web.json` / `tsconfig.node.json` | **0 / 0** |
| 本批契约 `verify-nonmd-topbar.mjs` | **54 / 54 PASS** |
| 批 1 契约 `verify-content-routing.mjs` | **65 / 65 PASS**（D2b / D4 / E6 三条同批改写） |
| 顶栏契约 `verify-note-topbar.mjs` | **58 / 58 PASS**（B8/B9/B10 改写 + B9b/B10b–f 新增） |
| 分屏契约 `verify-page-split.mjs` | **41 / 41 PASS**（F1 改写） |
| 笔记写作面 `verify-note-surface.mjs` | **196 / 196 PASS** |
| help 检索 `verify-help-retrieval.mjs` | **82 / 82 PASS**（+6 条批 2 问句） |
| 更新说明 `verify-release-notes.mjs` | **PASS**（46 版本 / 567 条目） |
| 插件契约 `verify-mascot.mjs` | **37 / 37 PASS**（mascot 线不受影响） |
| `verify-workbench-shell.mjs` | **F8 / F8b / F8c 由红转绿**；余 5 条 FAIL（E6f / G4 / G9 / N8 / N13b）是**既有**的，与本次无关 |

三个探针均通过 `node --check`（实机跑法见 `probe-nonmd-topbar.mjs` 头注）。
